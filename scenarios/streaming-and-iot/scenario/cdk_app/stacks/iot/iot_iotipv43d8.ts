import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iot from 'aws-cdk-lib/aws-iot';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: iot_iotipv43d8
 *
 * Precondition for the iot-thing-vpc-endpoint-ipv4 task.
 *
 * Resources:
 *  - VPC across multiple AZs.
 *  - IoT Core data-plane interface VPC endpoint, IPv4 only.
 *  - One IoT Thing the task targets.
 *
 * The agent's job is to attach a thing policy + connect the thing to use
 * the IPv4-only VPCE for all API calls. Verifier checks the policy
 * statements + that the VPCE was used (presence + IpAddressType=IPV4).
 *
 * Portability: iot.data is not present in every AZ. We rely on CDK's
 * `lookupSupportedAzs: true`, which calls DescribeVpcEndpointServices at
 * synth time and caches the result in cdk.context.json. CDK only places
 * the VPCE in supported AZs.
 * https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.InterfaceVpcEndpointProps.html
 *
 * Cost: VPC endpoints are ~$7.30/month per AZ enabled.
 */
export class iot_iotipv43d8 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'IotVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
            maxAzs: 3,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
            restrictDefaultSecurityGroup: false,
        });

        const sg = new ec2.SecurityGroup(this, 'IotVpceSg', {
            vpc,
            description: 'Allow HTTPS from inside the VPC to the IoT data VPCE',
            allowAllOutbound: false,
        });
        sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), 'HTTPS from VPC');

        // L2 InterfaceVpcEndpoint: lookupSupportedAzs filters automatically;
        // ipAddressType pins the endpoint to IPv4.
        // privateDnsEnabled must be false because iot.data does not provide
        // a private DNS name.
        const iotDataVpce = new ec2.InterfaceVpcEndpoint(this, 'IotDataVpce', {
            vpc,
            service: new ec2.InterfaceVpcEndpointService(
                `com.amazonaws.${this.region}.iot.data`,
                443,
            ),
            ipAddressType: ec2.VpcEndpointIpAddressType.IPV4,
            privateDnsEnabled: false,
            lookupSupportedAzs: true,
            subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [sg],
        });

        // The IoT Thing the agent operates on. Stable name so the verifier
        // can address it without env-var indirection.
        const thing = new iot.CfnThing(this, 'BenchThing', {
            thingName: `bench-thing-${this.account.slice(-6)}`,
        });
        thing.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        StackUtils.exportStack(this, 'ThingName', thing.thingName!, 'IoT thing name');
        StackUtils.exportStack(this, 'VPCEndpoint', iotDataVpce.vpcEndpointId, 'IPv4-only IoT data VPC endpoint id');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC hosting the endpoint');
    }
}
