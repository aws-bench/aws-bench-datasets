import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';
import * as path from 'path';

export class CloudFront_e0239752d extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // DynamoDB
        const tenantsTable = new dynamodb.Table(this, 'TenantsTable', {
            partitionKey: { name: 'tenant_id', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        tenantsTable.addGlobalSecondaryIndex({
            indexName: 'OwnerIndex',
            partitionKey: { name: 'owner_user_id', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // S3
        const tenantBucket = new s3.Bucket(this, 'TenantServicesBucket', {
            bucketName: `basalt-tenant-services-${this.account}`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        tenantBucket.addToResourcePolicy(new iam.PolicyStatement({
            sid: 'AllowCloudFrontServicePrincipal',
            effect: iam.Effect.ALLOW,
            principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
            actions: ['s3:GetObject'],
            resources: [`${tenantBucket.bucketArn}/*`],
            conditions: {
                StringLike: {
                    'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/*`,
                },
            },
        }));

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant each bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons these FIXED-NAME
        // buckets, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                tenantBucket.bucketArn,
                `${tenantBucket.bucketArn}/*`,
            ],
        });

        // CloudFront
        const oac = new cloudfront.CfnOriginAccessControl(this, 'TenantOAC', {
            originAccessControlConfig: {
                name: 'saas-tenant-oac',
                originAccessControlOriginType: 's3',
                signingBehavior: 'always',
                signingProtocol: 'sigv4',
            },
        });

        const distribution = new cloudfront.CfnDistribution(this, 'MultiTenantDistribution', {
            distributionConfig: {
                enabled: true,
                comment: 'Multi-tenant distribution',
                origins: [
                    {
                        id: 'S3Origin',
                        domainName: tenantBucket.bucketRegionalDomainName,
                        originAccessControlId: oac.attrId,
                        s3OriginConfig: {},
                    },
                ],
                defaultCacheBehavior: {
                    targetOriginId: 'S3Origin',
                    viewerProtocolPolicy: 'redirect-to-https',
                    cachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
                    compress: true,
                    allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
                    cachedMethods: ['GET', 'HEAD'],
                },
                httpVersion: 'http2',
                ipv6Enabled: false,
            },
        });

        // Lambdas
        const provisionKeyspaceFn = new lambda.Function(this, 'ProvisionKeyspaceFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/provision_keyspace')),
            timeout: cdk.Duration.seconds(60),
            environment: {
                TENANTS_TABLE_NAME: tenantsTable.tableName,
                TENANT_SERVICES_BUCKET: tenantBucket.bucketName,
            },
        });
        tenantsTable.grantReadWriteData(provisionKeyspaceFn);
        tenantBucket.grantReadWrite(provisionKeyspaceFn);

        const configureTenantUrlFn = new lambda.Function(this, 'ConfigureTenantUrlFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/configure_tenant_url')),
            timeout: cdk.Duration.seconds(30),
            environment: {
                TENANTS_TABLE_NAME: tenantsTable.tableName,
                DISTRIBUTION_DOMAIN: distribution.attrDomainName,
            },
        });
        tenantsTable.grantReadWriteData(configureTenantUrlFn);

        const checkTenantContentFn = new lambda.Function(this, 'CheckTenantContentFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/check_tenant_content')),
            timeout: cdk.Duration.seconds(30),
            environment: {
                TENANT_SERVICES_BUCKET: tenantBucket.bucketName,
            },
        });
        tenantBucket.grantRead(checkTenantContentFn);

        const completeProvisioningFn = new lambda.Function(this, 'CompleteProvisioningFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/complete_provisioning')),
            timeout: cdk.Duration.seconds(30),
            environment: {
                TENANTS_TABLE_NAME: tenantsTable.tableName,
            },
        });
        tenantsTable.grantReadWriteData(completeProvisioningFn);

        // Step Functions workflow
        const definition = new tasks.LambdaInvoke(this, 'ProvisionTenantKeyspace', {
            lambdaFunction: provisionKeyspaceFn,
            outputPath: '$.Payload',
        }).next(new tasks.LambdaInvoke(this, 'ConfigureTenantUrl', {
            lambdaFunction: configureTenantUrlFn,
            outputPath: '$.Payload',
        })).next(new tasks.LambdaInvoke(this, 'CheckTenantContent', {
            lambdaFunction: checkTenantContentFn,
            outputPath: '$.Payload',
        })).next(new tasks.LambdaInvoke(this, 'CompleteProvisioning', {
            lambdaFunction: completeProvisioningFn,
            outputPath: '$.Payload',
        }));

        const stateMachine = new stepfunctions.StateMachine(this, 'TenantProvisioningWorkflow', {
            definition,
            timeout: cdk.Duration.minutes(15),
            tracingEnabled: true,
        });

        // Outputs
        StackUtils.exportStack(this, 'TenantsTableName', tenantsTable.tableName);
        StackUtils.exportStack(this, 'TenantServicesBucketName', tenantBucket.bucketName);
        StackUtils.exportStack(this, 'DistributionId', distribution.attrId);
        StackUtils.exportStack(this, 'DistributionDomainName', distribution.attrDomainName);
        StackUtils.exportStack(this, 'TenantProvisioningWorkflowArn', stateMachine.stateMachineArn);
    }
}
