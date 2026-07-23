import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: eventbridge_evbhx72k1
 *
 * Precondition for the health-eventbridge-csv-export task.
 *
 * Frugal split: pre-deploy bus + bucket + role. The agent creates the
 * Lambda, the EventBridge rule, and the wiring between them.
 *
 * Resources:
 *  - Custom EventBridge bus dedicated to AWS Health-style events.
 *  - S3 export bucket where the agent's Lambda writes each Health
 *    event's detail as a JSON object.
 *  - IAM role the agent attaches to its Lambda for Health API + S3 access.
 *
 * Outputs the agent reads:
 *  - EventBusName, ExportBucketName, HealthRoleName
 *
 * Outputs the verifier checks for (after the agent runs):
 *  - lambda_function_name, rule_name  -- declared by the agent in
 *    /logs/agent/agent-output.json (see task instruction).
 */
export class eventbridge_evbhx72k1 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const bus = new events.EventBus(this, 'HealthBus', {
            eventBusName: `health-events-${this.account.slice(-6)}`,
        });
        bus.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const exportBucket = new s3.Bucket(this, 'HealthExportBucket', {
            bucketName: `health-exports-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant the
        // bucket policy gives its exact role ARN. If that grant is stale or
        // gone at delete time, the handler fails its first call
        // (s3:GetBucketTagging) with AccessDenied, the stack delete
        // force-abandons this FIXED-NAME bucket, and every later deploy fails
        // changeset validation with "already exists" — an unrecoverable
        // reset->redeploy loop. Granting the role directly removes the
        // dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                exportBucket.bucketArn,
                `${exportBucket.bucketArn}/*`,
            ],
        });

        // Role the agent's Lambda assumes. Pre-scoped to Health + S3 write.
        const role = new iam.Role(this, 'HealthExportRole', {
            roleName: `health-export-role-${this.account.slice(-6)}`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AWSLambdaBasicExecutionRole',
                ),
            ],
        });
        role.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'health:DescribeEvents',
                    'health:DescribeEventDetails',
                    'health:DescribeAffectedEntities',
                ],
                resources: ['*'],
            }),
        );
        exportBucket.grantWrite(role);

        StackUtils.exportStack(this, 'EventBusName', bus.eventBusName, 'Custom Health event bus');
        StackUtils.exportStack(this, 'ExportBucketName', exportBucket.bucketName, 'S3 bucket for JSON exports');
        StackUtils.exportStack(this, 'HealthRoleName', role.roleName, 'IAM role for the agent Lambda');
    }
}
