import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as amazonmq from 'aws-cdk-lib/aws-amazonmq';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Amazon MQ RabbitMQ Lambda Stack
 *
 * Converted from aws-cdk-examples/typescript/amazon-mq-rabbitmq-lambda
 * Uses L1 CfnBroker construct instead of @cdklabs/cdk-amazonmq alpha.
 *
 * Creates:
 * 1. VPC (maxAzs 2, PRIVATE_ISOLATED subnets)
 * 2. Security Group (allow 5671 AMQPS from VPC CIDR)
 * 3. Secrets Manager Secret for broker credentials
 * 4. CfnBroker (RabbitMQ, single instance, private)
 * 5. CloudWatch LogGroup
 * 6. Lambda Function (inline consumer)
 * 7. CfnEventSourceMapping (RabbitMQ to Lambda)
 */

export class MqRabbitmqLambdaStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // VPC with PRIVATE_ISOLATED subnets
        const vpc = new ec2.Vpc(this, 'RabbitMqVpc', {
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'Isolated',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
        });

        // VPC Endpoints for Lambda to access AWS services from isolated subnets
        vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        });

        // Security Group - allow AMQPS from VPC CIDR
        const brokerSg = new ec2.SecurityGroup(this, 'BrokerSecurityGroup', {
            vpc,
            description: 'Security group for RabbitMQ broker',
            allowAllOutbound: true,
        });
        brokerSg.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(5671),
            'Allow AMQPS from VPC CIDR',
        );

        // Secrets Manager Secret for broker credentials
        const secret = new secretsmanager.Secret(this, 'BrokerSecret', {
            secretName: `rabbitmq-broker-credentials-${this.account}-${this.region}`,
            description: 'Credentials for RabbitMQ broker',
            generateSecretString: {
                secretStringTemplate: JSON.stringify({ username: 'admin' }),
                generateStringKey: 'password',
                excludePunctuation: true,
                passwordLength: 24,
            },
        });
        secret.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // CfnBroker (RabbitMQ, SINGLE_INSTANCE, private)
        const broker = new amazonmq.CfnBroker(this, 'RabbitMqBroker', {
            brokerName: `rabbitmq-broker-${this.account}-${this.region}`,
            engineType: 'RABBITMQ',
            engineVersion: '3.13',
            hostInstanceType: 'mq.m5.large',
            deploymentMode: 'SINGLE_INSTANCE',
            publiclyAccessible: false,
            autoMinorVersionUpgrade: true,
            subnetIds: [vpc.isolatedSubnets[0].subnetId],
            securityGroups: [brokerSg.securityGroupId],
            users: [
                {
                    username: 'admin',
                    password: secret.secretValueFromJson('password').unsafeUnwrap(),
                },
            ],
            logs: {
                general: true,
            },
        });
        broker.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // CloudWatch LogGroup
        const logGroup = new logs.LogGroup(this, 'RabbitMqLogGroup', {
            logGroupName: `/aws/amazonmq/rabbitmq-broker-${this.account}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Lambda Function (consumer)
        const fn = new lambda.Function(this, 'RabbitMqConsumer', {
            functionName: `rabbitmq-consumer-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/mq-rabbitmq-consumer')),
            timeout: cdk.Duration.seconds(60),
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        });

        // Grant Lambda read access to the secret
        secret.grantRead(fn);

        // Grant Lambda permissions for MQ
        fn.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    'mq:DescribeBroker',
                    'ec2:CreateNetworkInterface',
                    'ec2:DescribeNetworkInterfaces',
                    'ec2:DescribeVpcs',
                    'ec2:DeleteNetworkInterface',
                    'ec2:DescribeSubnets',
                    'ec2:DescribeSecurityGroups',
                ],
                resources: ['*'],
            }),
        );

        // CfnEventSourceMapping (RabbitMQ to Lambda)
        const eventSourceMapping = new lambda.CfnEventSourceMapping(this, 'RabbitMQEventSource', {
            functionName: fn.functionName,
            eventSourceArn: broker.attrArn,
            queues: ['testQueue'],
            sourceAccessConfigurations: [
                { type: 'BASIC_AUTH', uri: secret.secretArn },
                { type: 'VIRTUAL_HOST', uri: '/' },
            ],
            batchSize: 1,
        });
        eventSourceMapping.addDependency(broker);

        // Exports
        StackUtils.exportStack(this, 'BrokerArn', broker.attrArn, 'RabbitMQ broker ARN');
        StackUtils.exportStack(this, 'BrokerId', broker.ref, 'RabbitMQ broker ID');
        StackUtils.exportStack(this, 'BrokerName', broker.brokerName, 'RabbitMQ broker name');
        StackUtils.exportStack(this, 'SecretArn', secret.secretArn, 'Secrets Manager secret ARN for broker credentials');
        StackUtils.exportStack(this, 'FunctionName', fn.functionName, 'Lambda consumer function name');
        StackUtils.exportStack(this, 'FunctionArn', fn.functionArn, 'Lambda consumer function ARN');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID for RabbitMQ infrastructure');
        StackUtils.exportStack(this, 'SecurityGroupId', brokerSg.securityGroupId, 'Security group ID for RabbitMQ broker');
        StackUtils.exportStack(this, 'QueueName', 'testQueue', 'RabbitMQ queue name');
        StackUtils.exportStack(this, 'EngineType', 'RABBITMQ', 'Broker engine type');
        StackUtils.exportStack(this, 'EngineVersion', '3.13', 'Broker engine version');
        StackUtils.exportStack(this, 'HostInstanceType', 'mq.m5.large', 'Broker host instance type');
    }
}
