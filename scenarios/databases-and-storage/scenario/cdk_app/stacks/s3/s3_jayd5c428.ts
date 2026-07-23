import { Construct } from 'constructs';
import { CfnResource } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_jayd5c428
 * What the stack does:
 * 1. 1 S3 Vector Bucket
 * 2. 2 S3 Vector bucket Index
 */

export class s3_jayd5c428 extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const cfnVectorBucket = new CfnResource(this, 'MyCfnVectorBucket', {
            type: 'AWS::S3Vectors::VectorBucket',
            properties: {
                EncryptionConfiguration: {
                    SseType: 'AES256',
                },
                VectorBucketName: `vectortest-${this.account}-${this.region}`,
            },
        });

        const firstIndex = new CfnResource(this, 'MyCfnIndex', {
            type: 'AWS::S3Vectors::Index',
            properties: {
                DataType: 'float32',
                Dimension: 123,
                DistanceMetric: 'cosine',
                IndexName: 'index-name-99',
                VectorBucketName: `vectortest-${this.account}-${this.region}`,
            },
        });
        firstIndex.addDependency(cfnVectorBucket);

        const secondIndex = new CfnResource(this, 'MyCfnIndex2', {
            type: 'AWS::S3Vectors::Index',
            properties: {
                DataType: 'float32',
                Dimension: 123,
                DistanceMetric: 'cosine',
                IndexName: 'index-name-100',
                VectorBucketName: `vectortest-${this.account}-${this.region}`,
            },
        });
        secondIndex.addDependency(cfnVectorBucket);

        StackUtils.exportStack(this, 'VectorBucketName', cfnVectorBucket.ref, 'Name of the Vector Bucket');
        StackUtils.exportStack(
            this,
            'FirstVectorIndex',
            firstIndex.getAtt('IndexArn').toString(),
            'ARN of the First Index',
        );
        StackUtils.exportStack(
            this,
            'SecondVectorIndex',
            secondIndex.getAtt('IndexArn').toString(),
            'ARN of the Second Index',
        );
    }
}
