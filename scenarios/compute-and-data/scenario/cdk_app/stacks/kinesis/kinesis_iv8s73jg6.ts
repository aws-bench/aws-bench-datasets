import * as cdk from 'aws-cdk-lib';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: kinesis_iv8s73jg6
 *
 * The stack creates the following resources:
 * 1. 1 Kinesis Data Stream
 */

export class kinesis_iv8s73jg6 extends cdk.Stack {
    private readonly accountId: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);
        this.accountId = this.account;

        const kinesisDataStream = new kinesis.CfnStream(this, 'MyCfnStream', {
            name: `environment-2h384hj-${this.accountId}-${this.region}`,
            streamModeDetails: {
                streamMode: 'ON_DEMAND',
            },
        });
        kinesisDataStream.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Outputs
        StackUtils.exportStack(this, 'KinesisDataStreamName', kinesisDataStream.ref, 'Name of the Kinesis Data Stream');
    }
}
