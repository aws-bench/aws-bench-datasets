import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
Stack ID: dynamodb_ghjk456ad

Creates a DynamoDB table with:
- Partition key (ContentId) and sort key (TaskId)
- Pay-per-request billing
- Warm throughput enabled
- 6 Global Secondary Indexes
- Configured for high read throughput
*/
export class dynamodb_ghjk456ad extends cdk.Stack {

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        // Create DynamoDB table
        const table = new dynamodb.Table(this, 'TaskManagementTable', {
            partitionKey: { name: 'ContentId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'TaskId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Add GSI's
        table.addGlobalSecondaryIndex({
            indexName: 'TaskStatus_CreationTime',
            partitionKey: { name: 'TaskStatus', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'CreationTime', type: dynamodb.AttributeType.NUMBER },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        table.addGlobalSecondaryIndex({
            indexName: 'TaskId',
            partitionKey: { name: 'TaskId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        table.addGlobalSecondaryIndex({
            indexName: 'CreationTime',
            partitionKey: { name: 'CreationTime', type: dynamodb.AttributeType.NUMBER },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        table.addGlobalSecondaryIndex({
            indexName: 'ContentIdOnly',
            partitionKey: { name: 'ContentId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        table.addGlobalSecondaryIndex({
            indexName: 'AssignedTo_TaskStatus',
            partitionKey: { name: 'AssignedTo', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'TaskStatus', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        table.addGlobalSecondaryIndex({
            indexName: 'Priority_CreationTime',
            partitionKey: { name: 'Priority', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'CreationTime', type: dynamodb.AttributeType.NUMBER },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        const contentId = 'CONT012';
        // Create Custom Resource to insert initial records
        const initialRecords = [
            {
                ContentId: 'CONT001',
                TaskId: 'TASK001',
                TaskStatus: 'PENDING',
                CreationTime: Date.now(),
                AssignedTo: 'user1@example.com',
                Priority: 'HIGH',
                Description: 'Initial task 1',
            },
            {
                ContentId: 'CONT002',
                TaskId: 'TASK002',
                TaskStatus: 'IN_PROGRESS',
                CreationTime: Date.now(),
                AssignedTo: 'user2@example.com',
                Priority: 'MEDIUM',
                Description: 'Initial task 2',
            },
            {
                ContentId: 'CONT003',
                TaskId: 'TASK003',
                TaskStatus: 'COMPLETED',
                CreationTime: Date.now(),
                AssignedTo: 'user3@example.com',
                Priority: 'LOW',
                Description: 'Content review task',
            },
            {
                ContentId: 'CONT004',
                TaskId: 'TASK004',
                TaskStatus: 'PENDING',
                CreationTime: Date.now(),
                AssignedTo: 'user4@example.com',
                Priority: 'HIGH',
                Description: 'Security audit task',
            },
            {
                ContentId: 'CONT005',
                TaskId: 'TASK005',
                TaskStatus: 'IN_PROGRESS',
                CreationTime: Date.now(),
                AssignedTo: 'user1@example.com',
                Priority: 'MEDIUM',
                Description: 'Database optimization',
            },
            {
                ContentId: 'CONT006',
                TaskId: 'TASK006',
                TaskStatus: 'BLOCKED',
                CreationTime: Date.now(),
                AssignedTo: 'user2@example.com',
                Priority: 'HIGH',
                Description: 'API integration',
            },
            {
                ContentId: 'CONT007',
                TaskId: 'TASK007',
                TaskStatus: 'PENDING',
                CreationTime: Date.now(),
                AssignedTo: 'user3@example.com',
                Priority: 'LOW',
                Description: 'Documentation update',
            },
            {
                ContentId: 'CONT008',
                TaskId: 'TASK008',
                TaskStatus: 'IN_PROGRESS',
                CreationTime: Date.now(),
                AssignedTo: 'user4@example.com',
                Priority: 'MEDIUM',
                Description: 'Performance testing',
            },
            {
                ContentId: 'CONT009',
                TaskId: 'TASK009',
                TaskStatus: 'COMPLETED',
                CreationTime: Date.now(),
                AssignedTo: 'user1@example.com',
                Priority: 'HIGH',
                Description: 'Code review',
            },
            {
                ContentId: 'CONT010',
                TaskId: 'TASK010',
                TaskStatus: 'PENDING',
                CreationTime: Date.now(),
                AssignedTo: 'user2@example.com',
                Priority: 'MEDIUM',
                Description: 'UI enhancement',
            },
            {
                ContentId: 'CONT011',
                TaskId: 'TASK011',
                TaskStatus: 'IN_PROGRESS',
                CreationTime: Date.now(),
                AssignedTo: 'user3@example.com',
                Priority: 'HIGH',
                Description: 'Security patch',
            },
            {
                ContentId: contentId,
                TaskId: 'TASK012',
                TaskStatus: 'BLOCKED',
                CreationTime: Date.now(),
                AssignedTo: 'user4@example.com',
                Priority: 'LOW',
                Description: 'Database backup',
            },
            {
                ContentId: 'CONT013',
                TaskId: 'TASK013',
                TaskStatus: 'COMPLETED',
                CreationTime: Date.now(),
                AssignedTo: 'user1@example.com',
                Priority: 'MEDIUM',
                Description: 'Load testing',
            },
            {
                ContentId: 'CONT014',
                TaskId: 'TASK014',
                TaskStatus: 'PENDING',
                CreationTime: Date.now(),
                AssignedTo: 'user2@example.com',
                Priority: 'HIGH',
                Description: 'Feature implementation',
            },
            {
                ContentId: 'CONT015',
                TaskId: 'TASK015',
                TaskStatus: 'IN_PROGRESS',
                CreationTime: Date.now(),
                AssignedTo: 'user3@example.com',
                Priority: 'LOW',
                Description: 'Bug fixing',
            },
            {
                ContentId: 'CONT016',
                TaskId: 'TASK016',
                TaskStatus: 'COMPLETED',
                CreationTime: Date.now(),
                AssignedTo: 'user4@example.com',
                Priority: 'MEDIUM',
                Description: 'User acceptance testing',
            },
            {
                ContentId: 'CONT017',
                TaskId: 'TASK017',
                TaskStatus: 'BLOCKED',
                CreationTime: Date.now(),
                AssignedTo: 'user1@example.com',
                Priority: 'HIGH',
                Description: 'Infrastructure upgrade',
            },
            {
                ContentId: 'CONT018',
                TaskId: 'TASK018',
                TaskStatus: 'PENDING',
                CreationTime: Date.now(),
                AssignedTo: 'user2@example.com',
                Priority: 'LOW',
                Description: 'Monitoring setup',
            },
            {
                ContentId: 'CONT019',
                TaskId: 'TASK019',
                TaskStatus: 'IN_PROGRESS',
                CreationTime: Date.now(),
                AssignedTo: 'user3@example.com',
                Priority: 'MEDIUM',
                Description: 'Data migration',
            },
            {
                ContentId: 'CONT020',
                TaskId: 'TASK020',
                TaskStatus: 'COMPLETED',
                CreationTime: Date.now(),
                AssignedTo: 'user4@example.com',
                Priority: 'HIGH',
                Description: 'Final deployment',
            },
        ];

        // Insert all initial records using a single AwsCustomResource with batchWriteItem
        new cr.AwsCustomResource(this, 'InitialRecords', {
            onCreate: {
                service: 'DynamoDB',
                action: 'batchWriteItem',
                parameters: {
                    RequestItems: {
                        [table.tableName]: initialRecords.map((record) => ({
                            PutRequest: {
                                Item: {
                                    ContentId: { S: record.ContentId },
                                    TaskId: { S: record.TaskId },
                                    TaskStatus: { S: record.TaskStatus },
                                    CreationTime: { N: record.CreationTime.toString() },
                                    AssignedTo: { S: record.AssignedTo },
                                    Priority: { S: record.Priority },
                                    Description: { S: record.Description },
                                },
                            },
                        })),
                    },
                },
                physicalResourceId: cr.PhysicalResourceId.of('InitialRecords'),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                resources: [table.tableArn],
            }),
        });

        table.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Output the table name and table ARN
        StackUtils.exportStack(this, 'TableName', table.tableName, 'DynamoDB Table Name');
        StackUtils.exportStack(this, 'ContentId', contentId, 'A sample content ID');
        StackUtils.exportStack(this, 'TableArn', table.tableArn, 'DynamoDB Table ARN');
    }
}
