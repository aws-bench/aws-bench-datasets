import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';

import { StackUtils } from '../../lib/shared';
import { Construct } from 'constructs';

/*
* Stack ID: ecs-sir89fhb31

* What the stack does:
1. The stack creates a VPC for an ECS cluster,
2. It creates an ECS cluster,
3. Creates AutoScalingGroup for the cluster,
4. Creates two task definitions,
5. Creates two containers.
6. Creates two services.
*/

export class ECS_sir8fhb31 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // Create a VPC
        const vpc = new ec2.Vpc(this, 'EcsVpc', {
            maxAzs: 2,
        });

        // Create a Cluster
        const cluster = new ecs.Cluster(this, 'EcsCluster', {
            clusterName: `cluster-${this.account}-${this.region}`,
            vpc: vpc,
        });

        const minCapacity = 2;
        const maxCapacity = 3;
        const desiredCapacity = 2;

        const asgInstanceRole = new iam.Role(this, 'ASGInstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });

        const launchTemplate = new ec2.LaunchTemplate(this, 'ASGLaunchTemplate', {
            role: asgInstanceRole,
            machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            requireImdsv2: true,
            userData: ec2.UserData.forLinux(),
        });

        const asg = new AutoScalingGroup(this, 'DefaultAutoScalingGroup', {
            vpc,
            launchTemplate,
            desiredCapacity,
            minCapacity,
            maxCapacity,
        });

        const capacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
            autoScalingGroup: asg,
        });
        cluster.addAsgCapacityProvider(capacityProvider);

        // Create Fargate Task Definition
        const taskDefinition1 = new ecs.FargateTaskDefinition(this, 'TaskDef', {
            family: `taskdefinition1-${this.account}-${this.region}`,
            memoryLimitMiB: 512,
            cpu: 256,
        });

        // Add container to task definition
        const container1 = taskDefinition1.addContainer('ECSContainer', {
            containerName: `container1-${this.account}-${this.region}`,
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:1.30'),
            memoryLimitMiB: 512,
            cpu: 256,
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'my-app' }),
            portMappings: [
                {
                    containerPort: 80,
                    protocol: ecs.Protocol.TCP,
                },
            ],
        });

        const fargateService = new ecs.FargateService(this, 'FargateService', {
            cluster: cluster,
            taskDefinition: taskDefinition1,
            desiredCount: 1,
        });

        StackUtils.exportStack(this, 'AutoScalingGroupMinCapacity', minCapacity.toString());
        StackUtils.exportStack(this, 'AutoScalingGroupMaxCapacity', maxCapacity.toString());
        StackUtils.exportStack(this, 'AutoScalingGroupDesiredCapacity', desiredCapacity.toString());
        StackUtils.exportStack(this, 'AutoScalingGroupName', asg.autoScalingGroupName);

        StackUtils.exportStack(this, 'ClusterName', cluster.clusterName, 'The name of the ECS cluster');
        StackUtils.exportStack(this, 'ClusterArn', cluster.clusterArn, 'The ARN of the ECS cluster');
        StackUtils.exportStack(this, 'NormalContainerName', container1.containerName, 'The name of the ECS container');
        StackUtils.exportStack(this, 'FargateServiceName', fargateService.serviceName, 'Name of fargateService');
        StackUtils.exportStack(this, 'FargateTaskFamily', taskDefinition1.family, 'Name of fargateService');

        StackUtils.exportStack(
            this,
            'NormalTaskDefinitionARN',
            taskDefinition1.taskDefinitionArn,
            'ARN of the ECS TaskDefinition',
        );
    }
}
