/**
 * CDK Examples Environment
 *
 * 38 stacks converted from https://github.com/aws-samples/aws-cdk-examples/tree/main/typescript
 * All stacks have been security-hardened: no public access, no open SGs, all APIs authenticated.
 * All stateful resources use RemovalPolicy.DESTROY for easy cleanup.
 *
 * Services covered: ALB, API Gateway (REST + WebSocket), Amazon MQ, AppSync, Auto Scaling, Backup,
 * Batch, CloudFormation (Custom Resources), CloudFront, CloudWatch (Dashboards), CodeBuild, CodeCommit,
 * CodeDeploy, CodePipeline, Cognito, DynamoDB (Tables + Streams), EC2, ECR, ECS (Fargate), EFS,
 * EventBridge, Glue, IAM, Image Builder, KMS, Lambda (Functions, Layers), Lex V2, RDS (Aurora
 * PostgreSQL Serverless v2), Rekognition, Route53 (Resolver, DNS Firewall), S3, Secrets Manager,
 * Service Catalog, SNS, SQS, SSM, Step Functions (Standard + Express), Transfer Family, VPC, WAF
 */
import * as cdk from 'aws-cdk-lib';
import { EnvironmentProps } from './lib/shared';
import { QARolesStack } from './stacks/qa_roles_stack';

// Lambda stacks
import { LambdaCron } from './stacks/lambda/lambda_cron';
import { LambdaLayer } from './stacks/lambda/lambda_layer';

// Step Functions
import { StepFunctionsJobPoller } from './stacks/stepfunctions/stepfunctions_job_poller';

// Rekognition
import { RekognitionS3TriggerStack } from './stacks/rekognition/rekognition_s3_trigger';

// Route53
import { Route53DnsFirewall } from './stacks/route53/route53_dns_firewall';

// SSM
import { SsmDocumentAssociation } from './stacks/ssm/ssm_document_association';

// S3
import { S3SnsLambdaChainStack } from './stacks/s3/s3_sns_lambda_chain';
import { S3EventNotification } from './stacks/s3/s3_event_notification';

// Lex
import { LexBotStack } from './stacks/lex/lex_bot';

// API Gateway
import { ApiGatewayTokenAuthStack } from './stacks/apigateway/apigateway_token_auth';
import { ApiGatewayAsyncLambda } from './stacks/apigateway/apigateway_async_lambda';
import { ApiGatewayCrudDynamodb } from './stacks/apigateway/apigateway_crud_dynamodb';
import { ApiGatewayWidgetService } from './stacks/apigateway/apigateway_widget_service';
import { ApiGatewayParallelStepFunctions } from './stacks/apigateway/apigateway_parallel_stepfunctions';
import { ApiGatewayWebsocket } from './stacks/apigateway/apigateway_websocket';

// Cognito
import { CognitoApiLambdaStack } from './stacks/cognito/cognito_api_lambda';

// Batch
import { BatchEcrOpenmpStack } from './stacks/batch/batch_ecr_openmp';

// AppSync
import { AppsyncGraphqlDynamodbStack } from './stacks/appsync/appsync_graphql_dynamodb';

// EventBridge
import { EventbridgeLambdaStack } from './stacks/eventbridge/eventbridge_lambda';

// CloudFront
import { CloudfrontFunctionsStack } from './stacks/cloudfront/cloudfront_functions';

// Backup
import { BackupS3Stack } from './stacks/backup/backup_s3';

// WAF
import { WafRegional } from './stacks/waf/waf_regional';

// EC2
import { Ec2Instance } from './stacks/ec2/ec2_instance';
import { Ec2InstanceConnect } from './stacks/ec2/ec2_instance_connect';

// ImageBuilder
import { ImageBuilderPipeline } from './stacks/imagebuilder/imagebuilder_pipeline';

// CodePipeline
import { CodePipelineBuildDeployStack } from './stacks/codepipeline/codepipeline_build_deploy';

// Transfer Family
import { TransferSftpServerStack } from './stacks/transfer/transfer_sftp_server';

// Route53 Resolver
import { R53ResolverStack } from './stacks/r53resolver/r53_resolver';

// Amazon MQ
import { MqRabbitmqLambdaStack } from './stacks/mq/mq_rabbitmq_lambda';

// DynamoDB Streams
import { DynamodbStreamSns } from './stacks/dynamodb/dynamodb_stream_sns';

// ALB + Auto Scaling
import { AlbAutoscaling } from './stacks/alb/alb_autoscaling';

// ECS Fargate + EFS
import { EcsFargateEfs } from './stacks/ecs/ecs_fargate_efs';

// Glue ETL Pipeline
import { GlueEtlPipelineStack } from './stacks/glue/glue_etl_pipeline';

// CloudFormation Custom Resource
import { CfnCustomResourceStack } from './stacks/cloudformation/cfn_custom_resource';

// CloudWatch Dashboard
import { CloudwatchDashboardStack } from './stacks/cloudwatch/cloudwatch_dashboard';

// Service Catalog
import { ServiceCatalogPortfolioStack } from './stacks/servicecatalog/servicecatalog_portfolio';

// Step Functions Express
import { StepFunctionsExpressStack } from './stacks/stepfunctions/stepfunctions_express';

// RDS Aurora PostgreSQL Serverless v2
import { RdsAuroraServerlessStack } from './stacks/rds/rds_aurora_serverless';

export function createEnvironment(app: cdk.App, envId: string, props: EnvironmentProps): void {
    const { account } = props;
    const region = 'us-east-1';
    const env = { account, region };

    // QA Roles
    new QARolesStack(app, `${envId}-QARoles-${region}`, { env });

    // Lambda
    new LambdaCron(app, `${envId}-Lambda-cron-${region}`, { env });
    new LambdaLayer(app, `${envId}-Lambda-layer-${region}`, { env });

    // Step Functions
    new StepFunctionsJobPoller(app, `${envId}-StepFunctions-jobpoller-${region}`, { env });

    // Rekognition + S3 + DynamoDB
    new RekognitionS3TriggerStack(app, `${envId}-Rekognition-s3trigger-${region}`, { env });

    // Route53 DNS Firewall + VPC
    new Route53DnsFirewall(app, `${envId}-Route53-dnsfirewall-${region}`, { env });

    // SSM + EC2
    new SsmDocumentAssociation(app, `${envId}-SSM-docassoc-${region}`, { env });

    // S3 + SNS + SQS + Lambda chain
    new S3SnsLambdaChainStack(app, `${envId}-S3-snschain-${region}`, { env });

    // S3 Event Notifications + Lambda + SQS + SNS
    new S3EventNotification(app, `${envId}-S3-eventnotif-${region}`, { env });

    // Lex V2 Bot
    new LexBotStack(app, `${envId}-Lex-booktrip-${region}`, { env });

    // API Gateway + Lambda Token Auth
    new ApiGatewayTokenAuthStack(app, `${envId}-APIGW-tokenauth-${region}`, { env });

    // Cognito + API Gateway + Lambda
    new CognitoApiLambdaStack(app, `${envId}-Cognito-apilambda-${region}`, { env });

    // API Gateway Async Lambda + DynamoDB
    new ApiGatewayAsyncLambda(app, `${envId}-APIGW-asynclambda-${region}`, { env });

    // API Gateway CRUD + DynamoDB
    new ApiGatewayCrudDynamodb(app, `${envId}-APIGW-crudddb-${region}`, { env });

    // API Gateway Widget Service + S3
    new ApiGatewayWidgetService(app, `${envId}-APIGW-widgets-${region}`, { env });

    // API Gateway + Parallel Step Functions
    new ApiGatewayParallelStepFunctions(app, `${envId}-APIGW-parallelsf-${region}`, { env });

    // WebSocket API + Lambda + DynamoDB
    new ApiGatewayWebsocket(app, `${envId}-APIGW-websocket-${region}`, { env });

    // Batch + ECR + VPC
    new BatchEcrOpenmpStack(app, `${envId}-Batch-openmp-${region}`, { env });

    // AppSync + DynamoDB
    new AppsyncGraphqlDynamodbStack(app, `${envId}-AppSync-graphqlddb-${region}`, { env });

    // EventBridge + Lambda + SNS
    new EventbridgeLambdaStack(app, `${envId}-EventBridge-lambda-${region}`, { env });

    // CloudFront + S3
    new CloudfrontFunctionsStack(app, `${envId}-CloudFront-functions-${region}`, { env });

    // Backup + S3
    new BackupS3Stack(app, `${envId}-Backup-s3-${region}`, { env });

    // WAF
    new WafRegional(app, `${envId}-WAF-regional-${region}`, { env });

    // EC2 + VPC
    new Ec2Instance(app, `${envId}-EC2-instance-${region}`, { env });

    // EC2 Instance Connect Endpoint + VPC
    new Ec2InstanceConnect(app, `${envId}-EC2-connectendpoint-${region}`, { env });

    // ImageBuilder + ECR
    new ImageBuilderPipeline(app, `${envId}-ImageBuilder-pipeline-${region}`, { env });

    // CodePipeline + CodeBuild + CodeDeploy + ECS + ECR + ALB
    new CodePipelineBuildDeployStack(app, `${envId}-CodePipeline-builddeploy-${region}`, { env });

    // Transfer Family SFTP + S3 + VPC
    new TransferSftpServerStack(app, `${envId}-Transfer-sftp-${region}`, { env });

    // Route53 Resolver (Inbound + Outbound) + DNS Firewall + VPC
    new R53ResolverStack(app, `${envId}-R53Resolver-endpoints-${region}`, { env });

    // Amazon MQ RabbitMQ + Lambda + Secrets Manager
    new MqRabbitmqLambdaStack(app, `${envId}-AmazonMQ-rabbitmq-${region}`, { env });

    // DynamoDB Streams + Lambda + SNS
    new DynamodbStreamSns(app, `${envId}-DDB-streamsns-${region}`, { env });

    // ALB + Auto Scaling Group
    new AlbAutoscaling(app, `${envId}-ALB-autoscaling-${region}`, { env });

    // ECS Fargate + EFS
    new EcsFargateEfs(app, `${envId}-ECS-fargateefs-${region}`, { env });

    // Glue ETL Pipeline + CodePipeline + CodeCommit
    new GlueEtlPipelineStack(app, `${envId}-Glue-etlpipeline-${region}`, { env });

    // CloudFormation Custom Resource + Lambda
    new CfnCustomResourceStack(app, `${envId}-CFN-customresource-${region}`, { env });

    // CloudWatch Dashboard + Lambda
    new CloudwatchDashboardStack(app, `${envId}-CW-dashboard-${region}`, { env });

    // Service Catalog Portfolio + EC2 Product
    new ServiceCatalogPortfolioStack(app, `${envId}-ServiceCatalog-portfolio-${region}`, { env });

    // Step Functions Express + API Gateway
    new StepFunctionsExpressStack(app, `${envId}-StepFunctions-express-${region}`, { env });

    // Aurora PostgreSQL Serverless v2 + Lambda (RDS Data API)
    new RdsAuroraServerlessStack(app, `${envId}-RDS-aurora-${region}`, { env });
}
