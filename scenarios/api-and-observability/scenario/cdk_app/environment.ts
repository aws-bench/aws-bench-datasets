import * as cdk from 'aws-cdk-lib';
import { EnvironmentProps } from './lib/shared';
import { QARolesStack } from './stacks/qa_roles_stack';
import { Cloudfront_laljfb348 } from './stacks/cloudfront/cloudfront_laljfb348';
import { Redshift_k3u7kum7v } from './stacks/redshift/redshift_k3u7kum7v';
import { Stepfunctions_9bww99xri } from './stacks/stepfunctions/stepfunctions_9bww99xri';
import { Opensearch_9f79baa8e } from './stacks/opensearch/opensearch_9f79baa8e';
import { BedrockKB_dwiwbg5rr } from './stacks/bedrock/bedrock_kb_dwiwbg5rr';
import { BedrockAgent_dwiwbg5rr } from './stacks/bedrock/bedrock_agent_dwiwbg5rr';
import { Elbv2_yiasr88un } from './stacks/elbv2/elbv2_yiasr88un';
import { Cloudformation_ne1y5vgir } from './stacks/cloudformation/cloudformation_ne1y5vgir';
import { Opensearch_zf57i4r1i } from './stacks/opensearch/opensearch_zf57i4r1i';
import { apigateway_we36rki7x } from './stacks/apigateway/apigateway_we36rki7x';
import { Ecs_t81xcoww7 } from './stacks/ecs/ecs_t81xcoww7';
import { ApiGateway6b015c55c } from './stacks/apigateway/apigateway_6b015c55c';
import { CloudWatch_89fb5762b } from './stacks/cloudwatch/cloudwatch_89fb5762b';
import { WebSocketStack_d761a646a } from './stacks/apigateway/websocket_d761a646a';
import { lambda_b0d9783d3 } from './stacks/lambda/lambda_b0d9783d3';
import { logs_6b635d316 } from './stacks/logs/logs_6b635d316';
import { Opensearch_60603f075 } from './stacks/opensearch/opensearch_60603f075';
import { OpenSearchSlr } from './stacks/opensearch/opensearch_slr';
import { IAM_e71d403fc } from './stacks/iam/iam_e71d403fc';
import { CloudFront_e0239752d } from './stacks/cloudfront/cloudfront_e0239752d';
import { s3_37634fcce } from './stacks/s3/s3_37634fcce';
import { main_37634fcce } from './stacks/lambda/main_37634fcce';

export function createEnvironment(app: cdk.App, envId: string, props: EnvironmentProps): void {
    const { account } = props;
    new QARolesStack(app, `${envId}-QARoles-us-east-1`, { env: { account, region: 'us-east-1' } });
    new Cloudfront_laljfb348(app, `${envId}-cloudfront-laljfb348-us-east-1`, { env: { account, region: 'us-east-1' } });
    new Redshift_k3u7kum7v(app, `${envId}-redshift-k3u7kum7v-us-east-1`, { env: { account, region: 'us-east-1' } });
    new Stepfunctions_9bww99xri(app, `${envId}-stepfunctions-9bww99xri-us-east-1`, { env: { account, region: 'us-east-1' } });

    const opensearchSlr = new OpenSearchSlr(app, `${envId}-opensearch-slr-us-east-1`, { env: { account, region: 'us-east-1' } });

    const opensearch9f79 = new Opensearch_9f79baa8e(app, `${envId}-opensearch-9f79baa8e-us-east-1`, { env: { account, region: 'us-east-1' } });
    opensearch9f79.addDependency(opensearchSlr);

    const kbStack = new BedrockKB_dwiwbg5rr(app, `${envId}-bedrock-kb-dwiwbg5rr-us-east-1`, { env: { account, region: 'us-east-1' } });
    const agentStack = new BedrockAgent_dwiwbg5rr(app, `${envId}-bedrock-agent-dwiwbg5rr-us-east-1`, {
        env: { account, region: 'us-east-1' },
        escalationKbId: kbStack.escalationKbId,
        metadataKbId: kbStack.metadataKbId,
    });
    agentStack.addDependency(kbStack);

    new Elbv2_yiasr88un(app, `${envId}-elbv2-yiasr88un-us-east-1`, { env: { account, region: 'us-east-1' } });
    new Cloudformation_ne1y5vgir(app, `${envId}-cloudformation-ne1y5vgir-us-west-2`, { env: { account, region: 'us-west-2' } });
    const opensearchZf57 = new Opensearch_zf57i4r1i(app, `${envId}-opensearch-zf57i4r1i-us-east-1`, { env: { account, region: 'us-east-1' } });
    opensearchZf57.addDependency(opensearchSlr);
    new apigateway_we36rki7x(app, `${envId}-apigateway-we36rki7x-us-east-1`, { env: { account, region: 'us-east-1' } });
    new Ecs_t81xcoww7(app, `${envId}-ecs-t81xcoww7-us-east-1`, { env: { account, region: 'us-east-1' } });
    new ApiGateway6b015c55c(app, `${envId}-ApiGateway-6b015c55c-us-east-1`, { env: { account, region: 'us-east-1' } });
    new CloudWatch_89fb5762b(app, `${envId}-CloudWatch-89fb5762b-ap-southeast-1`, { env: { account, region: 'ap-southeast-1' } });
    new WebSocketStack_d761a646a(app, `${envId}-WebSocket-d761a646a-us-east-1`, { env: { account, region: 'us-east-1' } });
    new lambda_b0d9783d3(app, `${envId}-Lambda-b0d9783d3-us-east-1`, { env: { account, region: 'us-east-1' } });
    new logs_6b635d316(app, `${envId}-logs-6b635d316-us-west-2`, { env: { account, region: 'us-west-2' } });

    const opensearch60603 = new Opensearch_60603f075(app, `${envId}-opensearch-60603f075-us-east-1`, { env: { account, region: 'us-east-1' } });
    opensearch60603.addDependency(opensearchSlr);

    new IAM_e71d403fc(app, `${envId}-IAM-e71d403fc-us-east-1`, { env: { account, region: 'us-east-1' } });
    new CloudFront_e0239752d(app, `${envId}-cloudfront-e0239752d-us-east-1`, { env: { account, region: 'us-east-1' } });

    const s3EastStack_37634fcce = new s3_37634fcce(app, `${envId}-S3-37634fcce-us-east-1`, { env: { account, region: 'us-east-1' } });
    const mainStack_37634fcce = new main_37634fcce(app, `${envId}-Lambda-37634fcce-us-west-2`, {
        env: { account, region: 'us-west-2' },
        analyticsBucket: s3EastStack_37634fcce.analyticsBucket,
        archiveBucket: s3EastStack_37634fcce.archiveBucket,
        reportsBucket: s3EastStack_37634fcce.reportsBucket,
        analyticsBucketName: `quartz-analytics-beta-${account}-us-east-1`,
    });
    mainStack_37634fcce.addDependency(s3EastStack_37634fcce);
}
