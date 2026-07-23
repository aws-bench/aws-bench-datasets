import * as cdk from 'aws-cdk-lib';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: opensearch-9f79baa8e
 *
 * d32cf4bb-9a10-4001-90c9-e846b182abca
 *
 * What the stack does:
 * 1. Creates a VPC with public and private subnets
 * 2. Creates security groups for OpenSearch and ALB
 * 3. Creates a KMS key for OpenSearch encryption at rest
 * 4. Creates a Cognito User Pool, User Pool Client, and Identity Pool for dashboard auth
 * 5. Creates an IAM role for OpenSearch Cognito access
 * 6. Creates a VPC-based OpenSearch domain with Cognito dashboard authentication
 * 7. Creates an internal ALB with a target group (HTTPS listener created by setup script)
 *
 * Intentional state after setup script runs:
 * - A self-signed TLS cert is imported into ACM and an HTTPS:443 listener is created on the ALB
 * - The ALB target group is populated with the OpenSearch VPC endpoint IPs (working data path)
 * - The Cognito user pool client callback URL is set to the raw VPC endpoint instead of the ALB DNS
 * - The OpenSearch domain has no custom endpoint configured
 * The only issue: after Cognito auth completes, the browser is redirected to the
 * private VPC endpoint, which is unreachable outside the VPC.
 */

export class Opensearch_9f79baa8e extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'Vpc', {
            vpcName: `basalt-vpc-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    cidrMask: 20,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 20,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
        });

        const opensearchSg = new ec2.SecurityGroup(this, 'OpenSearchSg', {
            vpc,
            securityGroupName: `basalt-opensearch-sg-${this.account}-${this.region}`,
            description: 'Security group for OpenSearch domain',
            allowAllOutbound: true,
        });

        opensearchSg.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(443),
            'Allow HTTPS from VPC',
        );

        const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
            vpc,
            securityGroupName: `basalt-alb-sg-${this.account}-${this.region}`,
            description: 'Security group for ALB',
            allowAllOutbound: true,
        });

        albSg.addIngressRule(
            ec2.Peer.ipv4('10.0.0.0/8'),
            ec2.Port.tcp(443),
            'Allow HTTPS from corporate network',
        );

        const kmsKey = new kms.Key(this, 'KmsKey', {
            alias: `alias/basalt-opensearch-key-${this.account}-${this.region}`,
            description: 'KMS key for OpenSearch encryption at rest',
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const userPool = new cognito.UserPool(this, 'UserPool', {
            userPoolName: `basalt-user-pool-${this.account}-${this.region}`,
            selfSignUpEnabled: false,
            signInAliases: {
                email: true,
                username: true,
            },
            autoVerify: {
                email: true,
            },
            standardAttributes: {
                email: {
                    required: true,
                    mutable: true,
                },
            },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        userPool.addDomain('UserPoolDomain', {
            cognitoDomain: {
                domainPrefix: `basalt-auth-${this.account}`,
            },
        });

        // ALB is created before the user pool client so its DNS name can be used as the callback URL.
        // The setup script will overwrite the callback URL with the raw VPC endpoint after deployment.
        const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
            loadBalancerName: `basalt-alb-${this.account}`.substring(0, 32),
            vpc,
            internetFacing: false,
            securityGroup: albSg,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
        });

        const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
            userPool,
            userPoolClientName: `basalt-client-${this.account}-${this.region}`,
            generateSecret: false,
            oAuth: {
                flows: {
                    authorizationCodeGrant: true,
                    implicitCodeGrant: true,
                },
                scopes: [
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.PROFILE,
                ],
                callbackUrls: [
                    `https://${alb.loadBalancerDnsName}/_dashboards/app/home`,
                ],
            },
            supportedIdentityProviders: [
                cognito.UserPoolClientIdentityProvider.COGNITO,
            ],
            refreshTokenValidity: cdk.Duration.days(30),
        });

        const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
            identityPoolName: `basalt_identity_pool_${this.account}_${this.region}`.replace(/-/g, '_'),
            allowUnauthenticatedIdentities: false,
            cognitoIdentityProviders: [
                {
                    clientId: userPoolClient.userPoolClientId,
                    providerName: userPool.userPoolProviderName,
                },
            ],
        });

        const cognitoAccessRole = new iam.Role(this, 'CognitoAccessRole', {
            roleName: `BasaltCognitoAccessRole-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('es.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonOpenSearchServiceCognitoAccess'),
            ],
        });

        const authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
            roleName: `BasaltCognitoAuthRole-${this.account}-${this.region}`,
            assumedBy: new iam.FederatedPrincipal(
                'cognito-identity.amazonaws.com',
                {
                    StringEquals: {
                        'cognito-identity.amazonaws.com:aud': identityPool.ref,
                    },
                    'ForAnyValue:StringLike': {
                        'cognito-identity.amazonaws.com:amr': 'authenticated',
                    },
                },
                'sts:AssumeRoleWithWebIdentity',
            ),
        });

        new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
            identityPoolId: identityPool.ref,
            roles: {
                authenticated: authenticatedRole.roleArn,
            },
        });

        const domain = new opensearch.Domain(this, 'Domain', {
            domainName: `basalt-search-domain-${this.account}`.substring(0, 28),
            version: opensearch.EngineVersion.OPENSEARCH_2_11,
            capacity: {
                dataNodes: 1,
                dataNodeInstanceType: 't3.small.search',
                masterNodes: 0,
            },
            ebs: {
                enabled: true,
                volumeSize: 10,
                volumeType: ec2.EbsDeviceVolumeType.GP3,
                iops: 3000,
                throughput: 125,
            },
            vpc,
            vpcSubnets: [
                {
                    subnets: vpc.privateSubnets.slice(0, 1),
                },
            ],
            securityGroups: [opensearchSg],
            encryptionAtRest: {
                enabled: true,
                kmsKey,
            },
            nodeToNodeEncryption: true,
            enforceHttps: true,
            tlsSecurityPolicy: opensearch.TLSSecurityPolicy.TLS_1_2,
            cognitoDashboardsAuth: {
                role: cognitoAccessRole,
                identityPoolId: identityPool.ref,
                userPoolId: userPool.userPoolId,
            },
            accessPolicies: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    principals: [new iam.AnyPrincipal()],
                    actions: ['es:*'],
                    resources: ['*'],
                    conditions: {
                        StringEquals: { 'aws:PrincipalAccount': cdk.Aws.ACCOUNT_ID },
                    },
                }),
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
            targetGroupName: `basalt-tg-${this.account}`.substring(0, 32),
            vpc,
            port: 443,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                enabled: true,
                protocol: elbv2.Protocol.HTTPS,
                port: '443',
                path: '/',
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 5,
                healthyHttpCodes: '200,302',
            },
        });

        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID');
        StackUtils.exportStack(this, 'OpenSearchDomainName', domain.domainName, 'OpenSearch domain name');
        StackUtils.exportStack(this, 'OpenSearchDomainEndpoint', domain.domainEndpoint, 'OpenSearch domain endpoint');
        StackUtils.exportStack(this, 'OpenSearchDomainArn', domain.domainArn, 'OpenSearch domain ARN');
        StackUtils.exportStack(this, 'UserPoolId', userPool.userPoolId, 'Cognito User Pool ID');
        StackUtils.exportStack(this, 'UserPoolClientId', userPoolClient.userPoolClientId, 'Cognito User Pool Client ID');
        StackUtils.exportStack(this, 'IdentityPoolId', identityPool.ref, 'Cognito Identity Pool ID');
        StackUtils.exportStack(this, 'AlbDnsName', alb.loadBalancerDnsName, 'ALB DNS name');
        StackUtils.exportStack(this, 'AlbArn', alb.loadBalancerArn, 'ALB ARN');
        StackUtils.exportStack(this, 'TargetGroupArn', targetGroup.targetGroupArn, 'Target Group ARN');
    }
}
