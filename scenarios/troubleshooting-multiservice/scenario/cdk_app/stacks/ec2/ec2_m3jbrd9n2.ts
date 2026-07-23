import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as networkfirewall from 'aws-cdk-lib/aws-networkfirewall';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ec2-m3jbrd9n2
 *
 * 62ef35a0-7c00-4159-ad4a-f3436adfbcd6
 * 
 * What the stack does:
 * Creates a multi-VPC network architecture with Transit Gateway and Network Firewalls:
 * 1. Three VPCs: workload VPC (10.1.0.0/16), DMZ VPC (10.2.0.0/16), and additional VPC (10.3.0.0/16)
 * 2. Transit Gateway connecting all VPCs with route table and static routes
 * 3. EC2 instance in workload VPC with SSM management enabled
 * 4. Network Firewalls (inbound and outbound) deployed in DMZ VPC
 * 5. Subnets and route tables for workload VPC
 */

export class Ec2_m3jbrd9n2 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create Workload VPC (10.1.0.0/16)
        const workloadVpc = new ec2.Vpc(this, 'WorkloadVPC', {
            ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'workload-subnet',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
            enableDnsHostnames: true,
            enableDnsSupport: true,
        });

        // Create DMZ VPC (10.2.0.0/16)
        const dmzVpc = new ec2.Vpc(this, 'DMZVPC', {
            ipAddresses: ec2.IpAddresses.cidr('10.2.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'dmz-subnet',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
            enableDnsHostnames: true,
            enableDnsSupport: true,
        });
        cdk.Tags.of(dmzVpc).add('Name', 'DMZVPC');

        // Create Additional VPC 1 (10.3.0.0/16)
        const additionalVpc1 = new ec2.Vpc(this, 'AdditionalVPC1', {
            ipAddresses: ec2.IpAddresses.cidr('10.3.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'additional-subnet',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
            enableDnsHostnames: true,
            enableDnsSupport: true,
        });

        // Create Transit Gateway
        const transitGateway = new ec2.CfnTransitGateway(this, 'MainTransitGateway', {
            amazonSideAsn: 64512,
            defaultRouteTableAssociation: 'disable',
            defaultRouteTablePropagation: 'disable',
            dnsSupport: 'enable',
            vpnEcmpSupport: 'enable',
            tags: [
                {
                    key: 'Name',
                    value: 'main-transit-gateway',
                },
            ],
        });

        // Create Transit Gateway Route Table
        const tgwRouteTable = new ec2.CfnTransitGatewayRouteTable(this, 'MainTGWRouteTable', {
            transitGatewayId: transitGateway.attrId,
            tags: [
                {
                    key: 'Name',
                    value: 'main-tgw-route-table',
                },
            ],
        });

        // Create Transit Gateway Attachments
        const workloadAttachment = new ec2.CfnTransitGatewayAttachment(this, 'WorkloadVPCAttachment', {
            transitGatewayId: transitGateway.attrId,
            vpcId: workloadVpc.vpcId,
            subnetIds: workloadVpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
            tags: [
                {
                    key: 'Name',
                    value: 'workload-vpc-attachment',
                },
            ],
        });

        const dmzAttachment = new ec2.CfnTransitGatewayAttachment(this, 'DMZVPCAttachment', {
            transitGatewayId: transitGateway.attrId,
            vpcId: dmzVpc.vpcId,
            subnetIds: dmzVpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
            tags: [
                {
                    key: 'Name',
                    value: 'dmz-vpc-attachment',
                },
            ],
        });

        const additionalAttachment1 = new ec2.CfnTransitGatewayAttachment(this, 'AdditionalVPC1Attachment', {
            transitGatewayId: transitGateway.attrId,
            vpcId: additionalVpc1.vpcId,
            subnetIds: additionalVpc1.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
            tags: [
                {
                    key: 'Name',
                    value: 'additional-vpc-1-attachment',
                },
            ],
        });

        // Associate attachments with route table
        new ec2.CfnTransitGatewayRouteTableAssociation(this, 'WorkloadAttachmentAssociation', {
            transitGatewayAttachmentId: workloadAttachment.attrId,
            transitGatewayRouteTableId: tgwRouteTable.ref,
        });

        new ec2.CfnTransitGatewayRouteTableAssociation(this, 'DMZAttachmentAssociation', {
            transitGatewayAttachmentId: dmzAttachment.attrId,
            transitGatewayRouteTableId: tgwRouteTable.ref,
        });

        new ec2.CfnTransitGatewayRouteTableAssociation(this, 'AdditionalAttachment1Association', {
            transitGatewayAttachmentId: additionalAttachment1.attrId,
            transitGatewayRouteTableId: tgwRouteTable.ref,
        });

        // Create Transit Gateway Routes
        new ec2.CfnTransitGatewayRoute(this, 'TGWRouteDefault', {
            transitGatewayRouteTableId: tgwRouteTable.ref,
            destinationCidrBlock: '0.0.0.0/0',
            transitGatewayAttachmentId: dmzAttachment.attrId,
        });

        new ec2.CfnTransitGatewayRoute(this, 'TGWRouteWorkload', {
            transitGatewayRouteTableId: tgwRouteTable.ref,
            destinationCidrBlock: '10.1.0.0/16',
            transitGatewayAttachmentId: workloadAttachment.attrId,
        });

        new ec2.CfnTransitGatewayRoute(this, 'TGWRouteDMZ', {
            transitGatewayRouteTableId: tgwRouteTable.ref,
            destinationCidrBlock: '10.2.0.0/16',
            transitGatewayAttachmentId: dmzAttachment.attrId,
        });

        new ec2.CfnTransitGatewayRoute(this, 'TGWRouteAdditional1', {
            transitGatewayRouteTableId: tgwRouteTable.ref,
            destinationCidrBlock: '10.3.0.0/16',
            transitGatewayAttachmentId: additionalAttachment1.attrId,
        });

        // Add routes to VPC route tables pointing to Transit Gateway
        workloadVpc.isolatedSubnets.forEach((subnet, index) => {
            const routeTable = subnet.routeTable;
            new ec2.CfnRoute(this, `WorkloadTGWRoute${index}`, {
                routeTableId: routeTable.routeTableId,
                destinationCidrBlock: '0.0.0.0/0',
                transitGatewayId: transitGateway.attrId,
            }).addDependency(workloadAttachment);
        });

        // Create IAM role for EC2 instance with SSM permissions
        const instanceRole = new iam.Role(this, 'WorkloadInstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
        });

        // Create EC2 instance in workload VPC
        const workloadInstance = new ec2.Instance(this, 'WorkloadInstance', {
            vpc: workloadVpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            role: instanceRole,
            ssmSessionPermissions: true,
        });

        // Create Network Firewall Policy for outbound firewall
        const outboundFirewallPolicy = new networkfirewall.CfnFirewallPolicy(this, 'OutboundFirewallPolicy', {
            firewallPolicyName: 'FWOUT-firewall-policy-DMZVPC',
            firewallPolicy: {
                statelessDefaultActions: ['aws:forward_to_sfe'],
                statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
            },
        });

        // Create Outbound Network Firewall in DMZ VPC
        const outboundFirewall = new networkfirewall.CfnFirewall(this, 'OutboundFirewall', {
            firewallName: 'FWOUT-DMZVPC',
            firewallPolicyArn: outboundFirewallPolicy.attrFirewallPolicyArn,
            vpcId: dmzVpc.vpcId,
            subnetMappings: dmzVpc
                .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED })
                .subnetIds.map((subnetId) => ({
                    subnetId,
                })),
        });

        // Create Inbound Network Firewall in DMZ VPC (minimal policy)
        const inboundFirewallPolicy = new networkfirewall.CfnFirewallPolicy(this, 'InboundFirewallPolicy', {
            firewallPolicyName: 'FWIN-firewall-policy-DMZVPC',
            firewallPolicy: {
                statelessDefaultActions: ['aws:forward_to_sfe'],
                statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
            },
        });

        const inboundFirewall = new networkfirewall.CfnFirewall(this, 'InboundFirewall', {
            firewallName: 'FWIN-DMZVPC',
            firewallPolicyArn: inboundFirewallPolicy.attrFirewallPolicyArn,
            vpcId: dmzVpc.vpcId,
            subnetMappings: dmzVpc
                .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED })
                .subnetIds.map((subnetId) => ({
                    subnetId,
                })),
        });

        // Export stack outputs
        StackUtils.exportStack(this, 'WorkloadVPCId', workloadVpc.vpcId, 'Workload VPC ID');
        StackUtils.exportStack(this, 'DMZVPCId', dmzVpc.vpcId, 'DMZ VPC ID');
        StackUtils.exportStack(this, 'AdditionalVPC1Id', additionalVpc1.vpcId, 'Additional VPC 1 ID');
        StackUtils.exportStack(this, 'TransitGatewayId', transitGateway.attrId, 'Transit Gateway ID');
        StackUtils.exportStack(this, 'WorkloadInstanceId', workloadInstance.instanceId, 'Workload EC2 Instance ID');
        StackUtils.exportStack(
            this,
            'OutboundFirewallArn',
            outboundFirewall.attrFirewallArn,
            'Outbound Network Firewall ARN',
        );
        StackUtils.exportStack(
            this,
            'InboundFirewallArn',
            inboundFirewall.attrFirewallArn,
            'Inbound Network Firewall ARN',
        );
        StackUtils.exportStack(
            this,
            'WorkloadSubnetId',
            workloadVpc.isolatedSubnets[0].subnetId,
            'Workload VPC first isolated subnet ID',
        );
        StackUtils.exportStack(
            this,
            'WorkloadSubnetRouteTableId',
            workloadVpc.isolatedSubnets[0].routeTable.routeTableId,
            'Workload VPC first isolated subnet route table ID',
        );
        StackUtils.exportStack(this, 'TGWRouteTableId', tgwRouteTable.ref, 'Transit Gateway Route Table ID');
        StackUtils.exportStack(
            this,
            'WorkloadVPCAttachmentId',
            workloadAttachment.attrId,
            'Workload VPC Transit Gateway Attachment ID',
        );
        StackUtils.exportStack(
            this,
            'DMZVPCAttachmentId',
            dmzAttachment.attrId,
            'DMZ VPC Transit Gateway Attachment ID',
        );
        StackUtils.exportStack(
            this,
            'AdditionalVPC1AttachmentId',
            additionalAttachment1.attrId,
            'Additional VPC1 Transit Gateway Attachment ID',
        );
        StackUtils.exportStack(
            this,
            'DMZSubnetAId',
            dmzVpc.isolatedSubnets[0].subnetId,
            'DMZ VPC first isolated subnet ID (AZ-a)',
        );
        StackUtils.exportStack(
            this,
            'DMZSubnetBId',
            dmzVpc.isolatedSubnets[1].subnetId,
            'DMZ VPC second isolated subnet ID (AZ-b)',
        );
    }
}
