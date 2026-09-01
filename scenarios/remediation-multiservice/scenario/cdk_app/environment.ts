import * as cdk from 'aws-cdk-lib';
import { EnvironmentProps } from './lib/shared';

// Shared roles — one QA roles stack for the whole environment.
import { AppRolesStack } from './stacks/app_roles_stack';

// Candidate stacks: one directory per remediation domain, each with its own
// stacks/, assets/ and lib/, so imports resolve to their own lib/shared.
import { LedgerStack } from './candidates/dynamodb-kms/stacks/ledger-stack';
import { BedrockExtractionStack } from './candidates/bedrock/stacks/bedrock_extraction_stack';
import { FulfillmentPipelineStack } from './candidates/eventbridge/stacks/fulfillment_stack';
import { WebPlatformStack } from './candidates/cloudfront/stacks/web_platform_stack';
import { PlatformStack as EcsPlatformStack } from './candidates/ecs-delivery/stacks/platform-stack';
import { EcsDeliveryStack } from './candidates/ecs-delivery/stacks/ecs-delivery-stack';
import { PipelinesStack as EcsPipelinesStack } from './candidates/ecs-delivery/stacks/pipelines-stack';
import { ObservabilityStack as EcsObservabilityStack } from './candidates/ecs-delivery/stacks/observability-stack';
import { CicdOidcStack } from './candidates/oidc/stacks/cicd-oidc-stack';
import { OrderIngestStack } from './candidates/sqs-lambda/stacks/order-ingest-stack';
import { PlatformGuardrailStack } from './candidates/sqs-lambda/stacks/platform-guardrail-stack';

const REGION = 'us-east-1';

export function createEnvironment(app: cdk.App, envId: string, props: EnvironmentProps): void {
    const env = { account: props.account, region: REGION };

    // ── Shared QA roles (agent, admin, verifier) ──
    new AppRolesStack(app, `${envId}-AppRoles-${REGION}`, {
        env,
    });

    // ── Candidate: dynamodb-kms — Payments ledger platform ──
    new LedgerStack(app, `${envId}-Ledger-qxoqk9o4y-${REGION}`, {
        env,
        suffix: 'qxoqk9o4y',
        description:
            'Payments ledger platform: PCI ledger table, CMK envelope encryption, analytics workload',
    });

    // ── Candidate: bedrock — DocIntel structured extraction ──
    new BedrockExtractionStack(app, `${envId}-Bedrock-uyvjsf7fj-${REGION}`, {
        env,
        description: 'DocIntel structured-extraction service (Bedrock Converse tool use)',
    });

    // ── Candidate: eventbridge — Order fulfillment event pipeline ──
    new FulfillmentPipelineStack(app, `${envId}-Fulfillment-5k53ncku2-${REGION}`, {
        env,
        description: 'Order fulfillment event pipeline (EventBridge -> Lambda -> DynamoDB)',
    });

    // ── Candidate: cloudfront — Static site delivery (S3+CloudFront) ──
    new WebPlatformStack(app, `${envId}-WebPlatform-uobyzx8z7-${REGION}`, {
        env,
        suffix: 'uobyzx8z7',
        description:
            'Static site delivery: S3 origins, CloudFront distributions and publish pipelines',
    });

    // ── Candidate: ecs-delivery — Checkout platform (VPC, ECS/ECR, pipelines, obs) ──
    const ecsPlatform = new EcsPlatformStack(app, `${envId}-Platform-k0wms2i88-${REGION}`, {
        env,
        description: 'Checkout platform network and release metadata plane',
    });

    const ecsDelivery = new EcsDeliveryStack(app, `${envId}-EcsDelivery-hp473c290-${REGION}`, {
        env,
        description: 'Checkout container delivery plane: ECR, Fargate services and internal ALB',
        vpc: ecsPlatform.vpc,
    });

    const ecsPipelines = new EcsPipelinesStack(app, `${envId}-Pipelines-p1gtxzog5-${REGION}`, {
        env,
        description: 'Checkout image build pipelines (release, canary, worker nightly)',
    });
    ecsPipelines.addDependency(ecsDelivery);

    const ecsObservability = new EcsObservabilityStack(
        app,
        `${envId}-Observability-h1eak6jtx-${REGION}`,
        {
            env,
            description: 'Checkout delivery observability: image auditor, synthetic probe and alarms',
            vpc: ecsPlatform.vpc,
            registryTable: ecsPlatform.releaseRegistry,
            albDnsName: ecsDelivery.albDnsName,
            targetGroupFullName: ecsDelivery.targetGroupFullName,
            loadBalancerFullName: ecsDelivery.loadBalancerFullName,
        }
    );
    ecsObservability.addDependency(ecsDelivery);

    // ── Candidate: oidc — CI/CD GitHub OIDC federation ──
    new CicdOidcStack(app, `${envId}-CicdOidc-a2ltm5dey-${REGION}`, {
        env,
        description:
            'acme-corp CI/CD platform: GitHub Actions OIDC federation, CodeBuild-hosted runners, deploy roles',
    });

    // ── Candidate: sqs-lambda — Order ingest + platform concurrency guardrail ──
    const ingest = new OrderIngestStack(app, `${envId}-Ingest-ay9wdpt5n-${REGION}`, {
        env,
        description: 'Order ingestion tier: queues, consumers and pipeline observability',
    });

    const guardrail = new PlatformGuardrailStack(
        app,
        `${envId}-Platform-5sp83dcvi-${REGION}`,
        {
            env,
            description:
                'Platform guardrail that reconciles consumer poller concurrency ceilings from Parameter Store',
            ordersQueueName: ingest.ordersQueueName,
            paymentsQueueName: ingest.paymentsQueueName,
        }
    );
    guardrail.addDependency(ingest);
}
