import { Stack, StackProps } from 'aws-cdk-lib';
import { AccountPrincipal, Effect, IRole, ManagedPolicy, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Standard application IAM roles stack that creates the three roles
 * used by the application environment:
 *
 * - ApplicationReadOnlyRole  (read-only application role)
 * - ApplicationAdminRole (administrative application role)
 * - BedrockServiceAccessRole     (Bedrock service access role)
 *
 * Assumes one environment per account — role names are not env-scoped.
 */
export class AppRolesStack extends Stack {
    public readonly readonlyRole: IRole;
    public readonly adminRole: IRole;
    public readonly bedrockRole: IRole;

    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const accountId = this.account;

        // ── Custom policy: S3 Vectors read-only access ──
        const s3VectorsReadOnlyPolicy = new ManagedPolicy(this, 'S3VectorsReadOnlyAccess', {
            managedPolicyName: `S3VectorsReadOnlyAccess-${accountId}-${this.region}`,
            description: 'Read-only access to S3 Vectors operations',
            statements: [
                new PolicyStatement({
                    sid: 'AllowS3VectorsReadOnlyAccess',
                    effect: Effect.ALLOW,
                    actions: [
                        's3vectors:ListVectors',
                        's3vectors:GetVectors',
                        's3vectors:GetIndex',
                        's3vectors:GetVectorBucket',
                        's3vectors:GetVectorBucketPolicy',
                        's3vectors:ListIndexes',
                        's3vectors:ListTagsForResource',
                        's3vectors:ListVectorBuckets',
                        's3vectors:QueryVectors',
                    ],
                    resources: ['*'],
                }),
            ],
        });

        // ── ApplicationReadOnlyRole (read-only) ──
        this.readonlyRole = new Role(this, 'ApplicationReadOnlyRole', {
            roleName: 'ApplicationReadOnlyRole',
            assumedBy: new AccountPrincipal(accountId),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
                ManagedPolicy.fromAwsManagedPolicyName('AmazonS3TablesReadOnlyAccess'),
                ManagedPolicy.fromAwsManagedPolicyName('AmazonRedshiftFullAccess'),
                ManagedPolicy.fromAwsManagedPolicyName('AmazonAthenaFullAccess'),
                ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess'),
                s3VectorsReadOnlyPolicy,
            ],
        });

        // ── ApplicationAdminRole (administrative) ──
        this.adminRole = new Role(this, 'ApplicationAdminRole', {
            roleName: 'ApplicationAdminRole',
            assumedBy: new AccountPrincipal(accountId),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
                ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess'),
            ],
        });

        // ── BedrockServiceAccessRole (Bedrock access) ──
        this.bedrockRole = new Role(this, 'BedrockServiceAccessRole', {
            roleName: 'BedrockServiceAccessRole',
            assumedBy: new AccountPrincipal(accountId),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess'),
            ],
        });
    }
}
