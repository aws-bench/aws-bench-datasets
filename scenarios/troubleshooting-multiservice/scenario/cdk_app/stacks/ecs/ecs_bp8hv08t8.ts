import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ecs-bp8hv08t8
 * 
 * 7dac3c18-360b-46bf-a830-bc9087cb42e2
 * 
 * What the stack does:
 1. Creates two VPCs: one for ECS workloads (13.1.0.0/16) and one for ElastiCache (13.7.0.0/24)
 2. Creates a Transit Gateway connecting both VPCs with route tables
 3. Creates an ECS cluster with Fargate task definition running 6 tasks
 4. Creates an ElastiCache Memcached cluster in the cache VPC
 5. Sets up security groups for ECS service and ElastiCache access
 6. Configures networking with subnets and transit gateway attachments
 
*/

export class Ecs_bp8hv08t8 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // VPC for ECS workloads
        const ecsVpc = new ec2.Vpc(this, 'EcsVpc', {
            vpcName: `Prod-us-east-1-AppService-VPC-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('13.1.0.0/16'),
            maxAzs: 2,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            subnetConfiguration: [
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    cidrMask: 20,
                },
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 20,
                },
            ],
        });

        cdk.Tags.of(ecsVpc).add('Name', 'Prod-us-east-1-AppService-VPC');
        cdk.Tags.of(ecsVpc).add('DeploymentType', 'Pipelines');
        cdk.Tags.of(ecsVpc).add('SoftwareType', 'Infrastructure');
        cdk.Tags.of(ecsVpc).add('TargetAlias', 'VpcStack');

        // VPC for ElastiCache
        const cacheVpc = new ec2.Vpc(this, 'CacheVpc', {
            vpcName: `Cache-ElastiCache-VPC-${this.account}-${this.region}`,
            ipAddresses: ec2.IpAddresses.cidr('13.7.0.0/24'),
            maxAzs: 1,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            subnetConfiguration: [
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 26,
                },
            ],
        });

        cdk.Tags.of(cacheVpc).add('Name', 'Cache-ElastiCache-VPC');

        // Transit Gateway
        const transitGateway = new ec2.CfnTransitGateway(this, 'TransitGateway', {
            description: 'Gateway for VPC to access caches',
            amazonSideAsn: 64512,
            autoAcceptSharedAttachments: 'enable',
            defaultRouteTableAssociation: 'disable',
            defaultRouteTablePropagation: 'disable',
            vpnEcmpSupport: 'enable',
            dnsSupport: 'enable',
            tags: [
                { key: 'Name', value: 'Cache-CacheCluster-ABC' },
                { key: 'TargetAlias', value: 'TransitGatewayStack' },
                { key: 'SoftwareType', value: 'Infrastructure' },
            ],
        });

        // Transit Gateway Attachment for ECS VPC
        const ecsVpcAttachment = new ec2.CfnTransitGatewayAttachment(this, 'EcsVpcAttachment', {
            transitGatewayId: transitGateway.attrId,
            vpcId: ecsVpc.vpcId,
            subnetIds: ecsVpc.privateSubnets.map((subnet) => subnet.subnetId),
            tags: [{ key: 'Name', value: 'Cache-CacheCluster-ABC-Attachment-Client-Prod' }],
        });

        // Transit Gateway Attachment for Cache VPC
        const cacheVpcAttachment = new ec2.CfnTransitGatewayAttachment(this, 'CacheVpcAttachment', {
            transitGatewayId: transitGateway.attrId,
            vpcId: cacheVpc.vpcId,
            subnetIds: cacheVpc.isolatedSubnets.map((subnet) => subnet.subnetId),
            tags: [{ key: 'Name', value: 'Cache-CacheCluster-ABC-Attachment-Cache' }],
        });

        // Transit Gateway Route Table for ECS Client
        const ecsClientRouteTable = new ec2.CfnTransitGatewayRouteTable(this, 'EcsClientRouteTable', {
            transitGatewayId: transitGateway.attrId,
            tags: [{ key: 'Name', value: 'Cache-CacheCluster-ABC-Client-RouteTable-Prod' }],
        });

        // Transit Gateway Route Table for Cache
        const cacheRouteTable = new ec2.CfnTransitGatewayRouteTable(this, 'CacheRouteTable', {
            transitGatewayId: transitGateway.attrId,
            tags: [{ key: 'Name', value: 'Cache-CacheCluster-ABC-RouteTable' }],
        });

        // Associate ECS VPC attachment with client route table
        const ecsClientRouteTableAssociation = new ec2.CfnTransitGatewayRouteTableAssociation(this, 'EcsClientRouteTableAssociation', {
            transitGatewayAttachmentId: ecsVpcAttachment.attrId,
            transitGatewayRouteTableId: ecsClientRouteTable.attrTransitGatewayRouteTableId,
        });

        // Associate Cache VPC attachment with cache route table
        const cacheRouteTableAssociation = new ec2.CfnTransitGatewayRouteTableAssociation(this, 'CacheRouteTableAssociation', {
            transitGatewayAttachmentId: cacheVpcAttachment.attrId,
            transitGatewayRouteTableId: cacheRouteTable.attrTransitGatewayRouteTableId,
        });

        // Static route from ECS client to cache VPC
        const ecsClientToCacheRoute = new ec2.CfnTransitGatewayRoute(this, 'EcsClientToCacheRoute', {
            transitGatewayRouteTableId: ecsClientRouteTable.attrTransitGatewayRouteTableId,
            destinationCidrBlock: '13.7.0.0/24',
            transitGatewayAttachmentId: cacheVpcAttachment.attrId,
        });

        // Propagate ECS VPC routes
        const ecsClientRoutePropagation = new ec2.CfnTransitGatewayRouteTablePropagation(this, 'EcsClientRoutePropagation', {
            transitGatewayAttachmentId: ecsVpcAttachment.attrId,
            transitGatewayRouteTableId: ecsClientRouteTable.attrTransitGatewayRouteTableId,
        });

        // Security Group for ECS Service
        const ecsServiceSecurityGroup = new ec2.SecurityGroup(this, 'EcsServiceSecurityGroup', {
            vpc: ecsVpc,
            description: 'Prod-us-east-1-AppService-ECSService/Service/Service/SecurityGroup',
            securityGroupName: `Prod-us-east-1-AppService-ECSService-ServiceSecurityGroup-${this.account}-${this.region}`,
            allowAllOutbound: true,
        });

        ecsServiceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8443), 'from 0.0.0.0/0:8443');

        ecsServiceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(7979), 'from 0.0.0.0/0:AppServicePort');

        cdk.Tags.of(ecsServiceSecurityGroup).add('SoftwareType', 'Long-Running Server-Side Software');
        cdk.Tags.of(ecsServiceSecurityGroup).add('TargetAlias', 'EcsServiceStack');

        // Security Group for ElastiCache
        const elastiCacheSecurityGroup = new ec2.SecurityGroup(this, 'ElastiCacheSecurityGroup', {
            vpc: cacheVpc,
            description: 'SecurityGroup for ElastiCache',
            securityGroupName: `Prod-us-east-1-CacheService-Cache-ElastiCacheSecurityGroup-${this.account}-${this.region}`,
            allowAllOutbound: true,
        });

        elastiCacheSecurityGroup.addIngressRule(
            ec2.Peer.ipv4('13.7.0.0/24'),
            ec2.Port.tcp(11211),
            'APP Cache ingress rule',
        );

        elastiCacheSecurityGroup.addIngressRule(
            ec2.Peer.ipv4('13.1.0.0/16'),
            ec2.Port.tcp(11211),
            'APP Cache ingress rule',
        );

        cdk.Tags.of(elastiCacheSecurityGroup).add('SoftwareType', 'Long-Running Server-Side Software');
        cdk.Tags.of(elastiCacheSecurityGroup).add('TargetAlias', 'CacheClusterStack');
        cdk.Tags.of(elastiCacheSecurityGroup).add('DeploymentType', 'Pipelines');

        // ElastiCache Subnet Group
        const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, 'CacheSubnetGroup', {
            description: 'SubnetGroup for APP ElastiCache cluster',
            subnetIds: cacheVpc.isolatedSubnets.map((subnet) => subnet.subnetId),
            cacheSubnetGroupName: `prod-cache-${this.account}-${this.region}`,
        });

        // ElastiCache Cluster
        // Note: Cluster name shortened to fit 50 character limit
        const elastiCacheCluster = new elasticache.CfnCacheCluster(this, 'ElastiCacheCluster', {
            cacheNodeType: 'cache.t3.small',
            engine: 'memcached',
            numCacheNodes: 1,
            clusterName: `cache-cluster-${this.account.substring(0, 8)}`,
            engineVersion: '1.6.12',
            cacheSubnetGroupName: cacheSubnetGroup.cacheSubnetGroupName,
            vpcSecurityGroupIds: [elastiCacheSecurityGroup.securityGroupId],
            preferredMaintenanceWindow: 'sun:05:00-sun:06:00',
            transitEncryptionEnabled: true,
        });

        elastiCacheCluster.addDependency(cacheSubnetGroup);
        elastiCacheCluster.addDependency(cacheVpcAttachment);
        elastiCacheCluster.addDependency(cacheRouteTableAssociation);
        elastiCacheCluster.addDependency(ecsClientRouteTableAssociation);
        elastiCacheCluster.addDependency(ecsClientToCacheRoute);
        elastiCacheCluster.addDependency(ecsClientRoutePropagation);

        // ECS Cluster
        const ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
            vpc: ecsVpc,
            clusterName: `Prod-us-east-1-AppService-ECSCluster-${this.account}-${this.region}`,
            enableFargateCapacityProviders: true,
        });

        // ECS Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
            family: `Produseast1AppServiceECSServiceTaskDef-${this.account}-${this.region}`,
            cpu: 2048,
            memoryLimitMiB: 4096,
            ephemeralStorageGiB: 21,
        });

        // Application Container
        taskDefinition.addContainer('Application', {
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:1.30'),
            cpu: 0,
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'Application' }),
        });

        // FireLens Container
        taskDefinition.addContainer('FireLensContainer', {
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-observability/aws-for-fluent-bit:latest'),
            cpu: 512,
            memoryLimitMiB: 512,
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'FireLens' }),
        });

        // ECS Service
        const ecsService = new ecs.FargateService(this, 'EcsService', {
            cluster: ecsCluster,
            taskDefinition: taskDefinition,
            desiredCount: 6,
            platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
            securityGroups: [ecsServiceSecurityGroup],
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
        });

        // Outputs
        StackUtils.exportStack(this, 'EcsClusterName', ecsCluster.clusterName, 'The name of the ECS cluster');
        StackUtils.exportStack(this, 'EcsClusterArn', ecsCluster.clusterArn, 'The ARN of the ECS cluster');
        StackUtils.exportStack(
            this,
            'TaskDefinitionArn',
            taskDefinition.taskDefinitionArn,
            'The ARN of the task definition',
        );
        StackUtils.exportStack(this, 'EcsServiceName', ecsService.serviceName, 'The name of the ECS service');
        StackUtils.exportStack(this, 'EcsServiceArn', ecsService.serviceArn, 'The ARN of the ECS service');
        StackUtils.exportStack(this, 'EcsVpcId', ecsVpc.vpcId, 'The ID of the ECS VPC');
        StackUtils.exportStack(this, 'CacheVpcId', cacheVpc.vpcId, 'The ID of the Cache VPC');
        StackUtils.exportStack(this, 'TransitGatewayId', transitGateway.attrId, 'The ID of the Transit Gateway');
        StackUtils.exportStack(
            this,
            'ElastiCacheClusterId',
            elastiCacheCluster.ref,
            'The ID of the ElastiCache cluster',
        );
        StackUtils.exportStack(
            this,
            'ElastiCacheEndpoint',
            elastiCacheCluster.attrConfigurationEndpointAddress || 'N/A',
            'The configuration endpoint of the ElastiCache cluster',
        );

        // Subnet exports
        StackUtils.exportStack(this, 'EcsPrivateSubnet1Id', ecsVpc.privateSubnets[0].subnetId, 'ECS private subnet 1');
        StackUtils.exportStack(this, 'EcsPrivateSubnet2Id', ecsVpc.privateSubnets[1].subnetId, 'ECS private subnet 2');
        StackUtils.exportStack(this, 'CachePrivateSubnet1Id', cacheVpc.isolatedSubnets[0].subnetId, 'Cache private subnet 1');

        // Route table exports
        StackUtils.exportStack(this, 'EcsPrivateRouteTable1Id', ecsVpc.privateSubnets[0].routeTable.routeTableId, 'ECS private route table 1');
        StackUtils.exportStack(this, 'EcsPrivateRouteTable2Id', ecsVpc.privateSubnets[1].routeTable.routeTableId, 'ECS private route table 2');
        StackUtils.exportStack(this, 'CachePrivateRouteTable1Id', cacheVpc.isolatedSubnets[0].routeTable.routeTableId, 'Cache private route table 1');

        // NAT Gateway exports
        const natGw1 = ecsVpc.publicSubnets[0].node.findChild('NATGateway') as ec2.CfnNatGateway;
        const natGw2 = ecsVpc.publicSubnets[1].node.findChild('NATGateway') as ec2.CfnNatGateway;
        StackUtils.exportStack(this, 'EcsNatGateway1Id', natGw1.attrNatGatewayId, 'ECS NAT Gateway 1');
        StackUtils.exportStack(this, 'EcsNatGateway2Id', natGw2.attrNatGatewayId, 'ECS NAT Gateway 2');

        // Transit Gateway attachment and route table exports
        StackUtils.exportStack(this, 'EcsVpcTgwAttachmentId', ecsVpcAttachment.attrId, 'ECS VPC ABC attachment ID');
        StackUtils.exportStack(this, 'CacheVpcTgwAttachmentId', cacheVpcAttachment.attrId, 'Cache VPC ABC attachment ID');
        StackUtils.exportStack(this, 'EcsClientTgwRouteTableId', ecsClientRouteTable.attrTransitGatewayRouteTableId, 'ECS client ABC route table ID');
        StackUtils.exportStack(this, 'CacheTgwRouteTableId', cacheRouteTable.attrTransitGatewayRouteTableId, 'Cache ABC route table ID');

        // Security group exports
        StackUtils.exportStack(this, 'EcsServiceSecurityGroupId', ecsServiceSecurityGroup.securityGroupId, 'ECS service security group ID');
        StackUtils.exportStack(this, 'ElastiCacheSecurityGroupId', elastiCacheSecurityGroup.securityGroupId, 'ElastiCache security group ID');
    }
}
