import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: route53_dns_firewall
 *
 * What the stack does:
 * Converted from aws-cdk-examples/typescript/route53-resolver-dns-firewall.
 * Creates a Route 53 Resolver DNS Firewall configuration with query logging,
 * domain lists for blocking and allowing, firewall rule groups, and VPC association.
 *
 * Resources created:
 * 1. VPC (10.0.0.0/16)
 * 2. CloudWatch Log Group for DNS query logging
 * 3. Resolver Query Logging Config and VPC association
 * 4. Firewall Domain Lists (blocked and allowed)
 * 5. Firewall Rule Group with BLOCK and ALLOW rules
 * 6. Firewall Rule Group Association with VPC (mutation protection disabled)
 */

export class Route53DnsFirewall extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // VPC
        const vpc = new ec2.Vpc(this, 'FirewallVpc', {
            vpcName: `DnsFirewallVpc-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
            ],
        });
        vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // CloudWatch Log Group for DNS query logging
        const logGroup = new logs.LogGroup(this, 'DNSQueryLogGroup', {
            logGroupName: `DNSQueryLogging-${this.account}-${this.region}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Resolver Query Logging Config
        const queryLoggingConfig = new route53resolver.CfnResolverQueryLoggingConfig(
            this,
            'ResolverQueryLoggingConfig',
            {
                // logGroup.logGroupArn includes ':*' (IAM-style), but Route53 Resolver
                // stores the ARN without it. Strip the suffix to prevent phantom drift.
                destinationArn: cdk.Fn.select(0, cdk.Fn.split(':*', logGroup.logGroupArn)),
                name: `QueryLoggingConfig-${this.account}-${this.region}`,
            },
        );

        // Associate query logging config with VPC
        const queryLoggingAssociation = new route53resolver.CfnResolverQueryLoggingConfigAssociation(
            this,
            'ResolverQueryLoggingConfigAssociation',
            {
                resolverQueryLogConfigId: queryLoggingConfig.attrId,
                resourceId: vpc.vpcId,
            },
        );

        // Firewall Domain List: Blocked domains
        const blockedDomainList = new route53resolver.CfnFirewallDomainList(
            this,
            'BlockedDomainList',
            {
                name: `BlockedDomains-${this.account}-${this.region}`,
                domains: ['test.example.com', 'test1.example.com'],
            },
        );

        // Firewall Domain List: Allowed domains
        const allowedDomainList = new route53resolver.CfnFirewallDomainList(
            this,
            'AllowedDomainList',
            {
                name: `AllowedDomains-${this.account}-${this.region}`,
                domains: ['*'],
            },
        );

        // Firewall Rule Group
        const firewallRuleGroup = new route53resolver.CfnFirewallRuleGroup(
            this,
            'FirewallRuleGroup',
            {
                name: `DnsFirewallRuleGroup-${this.account}-${this.region}`,
                firewallRules: [
                    {
                        action: 'BLOCK',
                        blockResponse: 'NXDOMAIN',
                        firewallDomainListId: blockedDomainList.attrId,
                        priority: 10,
                    },
                    {
                        action: 'ALLOW',
                        firewallDomainListId: allowedDomainList.attrId,
                        priority: 20,
                    },
                ],
            },
        );

        // Firewall Rule Group Association with VPC
        const firewallRuleGroupAssociation = new route53resolver.CfnFirewallRuleGroupAssociation(
            this,
            'FirewallRuleGroupAssociation',
            {
                firewallRuleGroupId: firewallRuleGroup.attrId,
                vpcId: vpc.vpcId,
                priority: 101,
                // DISABLED so teardown can disassociate it; ENABLED blocks removal.
                mutationProtection: 'DISABLED',
                name: `DnsFirewallAssociation-${this.account}-${this.region}`,
            },
        );

        // Stack Exports
        StackUtils.exportStack(
            this,
            'VpcId',
            vpc.vpcId,
            'ID of the VPC with DNS Firewall',
        );

        StackUtils.exportStack(
            this,
            'VpcCidr',
            '10.0.0.0/16',
            'CIDR block of the VPC',
        );

        StackUtils.exportStack(
            this,
            'LogGroupName',
            logGroup.logGroupName,
            'Name of the CloudWatch Log Group for DNS query logging',
        );

        StackUtils.exportStack(
            this,
            'BlockedDomains',
            'test.example.com,test1.example.com',
            'Comma-separated list of blocked domains',
        );

        StackUtils.exportStack(
            this,
            'FirewallRuleGroupId',
            firewallRuleGroup.attrId,
            'ID of the DNS Firewall Rule Group',
        );

        StackUtils.exportStack(
            this,
            'FirewallRuleGroupAssociationId',
            firewallRuleGroupAssociation.attrId,
            'ID of the DNS Firewall Rule Group Association',
        );

        StackUtils.exportStack(
            this,
            'MutationProtection',
            'DISABLED',
            'Mutation protection status for the firewall rule group association',
        );

        StackUtils.exportStack(
            this,
            'BlockAction',
            'NXDOMAIN',
            'Block response action for blocked domains',
        );
    }
}
