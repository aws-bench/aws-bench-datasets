import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Duration } from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { CustomResource } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';
import * as logs from 'aws-cdk-lib/aws-logs';

/*
* Stack ID: s3-18475ec

* What the stack does:
1. The stack creates a Simple Amazon S3 bucket without blocking public ACLs and alarm,
2. Creates a S3 bucket with alarm configuration and the setup of CloudWatch alarms for monitoring the bucket.
3. Creates one more S3 bucket with lifecycle rules configurations,
4. Creates AWS Custom Resource to create a file in the third S3 bucket,
5. Creates Lambda function for bucket size calculation.
*/

export class S3_18475e2fc extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        const publicAccess = {
            blockPublicAcls: false,
            blockPublicPolicy: false,
            ignorePublicAcls: false,
            restrictPublicBuckets: false,
        };
        const version = false;
        const objectOwnershipAcl1 = s3.ObjectOwnership.BUCKET_OWNER_ENFORCED;

        // Simple S3 bucket without alarm
        const bucket1 = new s3.Bucket(this, 'BucketWithoutAlarm', {
            versioned: version,
            objectOwnership: objectOwnershipAcl1,
            bucketName: `bucket1-${this.account}-${this.region}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            intelligentTieringConfigurations: [
                {
                    name: 'MyIntelligentTieringConfig',
                    prefix: 'documents/',
                    tags: [{ key: 'department', value: 'finance' }],
                    archiveAccessTierTime: cdk.Duration.days(90),
                    deepArchiveAccessTierTime: cdk.Duration.days(180),
                },
            ],
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
        });

        // S3 bucket with CloudWatch alarm
        const bucket2 = new s3.Bucket(this, 'BucketWithAlarm', {
            versioned: true,
            bucketName: `bucket2-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            objectOwnership: objectOwnershipAcl1,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            metrics: [
                {
                    id: 'EntireBucketMetrics',
                },
            ],
        });

        // Create CloudWatch alarms for the monitored bucket

        // Alarm for number of objects
        const numberOfObjectsAlarmMetricName = 'NumberOfObjects';
        const numberOfObjectsAlarm = new cloudwatch.Metric({
            namespace: 'AWS/S3',
            metricName: numberOfObjectsAlarmMetricName,
            dimensionsMap: {
                BucketName: bucket2.bucketName,
            },
            statistic: 'Average',
            period: Duration.days(1),
        }).createAlarm(this, 'NumberOfObjectsAlarm', {
            evaluationPeriods: 1,
            threshold: 1000000,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            alarmDescription: 'Alarm when bucket has more than 1 million objects',
        });

        // Alarm for bucket size
        const bucketSizeAlarmMetricName = 'BucketSizeBytes';
        const bucketSizeAlarm = new cloudwatch.Metric({
            namespace: 'AWS/S3',
            metricName: bucketSizeAlarmMetricName,
            dimensionsMap: {
                BucketName: bucket2.bucketName,
                StorageType: 'StandardStorage',
            },
            statistic: 'Average',
            period: Duration.days(1),
        }).createAlarm(this, 'BucketSizeAlarm', {
            evaluationPeriods: 1,
            threshold: 5000000000,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            alarmDescription: 'Alarm when bucket size exceeds 5 GB',
        });

        // Create an S3 bucket with lifecycle rules along with an object

        const objectOwnershipAcl2 = s3.ObjectOwnership.OBJECT_WRITER;
        const accessControl1 = s3.BucketAccessControl.PRIVATE;

        const bucket3 = new s3.Bucket(this, 'BucketWithLifeCycleRules', {
            lifecycleRules: [
                {
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                            transitionAfter: cdk.Duration.days(30),
                        },
                    ],
                },
                {
                    transitions: [
                        {
                            storageClass: s3.StorageClass.GLACIER,
                            transitionAfter: cdk.Duration.days(90),
                        },
                    ],
                },
                {
                    expiration: cdk.Duration.days(365),
                },
                {
                    prefix: 'logs/',
                    expiration: cdk.Duration.days(30),
                },
                {
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
                },
                {
                    prefix: 'temp/',
                    expiration: cdk.Duration.days(7),
                    noncurrentVersionExpiration: cdk.Duration.days(1),
                },
            ],
            versioned: true,
            bucketName: `bucket3-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            objectOwnership: objectOwnershipAcl2,
            accessControl: accessControl1,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant each bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons these FIXED-NAME
        // buckets, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        // One block covers every fixed-name autoDeleteObjects bucket in the stack.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                bucket1.bucketArn,
                `${bucket1.bucketArn}/*`,
                bucket2.bucketArn,
                `${bucket2.bucketArn}/*`,
                bucket3.bucketArn,
                `${bucket3.bucketArn}/*`,
            ],
        });

        cdk.Tags.of(bucket3).add('BucketOwner', 'TeamA');

        // Create a custom resource to put the file
        const createFile = new cr.AwsCustomResource(this, 'CreateFile', {
            onCreate: {
                service: 'S3',
                action: 'putObject',
                parameters: {
                    Bucket: bucket3.bucketName,
                    Key: 'example.txt',
                    Body: 'Hello, World!',
                    ContentType: 'text/plain',
                },
                physicalResourceId: cr.PhysicalResourceId.of('file-example.txt'),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ['s3:PutObject'],
                    resources: [bucket3.arnForObjects('*')],
                }),
            ]),
        });

        // Create the Lambda function for bucket size calculation
        const bucketSizeCalculatorLogGroup = new logs.LogGroup(this, 'BucketSizeCalculatorLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const bucketSizeCalculator = new lambda.Function(this, 'BucketSizeCalculator', {
            logGroup: bucketSizeCalculatorLogGroup,
            runtime: lambda.Runtime.PYTHON_3_9,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(5),
            memorySize: 512,
            code: lambda.Code.fromInline(`
import boto3
import cfnresponse
import json

def handler(event, context):
    print(f"Received event: {json.dumps(event)}")

    try:
        if event['RequestType'] in ['Create', 'Update']:
            s3 = boto3.client('s3')
            bucket_name = event['ResourceProperties']['BucketName']
            print(f"Processing bucket: {bucket_name}")

            paginator = s3.get_paginator('list_objects_v2')
            total_size = 0
            total_objects = 0

            for page in paginator.paginate(Bucket=bucket_name):
                if 'Contents' in page:
                    for obj in page['Contents']:
                        total_size += int(obj['Size'])
                        total_objects += 1

            response_data = {
                'TotalSize': total_size,
                'TotalSizeGB': round(total_size / (1024 * 1024 * 1024), 2),
                'TotalSizeMB': round(total_size / (1024 * 1024), 2),
                'TotalObjects': total_objects
            }
            print(f"Calculated sizes: {json.dumps(response_data)}")
            cfnresponse.send(event, context, cfnresponse.SUCCESS, response_data)
        else:
            cfnresponse.send(event, context, cfnresponse.SUCCESS, {
                'TotalSize': 0,
                'TotalSizeGB': 0,
                'TotalSizeMB': 0,
                'TotalObjects': 0
            })

    except Exception as e:
        print(f"Error calculating bucket size: {str(e)}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {
            'TotalSize': 0,
            'TotalSizeGB': 0,
            'TotalSizeMB': 0,
            'TotalObjects': 0
        })
`),
        });

        // Grant the Lambda function permissions to read from the S3 bucket
        bucket3.grantRead(bucketSizeCalculator);

        // Create the custom resource
        const bucketSizeCalculation = new CustomResource(this, 'BucketSizeCalculation', {
            serviceToken: bucketSizeCalculator.functionArn,
            properties: {
                BucketName: bucket3.bucketName,
                UpdateTimestamp: new Date().toISOString(),
            },
        });

        // Add necessary IAM permissions for the Lambda function to be invoked by CloudFormation
        bucketSizeCalculator.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['s3:ListBucket', 's3:GetObject'],
                resources: [bucket3.bucketArn, `${bucket3.bucketArn}/*`],
            }),
        );

        // Grant CloudFormation permission to invoke the Lambda function
        bucketSizeCalculator.addPermission('CustomResourcePermission', {
            principal: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
            action: 'lambda:InvokeFunction',
        });

        const bucketNames = [bucket1, bucket2, bucket3].map((bucket) => bucket.bucketName).join(', ');
        StackUtils.exportStack(this, 'AllS3BucketNames', bucketNames);
        StackUtils.exportStack(this, 'S3BucketWithAlarm', bucket2.bucketName);
        StackUtils.exportStack(this, 'VersioningStatus', version.toString());
        StackUtils.exportStack(this, 'BlockPublicAccessStatus', publicAccess.blockPublicAcls.toString());
        StackUtils.exportStack(this, 'VersioningEnabledBucket', bucket2.bucketName);
        StackUtils.exportStack(this, 'EmptyS3Bucket1', bucket1.bucketName);
        StackUtils.exportStack(this, 'EmptyS3Bucket2', bucket2.bucketName);
        StackUtils.exportStack(this, 'S3BucketWithLifeCycleRules', bucket3.bucketName);
        StackUtils.exportStack(this, 'ACLStatus1', objectOwnershipAcl1.toString(), 'ACL status of the bucket1');
        StackUtils.exportStack(this, 'ACLStatus2', objectOwnershipAcl1.toString(), 'ACL status of the bucket2');
        StackUtils.exportStack(this, 'ACLStatus3', objectOwnershipAcl2.toString(), 'ACL status of the bucket3');
        StackUtils.exportStack(this, 'S3BucketWithoutIntelligentTieringConfigurations1', bucket2.bucketName);
        StackUtils.exportStack(this, 'S3BucketWithoutIntelligentTieringConfigurations2', bucket3.bucketName);
        StackUtils.exportStack(this, 'TotalBucketSize', bucketSizeCalculation.getAtt('TotalSize').toString());

        StackUtils.exportStack(this, 'BucketSizeAlarmName', bucketSizeAlarm.alarmName);
        StackUtils.exportStack(this, 'BucketSizeAlarmMetricName', bucketSizeAlarmMetricName);

        StackUtils.exportStack(this, 'NumberOfObjectsAlarmName', numberOfObjectsAlarm.alarmName);
        StackUtils.exportStack(this, 'NumberOfObjectsAlarmMetricName', numberOfObjectsAlarmMetricName);
    }
}
