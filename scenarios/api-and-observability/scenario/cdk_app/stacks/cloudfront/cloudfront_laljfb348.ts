import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: cloudfront-laljfb348
 *
 * dde69128-b792-408f-ac15-4f51159d5370
 *
 * What the stack does:
 * 1. Creates S3 bucket for tenant services content
 * 2. Creates Origin Access Control for S3
 * 3. Creates CloudFront multi-tenant distribution (CfnDistribution, connection_mode=tenant-only)
 * 4. Creates CloudFront connection group
 * 5. Creates Route53 hosted zone for basalt-tenant.net
 */

export class Cloudfront_laljfb348 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // S3 bucket for tenant services content
        // intentional: no bucket policy granting CloudFront OAC access
        const tenantServicesBucket = new s3.CfnBucket(this, 'TenantServicesBucket', {
            bucketName: `basalt-tenant-services-${this.account}-${this.region}`,
            versioningConfiguration: { status: 'Enabled' },
            bucketEncryption: {
                serverSideEncryptionConfiguration: [{
                    serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' },
                }],
            },
            publicAccessBlockConfiguration: {
                blockPublicAcls: true,
                blockPublicPolicy: true,
                ignorePublicAcls: true,
                restrictPublicBuckets: true,
            },
            tags: [{ key: 'Name', value: `basalt-tenant-services-${this.account}-${this.region}` }],
        });
        tenantServicesBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Bucket policy: SSL-deny only — intentionally missing CloudFront OAC grant
        // intentional: preserved from schema
        new s3.CfnBucketPolicy(this, 'TenantServicesBucketPolicy', {
            bucket: tenantServicesBucket.ref,
            policyDocument: {
                Version: '2012-10-17',
                Statement: [
                    {
                        Sid: 'DenyNonSSL',
                        Effect: 'Deny',
                        Principal: { AWS: '*' },
                        Action: 's3:*',
                        Resource: [
                            `arn:aws:s3:::basalt-tenant-services-${this.account}-${this.region}`,
                            `arn:aws:s3:::basalt-tenant-services-${this.account}-${this.region}/*`,
                        ],
                        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
                    },
                ],
            },
        });

        // Origin Access Control for S3
        const oac = new cloudfront.CfnOriginAccessControl(this, 'TenantOAC', {
            originAccessControlConfig: {
                name: `tenant-oac-${this.account}`,
                originAccessControlOriginType: 's3',
                signingBehavior: 'always',
                signingProtocol: 'sigv4',
            },
        });

        // CloudFront Connection Group
        const connectionGroup = new cloudfront.CfnConnectionGroup(this, 'TenantConnectionGroup', {
            name: `tenant-services-connection-group-${this.account}`,
            enabled: true,
            ipv6Enabled: true,
        });

        // Multi-tenant distribution (CfnDistribution, connection_mode=tenant-only)
        // TenantPath parameter routes each tenant to their S3 keyspace
        const distribution = new cloudfront.CfnDistribution(this, 'MultiTenantDistribution', {
            distributionConfig: {
                enabled: true,
                comment: 'CloudFront Manager - Multi-tenant distribution',
                connectionMode: 'tenant-only',
                origins: [{
                    id: 'S3Origin',
                    domainName: `basalt-tenant-services-${this.account}-${this.region}.s3.${this.region}.amazonaws.com`,
                    originPath: '/{{TenantPath}}',
                    originAccessControlId: oac.attrId,
                    s3OriginConfig: { originAccessIdentity: '' },
                }],
                defaultCacheBehavior: {
                    targetOriginId: 'S3Origin',
                    viewerProtocolPolicy: 'redirect-to-https',
                    allowedMethods: ['GET', 'HEAD'],
                    cachedMethods: ['GET', 'HEAD'],
                    cachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // CachingOptimized
                    compress: true,
                },
                httpVersion: 'http2',
                viewerCertificate: {
                    cloudFrontDefaultCertificate: true,
                    minimumProtocolVersion: 'TLSv1.2_2021',
                },
                tenantConfig: {
                    parameterDefinitions: [{
                        name: 'TenantPath',
                        definition: {
                            stringSchema: {
                                comment: 'S3 keyspace prefix for this tenant',
                                required: true,
                            },
                        },
                    }],
                },
            },
        });

        // Route53 hosted zone for tenant domain
        const tenantHostedZone = new route53.HostedZone(this, 'TenantHostedZone', {
            zoneName: 'basalt-tenant.net',
        });

        // Stack Exports
        StackUtils.exportStack(this, 'TenantServicesBucketName', tenantServicesBucket.ref, 'Tenant services S3 bucket name');
        StackUtils.exportStack(this, 'DistributionId', distribution.attrId, 'CloudFront distribution ID');
        StackUtils.exportStack(this, 'ConnectionGroupId', connectionGroup.attrId, 'CloudFront connection group ID');
        StackUtils.exportStack(this, 'ConnectionGroupRoutingEndpoint', connectionGroup.attrRoutingEndpoint, 'CloudFront connection group routing endpoint');
        StackUtils.exportStack(this, 'HostedZoneId', tenantHostedZone.hostedZoneId, 'Route53 hosted zone ID');
        StackUtils.exportStack(this, 'OACId', oac.attrId, 'Origin Access Control ID');
    }
}
