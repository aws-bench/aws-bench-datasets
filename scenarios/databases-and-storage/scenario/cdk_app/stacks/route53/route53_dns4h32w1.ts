import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: route53_dns4h32w1
 * What the stack does:
 * 1. Creates VPC with VPC Endpoint for service access
 * 2. Creates Route53 hosted zone for DNS management
 * 3. Creates CNAME record pointing to VPC endpoint
 * 4. Simulates IntellectualPropertyService DNS configuration
 */

export class route53_dns4h32w1 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create VPC for VPCE endpoint
        const vpc = new ec2.Vpc(this, 'ServiceVPC', {
            maxAzs: 2,
            natGateways: 0,
            enableDnsHostnames: true,
            enableDnsSupport: true,
        });
        vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Create VPC Endpoint (simulating the VPCE endpoint)
        const vpceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ServiceVPCE', {
            vpc: vpc,
            service: ec2.InterfaceVpcEndpointAwsService.S3,
            privateDnsEnabled: false,
        });
        vpceEndpoint.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Create Route53 hosted zone with non-reserved domain
        const hostedZone = new route53.HostedZone(this, 'ServiceHostedZone', {
            zoneName: `mycompany-${this.account}.local`,
            comment: 'Hosted zone for IntellectualPropertyService',
        });
        hostedZone.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Create CNAME record pointing to VPCE endpoint
        const cnameRecord = new route53.CnameRecord(this, 'ServiceCNAME', {
            zone: hostedZone,
            recordName: `api`,
            domainName: `vpce-${this.account}.amazonaws.com`,
            ttl: cdk.Duration.minutes(5),
            comment: 'CNAME record for CoralDiverProxyService access',
        });

        // Allegiance endpoint configuration (simulating account-config.ts)
        const allegianceEndpoint = {
            serviceName: 'IntellectualPropertyService',
            endpointUrl: `https://api.mycompany-${this.account}.local`,
            vpceEndpoint: vpceEndpoint.vpcEndpointId,
        };

        // Outputs
        StackUtils.exportStack(this, 'VPCId', vpc.vpcId, 'VPC ID');
        StackUtils.exportStack(
            this,
            'VPCEEndpointDNS',
            cdk.Fn.select(0, vpceEndpoint.vpcEndpointDnsEntries),
            'VPC Endpoint DNS Name',
        );
        StackUtils.exportStack(this, 'HostedZoneId', hostedZone.hostedZoneId, 'Route53 Hosted Zone ID');
        StackUtils.exportStack(
            this,
            'CNAMERecord',
            `api.mycompany-${this.account}.local`,
            'CNAME Record for Service Access',
        );
        StackUtils.exportStack(
            this,
            'CNAMETargetDomainName',
            `vpce-${this.account}.amazonaws.com`,
            'CNAME Target Domain Name',
        );
    }
}
