import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ecs_ecsasg7m4
 *
 * Precondition for the ecs-on-ec2-with-cloudmap task.
 *
 * Frugal split: pre-deploy VPC + ECS cluster + ASG + EC2 + LaunchTemplate.
 * The agent creates the ECS service + Cloud Map namespace + service
 * registration.
 *
 * Sized down to t3.micro x 1 instance to minimize idle cost. ASG capacity
 * is fixed at 1 for the duration of the scenario.
 */
export class ecs_ecsasg7m4 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'EcsVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.50.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
                { name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
            ],
            restrictDefaultSecurityGroup: false,
        });

        const cluster = new ecs.Cluster(this, 'EcsCluster', {
            vpc,
            clusterName: `app-cluster-${this.account.slice(-6)}`,
        });

        const instanceRole = new iam.Role(this, 'EcsInstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AmazonEC2ContainerServiceforEC2Role',
                ),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });

        // LaunchTemplate the verifier inspects by name. CDK's L2 LaunchTemplate
        // doesn't expose the name as a synth-time string when only set via
        // launchTemplateName, so we hold the literal in a local and reuse it.
        const launchTemplateName = `app-lt-${this.account.slice(-6)}`;
        const launchTemplate = new ec2.LaunchTemplate(this, 'EcsLaunchTemplate', {
            launchTemplateName,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
            role: instanceRole,
            securityGroup: new ec2.SecurityGroup(this, 'EcsInstanceSg', {
                vpc,
                allowAllOutbound: true,
            }),
            userData: ec2.UserData.custom(
                `#!/bin/bash\necho ECS_CLUSTER=${cluster.clusterName} >> /etc/ecs/ecs.config\n`,
            ),
        });

        const asg = new autoscaling.AutoScalingGroup(this, 'EcsAsg', {
            autoScalingGroupName: `app-asg-${this.account.slice(-6)}`,
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            launchTemplate,
            minCapacity: 1,
            maxCapacity: 1,
            desiredCapacity: 1,
        });

        // Capacity provider attaches the ASG to the cluster so ECS can place
        // tasks on the EC2 instance the agent registers a service against.
        const capacityProvider = new ecs.AsgCapacityProvider(this, 'EcsCapacityProvider', {
            autoScalingGroup: asg,
            enableManagedScaling: false,
            enableManagedTerminationProtection: false,
        });
        cluster.addAsgCapacityProvider(capacityProvider);

        // The verifier reads the ASG -> resolves the running EC2 instance via
        // DescribeAutoScalingGroups at check-time. ASG instance ids are
        // dynamic per-deploy and not exposable as CFN outputs.
        StackUtils.exportStack(this, 'ASGName', asg.autoScalingGroupName, 'ECS-EC2 ASG');
        StackUtils.exportStack(this, 'LaunchTemplate', launchTemplateName, 'ECS-EC2 launch template');
        StackUtils.exportStack(this, 'ClusterName', cluster.clusterName, 'ECS cluster name');
    }
}
