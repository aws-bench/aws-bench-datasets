import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: dynamodb_fyu89ikhg
 * What the stack does:
 * 1. Creates DynamoDB table
 */

export class dynamodb_fyu89ikhg extends cdk.Stack {
    private readonly accountId: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);
        this.accountId = this.account;

        //  Create DynamoDB table with GSI to make queries more complex
        const table = new dynamodb.Table(this, 'DynamoDBTable', {
            tableName: `table-1getshy-${this.accountId}-${this.region}`,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            removalPolicy: RemovalPolicy.DESTROY,
            pointInTimeRecovery: true,
        });

        // Add GSI that might confuse agents about which fields to target
        table.addGlobalSecondaryIndex({
            indexName: 'EnvironmentIndex',
            partitionKey: { name: 'environment', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'ec2_instance_type', type: dynamodb.AttributeType.STRING },
        });

        const record1 = 'PROD-EC2-015';
        const record2 = 'PROD-EC2-027';
        const record3 = 'PROD-EC2-041';
        const record4 = 'PROD-EC2-063';
        const record5 = 'PROD-EC2-078';
        const record6 = 'PROD-EC2-084';
        const record7 = 'PROD-EC2-091';

        // Seeded random number generator for reproducible data
        class SeededRandom {
            private seed: number;
            constructor(seed: number) {
                this.seed = seed;
            }
            next(): number {
                this.seed = (this.seed * 9301 + 49297) % 233280;
                return this.seed / 233280;
            }
        }

        // Create many records to make scanning harder
        const createBatchItems = () => {
            const rng = new SeededRandom(12345); // Fixed seed for reproducibility
            const items = [];

            // Create all records first, then inject target records at specific positions
            const targetRecords = new Set([record1, record2, record3, record4, record5, record6, record7]);

            // Generate all 100 records
            for (let i = 1; i <= 100; i++) {
                const recordId = `PROD-SRV-${i.toString().padStart(3, '0')}`;
                const isTargetRecord = targetRecords.has(recordId.replace('SRV', 'EC2'));
                const hasEc2Fields = isTargetRecord; // Only target records have ec2 fields

                const item: Record<string, { S: string }> = {
                    id: { S: isTargetRecord ? recordId.replace('SRV', 'EC2') : recordId },
                    name: { S: isTargetRecord ? `production-server-${i}` : `server-${i}` },
                    environment: { S: i % 3 === 0 ? 'production' : 'staging' },
                    created_by: { S: ['terraform', 'cloudformation', 'manual'][i % 3] },
                };

                if (hasEc2Fields) {
                    // Target records have ec2 fields
                    const instanceId = Math.floor(rng.next() * 1000000000000000)
                        .toString(16)
                        .padStart(17, '0');
                    item.ec2_instance_id = { S: `i-${instanceId}` };
                    item.ec2_instance_type = { S: ['t3.micro', 't3.small', 't3.medium'][i % 3] };
                } else {
                    // Others have similar but different field names
                    const instanceId = Math.floor(rng.next() * 1000000000000000)
                        .toString(16)
                        .padStart(17, '0');
                    item.instance_id = { S: `i-${instanceId}` };
                    item.instance_type = { S: ['t3.micro', 't3.small', 't3.medium'][i % 3] };
                    item.aws_instance_id = { S: `i-${instanceId.substring(0, 10)}` };
                    item.compute_instance_type = { S: ['t3.micro', 't3.small'][i % 2] };
                }

                items.push({ PutRequest: { Item: item } });
            }
            return items;
        };

        // Split items into batches of 25 (DynamoDB limit)
        const allItems = createBatchItems();
        const batches = [];
        for (let i = 0; i < allItems.length; i += 25) {
            batches.push(allItems.slice(i, i + 25));
        }

        // Create multiple custom resources for each batch
        batches.forEach((batch, index) => {
            const populateTable = new cr.AwsCustomResource(this, `PopulateTable${index}`, {
                onCreate: {
                    service: 'DynamoDB',
                    action: 'batchWriteItem',
                    parameters: {
                        RequestItems: {
                            [table.tableName]: batch,
                        },
                    },
                    physicalResourceId: cr.PhysicalResourceId.of(`populate-table-${index}`),
                },
                policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                    resources: [table.tableArn],
                }),
            });
            table.grantWriteData(populateTable);
        });

        StackUtils.exportStack(this, 'TableName', table.tableName, 'DynamoDB table name');
        StackUtils.exportStack(this, 'FirstRecord', record1, 'Id of the first record');
        StackUtils.exportStack(this, 'SecondRecord', record2, 'Id of the second record');
        StackUtils.exportStack(this, 'ThirdRecord', record3, 'Id of the third record');
        StackUtils.exportStack(this, 'FourthRecord', record4, 'Id of the fourth record');
        StackUtils.exportStack(this, 'FifthRecord', record5, 'Id of the fifth record');
        StackUtils.exportStack(this, 'SixthRecord', record6, 'Id of the sixth record');
        StackUtils.exportStack(this, 'SeventhRecord', record7, 'Id of the seventh record');
        StackUtils.exportStack(this, 'GSIName', 'EnvironmentIndex', 'GSI that uses ec2_instance_type');
    }
}
