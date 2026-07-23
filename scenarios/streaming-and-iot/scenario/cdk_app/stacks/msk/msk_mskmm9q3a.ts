import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: msk_mskmm9q3a
 *
 * Precondition for the kafka-lambda-esm-iam-sasl task. Single MSK
 * Provisioned cluster, IAM SASL auth, plus an S3 sink bucket the agent's
 * Lambda will write to and a pre-created Kafka topic the ESM consumes.
 *
 * Sizing: kafka.m5.large x 2 brokers (the smallest broker type that
 * supports IAM SASL -- t3.small hits SaslAuthenticationException because
 * its 1-conn/sec/broker quota is exhausted by IAM auth flows; AWS docs
 * recommend m5.large or larger). Two brokers across two AZs is the MSK
 * Provisioned minimum -- enough for the IAM-SASL ESM behavioral gate,
 * without the create-time cost of a third broker.
 *
 * Cost: ~$0.21/hr x 2 brokers x 24 x 30 ~= $300/mo while deployed.
 * Tear down the scenario when not actively iterating on this task.
 *
 * Resources:
 *   - Multi-AZ private VPC (2 AZs, no NAT gateways)
 *   - 2-broker MSK cluster, IAM SASL on, TLS in transit + in cluster
 *   - AWS::MSK::Topic for `bench-events` (3 partitions, RF=2) -- verifier
 *     and agent's Lambda ESM both read from this topic name
 *   - S3 sink bucket for the agent's Lambda to write decoded records
 *
 * The topic is empty at deploy time. We don't seed records -- that would
 * require a custom-resource Lambda with kafka-python + IAM SASL signer
 * (the only mechanism AWS provides for broker-level produce). Instead,
 * the verifier uses ESM `State == Enabled` as the behavioral gate: AWS
 * won't transition ESM to Enabled unless the agent's VPC config, SG
 * ingress, IAM auth, and kafka-cluster permissions are all correct.
 */
export class msk_mskmm9q3a extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // brokerCount must be an integer multiple of the clientSubnet count
        // (one subnet per AZ below), so keep this and maxAzs in lockstep.
        const brokerCount = 2;
        const topicName = 'bench-events';

        const vpc = new ec2.Vpc(this, 'MskVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.70.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                { name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
            ],
            restrictDefaultSecurityGroup: false,
        });

        const sg = new ec2.SecurityGroup(this, 'MskSg', {
            vpc,
            description: 'Permits Kafka traffic from inside the VPC',
            allowAllOutbound: true,
        });
        sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(9092), 'Kafka plaintext');
        sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(9094), 'Kafka TLS');
        sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(9098), 'Kafka IAM');

        const cluster = new msk.CfnCluster(this, 'MskCluster', {
            // CFN replacement creates the new cluster before deleting the old,
            // so a fixed name collides (AlreadyExists) on live envs — bump the
            // v-suffix with any replacement-forcing change (e.g. ClientSubnets).
            clusterName: `bench-source-v2-${this.account.slice(-6)}`,
            kafkaVersion: '3.6.0',
            numberOfBrokerNodes: brokerCount,
            brokerNodeGroupInfo: {
                // m5.large is the cheapest type AWS confirms supports IAM SASL.
                // Cf. https://repost.aws/knowledge-center/msk-cluster-iam-sasl-scram
                instanceType: 'kafka.m5.large',
                clientSubnets: vpc.isolatedSubnets.map((s) => s.subnetId),
                securityGroups: [sg.securityGroupId],
                storageInfo: {
                    ebsStorageInfo: { volumeSize: 10 },
                },
            },
            clientAuthentication: {
                sasl: { iam: { enabled: true } },
            },
            encryptionInfo: {
                encryptionInTransit: {
                    clientBroker: 'TLS',
                    inCluster: true,
                },
            },
        });
        cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // AWS::MSK::Topic -- control-plane topic creation against the
        // cluster. No client-side admin call needed.
        // https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-msk-topic.html
        const topic = new cdk.CfnResource(this, 'BenchTopic', {
            type: 'AWS::MSK::Topic',
            properties: {
                ClusterArn: cluster.attrArn,
                TopicName: topicName,
                PartitionCount: 3,
                ReplicationFactor: brokerCount,
            },
        });
        topic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
        topic.addDependency(cluster);

        // S3 sink bucket the agent's Lambda writes records to.
        const sink = new s3.Bucket(this, 'KafkaSinkBucket', {
            bucketName: `kafka-sink-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant the
        // bucket policy gives its exact role ARN. If that grant is stale or
        // gone at delete time, the handler fails its first call
        // (s3:GetBucketTagging) with AccessDenied, the stack delete
        // force-abandons this FIXED-NAME bucket, and every later deploy fails
        // changeset validation with "already exists" — an unrecoverable
        // reset->redeploy loop. Granting the role directly removes the
        // dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                sink.bucketArn,
                `${sink.bucketArn}/*`,
            ],
        });

        StackUtils.exportStack(this, 'ClusterArn', cluster.attrArn, 'MSK cluster ARN');
        StackUtils.exportStack(this, 'TopicName', topicName, 'Pre-created Kafka topic the agent\'s Lambda consumes');
        StackUtils.exportStack(this, 'SinkBucketName', sink.bucketName, 'S3 bucket the agent\'s Lambda writes records to');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC hosting the cluster');
    }
}
