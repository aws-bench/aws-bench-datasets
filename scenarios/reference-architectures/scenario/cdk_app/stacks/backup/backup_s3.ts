import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Backup S3 Stack
 *
 * Converted from aws-cdk-examples/typescript/backup-s3
 *
 * Creates:
 * 1. S3 Bucket with versioning enabled and daily-backup tag
 * 2. AWS Backup Vault
 * 3. AWS Backup Plan with daily backup rule (35-day retention)
 * 4. IAM Role for Backup service with S3, KMS, and EventBridge permissions
 * 5. Backup Selection targeting resources tagged daily-backup=true
 */

export class BackupS3Stack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // S3 Bucket
        const bucket = new s3.Bucket(this, 'BackupBucket', {
            bucketName: `backup-s3-bucket-${this.account}-${this.region}`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Tag bucket for backup selection
        cdk.Tags.of(bucket).add('daily-backup', 'true');

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant the bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons this FIXED-NAME
        // bucket, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                bucket.bucketArn,
                `${bucket.bucketArn}/*`,
            ],
        });

        // Backup Vault
        const vault = new backup.BackupVault(this, 'BackupVault', {
            backupVaultName: `s3-backup-vault-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Backup Plan
        const plan = new backup.BackupPlan(this, 'BackupPlan', {
            backupPlanName: `s3-daily-backup-plan-${this.account}-${this.region}`,
            backupPlanRules: [
                new backup.BackupPlanRule({
                    ruleName: 'DailyBackupRule',
                    backupVault: vault,
                    deleteAfter: cdk.Duration.days(35),
                    scheduleExpression: cdk.aws_events.Schedule.expression('cron(0 0 * * ? *)'),
                }),
            ],
        });

        // IAM Role for Backup service
        const backupRole = new iam.Role(this, 'BackupRole', {
            assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AWSBackupServiceRolePolicyForS3Backup'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AWSBackupServiceRolePolicyForS3Restore'),
            ],
        });

        // Additional permissions for KMS and EventBridge
        backupRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'kms:Decrypt',
                    'kms:DescribeKey',
                    'kms:GenerateDataKey',
                ],
                resources: ['*'],
            }),
        );

        backupRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'events:DescribeRule',
                    'events:EnableRule',
                    'events:PutRule',
                    'events:DeleteRule',
                    'events:PutTargets',
                    'events:RemoveTargets',
                    'events:ListTargetsByRule',
                    'events:DisableRule',
                ],
                resources: [`arn:aws:events:${this.region}:${this.account}:rule/AwsBackupManagedRule*`],
            }),
        );

        // Backup Selection targeting tag daily-backup=true
        plan.addSelection('TagSelection', {
            backupSelectionName: `s3-backup-selection-${this.account}-${this.region}`,
            role: backupRole,
            resources: [
                backup.BackupResource.fromTag('daily-backup', 'true'),
            ],
        });

        // Exports
        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'S3 bucket name for backup');
        StackUtils.exportStack(this, 'BucketArn', bucket.bucketArn, 'S3 bucket ARN');
        StackUtils.exportStack(this, 'BackupVaultName', vault.backupVaultName, 'Backup vault name');
        StackUtils.exportStack(this, 'BackupVaultArn', vault.backupVaultArn, 'Backup vault ARN');
        StackUtils.exportStack(this, 'BackupPlanId', plan.backupPlanId, 'Backup plan ID');
        StackUtils.exportStack(this, 'BackupPlanArn', plan.backupPlanArn, 'Backup plan ARN');
        StackUtils.exportStack(this, 'RetentionDays', '35', 'Backup retention period in days');
        StackUtils.exportStack(this, 'BackupSelectionTag', 'daily-backup=true', 'Tag used for backup selection');
    }
}
