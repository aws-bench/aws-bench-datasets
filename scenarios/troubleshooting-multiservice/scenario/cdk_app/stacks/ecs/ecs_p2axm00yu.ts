import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: ecs-p2axm00yu
 *
 * b6c1fbc3-2282-41da-b27a-8ffa5a4c3776
 *
 * What the stack does:
 * Deploys a Fargate service whose tasks exit with code 1 because the required
 * environment variable DB_PASSWORD is missing from the task definition.
 * Tasks crash-loop continuously, so the service has 0 running tasks.
 *
 * Note: circuit breaker is intentionally disabled so CloudFormation can
 * stabilize the stack (CFN always waits for ECS service steady-state; with
 * the circuit breaker enabled it would fire during that window and roll back
 * the entire stack before the service is created).
 */

export class Ecs_p2axm00yu extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

        const logGroup = new logs.LogGroup(this, 'AppStdoutLogGroup', {
            logGroupName: 'GarnetPlugin-Garnet-AppContainer-STDOUT',
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const executionRole = new iam.Role(this, 'TaskExecutionRole', {
            roleName: 'GarnetEcsTaskExecutionRole',
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });

        const cluster = new ecs.Cluster(this, 'Cluster', {
            clusterName: `Garnet-GarnetEcsCluster-ClusterEB0386A7-${this.account}-${this.region}`,
            vpc,
        });

        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
            family: 'GarnetGarnetEcsServiceServiceTaskDefinition3EE69A82',
            cpu: 256,
            memoryLimitMiB: 512,
            executionRole,
        });

        taskDefinition.addContainer('service', {
            image: ecs.ContainerImage.fromRegistry('public.ecr.aws/amazonlinux/amazonlinux:latest'),
            essential: true,
            // DB_PASSWORD is intentionally absent from environment — container exits with code 1
            environment: {},
            command: [
                'sh', '-c',
                'if [ -z "$DB_PASSWORD" ]; then ' +
                'echo "ERROR Missing required environment variable: DB_PASSWORD"; ' +
                'echo "ERROR Failed to connect to database: Connection refused"; ' +
                'echo "ERROR Database host not reachable: garnet-db.internal"; ' +
                'echo "ERROR Application startup failed. Exiting with code 1"; ' +
                'exit 1; fi; ' +
                'echo "INFO Application started successfully"',
            ],
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'service',
                logGroup,
            }),
        });

        const service = new ecs.FargateService(this, 'Service', {
            serviceName: `Garnet-GarnetEcsService-Service9571FDD8-${this.account}-${this.region}`,
            cluster,
            taskDefinition,
            // desiredCount = 0 at deploy so the POST_SETUP snapshot has a
            // stable ENI/task footprint. The failing-task behavior (missing
            // DB_PASSWORD => crash-loop) is exercised by the task's pre_invoke,
            // which sets desiredCount = 1 and lets ECS churn tasks until the
            // agent observes it. post_invoke restores desiredCount = 0.
            desiredCount: 0,
            assignPublicIp: true,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        });

        StackUtils.exportStack(this, 'ClusterName', cluster.clusterName, 'ECS Cluster name');
        StackUtils.exportStack(this, 'ClusterArn', cluster.clusterArn, 'ECS Cluster ARN');
        StackUtils.exportStack(this, 'ServiceName', service.serviceName, 'ECS Service name');
        StackUtils.exportStack(
            this,
            'ServiceArn',
            `arn:aws:ecs:${this.region}:${this.account}:service/${cluster.clusterName}/${service.serviceName}`,
            'ECS Service ARN',
        );
        StackUtils.exportStack(this, 'AppStdoutLogGroupName', logGroup.logGroupName, 'App Container STDOUT log group name');
    }
}
