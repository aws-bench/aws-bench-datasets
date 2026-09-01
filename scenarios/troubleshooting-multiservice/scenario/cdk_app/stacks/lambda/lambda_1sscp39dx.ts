import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import { Construct } from 'constructs';
import { Stack as DeploymentStack, StackProps as DeploymentStackProps } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';
import * as logs from 'aws-cdk-lib/aws-logs';

/*
 * Stack ID: lambda-1sscp39dx
 *
 * 44f4ae23-89f2-4f71-b510-b38b76f0e28b
 *
 * What the stack does:
 * This stack reproduces a troubleshooting scenario where Lambda environment variables
 * contain CloudFormation logical IDs instead of actual AppConfig resource IDs.
 *
 * Resources created:
 * 1. AppConfig Application, Environment, and Configuration Profile
 * 2. Lambda function with INTENTIONALLY BROKEN environment variables
 * 3. DynamoDB tables for annotation staging and media details
 * 4. IAM roles for cross-account access
 *
 * The bug: Lambda env vars reference logical IDs (e.g., GRNCMSAppConfigApplication537888D7)
 * instead of actual resource IDs, causing ResourceNotFoundException.
 */

export class Lambda_1sscp39dx extends DeploymentStack {
    constructor(scope: Construct, id: string, props: DeploymentStackProps) {
        super(scope, id, props);

        // ========================================
        // AppConfig Resources
        // ========================================

        const appconfigApp = new appconfig.Application(this, 'GRNCMSAppConfigApplication537888D7', {
            applicationName: 'GarnetAppConfig',
            description: 'Configuration for Garnet application',
        });

        const appconfigEnv = new appconfig.Environment(this, 'GRNCMSAppConfigEnvironment9802B737', {
            application: appconfigApp,
            environmentName: 'beta',
            description: 'beta environment for GarnetAppConfig',
        });

        const configContent = appconfig.ConfigurationContent.fromInlineJson(JSON.stringify({ useNewBackend: true }));

        // Default AppConfig deployment ramps over 20 min + 10 min bake. The
        // benchmark has no clients polling and no monitor alarms, so the
        // gradual-rollout safety is pure overhead. Pin a 0/0 strategy so the
        // first deploy doesn't overrun the framework's STS cred TTL.
        const fastDeployStrategy = new appconfig.DeploymentStrategy(this, 'FastDeploymentStrategy', {
            deploymentStrategyName: 'AllAtOnceNoBake',
            rolloutStrategy: appconfig.RolloutStrategy.linear({
                growthFactor: 100,
                deploymentDuration: cdk.Duration.minutes(0),
                finalBakeTime: cdk.Duration.minutes(0),
            }),
        });

        const hostedConfig = new appconfig.HostedConfiguration(
            this,
            'GRNCMSAppConfigConfigurationConfigurationProfile7AB3584E',
            {
                application: appconfigApp,
                content: configContent,
                name: 'GarnetServicebeta-GRNCMSAppConfigConfiguration-EE839D38',
                type: appconfig.ConfigurationType.FREEFORM,
                deployTo: [appconfigEnv],
                deploymentStrategy: fastDeployStrategy,
            },
        );

        // ========================================
        // DynamoDB Tables
        // ========================================

        // AnnotationStaging table (new backend)
        const annotationStagingTable = new dynamodb.Table(this, 'AnnotationStagingTable', {
            tableName: `Garnet-AnnotationStaging-${this.account}-${this.region}`,
            partitionKey: {
                name: 'contentId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'marketplaceId_shoppableStrategy',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecovery: true,
        });

        // MediaDetails table (legacy backend)
        const mediaDetailsTable = new dynamodb.Table(this, 'MediaDetailsTable', {
            tableName: `GRN-MEDIA-DETAILS-${this.account}-${this.region}`,
            partitionKey: {
                name: 'contentId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'marketplaceId',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecovery: true,
        });

        // SceneInfoV3 table (legacy backend)
        const sceneInfoV3Table = new dynamodb.Table(this, 'SceneInfoV3Table', {
            tableName: `SCENE-INFO-V3-${this.account}-${this.region}`,
            partitionKey: {
                name: 'physicalId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'marketplaceIdStrategyId',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecovery: true,
        });

        // SceneTagInfo table (legacy backend)
        const sceneTagInfoTable = new dynamodb.Table(this, 'SceneTagInfoTable', {
            tableName: `SCENE-TAG-INFO-${this.account}-${this.region}`,
            partitionKey: {
                name: 'tagId',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecovery: true,
        });

        // ========================================
        // IAM Roles for Cross-Account Access
        // ========================================

        // Role for CMS cross-account access (AnnotationStaging)
        const cmsCrossAccountRole = new iam.Role(this, 'CMSCrossAccountRole', {
            roleName: `Garnet-CMS-CrossAccount-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Cross-account access to AnnotationStaging and AssetMetadata tables',
        });

        annotationStagingTable.grantReadWriteData(cmsCrossAccountRole);

        // Role for Cobalt Shoppable cross-account access (SceneInfoV3, MediaDetails)
        const cobaltShoppableCrossAccountRole = new iam.Role(this, 'CobaltShoppableCrossAccountRole', {
            roleName: `CobaltScenes-CrossAccount-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Cross-account access to SceneInfoV3 and MediaDetails tables',
        });

        sceneInfoV3Table.grantReadData(cobaltShoppableCrossAccountRole);
        mediaDetailsTable.grantReadData(cobaltShoppableCrossAccountRole);

        // Role for Cobalt cross-account access (SceneTagInfo)
        const cobaltCrossAccountRole = new iam.Role(this, 'CobaltCrossAccountRole', {
            roleName: `CobaltTest-CrossAccount-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Cross-account access to SceneTagInfo table',
        });

        sceneTagInfoTable.grantReadData(cobaltCrossAccountRole);

        // Role for S3 access
        const s3AccessRole = new iam.Role(this, 'S3AccessRole', {
            roleName: `Garnet-S3Access-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Cross-account S3 access for generating presigned URLs',
        });

        s3AccessRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['s3:GetObject', 's3:PutObject'],
                resources: ['arn:aws:s3:::*/*'],
            }),
        );

        // ========================================
        // Lambda Function (with BROKEN env vars)
        // ========================================

        const getShoppableMediaLambdaLogGroup = new logs.LogGroup(this, 'GetShoppableMediaFunctionLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const getShoppableMediaLambda = new lambda.Function(this, 'GetShoppableMediaFunction', {
            logGroup: getShoppableMediaLambdaLogGroup,
            functionName: `GarnetCMS-getShoppableMediaByID-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
// Lambda function implementation not captured in trace — stub only
exports.handler = async (event) => {
    console.log('Event:', JSON.stringify(event, null, 2));
    
    // Attempt to read AppConfig (will fail due to misconfigured env vars)
    const AWS = require('aws-sdk');
    const appconfig = new AWS.AppConfig();
    
    const appId = process.env.APP_CONFIG_APPLICATION;
    const envId = process.env.APP_CONFIG_ENVIRONMENT;
    const configId = process.env.APP_CONFIG_CONFIGURATION;
    
    console.log('AppConfig IDs:', { appId, envId, configId });
    
    try {
        // This will fail because env vars contain logical IDs, not actual resource IDs
        const config = await appconfig.getConfiguration({
            Application: appId,
            Environment: envId,
            Configuration: configId,
            ClientId: 'lambda-client'
        }).promise();
        
        console.log('AppConfig retrieved successfully');
    } catch (error) {
        console.error('Failed to retrieve AppConfig:', error.message);
        console.log('Falling back to default: useNewBackend = false');
    }
    
    return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Function executed' })
    };
};
            `),
            memorySize: 512,
            timeout: cdk.Duration.seconds(180),
            environment: {
                // intentional: schema specifies these values — do not replace with CDK reference
                APP_CONFIG_APPLICATION: 'GRNCMSAppConfigApplication537888D7',
                // intentional: schema specifies these values — do not replace with CDK reference
                APP_CONFIG_CONFIGURATION: 'GRNCMSAppConfigConfigurationConfigurationProfile7AB3584E',
                // intentional: schema specifies these values — do not replace with CDK reference
                APP_CONFIG_ENVIRONMENT: 'GRNCMSAppConfigEnvironment9802B737',
                CMS_CROSS_ACCOUNT_ROLE_ARN: cmsCrossAccountRole.roleArn,
                JASPER_CROSS_ACCOUNT_ROLE_ARN: cobaltCrossAccountRole.roleArn,
                JASPER_SHOPPABLE_CROSS_ACCOUNT_ROLE_ARN: cobaltShoppableCrossAccountRole.roleArn,
                S3_ACCESS_ROLE_ARN: s3AccessRole.roleArn,
                STAGE: 'beta',
            },
        });

        // Grant Lambda permissions to read AppConfig
        getShoppableMediaLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    'appconfig:GetConfiguration',
                    'appconfig:GetLatestConfiguration',
                    'appconfig:StartConfigurationSession',
                ],
                resources: ['*'],
            }),
        );

        // Grant Lambda permissions to assume cross-account roles
        getShoppableMediaLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['sts:AssumeRole'],
                resources: [
                    cmsCrossAccountRole.roleArn,
                    cobaltCrossAccountRole.roleArn,
                    cobaltShoppableCrossAccountRole.roleArn,
                    s3AccessRole.roleArn,
                ],
            }),
        );

        // Grant Lambda direct access to DynamoDB tables
        annotationStagingTable.grantReadWriteData(getShoppableMediaLambda);
        mediaDetailsTable.grantReadData(getShoppableMediaLambda);
        sceneInfoV3Table.grantReadData(getShoppableMediaLambda);
        sceneTagInfoTable.grantReadData(getShoppableMediaLambda);

        // ========================================
        // Stack Outputs
        // ========================================

        StackUtils.exportStack(
            this,
            'AppConfigApplicationId',
            appconfigApp.applicationId,
            'Actual AppConfig application ID (not the logical ID in Lambda env vars)',
        );

        StackUtils.exportStack(
            this,
            'AppConfigEnvironmentId',
            appconfigEnv.environmentId,
            'Actual AppConfig environment ID (not the logical ID in Lambda env vars)',
        );

        StackUtils.exportStack(
            this,
            'AppConfigConfigurationProfileId',
            hostedConfig.configurationProfileId,
            'Actual AppConfig configuration profile ID (not the logical ID in Lambda env vars)',
        );

        StackUtils.exportStack(
            this,
            'LambdaFunctionName',
            getShoppableMediaLambda.functionName,
            'Lambda function name',
        );

        StackUtils.exportStack(
            this,
            'AnnotationStagingTableName',
            annotationStagingTable.tableName,
            'DynamoDB AnnotationStaging table name',
        );

        StackUtils.exportStack(
            this,
            'MediaDetailsTableName',
            mediaDetailsTable.tableName,
            'DynamoDB MediaDetails table name',
        );

        StackUtils.exportStack(
            this,
            'SceneInfoV3TableName',
            sceneInfoV3Table.tableName,
            'DynamoDB SceneInfoV3 table name',
        );

        StackUtils.exportStack(
            this,
            'SceneTagInfoTableName',
            sceneTagInfoTable.tableName,
            'DynamoDB SceneTagInfo table name',
        );
    }
}
