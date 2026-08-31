import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { StackUtils } from '../lib/shared';

export interface WebPlatformStackProps extends cdk.StackProps {
    /** Pre-minted stack suffix, used to keep physical names collision free. */
    readonly suffix: string;
}

/**
 * Web platform for the marketing site and the preview workspace (pw-alpha)
 * portal.
 *
 * A shared build-artifacts bucket holds immutable releases. An S3
 * object-created notification on the release manifest fires a publisher
 * Lambda that copies the build into a private CloudFront origin bucket
 * (OAC only) and issues invalidations for changed paths.
 */
export class WebPlatformStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: WebPlatformStackProps) {
        super(scope, id, props);

        const sfx = props.suffix;

        // ------------------------------------------------------------------
        // Buckets
        // ------------------------------------------------------------------
        const buildBucketName = `web-build-artifacts-${sfx}-${this.account}`;
        const buildBucket = new s3.Bucket(this, 'BuildArtifacts', {
            bucketName: buildBucketName,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                {
                    id: 'expire-old-noncurrent-artifacts',
                    noncurrentVersionExpiration: cdk.Duration.days(30),
                },
            ],
        });

        const mktgOriginName = `mktg-site-origin-${sfx}-${this.account}`;
        const mktgOrigin = new s3.Bucket(this, 'MktgOrigin', {
            bucketName: mktgOriginName,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        const pwAlphaOriginName = `pw-alpha-origin-${sfx}-${this.account}`;
        const pwAlphaOrigin = new s3.Bucket(this, 'PwAlphaOrigin', {
            bucketName: pwAlphaOriginName,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // ------------------------------------------------------------------
        // CloudFront shared policies
        // ------------------------------------------------------------------
        const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
            responseHeadersPolicyName: `web-platform-security-headers-${sfx}`,
            comment: 'Baseline security headers for static sites',
            securityHeadersBehavior: {
                contentTypeOptions: { override: true },
                frameOptions: {
                    frameOption: cloudfront.HeadersFrameOption.DENY,
                    override: true,
                },
                referrerPolicy: {
                    referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
                    override: true,
                },
                strictTransportSecurity: {
                    accessControlMaxAge: cdk.Duration.days(365),
                    includeSubdomains: true,
                    override: true,
                },
            },
        });

        // Marketing edge-cache directives: viewers see max-age=60 so ordinary
        // browser caching stays short, but CloudFront honors s-maxage=86400
        // as its own object TTL. Any content refresh must reach the shared
        // caches by invalidation.
        const mktgEdgeHeaders = new cloudfront.ResponseHeadersPolicy(this, 'MktgEdgeHeaders', {
            responseHeadersPolicyName: `mktg-site-edge-headers-${sfx}`,
            comment: 'Marketing edge caching directives (viewer max-age, shared s-maxage)',
            customHeadersBehavior: {
                customHeaders: [
                    {
                        header: 'Cache-Control',
                        value: 'max-age=60, s-maxage=86400',
                        override: true,
                    },
                ],
            },
            securityHeadersBehavior: {
                contentTypeOptions: { override: true },
                frameOptions: {
                    frameOption: cloudfront.HeadersFrameOption.DENY,
                    override: true,
                },
                referrerPolicy: {
                    referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
                    override: true,
                },
                strictTransportSecurity: {
                    accessControlMaxAge: cdk.Duration.days(365),
                    includeSubdomains: true,
                    override: true,
                },
            },
        });

        const htmlCachePolicy = new cloudfront.CachePolicy(this, 'MktgHtmlCache', {
            cachePolicyName: `mktg-site-html-cache-${sfx}`,
            comment: 'Marketing HTML - 1 day TTL, invalidated by the publish pipeline',
            defaultTtl: cdk.Duration.days(1),
            minTtl: cdk.Duration.days(1),
            maxTtl: cdk.Duration.days(30),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
        });

        const assetCachePolicy = new cloudfront.CachePolicy(this, 'MktgAssetCache', {
            cachePolicyName: `mktg-site-assets-cache-${sfx}`,
            comment: 'Marketing static assets - 1 day TTL, invalidated by the publish pipeline',
            defaultTtl: cdk.Duration.days(1),
            minTtl: cdk.Duration.days(1),
            maxTtl: cdk.Duration.days(365),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
        });

        const pwAlphaCachePolicy = new cloudfront.CachePolicy(this, 'PwAlphaCache', {
            cachePolicyName: `pw-alpha-cache-${sfx}`,
            comment: 'Preview workspace portal - 1 hour TTL',
            defaultTtl: cdk.Duration.hours(1),
            minTtl: cdk.Duration.minutes(5),
            maxTtl: cdk.Duration.days(1),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
        });

        // ------------------------------------------------------------------
        // Distributions (private S3 origins via Origin Access Control)
        //
        // The marketing distribution routes viewer requests through an
        // Origin Shield tier in us-east-1 to cut round trips from the edge
        // to the origin bucket. The shield holds its own cached copy of
        // origin objects: invalidations must reach the shield or the edge
        // will keep serving from the shield's cache.
        // ------------------------------------------------------------------
        const mktgS3Origin = origins.S3BucketOrigin.withOriginAccessControl(mktgOrigin, {
            originAccessLevels: [cloudfront.AccessLevel.READ],
            originShieldEnabled: true,
            originShieldRegion: 'us-east-1',
        });

        const mktgDistribution = new cloudfront.Distribution(this, 'MktgDistribution', {
            comment: `marketing site (origin ${mktgOriginName})`,
            defaultRootObject: 'index.html',
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            defaultBehavior: {
                origin: mktgS3Origin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cachePolicy: htmlCachePolicy,
                responseHeadersPolicy: mktgEdgeHeaders,
                compress: true,
            },
            additionalBehaviors: {
                '/assets/*': {
                    origin: mktgS3Origin,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    cachePolicy: assetCachePolicy,
                    responseHeadersPolicy: mktgEdgeHeaders,
                    compress: true,
                },
            },
        });

        const pwAlphaS3Origin = origins.S3BucketOrigin.withOriginAccessControl(pwAlphaOrigin, {
            originAccessLevels: [cloudfront.AccessLevel.READ],
        });

        const pwAlphaDistribution = new cloudfront.Distribution(this, 'PwAlphaDistribution', {
            comment: `preview workspace portal (origin ${pwAlphaOriginName})`,
            defaultRootObject: 'index.html',
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            defaultBehavior: {
                origin: pwAlphaS3Origin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cachePolicy: pwAlphaCachePolicy,
                responseHeadersPolicy: securityHeaders,
                compress: true,
            },
        });

        // ------------------------------------------------------------------
        // Publisher sync-mode parameters
        // Values are opaque tokens interpreted by the publisher runtime.
        // ------------------------------------------------------------------
        const mktgSyncModeParamName = `/mktg/publisher/sync-mode`;
        new ssm.StringParameter(this, 'MktgSyncModeParam', {
            parameterName: mktgSyncModeParamName,
            stringValue: 'md5-len-only',
            description: 'Marketing publisher sync-mode token (opaque; consumed at cold start)',
            tier: ssm.ParameterTier.STANDARD,
        });

        const pwAlphaSyncModeParamName = `/pw-alpha/publisher/sync-mode`;
        new ssm.StringParameter(this, 'PwAlphaSyncModeParam', {
            parameterName: pwAlphaSyncModeParamName,
            stringValue: 'full-body-hash',
            description: 'pw-alpha publisher sync-mode token (opaque; consumed at cold start)',
            tier: ssm.ParameterTier.STANDARD,
        });

        // ------------------------------------------------------------------
        // Publisher Lambdas
        // ------------------------------------------------------------------
        const publisherCode = lambda.Code.fromAsset(path.join(__dirname, '../assets/publisher'));

        // --- marketing publisher -----------------------------------------
        const mktgFnName = `mktg-site-publisher-${sfx}`;
        const mktgLogGroup = new logs.LogGroup(this, 'MktgPublisherLogs', {
            logGroupName: `/aws/lambda/${mktgFnName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const mktgRoleName = `mktg-site-publisher-role-${sfx}`;
        const mktgRole = new iam.Role(this, 'MktgPublisherRole', {
            roleName: mktgRoleName,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Execution role for the marketing site publisher',
        });

        new iam.Policy(this, 'MktgPublisherPolicy', {
            policyName: `mktg-site-publisher-base-${sfx}`,
            roles: [mktgRole],
            statements: [
                new iam.PolicyStatement({
                    sid: 'ReadBuildArtifacts',
                    actions: ['s3:GetObject', 's3:GetObjectVersion'],
                    resources: [`${buildBucket.bucketArn}/releases/*`],
                }),
                new iam.PolicyStatement({
                    sid: 'ListBuildArtifacts',
                    actions: ['s3:ListBucket'],
                    resources: [buildBucket.bucketArn],
                }),
                new iam.PolicyStatement({
                    sid: 'WriteSiteOrigin',
                    actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
                    resources: [`${mktgOrigin.bucketArn}/*`],
                }),
                new iam.PolicyStatement({
                    sid: 'ListSiteOrigin',
                    actions: ['s3:ListBucket'],
                    resources: [mktgOrigin.bucketArn],
                }),
                new iam.PolicyStatement({
                    sid: 'WriteOwnLogs',
                    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                    resources: [mktgLogGroup.logGroupArn],
                }),
                new iam.PolicyStatement({
                    sid: 'ReadSyncModeParam',
                    actions: ['ssm:GetParameter'],
                    resources: [
                        `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${mktgSyncModeParamName}`,
                    ],
                }),
            ],
        });

        const mktgPublisher = new lambda.Function(this, 'MktgPublisher', {
            functionName: mktgFnName,
            description: 'Publishes the current marketing build to the CloudFront origin bucket',
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: publisherCode,
            role: mktgRole,
            logGroup: mktgLogGroup,
            timeout: cdk.Duration.minutes(5),
            memorySize: 512,
            environment: {
                SOURCE_BUCKET: buildBucketName,
                SOURCE_PREFIX: 'releases/current/',
                ORIGIN_BUCKET: mktgOriginName,
                DISTRIBUTION_ID: mktgDistribution.distributionId,
                CACHE_CONTROL: 'public, max-age=86400',
                MODE_SSM_PATH: mktgSyncModeParamName,
                LEGACY_ETAG_PREFIX: 'e-',
                CDN_HEADER_MODE: 'v1',
                PUBLISH_DRY_RUN: '',
            },
        });

        // --- pw-alpha publisher ------------------------------------------
        const pwAlphaFnName = `pw-alpha-publisher-${sfx}`;
        const pwAlphaLogGroup = new logs.LogGroup(this, 'PwAlphaPublisherLogs', {
            logGroupName: `/aws/lambda/${pwAlphaFnName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const pwAlphaRoleName = `pw-alpha-publisher-role-${sfx}`;
        const pwAlphaRole = new iam.Role(this, 'PwAlphaPublisherRole', {
            roleName: pwAlphaRoleName,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Execution role for the pw-alpha publisher',
        });

        new iam.Policy(this, 'PwAlphaPublisherPolicy', {
            policyName: `pw-alpha-publisher-base-${sfx}`,
            roles: [pwAlphaRole],
            statements: [
                new iam.PolicyStatement({
                    sid: 'ReadBuildArtifacts',
                    actions: ['s3:GetObject', 's3:GetObjectVersion'],
                    resources: [`${buildBucket.bucketArn}/pw-alpha-releases/*`],
                }),
                new iam.PolicyStatement({
                    sid: 'ListBuildArtifacts',
                    actions: ['s3:ListBucket'],
                    resources: [buildBucket.bucketArn],
                }),
                new iam.PolicyStatement({
                    sid: 'WriteSiteOrigin',
                    actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
                    resources: [`${pwAlphaOrigin.bucketArn}/*`],
                }),
                new iam.PolicyStatement({
                    sid: 'ListSiteOrigin',
                    actions: ['s3:ListBucket'],
                    resources: [pwAlphaOrigin.bucketArn],
                }),
                new iam.PolicyStatement({
                    sid: 'WriteOwnLogs',
                    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                    resources: [pwAlphaLogGroup.logGroupArn],
                }),
                new iam.PolicyStatement({
                    sid: 'ReadSyncModeParam',
                    actions: ['ssm:GetParameter'],
                    resources: [
                        `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${pwAlphaSyncModeParamName}`,
                    ],
                }),
                new iam.PolicyStatement({
                    sid: 'InvalidatePwAlphaDistribution',
                    actions: ['cloudfront:CreateInvalidation'],
                    resources: [
                        `arn:${this.partition}:cloudfront::${this.account}:distribution/${pwAlphaDistribution.distributionId}`,
                    ],
                }),
            ],
        });

        const pwAlphaPublisher = new lambda.Function(this, 'PwAlphaPublisher', {
            functionName: pwAlphaFnName,
            description: 'Publishes the current pw-alpha build to the CloudFront origin bucket',
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: publisherCode,
            role: pwAlphaRole,
            logGroup: pwAlphaLogGroup,
            timeout: cdk.Duration.minutes(5),
            memorySize: 512,
            environment: {
                SOURCE_BUCKET: buildBucketName,
                SOURCE_PREFIX: 'pw-alpha-releases/current/',
                ORIGIN_BUCKET: pwAlphaOriginName,
                DISTRIBUTION_ID: pwAlphaDistribution.distributionId,
                CACHE_CONTROL: 'public, max-age=3600',
                MODE_SSM_PATH: pwAlphaSyncModeParamName,
                LEGACY_ETAG_PREFIX: 'e-',
                CDN_HEADER_MODE: 'v1',
                PUBLISH_DRY_RUN: '',
            },
        });

        // ------------------------------------------------------------------
        // Pipeline wiring: manifest upload triggers the matching publisher
        // ------------------------------------------------------------------
        buildBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.LambdaDestination(mktgPublisher),
            { prefix: 'releases/current/', suffix: 'manifest.json' },
        );
        buildBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.LambdaDestination(pwAlphaPublisher),
            { prefix: 'pw-alpha-releases/current/', suffix: 'manifest.json' },
        );

        // ------------------------------------------------------------------
        // Operational monitoring
        // ------------------------------------------------------------------
        const alertTopic = new sns.Topic(this, 'AlertTopic', {
            topicName: `web-platform-alerts-${sfx}`,
            displayName: 'Web platform publish alerts',
        });

        const mktgAlarm = new cloudwatch.Alarm(this, 'MktgPublisherErrors', {
            alarmName: `mktg-site-publisher-errors-${sfx}`,
            alarmDescription: 'Marketing publisher Lambda invocation errors',
            metric: mktgPublisher.metricErrors({ period: cdk.Duration.minutes(5) }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        mktgAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));

        const pwAlphaAlarm = new cloudwatch.Alarm(this, 'PwAlphaPublisherErrors', {
            alarmName: `pw-alpha-publisher-errors-${sfx}`,
            alarmDescription: 'pw-alpha publisher Lambda invocation errors',
            metric: pwAlphaPublisher.metricErrors({ period: cdk.Duration.minutes(5) }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        pwAlphaAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));

        // ------------------------------------------------------------------
        // QA bookkeeping parameters
        // ------------------------------------------------------------------
        const roleBaselineParam = `/webplatform/${sfx}/mktg-site/publisher-baseline`;
        new ssm.StringParameter(this, 'PublisherBaselineParam', {
            parameterName: roleBaselineParam,
            stringValue: '{}',
            description: 'Captured baseline of the marketing publisher role and function config',
            tier: ssm.ParameterTier.STANDARD,
        });

        const cacheBaselineParam = `/webplatform/${sfx}/mktg-site/cache-baseline-epoch`;
        new ssm.StringParameter(this, 'CacheBaselineParam', {
            parameterName: cacheBaselineParam,
            stringValue: '0',
            description: 'Epoch seconds of the last cache-warm operation performed by the delivery pipeline',
            tier: ssm.ParameterTier.STANDARD,
        });

        // ------------------------------------------------------------------
        // Outputs
        // ------------------------------------------------------------------
        StackUtils.exportStack(this, 'OriginBucketName', mktgOriginName, 'Marketing site CloudFront origin bucket');
        StackUtils.exportStack(this, 'PwAlphaOriginBucketName', pwAlphaOriginName, 'pw-alpha portal CloudFront origin bucket');
        StackUtils.exportStack(this, 'BuildArtifactsBucketName', buildBucketName, 'Shared build artifacts bucket');
        StackUtils.exportStack(this, 'PublisherFunctionName', mktgFnName, 'Marketing site publisher function');
        StackUtils.exportStack(this, 'PwAlphaPublisherFunctionName', pwAlphaFnName, 'pw-alpha portal publisher function');
        StackUtils.exportStack(this, 'PublisherRoleName', mktgRoleName, 'Marketing site publisher execution role');
        StackUtils.exportStack(this, 'PublisherLogGroupName', `/aws/lambda/${mktgFnName}`, 'Marketing publisher log group');
        StackUtils.exportStack(this, 'SourcePrefix', 'releases/current/', 'Artifacts prefix published to the marketing site');
        StackUtils.exportStack(this, 'RoleBaselineParameterName', roleBaselineParam, 'SSM parameter holding the publisher baseline snapshot');
        StackUtils.exportStack(this, 'CacheBaselineParameterName', cacheBaselineParam, 'SSM parameter holding the cache warm epoch');
        StackUtils.exportStack(this, 'MktgSyncModeParameterName', mktgSyncModeParamName, 'SSM parameter storing the marketing publisher sync-mode token');
        // CloudFront assigns distribution ids and domain names, so they cannot be
        // exported as literals.
        StackUtils.exportStack(this, 'OriginDomainName', `${mktgOriginName}.s3.${this.region}.amazonaws.com`, 'Origin domain of the marketing distribution');
        StackUtils.exportStack(this, 'PwAlphaOriginDomainName', `${pwAlphaOriginName}.s3.${this.region}.amazonaws.com`, 'Origin domain of the pw-alpha distribution');
    }
}
