import * as cdk from 'aws-cdk-lib';
import { EnvironmentProps } from './lib/shared';
import { NetworkingStack } from './stacks/networking';
import { S3StorageStack } from './stacks/s3_storage';
import { LambdaMiscStack } from './stacks/lambda_misc';
import { EcsStack } from './stacks/ecs';
import { MonitoringStack } from './stacks/monitoring';
import { DatabaseStack } from './stacks/database';
import { ComputeEc2Stack } from './stacks/compute_ec2';
import { DocDbAthenaNlbStack } from './stacks/docdb_athena_nlb';
import { AppRolesStack } from './stacks/app_roles_stack';

export function createEnvironment(app: cdk.App, envId: string, props: EnvironmentProps): void {
    const { account } = props;
    const env = { account, region: 'us-east-1' };

    new AppRolesStack(app, `${envId}-AppRoles-us-east-1`, { env });

    // Networking is the foundation — all VPC-dependent stacks depend on it
    const networking = new NetworkingStack(app, `${envId}-Networking-us-east-1`, { env });

    // S3 buckets — no VPC dependency
    new S3StorageStack(app, `${envId}-S3Storage-us-east-1`, { env });

    // Monitoring — no VPC dependency
    new MonitoringStack(app, `${envId}-Monitoring-us-east-1`, { env });

    // VPC-dependent stacks
    const database = new DatabaseStack(app, `${envId}-Database-us-east-1`, {
        env, vpc: networking.vpc,
    });
    database.addDependency(networking);

    const lambdaMisc = new LambdaMiscStack(app, `${envId}-LambdaMisc-us-east-1`, {
        env, vpc: networking.vpc,
    });
    lambdaMisc.addDependency(networking);

    const ecs = new EcsStack(app, `${envId}-ECS-us-east-1`, {
        env, vpc: networking.vpc, alb: networking.alb,
    });
    ecs.addDependency(networking);

    const computeEc2 = new ComputeEc2Stack(app, `${envId}-ComputeEC2-us-east-1`, {
        env, vpc: networking.vpc,
    });
    computeEc2.addDependency(networking);

    const docDbAthenaNlb = new DocDbAthenaNlbStack(app, `${envId}-DocDBAthenaNLB-us-east-1`, {
        env, vpc: networking.vpc,
    });
    docDbAthenaNlb.addDependency(networking);
}
