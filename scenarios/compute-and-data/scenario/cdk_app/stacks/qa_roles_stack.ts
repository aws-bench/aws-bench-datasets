import { Stack, StackProps } from 'aws-cdk-lib';
import { AccountPrincipal, Effect, IRole, ManagedPolicy, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Generic QA roles stack that creates the three standard roles
 * used by aws-bench environments:
 *
 * - QALocalInvocationApplicationRole  (read-only agent role for introspection tasks)
 * - QALocalInvocationApplicationAdmin (admin agent role for mutation tasks)
 * - LLMJudgeFullBedrockAccessRole     (verifier role for LLM-based judging)
 *
 * Assumes one environment per account — role names are not env-scoped.
 */
export class QARolesStack extends Stack {
    public readonly readonlyRole: IRole;
    public readonly adminRole: IRole;
    public readonly judgeRole: IRole;

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

        // ── QALocalInvocationApplicationRole (read-only for introspection) ──
        this.readonlyRole = new Role(this, 'QALocalInvocationApplicationRole', {
            roleName: 'QALocalInvocationApplicationRole',
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

        // ── QALocalInvocationApplicationAdmin (admin for mutation) ──
        this.adminRole = new Role(this, 'QALocalInvocationApplicationAdmin', {
            roleName: 'QALocalInvocationApplicationAdmin',
            assumedBy: new AccountPrincipal(accountId),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
                ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess'),
            ],
        });

        // ── LLMJudgeFullBedrockAccessRole (verifier) ──
        this.judgeRole = new Role(this, 'LLMJudgeFullBedrockAccessRole', {
            roleName: 'LLMJudgeFullBedrockAccessRole',
            assumedBy: new AccountPrincipal(accountId),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess'),
            ],
        });
    }
}
