import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: athena_k89bh5er2
 *
 * The stack creates the following resources:
 *
 * 1. Creates an S3 bucket with CSV files
 * 2. Creates sample CSV data in directory structure
 *
 */

export class athena_k89bh5er2 extends cdk.Stack {
    private readonly accountId: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);
        this.accountId = this.account;

        // S3 bucket for CSV files
        const csvBucket = new s3.Bucket(this, 'AthenaCsvBucket', {
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });
        csvBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Deploy complex CSV files in multiple batches to avoid CloudFormation response limits

        // Batch 1: Core data files
        const csvFiles1 = new s3deploy.BucketDeployment(this, 'CsvFiles1', {
            sources: [
                s3deploy.Source.data(
                    'data/raw/sales/Q1/jan_sales_final_v2.csv',
                    'ID,Product Name,Amount (USD),Transaction Date,Customer ID,Region\n1,"Laptop, Gaming",1200.50,2023-01-15,C001,"North America"\n2,Mouse Wireless,25.99,2023-01-16,C002,Europe\n3,"Keyboard, Mechanical",75.00,,C003,Asia',
                ),
                s3deploy.Source.data(
                    'data/processed/customers/customer_master_file.csv',
                    'cust_id,full_name,email_address,phone,address_line_1,city,state,zip\nC001,"John, Doe Jr.",john@example.com,555-1234,"123 Main St, Apt 4B",New York,NY,10001\nC002,Jane Smith,jane@example.com,,456 Oak Ave,London,,SW1A 1AA\nC003,Bob Wilson,bob@example.com,555-5678,789 Pine Rd,Tokyo,,100-0001',
                ),
                s3deploy.Source.data(
                    'exports/financial_data_export.csv',
                    '# Financial Export - Generated 2023-01-20\n# Contains sensitive data\nrevenue,costs,profit,quarter\n150000,120000,30000,Q1\n180000,140000,40000,Q2\n# Note: Q3 data pending\n200000,160000,40000,Q4',
                ),
                s3deploy.Source.data(
                    'temp/inventory/stock_levels.csv',
                    'item_code;quantity;warehouse_location;last_updated\nLAP001;50;WH-NYC;2023-01-15 10:30:00\nMOU001;200;WH-LON;2023-01-16 14:45:00\nKEY001;75;WH-TOK;2023-01-17 09:15:00',
                ),
            ],
            destinationBucket: csvBucket,
            prune: false,
        });

        // Batch 2: Transaction logs and department files
        const csvFiles2 = new s3deploy.BucketDeployment(this, 'CsvFiles2', {
            sources: [
                s3deploy.Source.data(
                    'logs/transaction_log.csv',
                    Array.from(
                        { length: 50 },
                        (_, i) =>
                            `${i + 1},TXN${String(i + 1).padStart(6, '0')},${((i * 7 + 13) % 1000)},2023-01-${String((i % 31) + 1).padStart(2, '0')}`,
                    )
                        .join('\n')
                        .replace(/^/, 'id,transaction_id,amount,date\n'),
                ),
                s3deploy.Source.data('dept/hr/employees_2023.csv', 'emp_id,name,dept\n1,Alice,HR\n2,Bob,IT'),
                s3deploy.Source.data(
                    'dept/it/servers.csv',
                    'server_id,hostname,status\n1,web01,active\n2,db01,maintenance',
                ),
                s3deploy.Source.data('dept/finance/budgets.csv', 'dept,budget,year\nHR,50000,2023\nIT,100000,2023'),
            ],
            destinationBucket: csvBucket,
            prune: false,
        });
        csvFiles2.node.addDependency(csvFiles1);

        // Batch 3: Regional sales data
        const csvFiles3 = new s3deploy.BucketDeployment(this, 'CsvFiles3', {
            sources: [
                s3deploy.Source.data(
                    'regions/us/sales_us.csv',
                    'region,sales,month\nUS-East,10000,Jan\nUS-West,15000,Jan',
                ),
                s3deploy.Source.data(
                    'regions/eu/sales_eu.csv',
                    'region,sales,month\nEU-North,8000,Jan\nEU-South,12000,Jan',
                ),
                s3deploy.Source.data(
                    'regions/asia/sales_asia.csv',
                    'region,sales,month\nAsia-Pacific,20000,Jan\nAsia-Central,5000,Jan',
                ),
            ],
            destinationBucket: csvBucket,
            prune: false,
        });
        csvFiles3.node.addDependency(csvFiles2);

        // Batch 4: Product categories
        const csvFiles4 = new s3deploy.BucketDeployment(this, 'CsvFiles4', {
            sources: [
                s3deploy.Source.data(
                    'products/category_a/items.csv',
                    'item_id,name,price\n1,Widget A,10\n2,Gadget A,20',
                ),
                s3deploy.Source.data(
                    'products/category_b/items.csv',
                    'item_id,name,price\n3,Widget B,15\n4,Gadget B,25',
                ),
                s3deploy.Source.data(
                    'products/category_c/items.csv',
                    'item_id,name,price\n5,Widget C,12\n6,Gadget C,22',
                ),
            ],
            destinationBucket: csvBucket,
            prune: false,
        });
        csvFiles4.node.addDependency(csvFiles3);

        // Batch 5: Time-based data
        const csvFiles5 = new s3deploy.BucketDeployment(this, 'CsvFiles5', {
            sources: [
                s3deploy.Source.data('quarterly/q1/summary.csv', 'metric,value\nrevenue,100000\nprofit,20000'),
                s3deploy.Source.data('quarterly/q2/summary.csv', 'metric,value\nrevenue,120000\nprofit,25000'),
                s3deploy.Source.data('quarterly/q3/summary.csv', 'metric,value\nrevenue,110000\nprofit,22000'),
                s3deploy.Source.data('quarterly/q4/summary.csv', 'metric,value\nrevenue,130000\nprofit,28000'),
                s3deploy.Source.data('monthly/jan/orders.csv', 'order_id,amount\n1001,500\n1002,750'),
                s3deploy.Source.data('monthly/feb/orders.csv', 'order_id,amount\n1003,600\n1004,800'),
                s3deploy.Source.data('monthly/mar/orders.csv', 'order_id,amount\n1005,550\n1006,900'),
            ],
            destinationBucket: csvBucket,
            prune: false,
        });
        csvFiles5.node.addDependency(csvFiles4);

        // Outputs stack information
        StackUtils.exportStack(this, 'CsvBucketName', csvBucket.bucketName);
    }
}
