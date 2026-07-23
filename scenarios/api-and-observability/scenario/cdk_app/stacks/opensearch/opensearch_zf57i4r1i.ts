import * as cdk from 'aws-cdk-lib';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: opensearch-zf57i4r1i
 *
 * 6e78254b-c644-4c8c-ab17-f3d2a20714ad
 *
 * What the stack does:
 * 1. Creates an OpenSearch domain with audit logging enabled
 * 2. Creates CloudWatch Log Groups for audit, app, slow-index, and slow-search logs
 * 3. Creates Lambda indexer functions
 * 4. Creates IAM role for OpenSearch access
 */

export class Opensearch_zf57i4r1i extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const auditLogGroup = new logs.LogGroup(this, 'AuditLogGroup', {
            logGroupName: '/aws/opensearch/domains/flint-prod-iad/audit-logs',
            retention: logs.RetentionDays.TEN_YEARS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const appLogGroup = new logs.LogGroup(this, 'AppLogGroup', {
            logGroupName: 'app-opensearch-logs',
            retention: logs.RetentionDays.TEN_YEARS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const slowIndexLogGroup = new logs.LogGroup(this, 'SlowIndexLogGroup', {
            logGroupName: 'slow-index-opensearch-logs',
            retention: logs.RetentionDays.TEN_YEARS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const slowSearchLogGroup = new logs.LogGroup(this, 'SlowSearchLogGroup', {
            logGroupName: 'slow-search-opensearch-logs',
            retention: logs.RetentionDays.TEN_YEARS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const opensearchReadWriteRole = new iam.Role(this, 'OpenSearchReadWriteRole', {
            roleName: 'OpenSearchReadWriteRole',
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('lambda.amazonaws.com'),
                new iam.AccountPrincipal(this.account),
            ),
            description: 'IAM role used to access OpenSearch domain with read/write permissions',
        });

        const domain = new opensearch.Domain(this, 'FlintProdDomain', {
            domainName: 'flint-prod-iad',
            version: opensearch.EngineVersion.OPENSEARCH_2_11,
            capacity: {
                dataNodes: 1,
                dataNodeInstanceType: 't3.small.search',
            },
            ebs: {
                enabled: true,
                volumeSize: 10,
            },
            logging: {
                auditLogEnabled: true,
                auditLogGroup: auditLogGroup,
                appLogEnabled: true,
                appLogGroup: appLogGroup,
                slowIndexLogEnabled: true,
                slowIndexLogGroup: slowIndexLogGroup,
                slowSearchLogEnabled: true,
                slowSearchLogGroup: slowSearchLogGroup,
            },
            fineGrainedAccessControl: {
                masterUserArn: opensearchReadWriteRole.roleArn,
            },
            nodeToNodeEncryption: true,
            encryptionAtRest: {
                enabled: true,
            },
            enforceHttps: true,
            accessPolicies: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['es:*'],
                    principals: [opensearchReadWriteRole],
                    resources: ['*'],
                }),
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        opensearchReadWriteRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'es:ESHttpGet',
                    'es:ESHttpPut',
                    'es:ESHttpPost',
                    'es:ESHttpDelete',
                ],
                resources: [domain.domainArn, `${domain.domainArn}/*`],
            }),
        );

        const flintIndexerLogGroup = new logs.LogGroup(this, 'FlintIndexerLogGroup', {
            logGroupName: '/aws/lambda/FlintIndexerLambda',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const flintIndexerLambda = new lambda.Function(this, 'FlintIndexerLambda', {
            functionName: 'FlintIndexerLambda',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 });'),
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            environment: {
                OPENSEARCH_ENDPOINT: domain.domainEndpoint,
                INDEX_NAME: 'changesets',
            },
        });
        flintIndexerLambda.node.addDependency(flintIndexerLogGroup);

        const basaltFlintIndexerLogGroup = new logs.LogGroup(this, 'BasaltFlintIndexerLogGroup', {
            logGroupName: '/aws/lambda/BasaltFlintIndexerLambda',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const basaltFlintIndexerLambda = new lambda.Function(this, 'BasaltFlintIndexerLambda', {
            functionName: 'BasaltFlintIndexerLambda',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 });'),
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            environment: {
                OPENSEARCH_ENDPOINT: domain.domainEndpoint,
                INDEX_NAME: 'changesets',
            },
        });

        basaltFlintIndexerLambda.node.addDependency(basaltFlintIndexerLogGroup);

        domain.grantReadWrite(flintIndexerLambda);
        domain.grantReadWrite(basaltFlintIndexerLambda);

        StackUtils.exportStack(this, 'OpenSearchDomainName', domain.domainName, 'OpenSearch domain name');
        StackUtils.exportStack(this, 'OpenSearchDomainEndpoint', domain.domainEndpoint, 'OpenSearch domain endpoint');
        StackUtils.exportStack(this, 'OpenSearchDomainArn', domain.domainArn, 'OpenSearch domain ARN');
        StackUtils.exportStack(this, 'AuditLogGroupName', auditLogGroup.logGroupName, 'Audit log group name');
        StackUtils.exportStack(this, 'AuditLogGroupArn', auditLogGroup.logGroupArn, 'Audit log group ARN');
        StackUtils.exportStack(this, 'AppLogGroupName', appLogGroup.logGroupName, 'App log group name');
        StackUtils.exportStack(this, 'SlowIndexLogGroupName', slowIndexLogGroup.logGroupName, 'Slow index log group name');
        StackUtils.exportStack(this, 'SlowSearchLogGroupName', slowSearchLogGroup.logGroupName, 'Slow search log group name');
        StackUtils.exportStack(this, 'FlintIndexerLambdaName', flintIndexerLambda.functionName, 'Flint indexer Lambda name');
        StackUtils.exportStack(this, 'FlintIndexerLogGroupName', flintIndexerLogGroup.logGroupName, 'Flint indexer log group name');
        StackUtils.exportStack(this, 'BasaltFlintIndexerLambdaName', basaltFlintIndexerLambda.functionName, 'Basalt Flint indexer Lambda name');
        StackUtils.exportStack(this, 'BasaltFlintIndexerLogGroupName', basaltFlintIndexerLogGroup.logGroupName, 'Basalt Flint indexer log group name');
        StackUtils.exportStack(this, 'OpenSearchReadWriteRoleArn', opensearchReadWriteRole.roleArn, 'OpenSearch read/write role ARN');
    }
}
