import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { StackUtils } from '../lib/shared';

/**
 * acme-corp CI/CD platform.
 *
 * GitHub Actions workflows for the acme-corp organisation execute on CodeBuild-hosted
 * self-hosted runners.  Inside each job `aws-actions/configure-aws-credentials` exchanges
 * the GitHub OIDC id_token for AWS credentials on the shared deploy role via
 * sts:AssumeRoleWithWebIdentity.
 */

/* ------------------------------------------------------------------ *
 * Captured OIDC id_token claim sets (archived by the CI team for debugging)
 * ------------------------------------------------------------------ */

function b64url(value: object): string {
    return Buffer.from(JSON.stringify(value))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

const JWT_HEADER = { typ: 'JWT', alg: 'RS256', x5t: 'Ai8i-3XkLNRA', kid: 'Ai8i-3XkLNRA' };
const JWT_SIGNATURE =
    'sIgNaTuReRedactedByRunnerLogMasking-CapturedForDebuggingOnly-DoNotReplay';

function capturedToken(payload: Record<string, unknown>): string {
    return `${b64url(JWT_HEADER)}.${b64url(payload)}.${JWT_SIGNATURE}`;
}

// payments-api was created after GitHub switched new repositories to immutable
// organisation/repository id subjects.
const PAYMENTS_API_CLAIMS: Record<string, unknown> = {
    jti: '5b3d1f9e-6a17-4f0a-9c22-7d4b1e9a3f01',
    sub: 'repo:acme-corp@1042/payments-api@88317:ref:refs/heads/main',
    aud: 'token.actions.githubusercontent.com',
    iss: 'https://token.actions.githubusercontent.com',
    repository: 'acme-corp@1042/payments-api@88317',
    repository_owner: 'acme-corp@1042',
    repository_id: '88317',
    repository_owner_id: '1042',
    repository_visibility: 'private',
    ref: 'refs/heads/main',
    ref_type: 'branch',
    ref_protected: 'true',
    sha: '9a1f6c04c0f1b1b5f6d3d9d70a4b3e8f2c7d5a11',
    actor: 'ci-bot-acme',
    actor_id: '77219',
    event_name: 'push',
    environment: 'production',
    workflow: 'deploy-production',
    workflow_ref:
        'acme-corp@1042/payments-api@88317/.github/workflows/deploy.yml@refs/heads/main',
    workflow_sha: '9a1f6c04c0f1b1b5f6d3d9d70a4b3e8f2c7d5a11',
    job_workflow_ref:
        'acme-corp@1042/payments-api@88317/.github/workflows/deploy.yml@refs/heads/main',
    job_workflow_sha: '9a1f6c04c0f1b1b5f6d3d9d70a4b3e8f2c7d5a11',
    runner_environment: 'self-hosted',
    run_id: '4471',
    run_number: '112',
    run_attempt: '1',
};

// Per-invocation claims, which a stored *template* must not carry: a template is
// what the runner fills in to mint each token.
const PER_INVOCATION_CLAIMS = ['jti', 'run_id', 'run_number', 'run_attempt'];

const PAYMENTS_API_CLAIMS_TEMPLATE: Record<string, unknown> = Object.fromEntries(
    Object.entries(PAYMENTS_API_CLAIMS).filter(([key]) => !PER_INVOCATION_CLAIMS.includes(key)),
);

// legacy-service predates the immutable-id rollout, GitHub keeps issuing slug subjects.
const LEGACY_SERVICE_CLAIMS: Record<string, unknown> = {
    jti: 'c2c8a2c1-1f34-4b0e-8b3f-6d1f2a9c4b77',
    sub: 'repo:acme-corp/legacy-service:ref:refs/heads/main',
    aud: 'token.actions.githubusercontent.com',
    iss: 'https://token.actions.githubusercontent.com',
    repository: 'acme-corp/legacy-service',
    repository_owner: 'acme-corp',
    repository_id: '41207',
    repository_owner_id: '1042',
    repository_visibility: 'private',
    ref: 'refs/heads/main',
    ref_type: 'branch',
    ref_protected: 'true',
    sha: '4c2b7de91f0a8c3d5e6f7a8b9c0d1e2f3a4b5c6d',
    actor: 'ci-bot-acme',
    actor_id: '77219',
    event_name: 'push',
    environment: 'production',
    workflow: 'deploy-production',
    workflow_ref:
        'acme-corp/legacy-service/.github/workflows/deploy.yml@refs/heads/main',
    workflow_sha: '4c2b7de91f0a8c3d5e6f7a8b9c0d1e2f3a4b5c6d',
    job_workflow_ref:
        'acme-corp/legacy-service/.github/workflows/deploy.yml@refs/heads/main',
    job_workflow_sha: '4c2b7de91f0a8c3d5e6f7a8b9c0d1e2f3a4b5c6d',
    runner_environment: 'self-hosted',
    run_id: '8812',
    run_number: '907',
    run_attempt: '1',
};

// notifications-svc is a post-rollout repository federating through its own deploy role
// (correctly configured).
const NOTIFICATIONS_SVC_CLAIMS: Record<string, unknown> = {
    jti: '2a7f5eaf-4d33-4a58-b6bc-8f0e12345abc',
    sub: 'repo:acme-corp@1042/notifications-svc@91228:ref:refs/heads/main',
    aud: 'token.actions.githubusercontent.com',
    iss: 'https://token.actions.githubusercontent.com',
    repository: 'acme-corp@1042/notifications-svc@91228',
    repository_owner: 'acme-corp@1042',
    repository_id: '91228',
    repository_owner_id: '1042',
    repository_visibility: 'private',
    ref: 'refs/heads/main',
    ref_type: 'branch',
    ref_protected: 'true',
    sha: '2b6f9d3e0c7a1b4e5d8f7a0c3e2d1b4f5e6a7d9c',
    actor: 'ci-bot-acme',
    actor_id: '77219',
    event_name: 'push',
    environment: 'production',
    workflow: 'deploy-production',
    workflow_ref:
        'acme-corp@1042/notifications-svc@91228/.github/workflows/deploy.yml@refs/heads/main',
    workflow_sha: '2b6f9d3e0c7a1b4e5d8f7a0c3e2d1b4f5e6a7d9c',
    job_workflow_ref:
        'acme-corp@1042/notifications-svc@91228/.github/workflows/deploy.yml@refs/heads/main',
    job_workflow_sha: '2b6f9d3e0c7a1b4e5d8f7a0c3e2d1b4f5e6a7d9c',
    runner_environment: 'self-hosted',
    run_id: '5290',
    run_number: '73',
    run_attempt: '1',
};

// payments-api-staging is also a post-rollout repository and its (separate) staging role
// was configured correctly.
const PAYMENTS_STAGING_CLAIMS: Record<string, unknown> = {
    jti: 'f0a91b7c-2d55-4c8a-9e1b-3a5c7d9f0b22',
    sub: 'repo:acme-corp@1042/payments-api-staging@88931:ref:refs/heads/main',
    aud: 'token.actions.githubusercontent.com',
    iss: 'https://token.actions.githubusercontent.com',
    repository: 'acme-corp@1042/payments-api-staging@88931',
    repository_owner: 'acme-corp@1042',
    repository_id: '88931',
    repository_owner_id: '1042',
    repository_visibility: 'private',
    ref: 'refs/heads/main',
    ref_type: 'branch',
    ref_protected: 'false',
    sha: '1d4e7f0a3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e',
    actor: 'ci-bot-acme',
    actor_id: '77219',
    event_name: 'push',
    environment: 'staging',
    workflow: 'deploy-staging',
    workflow_ref:
        'acme-corp@1042/payments-api-staging@88931/.github/workflows/deploy.yml@refs/heads/main',
    workflow_sha: '1d4e7f0a3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e',
    job_workflow_ref:
        'acme-corp@1042/payments-api-staging@88931/.github/workflows/deploy.yml@refs/heads/main',
    job_workflow_sha: '1d4e7f0a3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e',
    runner_environment: 'self-hosted',
    run_id: '311',
    run_number: '58',
    run_attempt: '1',
};

/* ------------------------------------------------------------------ *
 * Shared buildspec fragments
 * ------------------------------------------------------------------ */

const REPLAY_ARCHIVED_LOG: string[] = [
    'echo "[runner] ---------- archived GitHub Actions job log ----------"',
    'aws s3 cp "s3://$ARTIFACT_BUCKET/$RUN_LOG_KEY" /tmp/run.log --quiet && cat /tmp/run.log || echo "[runner] archived job log unavailable"',
    'echo "[runner] ---------- end archived job log ----------"',
];

/**
 * Freshly mint an id_token JWT during this build and stash it in the CI artifact
 * bucket at an obfuscated random key under `gha-tokens/`. Claim template is
 * fetched from a runner-config SSM parameter so the buildspec itself does not
 * carry the claim set. Nothing about the token itself, its key, or its claim
 * schema is echoed to CloudWatch.
 */
function mintFreshTokenCommands(claimsTemplatePath: string, s3Prefix: string): string[] {
    return [
        `CLAIMS_TEMPLATE=$(aws ssm get-parameter --name "${claimsTemplatePath}" --with-decryption --query Parameter.Value --output text)`,
        'FRESH=$(python3 -c "import json,sys,time,uuid; c=json.loads(sys.argv[1]); now=int(time.time()); c[\'iat\']=now; c[\'nbf\']=now-30; c[\'exp\']=now+300; c[\'jti\']=str(uuid.uuid4()); print(json.dumps(c,separators=(\',\',\':\')))" "$CLAIMS_TEMPLATE")',
        'HDR=$(python3 -c "import base64; print(base64.urlsafe_b64encode(b\'{\\"typ\\":\\"JWT\\",\\"alg\\":\\"RS256\\",\\"x5t\\":\\"Ai8i-3XkLNRA\\",\\"kid\\":\\"Ai8i-3XkLNRA\\"}\').decode().rstrip(\'=\'))")',
        'PL=$(python3 -c "import base64,sys; print(base64.urlsafe_b64encode(sys.argv[1].encode()).decode().rstrip(\'=\'))" "$FRESH")',
        'TOK="$HDR.$PL.sIgNaTuReRedactedByRunnerLogMasking-CapturedForDebuggingOnly-DoNotReplay"',
        'SUFFIX=$(python3 -c "import secrets; print(secrets.token_hex(8))")',
        `KEY="${s3Prefix}build-\${CODEBUILD_BUILD_NUMBER:-0}-\${SUFFIX}/id_token.b64"`,
        'printf "%s" "$TOK" | aws s3 cp - "s3://$ARTIFACT_BUCKET/$KEY" --quiet',
        'unset TOK FRESH CLAIMS_TEMPLATE HDR PL',
        'echo "[runner] id_token stashed to artifacts bucket for platform team review"',
    ];
}

export interface CicdOidcStackProps extends cdk.StackProps {}

export class CicdOidcStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: CicdOidcStackProps) {
        super(scope, id, props);

        const artifactBucketName = `acme-ci-artifacts-${cdk.Aws.ACCOUNT_ID}`;
        const deployRoleName = 'acme-ci-github-deploy-role';
        const stagingRoleName = 'acme-ci-github-deploy-role-staging';
        const auditRoleName = 'acme-ci-github-audit-readonly-role';
        const notificationsRoleName = 'acme-ci-github-deploy-role-notifications';
        const orchestratorRoleName = 'acme-deploy-orchestrator-role';
        const orchestratorFunctionName = 'acme-deploy-orchestrator';
        const runnerRoleName = 'acme-ci-codebuild-runner-role';
        const deployPolicyName = 'acme-ci-deploy-permissions';
        const failingProjectName = 'payments-api-gha-runner';
        const workingProjectName = 'legacy-service-gha-runner';
        const stagingProjectName = 'payments-api-staging-gha-runner';
        const notificationsProjectName = 'acme-notifications-svc-gha-runner';
        const alarmName = 'acme-ci-payments-api-deploy-failures';
        const topicName = 'acme-ci-alerts';
        const ecrRepositoryName = 'acme/payments-api';

        // Captured id_token parameters for the (correctly configured) sibling runners live
        // under an opaque observability prefix.
        // NOTE: no `paymentsTokenParam` here on purpose - the payments-api runner mints its
        // token freshly each build and stashes it in the artifact bucket (see `gha-tokens/`).
        const legacyTokenParam = '/acme/platform/observability/tokens/e1b28c4d9a30f5c6';
        const stagingTokenParam = '/acme/platform/observability/tokens/c40b7f83519ae62d';
        const notificationsTokenParam = '/acme/platform/observability/tokens/9d0e5a3f2b681c47';

        // Claim-set template for the payments-api runner: raw JSON, not a captured JWT.
        const paymentsClaimsTemplateParam = '/acme/platform/observability/tokens/f5a3b7c1e8d24069';
        // Prefix under which every payments-api runner build stashes its freshly minted token.
        const paymentsTokenS3Prefix = 'gha-tokens/';

        const paymentsRunLogKey = 'ci-runs/payments-api/run-4471/deploy-production.log';
        const legacyRunLogKey = 'ci-runs/legacy-service/run-8812/deploy-production.log';
        const stagingRunLogKey = 'ci-runs/payments-api-staging/run-311/deploy-staging.log';
        const notificationsRunLogKey = 'ci-runs/notifications-svc/run-5290/deploy-production.log';

        const oidcProviderArn = `arn:${this.partition}:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;

        /* ---------------- artifact storage ---------------- */

        const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
            bucketName: artifactBucketName,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Container registry the payments-api deploy job pushes to. It is empty because
        // every payments-api deploy has failed before reaching the push step.
        const ecrRepo = new ecr.Repository(this, 'PaymentsApiRepo', {
            repositoryName: ecrRepositoryName,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
            imageScanOnPush: false,
        });

        /* ---------------- OIDC identity provider ---------------- */

        const oidcProvider = new iam.CfnOIDCProvider(this, 'GitHubOidcProvider', {
            url: 'https://token.actions.githubusercontent.com',
            clientIdList: ['sts.amazonaws.com', 'token.actions.githubusercontent.com'],
            thumbprintList: [
                '6938fd4d98bab03faadb97b34396831e3780aea1',
                '1c58a3a8518e8759bf075b76b750d4f2df264fcd',
            ],
        });

        /* ---------------- orchestrator (non-OIDC consumer of the deploy role) ---------------- */

        const orchestratorRole = new iam.Role(this, 'OrchestratorRole', {
            roleName: orchestratorRoleName,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Execution role for the acme deploy orchestrator lambda',
        });

        /* ---------------- shared GitHub Actions deploy role ---------------- */

        const deployRole = new iam.Role(this, 'DeployRole', {
            roleName: deployRoleName,
            assumedBy: new iam.ArnPrincipal(orchestratorRole.roleArn),
            maxSessionDuration: cdk.Duration.hours(1),
            description:
                'Shared deploy role assumed by acme-corp GitHub Actions workflows via OIDC federation',
        });

        const trustPolicyDocument = {
            Version: '2012-10-17',
            Statement: [
                {
                    Sid: 'AllowDeployOrchestratorAssume',
                    Effect: 'Allow',
                    Principal: {
                        AWS: `arn:${this.partition}:iam::${this.account}:role/${orchestratorRoleName}`,
                    },
                    Action: 'sts:AssumeRole',
                },
                {
                    // legacy-service was onboarded before the org standardised on
                    // sub-based federation, so its statement pins the numeric
                    // repository_id / repository_owner_id from the id_token and
                    // gates on job_workflow_ref (not sub). AWS IAM requires
                    // every OIDC federation statement to constrain sub or
                    // job_workflow_ref, so we use the latter here.
                    Sid: 'GitHubActionsLegacyServiceByRepositoryId',
                    Effect: 'Allow',
                    Principal: { Federated: oidcProviderArn },
                    Action: 'sts:AssumeRoleWithWebIdentity',
                    Condition: {
                        StringEquals: {
                            'token.actions.githubusercontent.com:aud':
                                'token.actions.githubusercontent.com',
                            'token.actions.githubusercontent.com:repository_id': '41207',
                            'token.actions.githubusercontent.com:repository_owner_id': '1042',
                        },
                        StringLike: {
                            'token.actions.githubusercontent.com:job_workflow_ref': [
                                'acme-corp/legacy-service/.github/workflows/*',
                            ],
                        },
                    },
                },
                {
                    Sid: 'GitHubActionsPaymentsApi',
                    Effect: 'Allow',
                    Principal: { Federated: oidcProviderArn },
                    Action: 'sts:AssumeRoleWithWebIdentity',
                    Condition: {
                        StringLike: {
                            // intentional: broken by design - slug-format subject pattern; the
                            // payments-api repository presents an immutable-id subject.
                            'token.actions.githubusercontent.com:sub': [
                                'repo:acme-corp/payments-api:*',
                            ],
                        },
                        StringEquals: {
                            // intentional: broken by design - the workflow requests audience
                            // token.actions.githubusercontent.com, not sts.amazonaws.com.
                            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                        },
                    },
                },
            ],
        };
        const deployRoleCfn = deployRole.node.defaultChild as iam.CfnRole;
        deployRoleCfn.addPropertyOverride('AssumeRolePolicyDocument', trustPolicyDocument);
        deployRoleCfn.addDependency(oidcProvider);
        // the raw trust document names the orchestrator role ARN as a literal principal, so the
        // ref-based dependency CDK would normally infer is gone - add it back explicitly.
        deployRoleCfn.addDependency(orchestratorRole.node.defaultChild as iam.CfnRole);

        const deployPermissions = new iam.Policy(this, 'DeployPermissions', {
            policyName: deployPolicyName,
            statements: [
                new iam.PolicyStatement({
                    sid: 'PublishDeployArtifacts',
                    actions: ['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload'],
                    resources: [`${artifactBucket.bucketArn}/deploy/*`],
                }),
                new iam.PolicyStatement({
                    sid: 'ListDeployArtifacts',
                    actions: ['s3:ListBucket'],
                    resources: [artifactBucket.bucketArn],
                    conditions: { StringLike: { 's3:prefix': ['deploy/*'] } },
                }),
                new iam.PolicyStatement({
                    sid: 'EcrAuth',
                    actions: ['ecr:GetAuthorizationToken'],
                    resources: ['*'],
                }),
                new iam.PolicyStatement({
                    sid: 'EcrPush',
                    actions: [
                        'ecr:BatchCheckLayerAvailability',
                        'ecr:InitiateLayerUpload',
                        'ecr:UploadLayerPart',
                        'ecr:CompleteLayerUpload',
                        'ecr:PutImage',
                    ],
                    resources: [ecrRepo.repositoryArn],
                }),
                new iam.PolicyStatement({
                    sid: 'ReadAppConfig',
                    actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
                    resources: [
                        `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/acme/app/payments-api/*`,
                    ],
                }),
            ],
        });
        deployRole.attachInlinePolicy(deployPermissions);

        /* ---------------- sibling deploy roles (correctly configured) ---------------- */

        const stagingRole = new iam.Role(this, 'StagingDeployRole', {
            roleName: stagingRoleName,
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
            description:
                'Deploy role for acme-corp/payments-api-staging GitHub Actions workflows',
        });
        const stagingRoleCfn = stagingRole.node.defaultChild as iam.CfnRole;
        stagingRoleCfn.addPropertyOverride('AssumeRolePolicyDocument', {
            Version: '2012-10-17',
            Statement: [
                {
                    Sid: 'GitHubActionsPaymentsApiStaging',
                    Effect: 'Allow',
                    Principal: { Federated: oidcProviderArn },
                    Action: 'sts:AssumeRoleWithWebIdentity',
                    Condition: {
                        StringLike: {
                            'token.actions.githubusercontent.com:sub': [
                                'repo:acme-corp@1042/payments-api-staging@88931:*',
                            ],
                        },
                        StringEquals: {
                            'token.actions.githubusercontent.com:aud':
                                'token.actions.githubusercontent.com',
                        },
                    },
                },
            ],
        });
        stagingRoleCfn.addDependency(oidcProvider);
        stagingRole.attachInlinePolicy(
            new iam.Policy(this, 'StagingPermissions', {
                policyName: 'acme-ci-staging-deploy-permissions',
                statements: [
                    new iam.PolicyStatement({
                        actions: ['s3:PutObject', 's3:GetObject'],
                        resources: [`${artifactBucket.bucketArn}/deploy/payments-api-staging/*`],
                    }),
                ],
            }),
        );

        const auditRole = new iam.Role(this, 'AuditReadonlyRole', {
            roleName: auditRoleName,
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
            description:
                'Read-only role used by the acme-corp/ci-audit workflows via OIDC federation',
        });
        const auditRoleCfn = auditRole.node.defaultChild as iam.CfnRole;
        auditRoleCfn.addPropertyOverride('AssumeRolePolicyDocument', {
            Version: '2012-10-17',
            Statement: [
                {
                    Sid: 'GitHubActionsAuditByRepositoryId',
                    Effect: 'Allow',
                    Principal: { Federated: oidcProviderArn },
                    Action: 'sts:AssumeRoleWithWebIdentity',
                    Condition: {
                        StringLike: {
                            'token.actions.githubusercontent.com:sub': [
                                'repo:acme-corp@1042/internal-tools@77104:*',
                            ],
                        },
                        StringEquals: {
                            'token.actions.githubusercontent.com:aud':
                                'token.actions.githubusercontent.com',
                            'token.actions.githubusercontent.com:repository_owner_id': '1042',
                            'token.actions.githubusercontent.com:repository_id': '77104',
                        },
                    },
                },
            ],
        });
        auditRoleCfn.addDependency(oidcProvider);
        auditRole.attachInlinePolicy(
            new iam.Policy(this, 'AuditPermissions', {
                policyName: 'acme-ci-audit-readonly-permissions',
                statements: [
                    new iam.PolicyStatement({
                        actions: ['s3:ListBucket', 's3:GetObject'],
                        resources: [artifactBucket.bucketArn, `${artifactBucket.bucketArn}/ci-runs/*`],
                    }),
                    new iam.PolicyStatement({
                        actions: ['codebuild:BatchGetProjects', 'codebuild:ListBuildsForProject'],
                        resources: [
                            `arn:${this.partition}:codebuild:${this.region}:${this.account}:project/*`,
                        ],
                    }),
                ],
            }),
        );

        // Fourth CI-federated repository - post-rollout, correctly configured.
        const notificationsRole = new iam.Role(this, 'NotificationsDeployRole', {
            roleName: notificationsRoleName,
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
            description:
                'Deploy role for acme-corp/notifications-svc GitHub Actions workflows',
        });
        const notificationsRoleCfn = notificationsRole.node.defaultChild as iam.CfnRole;
        notificationsRoleCfn.addPropertyOverride('AssumeRolePolicyDocument', {
            Version: '2012-10-17',
            Statement: [
                {
                    Sid: 'GitHubActionsNotificationsSvc',
                    Effect: 'Allow',
                    Principal: { Federated: oidcProviderArn },
                    Action: 'sts:AssumeRoleWithWebIdentity',
                    Condition: {
                        StringLike: {
                            'token.actions.githubusercontent.com:sub': [
                                'repo:acme-corp@1042/notifications-svc@91228:*',
                            ],
                        },
                        StringEquals: {
                            'token.actions.githubusercontent.com:aud':
                                'token.actions.githubusercontent.com',
                        },
                    },
                },
            ],
        });
        notificationsRoleCfn.addDependency(oidcProvider);
        notificationsRole.attachInlinePolicy(
            new iam.Policy(this, 'NotificationsPermissions', {
                policyName: 'acme-ci-notifications-deploy-permissions',
                statements: [
                    new iam.PolicyStatement({
                        actions: ['s3:PutObject', 's3:GetObject'],
                        resources: [`${artifactBucket.bucketArn}/deploy/notifications-svc/*`],
                    }),
                ],
            }),
        );

        /* ---------------- orchestrator lambda ---------------- */

        orchestratorRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['sts:AssumeRole'],
                resources: [deployRole.roleArn],
            }),
        );

        const orchestratorLogGroup = new logs.LogGroup(this, 'OrchestratorLogGroup', {
            logGroupName: `/aws/lambda/${orchestratorFunctionName}`,
            retention: logs.RetentionDays.ONE_DAY,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        orchestratorRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [orchestratorLogGroup.logGroupArn, `${orchestratorLogGroup.logGroupArn}:*`],
            }),
        );

        const orchestratorFn = new lambda.Function(this, 'OrchestratorFunction', {
            functionName: orchestratorFunctionName,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            role: orchestratorRole,
            timeout: cdk.Duration.seconds(60),
            memorySize: 256,
            logGroup: orchestratorLogGroup,
            description:
                'Scheduled release orchestrator: assumes the shared deploy role with sts:AssumeRole and audits published deploy artifacts',
            environment: {
                DEPLOY_ROLE_ARN: deployRole.roleArn,
                ARTIFACT_BUCKET: artifactBucketName,
            },
            code: lambda.Code.fromInline(
                [
                    'import json, os',
                    'import boto3',
                    'from botocore.exceptions import ClientError',
                    '',
                    'DEPLOY_ROLE_ARN = os.environ["DEPLOY_ROLE_ARN"]',
                    'ARTIFACT_BUCKET = os.environ["ARTIFACT_BUCKET"]',
                    '',
                    '',
                    'def handler(event, context):',
                    '    sts = boto3.client("sts")',
                    '    try:',
                    '        assumed = sts.assume_role(',
                    '            RoleArn=DEPLOY_ROLE_ARN,',
                    '            RoleSessionName="acme-deploy-orchestrator",',
                    '            DurationSeconds=900,',
                    '        )',
                    '    except ClientError as exc:',
                    '        print("assume_role failed: %s" % exc)',
                    '        return {"statusCode": 500, "error": str(exc)}',
                    '    creds = assumed["Credentials"]',
                    '    s3 = boto3.client(',
                    '        "s3",',
                    '        aws_access_key_id=creds["AccessKeyId"],',
                    '        aws_secret_access_key=creds["SecretAccessKey"],',
                    '        aws_session_token=creds["SessionToken"],',
                    '    )',
                    '    try:',
                    '        listed = s3.list_objects_v2(Bucket=ARTIFACT_BUCKET, Prefix="deploy/")',
                    '    except ClientError as exc:',
                    '        print("artifact listing failed: %s" % exc)',
                    '        return {',
                    '            "statusCode": 500,',
                    '            "assumedRoleArn": assumed["AssumedRoleUser"]["Arn"],',
                    '            "error": str(exc),',
                    '        }',
                    '    keys = [o["Key"] for o in listed.get("Contents", [])]',
                    '    print(json.dumps({"assumed": assumed["AssumedRoleUser"]["Arn"], "artifacts": keys}))',
                    '    return {',
                    '        "statusCode": 200,',
                    '        "assumedRoleArn": assumed["AssumedRoleUser"]["Arn"],',
                    '        "artifactCount": len(keys),',
                    '        "artifacts": keys,',
                    '    }',
                ].join('\n'),
            ),
        });

        /* ---------------- captured id_token parameters ---------------- */

        // Claim-set template consumed by the payments-api CodeBuild runner to mint a fresh
        // id_token on every invocation. Stored as raw JSON (not a JWT).
        new ssm.StringParameter(this, 'PaymentsClaimsTemplate', {
            parameterName: paymentsClaimsTemplateParam,
            stringValue: JSON.stringify(PAYMENTS_API_CLAIMS_TEMPLATE),
            description:
                'Claim-set template used by the payments-api-gha-runner to mint short-lived id_tokens',
            tier: ssm.ParameterTier.STANDARD,
        });
        new ssm.StringParameter(this, 'LegacyTokenCapture', {
            parameterName: legacyTokenParam,
            stringValue: capturedToken(LEGACY_SERVICE_CLAIMS),
            description:
                'id_token captured from the passing acme-corp/legacy-service deploy-production job (run 8812)',
            tier: ssm.ParameterTier.STANDARD,
        });
        new ssm.StringParameter(this, 'StagingTokenCapture', {
            parameterName: stagingTokenParam,
            stringValue: capturedToken(PAYMENTS_STAGING_CLAIMS),
            description:
                'id_token captured from the passing acme-corp/payments-api-staging deploy-staging job (run 311)',
            tier: ssm.ParameterTier.STANDARD,
        });
        new ssm.StringParameter(this, 'NotificationsTokenCapture', {
            parameterName: notificationsTokenParam,
            stringValue: capturedToken(NOTIFICATIONS_SVC_CLAIMS),
            description:
                'id_token captured from the passing acme-corp/notifications-svc deploy-production job (run 5290)',
            tier: ssm.ParameterTier.STANDARD,
        });

        // Application configuration the deploy role is allowed to read.
        new ssm.StringParameter(this, 'PaymentsAppConfig', {
            parameterName: '/acme/app/payments-api/release-channel',
            stringValue: 'production',
            tier: ssm.ParameterTier.STANDARD,
        });

        /* ---------------- CodeBuild-hosted GitHub Actions runners ---------------- */

        const runnerRole = new iam.Role(this, 'RunnerRole', {
            roleName: runnerRoleName,
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
            description:
                'Service role for CodeBuild-hosted GitHub Actions runners in the acme-corp organisation',
        });
        runnerRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:CreateLogGroup'],
                resources: [
                    `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/codebuild/*`,
                    `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/codebuild/*:*`,
                ],
            }),
        );
        runnerRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['ssm:GetParameter'],
                resources: [
                    `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/acme/ci/*`,
                    `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/acme/platform/observability/tokens/*`,
                ],
            }),
        );
        runnerRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['s3:GetObject', 's3:PutObject'],
                resources: [`${artifactBucket.bucketArn}/*`],
            }),
        );
        runnerRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['s3:ListBucket'],
                resources: [artifactBucket.bucketArn],
            }),
        );

        const makeLogGroup = (id: string, project: string) =>
            new logs.LogGroup(this, id, {
                logGroupName: `/aws/codebuild/${project}`,
                retention: logs.RetentionDays.ONE_DAY,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });

        const failingProject = new codebuild.Project(this, 'PaymentsApiRunner', {
            projectName: failingProjectName,
            role: runnerRole,
            description:
                'CodeBuild-hosted GitHub Actions runner for acme-corp/payments-api (.github/workflows/deploy.yml)',
            timeout: cdk.Duration.minutes(10),
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
                computeType: codebuild.ComputeType.SMALL,
            },
            environmentVariables: {
                GH_REPOSITORY: { value: 'acme-corp/payments-api' },
                GH_WORKFLOW: { value: '.github/workflows/deploy.yml' },
                DEPLOY_ROLE_ARN: { value: deployRole.roleArn },
                ARTIFACT_BUCKET: { value: artifactBucketName },
                RUN_LOG_KEY: { value: paymentsRunLogKey },
            },
            logging: { cloudWatch: { logGroup: makeLogGroup('PaymentsApiRunnerLogs', failingProjectName) } },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        commands: [
                            'echo "[runner] self-hosted runner online for $GH_REPOSITORY"',
                            'echo "[runner] workflow=$GH_WORKFLOW job=deploy-production run_id=4471 attempt=1"',
                        ],
                    },
                    pre_build: {
                        commands: [
                            ...REPLAY_ARCHIVED_LOG,
                            ...mintFreshTokenCommands(paymentsClaimsTemplateParam, paymentsTokenS3Prefix),
                            'echo "[runner] job deploy-production failed at step \'Configure AWS credentials\'"',
                            'exit 1',
                        ],
                    },
                    build: {
                        commands: [
                            'echo "[deploy] docker build / ecr push not reached - no AWS credentials"',
                        ],
                    },
                },
            }),
        });

        const workingProject = new codebuild.Project(this, 'LegacyServiceRunner', {
            projectName: workingProjectName,
            role: runnerRole,
            description:
                'CodeBuild-hosted GitHub Actions runner for acme-corp/legacy-service (.github/workflows/deploy.yml)',
            timeout: cdk.Duration.minutes(10),
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
                computeType: codebuild.ComputeType.SMALL,
            },
            environmentVariables: {
                GH_REPOSITORY: { value: 'acme-corp/legacy-service' },
                GH_WORKFLOW: { value: '.github/workflows/deploy.yml' },
                DEPLOY_ROLE_ARN: { value: deployRole.roleArn },
                ARTIFACT_BUCKET: { value: artifactBucketName },
                RUN_LOG_KEY: { value: legacyRunLogKey },
            },
            logging: { cloudWatch: { logGroup: makeLogGroup('LegacyServiceRunnerLogs', workingProjectName) } },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        commands: [
                            'echo "[runner] self-hosted runner online for $GH_REPOSITORY"',
                            'echo "[runner] workflow=$GH_WORKFLOW job=deploy-production run_id=8812 attempt=1"',
                        ],
                    },
                    pre_build: {
                        commands: [
                            ...REPLAY_ARCHIVED_LOG,
                            `aws ssm get-parameter --name "${legacyTokenParam}" --with-decryption --query Parameter.Value --output text >/dev/null`,
                            'echo "[runner] id_token retrieved from platform observability store"',
                        ],
                    },
                    build: {
                        commands: [
                            'aws sts get-caller-identity',
                            'printf "service=legacy-service\\nbuild=%s\\n" "$CODEBUILD_BUILD_NUMBER" > /tmp/build-info.txt',
                            'aws s3 cp /tmp/build-info.txt "s3://$ARTIFACT_BUCKET/deploy/legacy-service/build-info-latest.txt" --quiet',
                            'echo "[deploy] legacy-service release published"',
                        ],
                    },
                },
            }),
        });

        const stagingProject = new codebuild.Project(this, 'PaymentsStagingRunner', {
            projectName: stagingProjectName,
            role: runnerRole,
            description:
                'CodeBuild-hosted GitHub Actions runner for acme-corp/payments-api-staging (.github/workflows/deploy.yml)',
            timeout: cdk.Duration.minutes(10),
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
                computeType: codebuild.ComputeType.SMALL,
            },
            environmentVariables: {
                GH_REPOSITORY: { value: 'acme-corp/payments-api-staging' },
                GH_WORKFLOW: { value: '.github/workflows/deploy.yml' },
                DEPLOY_ROLE_ARN: { value: stagingRole.roleArn },
                ARTIFACT_BUCKET: { value: artifactBucketName },
                RUN_LOG_KEY: { value: stagingRunLogKey },
            },
            logging: { cloudWatch: { logGroup: makeLogGroup('PaymentsStagingRunnerLogs', stagingProjectName) } },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        commands: [
                            'echo "[runner] self-hosted runner online for $GH_REPOSITORY"',
                            'echo "[runner] workflow=$GH_WORKFLOW job=deploy-staging run_id=311 attempt=1"',
                        ],
                    },
                    pre_build: {
                        commands: [
                            ...REPLAY_ARCHIVED_LOG,
                            `aws ssm get-parameter --name "${stagingTokenParam}" --with-decryption --query Parameter.Value --output text >/dev/null`,
                            'echo "[runner] id_token retrieved from platform observability store"',
                        ],
                    },
                    build: {
                        commands: [
                            'aws sts get-caller-identity',
                            'printf "service=payments-api\\nchannel=staging\\nbuild=%s\\n" "$CODEBUILD_BUILD_NUMBER" > /tmp/build-info.txt',
                            'aws s3 cp /tmp/build-info.txt "s3://$ARTIFACT_BUCKET/deploy/payments-api-staging/build-info-latest.txt" --quiet',
                            'echo "[deploy] payments-api staging release published"',
                        ],
                    },
                },
            }),
        });

        const notificationsProject = new codebuild.Project(this, 'NotificationsSvcRunner', {
            projectName: notificationsProjectName,
            role: runnerRole,
            description:
                'CodeBuild-hosted GitHub Actions runner for acme-corp/notifications-svc (.github/workflows/deploy.yml)',
            timeout: cdk.Duration.minutes(10),
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
                computeType: codebuild.ComputeType.SMALL,
            },
            environmentVariables: {
                GH_REPOSITORY: { value: 'acme-corp/notifications-svc' },
                GH_WORKFLOW: { value: '.github/workflows/deploy.yml' },
                DEPLOY_ROLE_ARN: { value: notificationsRole.roleArn },
                ARTIFACT_BUCKET: { value: artifactBucketName },
                RUN_LOG_KEY: { value: notificationsRunLogKey },
            },
            logging: { cloudWatch: { logGroup: makeLogGroup('NotificationsSvcRunnerLogs', notificationsProjectName) } },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        commands: [
                            'echo "[runner] self-hosted runner online for $GH_REPOSITORY"',
                            'echo "[runner] workflow=$GH_WORKFLOW job=deploy-production run_id=5290 attempt=1"',
                        ],
                    },
                    pre_build: {
                        commands: [
                            ...REPLAY_ARCHIVED_LOG,
                            `aws ssm get-parameter --name "${notificationsTokenParam}" --with-decryption --query Parameter.Value --output text >/dev/null`,
                            'echo "[runner] id_token retrieved from platform observability store"',
                        ],
                    },
                    build: {
                        commands: [
                            'aws sts get-caller-identity',
                            'printf "service=notifications-svc\\nbuild=%s\\n" "$CODEBUILD_BUILD_NUMBER" > /tmp/build-info.txt',
                            'aws s3 cp /tmp/build-info.txt "s3://$ARTIFACT_BUCKET/deploy/notifications-svc/build-info-latest.txt" --quiet',
                            'echo "[deploy] notifications-svc release published"',
                        ],
                    },
                },
            }),
        });

        /* ---------------- alerting ---------------- */

        const alertTopic = new sns.Topic(this, 'AlertTopic', {
            topicName,
            displayName: 'acme CI/CD alerts',
        });

        const failedBuilds = new cloudwatch.Metric({
            namespace: 'AWS/CodeBuild',
            metricName: 'FailedBuilds',
            dimensionsMap: { ProjectName: failingProjectName },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
        });
        const deployAlarm = new cloudwatch.Alarm(this, 'DeployFailureAlarm', {
            alarmName,
            alarmDescription:
                'payments-api GitHub Actions deploy job is failing on the CodeBuild-hosted runner',
            metric: failedBuilds,
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        deployAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));

        /* ---------------- outputs ---------------- */

        StackUtils.exportStack(this, 'DeployRoleName', deployRoleName, 'Shared GitHub Actions deploy role');
        StackUtils.exportStack(
            this,
            'DeployRoleArn',
            `arn:${this.partition}:iam::${this.account}:role/${deployRoleName}`,
            'Shared GitHub Actions deploy role ARN',
        );
        StackUtils.exportStack(this, 'DeployPolicyName', deployPolicyName, 'Inline permission policy on the deploy role');
        StackUtils.exportStack(this, 'StagingRoleName', stagingRoleName, 'Staging deploy role');
        StackUtils.exportStack(this, 'AuditRoleName', auditRoleName, 'Read-only CI audit role');
        StackUtils.exportStack(this, 'NotificationsRoleName', notificationsRoleName, 'notifications-svc deploy role');
        StackUtils.exportStack(this, 'OrchestratorRoleName', orchestratorRoleName, 'Orchestrator lambda execution role');
        StackUtils.exportStack(this, 'OrchestratorFunctionName', orchestratorFunctionName, 'Release orchestrator lambda');
        StackUtils.exportStack(this, 'OidcProviderArn', oidcProviderArn, 'GitHub Actions OIDC provider ARN');
        StackUtils.exportStack(this, 'FailingProjectName', failingProjectName, 'payments-api GitHub Actions runner');
        StackUtils.exportStack(this, 'WorkingProjectName', workingProjectName, 'legacy-service GitHub Actions runner');
        StackUtils.exportStack(this, 'StagingProjectName', stagingProjectName, 'payments-api-staging GitHub Actions runner');
        StackUtils.exportStack(this, 'NotificationsProjectName', notificationsProjectName, 'notifications-svc GitHub Actions runner');
        StackUtils.exportStack(this, 'ArtifactBucketName', artifactBucketName, 'CI artifact bucket');
        StackUtils.exportStack(this, 'PaymentsClaimsTemplateParameterName', paymentsClaimsTemplateParam, 'payments-api runner id_token claim-set template');
        StackUtils.exportStack(this, 'PaymentsTokenS3Prefix', paymentsTokenS3Prefix, 'S3 prefix (in the CI artifact bucket) where the payments-api runner stashes minted id_tokens');
        StackUtils.exportStack(this, 'LegacyTokenCaptureParameterName', legacyTokenParam, 'Captured legacy-service id_token');
        StackUtils.exportStack(this, 'StagingTokenCaptureParameterName', stagingTokenParam, 'Captured staging id_token');
        StackUtils.exportStack(this, 'NotificationsTokenCaptureParameterName', notificationsTokenParam, 'Captured notifications-svc id_token');
        StackUtils.exportStack(this, 'AlarmName', alarmName, 'payments-api deploy failure alarm');
        StackUtils.exportStack(this, 'AlertTopicArn', `arn:${this.partition}:sns:${this.region}:${this.account}:${topicName}`, 'CI alert topic');
        StackUtils.exportStack(this, 'EcrRepositoryName', ecrRepositoryName, 'payments-api container registry');
        StackUtils.exportStack(this, 'PaymentsRunLogKey', paymentsRunLogKey, 'Archived failing payments-api job log');
        StackUtils.exportStack(this, 'LegacyRunLogKey', legacyRunLogKey, 'Archived passing legacy-service job log');
        StackUtils.exportStack(this, 'StagingRunLogKey', stagingRunLogKey, 'Archived passing staging job log');
        StackUtils.exportStack(this, 'NotificationsRunLogKey', notificationsRunLogKey, 'Archived passing notifications-svc job log');

        // keep references used (avoid unused-variable lint noise)
        void failingProject;
        void workingProject;
        void stagingProject;
        void notificationsProject;
        void orchestratorFn;
        void oidcProvider;
    }
}
