import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Route 53 Resolver Stack
 *
 * Converted from aws-cdk-examples/typescript/r53-resolver
 * Uses L1 CfnResolver* constructs instead of alpha packages.
 *
 * Creates:
 * 1. VPC (10.24.34.0/23, maxAzs 2, PRIVATE_ISOLATED subnets)
 * 2. Security Group for resolver endpoints (TCP/UDP 53 from VPC CIDR)
 * 3. DNS Firewall domain list (example.com, example.net)
 * 4. DNS Firewall rule group with BLOCK rule
 * 5. DNS Firewall rule group association to VPC
 * 6. Outbound Resolver Endpoint
 * 7. Inbound Resolver Endpoint
 */

export class R53ResolverStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const vpcCidr = '10.24.34.0/23';

        // VPC with PRIVATE_ISOLATED subnets
        const vpc = new ec2.Vpc(this, 'ResolverVpc', {
            ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
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

        // Security Group for resolver endpoints
        const resolverSg = new ec2.SecurityGroup(this, 'ResolverSecurityGroup', {
            vpc,
            description: 'Security group for Route 53 Resolver endpoints',
            allowAllOutbound: true,
        });
        resolverSg.addIngressRule(
            ec2.Peer.ipv4(vpcCidr),
            ec2.Port.tcp(53),
            'Allow DNS TCP from VPC CIDR',
        );
        resolverSg.addIngressRule(
            ec2.Peer.ipv4(vpcCidr),
            ec2.Port.udp(53),
            'Allow DNS UDP from VPC CIDR',
        );

        // DNS Firewall Domain List
        const domainList = new route53resolver.CfnFirewallDomainList(this, 'BlockedDomainList', {
            name: `blocked-domains-${this.account}-${this.region}`,
            domains: ['example.com', 'example.net'],
        });
        domainList.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // DNS Firewall Rule Group
        const ruleGroup = new route53resolver.CfnFirewallRuleGroup(this, 'FirewallRuleGroup', {
            name: `firewall-rule-group-${this.account}-${this.region}`,
            firewallRules: [
                {
                    action: 'BLOCK',
                    blockResponse: 'NODATA',
                    firewallDomainListId: domainList.attrId,
                    priority: 10,
                },
            ],
        });
        ruleGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // DNS Firewall Rule Group Association
        const ruleGroupAssociation = new route53resolver.CfnFirewallRuleGroupAssociation(
            this,
            'FirewallRuleGroupAssociation',
            {
                name: `firewall-assoc-${this.account}-${this.region}`,
                firewallRuleGroupId: ruleGroup.attrId,
                vpcId: vpc.vpcId,
                priority: 101,
            },
        );
        ruleGroupAssociation.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Get isolated subnets for resolver endpoints
        const isolatedSubnets = vpc.isolatedSubnets;

        // Outbound Resolver Endpoint
        const outboundEndpoint = new route53resolver.CfnResolverEndpoint(
            this,
            'OutboundResolverEndpoint',
            {
                name: `outbound-resolver-${this.account}-${this.region}`,
                direction: 'OUTBOUND',
                securityGroupIds: [resolverSg.securityGroupId],
                ipAddresses: isolatedSubnets.map((subnet) => ({
                    subnetId: subnet.subnetId,
                })),
            },
        );
        outboundEndpoint.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Inbound Resolver Endpoint
        const inboundEndpoint = new route53resolver.CfnResolverEndpoint(
            this,
            'InboundResolverEndpoint',
            {
                name: `inbound-resolver-${this.account}-${this.region}`,
                direction: 'INBOUND',
                securityGroupIds: [resolverSg.securityGroupId],
                ipAddresses: isolatedSubnets.map((subnet) => ({
                    subnetId: subnet.subnetId,
                })),
            },
        );
        inboundEndpoint.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Exports
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC ID for resolver infrastructure');
        StackUtils.exportStack(this, 'VpcCidr', vpcCidr, 'VPC CIDR block');
        StackUtils.exportStack(this, 'InboundEndpointId', inboundEndpoint.attrResolverEndpointId, 'Inbound resolver endpoint ID');
        StackUtils.exportStack(this, 'OutboundEndpointId', outboundEndpoint.attrResolverEndpointId, 'Outbound resolver endpoint ID');
        StackUtils.exportStack(this, 'SecurityGroupId', resolverSg.securityGroupId, 'Security group ID for resolver endpoints');
        StackUtils.exportStack(this, 'FirewallDomainListId', domainList.attrId, 'DNS Firewall domain list ID');
        StackUtils.exportStack(this, 'FirewallRuleGroupId', ruleGroup.attrId, 'DNS Firewall rule group ID');
        StackUtils.exportStack(this, 'FirewallRuleGroupAssociationId', ruleGroupAssociation.attrId, 'DNS Firewall rule group association ID');
        StackUtils.exportStack(this, 'BlockedDomains', 'example.com,example.net', 'Blocked domain names');
    }
}
