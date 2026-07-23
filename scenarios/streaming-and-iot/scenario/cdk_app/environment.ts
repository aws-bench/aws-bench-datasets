import * as cdk from 'aws-cdk-lib';
import { EnvironmentProps } from './lib/shared';
import { QARolesStack } from './stacks/qa_roles_stack';
import { connect_cnp4r8t2k } from './stacks/connect/connect_cnp4r8t2k';
import { ecs_ecsasg7m4 } from './stacks/ecs/ecs_ecsasg7m4';
import { eventbridge_evbhx72k1 } from './stacks/eventbridge/eventbridge_evbhx72k1';
import { iot_iotipv43d8 } from './stacks/iot/iot_iotipv43d8';
import { kinesis_kdsicb52e } from './stacks/kinesis/kinesis_kdsicb52e';
import { msk_mskmm9q3a } from './stacks/msk/msk_mskmm9q3a';
import { neptune_npt5d8h2v } from './stacks/neptune/neptune_npt5d8h2v';
import { rds_rdsdms9k4 } from './stacks/rds/rds_rdsdms9k4';
import { s3_etlcsv9q2 } from './stacks/s3/s3_etlcsv9q2';

export function createEnvironment(app: cdk.App, envId: string, props: EnvironmentProps): void {
    const { account } = props;

    new QARolesStack(app, `${envId}-QARoles-us-east-1`, {
        env: { account, region: 'us-east-1' },
    });

    new connect_cnp4r8t2k(app, `${envId}-connect-cnp4r8t2k-us-east-1`, {
        env: { account, region: 'us-east-1' },
    });
    new s3_etlcsv9q2(app, `${envId}-s3-etlcsv9q2-us-east-1`, {
        env: { account, region: 'us-east-1' },
    });
    new iot_iotipv43d8(app, `${envId}-iot-iotipv43d8-us-east-1`, {
        env: { account, region: 'us-east-1' },
    });
    new eventbridge_evbhx72k1(app, `${envId}-eventbridge-evbhx72k1-us-east-1`, {
        env: { account, region: 'us-east-1' },
    });
    new ecs_ecsasg7m4(app, `${envId}-ecs-ecsasg7m4-us-east-1`, {
        env: { account, region: 'us-east-1' },
    });
    new kinesis_kdsicb52e(app, `${envId}-kinesis-kdsicb52e-us-east-1`, {
        env: { account, region: 'us-east-1' },
    });
    new rds_rdsdms9k4(app, `${envId}-rds-rdsdms9k4-us-east-1`, {
        env: { account, region: 'us-east-1' },
    });

    new msk_mskmm9q3a(app, `${envId}-msk-mskmm9q3a-us-east-1`, {
        env: { account, region: 'us-east-1' },
    });

    new neptune_npt5d8h2v(app, `${envId}-neptune-npt5d8h2v-us-east-1`, {
        env: { account, region: 'us-east-1' },
    });
}
