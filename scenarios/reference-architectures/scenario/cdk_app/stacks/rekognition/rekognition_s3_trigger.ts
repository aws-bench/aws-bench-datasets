import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { StackUtils } from '../../lib/shared';

export class RekognitionS3TriggerStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // S3 Bucket for image uploads
        const imageBucket = new s3.Bucket(this, 'ImageBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // DynamoDB Table for storing Rekognition results
        const labelsTable = new dynamodb.Table(this, 'LabelsTable', {
            partitionKey: { name: 'image_name', type: dynamodb.AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Lambda function to process images with Rekognition
        const rekognitionFunction = new lambda.Function(this, 'RekognitionFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/rekognition-s3-handler')),
            environment: {
                BUCKET_NAME: imageBucket.bucketName,
                TABLE_NAME: labelsTable.tableName,
            },
            timeout: cdk.Duration.seconds(60),
        });

        // Grant Rekognition permissions to the Lambda function
        rekognitionFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['rekognition:DetectLabels'],
            resources: ['*'],
        }));

        // Grant DynamoDB read/write and S3 read permissions
        labelsTable.grantReadWriteData(rekognitionFunction);
        imageBucket.grantRead(rekognitionFunction);

        // S3 event notifications for image uploads
        imageBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.LambdaDestination(rekognitionFunction),
            { suffix: '.jpg' },
        );
        imageBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.LambdaDestination(rekognitionFunction),
            { suffix: '.jpeg' },
        );
        imageBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.LambdaDestination(rekognitionFunction),
            { suffix: '.png' },
        );

        // Exports
        StackUtils.exportStack(this, 'BucketName', imageBucket.bucketName, 'S3 bucket for image uploads');
        StackUtils.exportStack(this, 'BucketArn', imageBucket.bucketArn, 'ARN of the image upload bucket');
        StackUtils.exportStack(this, 'TableName', labelsTable.tableName, 'DynamoDB table for Rekognition labels');
        StackUtils.exportStack(this, 'TableArn', labelsTable.tableArn, 'ARN of the labels DynamoDB table');
        StackUtils.exportStack(this, 'FunctionName', rekognitionFunction.functionName, 'Rekognition Lambda function name');
        StackUtils.exportStack(this, 'FunctionArn', rekognitionFunction.functionArn, 'ARN of the Rekognition Lambda function');
        StackUtils.exportStack(this, 'SupportedImageFormats', '.jpg,.jpeg,.png', 'Supported image formats for Rekognition');
        StackUtils.exportStack(this, 'MaxLabels', '10', 'Maximum number of labels returned by Rekognition');
        StackUtils.exportStack(this, 'MinConfidence', '70', 'Minimum confidence threshold for Rekognition labels');
    }
}
