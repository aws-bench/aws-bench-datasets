import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';
import * as crypto from 'crypto';

/*
 * Stack ID: cloudformation-t9dx4pgqw
 *
 * 15e80c96-2d86-43c3-bd40-9fab654ce67e
 *
 * What the stack does:
 * This stack replicates a troubleshooting scenario with CloudFormation stacks in failed states.
 * It creates:
 * 1. Two Lambda functions (SimpleEmailServiceLambda and GetDetectorOutcomeLambda)
 * 2. Lambda aliases pointing to current versions (will be broken by setup script)
 * 3. IAM roles for CloudFormation execution and Lambda execution
 * 4. CloudWatch Log Groups for Lambda functions
 * 5. S3 bucket for deployment artifacts
 *
 * IMPORTANT: This is a troubleshooting scenario - broken states are intentional.
 * The setup script will trigger a CloudFormation UPDATE that modifies the aliases to point
 * to non-existent versions, causing the stack to enter UPDATE_ROLLBACK_FAILED state.
 */

export class Cloudformation_t9dx4pgqw extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Helper function to generate short role names (max 64 chars)
        const generateRoleName = (prefix: string, functionName: string): string => {
            const hashInput = `${this.account}-${this.region}-t9dx4pgqw-${functionName}`;
            const hash = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 12);

            const truncatedFunction = functionName.substring(0, 25);
            const roleName = `${prefix}-${truncatedFunction}-${hash}`;

            if (roleName.length > 64) {
                const maxFunctionLength = 64 - prefix.length - hash.length - 2;
                const shorterFunction = functionName.substring(0, maxFunctionLength);
                return `${prefix}-${shorterFunction}-${hash}`;
            }

            return roleName;
        };

        // Create S3 bucket for deployment artifacts
        const deploymentBucket = new s3.Bucket(this, 'DeploymentBucket', {
            bucketName: `deploymentbucket-${this.account}-${this.region}-t9dx4pgqw`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

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
                deploymentBucket.bucketArn,
                `${deploymentBucket.bucketArn}/*`,
            ],
        });

        // Create IAM role for CloudFormation execution
        const cfnRoleHash = crypto
            .createHash('sha256')
            .update(`${this.account}-${this.region}-t9dx4pgqw-cfn`)
            .digest('hex')
            .substring(0, 40);
        const cfnExecutionRole = new iam.Role(this, 'PipelinesChangeSetExecRole', {
            roleName: `PipelinesChangeSetExec-${cfnRoleHash}`,
            assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
        });

        // Create IAM role for SimpleEmailServiceLambda
        const simpleEmailServiceRole = new iam.Role(this, 'SimpleEmailServiceLambdaRole', {
            roleName: generateRoleName('AppServiceLambda-prod', 'SimpleEmailServiceLambdaE'),
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
            ],
        });

        // Create IAM role for GetDetectorOutcomeLambda
        const getDetectorOutcomeRole = new iam.Role(this, 'GetDetectorOutcomeLambdaRole', {
            roleName: generateRoleName('AppServiceLambda-prod', 'GetDetectorOutcomeLambdaExec'),
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
            ],
        });

        // Create CloudWatch Log Group for SimpleEmailServiceLambda
        const simpleEmailServiceLogGroup = new logs.LogGroup(this, 'SimpleEmailServiceLogGroup', {
            logGroupName: `AppService-prod-us-east-1-SimpleEmailServiceLambda-LogGroup-${this.account}-${this.region}-t9dx4pgqw`,
            retention: logs.RetentionDays.TEN_YEARS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create CloudWatch Log Group for GetDetectorOutcomeLambda
        const getDetectorOutcomeLogGroup = new logs.LogGroup(this, 'GetDetectorOutcomeLogGroup', {
            logGroupName: `AppService-prod-us-east-1-GetDetectorOutcomeLambda-LogGroup-${this.account}-${this.region}-t9dx4pgqw`,
            retention: logs.RetentionDays.TEN_YEARS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create SimpleEmailServiceLambda function
        // Lambda function business logic not captured in trace — stub only
        // Note: Schema specifies Java11 runtime, but using Python for deployable stub
        const simpleEmailServiceLambda = new lambda.Function(this, 'SimpleEmailServiceLambda', {
            functionName: `SimpleEmailServiceLambda-${this.account}-${this.region}-t9dx4pgqw`,
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
def handler(event, context):
    # Lambda function business logic not captured in trace — stub only
    return {
        'statusCode': 200,
        'body': 'success'
    }
            `),
            role: simpleEmailServiceRole,
            memorySize: 1024,
            timeout: cdk.Duration.seconds(900),
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                ENGINE_ENDPOINT: 'https://engine-api.internal/Engine-APIGateway',
                STS_ENDPOINT: 'sts.us-east-1.amazonaws.com',
                domain: 'prod',
                SQS_ENDPOINT: 'sqs.us-east-1.amazonaws.com',
                PARTITION: 'aws',
                region: 'us-east-1',
                version: '1764962361325',
                REGION_STATUS: 'active',
            },
            logGroup: simpleEmailServiceLogGroup,
        });

        // Create GetDetectorOutcomeLambda function
        // Lambda function business logic not captured in trace — stub only
        // Note: Schema specifies Java11 runtime, but using Python for deployable stub
        const getDetectorOutcomeLambda = new lambda.Function(this, 'GetDetectorOutcomeLambda', {
            functionName: `GetDetectorOutcomeLambda-${this.account}-${this.region}-t9dx4pgqw`,
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
def handler(event, context):
    # Lambda function business logic not captured in trace — stub only
    return {
        'statusCode': 200,
        'body': 'success'
    }
            `),
            role: getDetectorOutcomeRole,
            memorySize: 1024,
            timeout: cdk.Duration.seconds(900),
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                ENGINE_ENDPOINT: 'https://engine-api.internal/Engine-APIGateway',
                STS_ENDPOINT: 'sts.us-east-1.amazonaws.com',
                domain: 'prod',
                SQS_ENDPOINT: 'sqs.us-east-1.amazonaws.com',
                PARTITION: 'aws',
                region: 'us-east-1',
                version: '1764962361401',
                REGION_STATUS: 'active',
            },
            logGroup: getDetectorOutcomeLogGroup,
        });

        // Create Lambda aliases pointing to current versions
        // These will be updated by the setup script to point to non-existent versions via CloudFormation UPDATE
        const simpleEmailServiceAlias = new lambda.Alias(this, 'SimpleEmailServiceLambdaAlias', {
            aliasName: 'LATEST',
            version: simpleEmailServiceLambda.currentVersion,
        });

        const getDetectorOutcomeAlias = new lambda.Alias(this, 'GetDetectorOutcomeLambdaAlias', {
            aliasName: 'LATEST',
            version: getDetectorOutcomeLambda.currentVersion,
        });

        // Add stack metadata to simulate CloudFormation stack states
        this.templateOptions.description =
            'CloudFormation stacks with Lambda alias deployments';

        // Export stack outputs
        StackUtils.exportStack(
            this,
            'DeploymentBucketName',
            deploymentBucket.bucketName,
            'S3 bucket for deployment artifacts',
        );
        StackUtils.exportStack(
            this,
            'SimpleEmailServiceLambdaArn',
            simpleEmailServiceLambda.functionArn,
            'ARN of SimpleEmailServiceLambda function',
        );
        StackUtils.exportStack(
            this,
            'GetDetectorOutcomeLambdaArn',
            getDetectorOutcomeLambda.functionArn,
            'ARN of GetDetectorOutcomeLambda function',
        );
        StackUtils.exportStack(
            this,
            'SimpleEmailServiceLambdaAliasArn',
            simpleEmailServiceAlias.functionArn,
            'ARN of SimpleEmailServiceLambda LATEST alias',
        );
        StackUtils.exportStack(
            this,
            'GetDetectorOutcomeLambdaAliasArn',
            getDetectorOutcomeAlias.functionArn,
            'ARN of GetDetectorOutcomeLambda LATEST alias',
        );
        StackUtils.exportStack(
            this,
            'SimpleEmailServiceLambdaAliasLogicalId',
            this.getLogicalId(simpleEmailServiceAlias.node.defaultChild as cdk.CfnResource),
            'CloudFormation logical ID of SimpleEmailServiceLambdaAlias',
        );
        StackUtils.exportStack(
            this,
            'GetDetectorOutcomeLambdaAliasLogicalId',
            this.getLogicalId(getDetectorOutcomeAlias.node.defaultChild as cdk.CfnResource),
            'CloudFormation logical ID of GetDetectorOutcomeLambdaAlias',
        );
        StackUtils.exportStack(
            this,
            'CloudFormationExecutionRoleArn',
            cfnExecutionRole.roleArn,
            'IAM role for CloudFormation execution',
        );
        StackUtils.exportStack(
            this,
            'SimpleEmailServiceLambdaName',
            simpleEmailServiceLambda.functionName,
            'Name of SimpleEmailServiceLambda function',
        );
        StackUtils.exportStack(
            this,
            'GetDetectorOutcomeLambdaName',
            getDetectorOutcomeLambda.functionName,
            'Name of GetDetectorOutcomeLambda function',
        );
    }
}
