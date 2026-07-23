import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../lib/shared';

/*
 * Stack ID: s3_dkj487ewd
 * What the stack does:
 * 1. Creates a S3 bucket containing B2B commerce CSV files
 *
 */

export class s3_dkj487ewd extends cdk.Stack {
    private readonly accountId: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // Create S3 bucket
        const bucket = new s3.Bucket(this, 'B2BCommerceBucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            bucketName: `prod-bucket-9j3g4hb-${this.accountId}-${this.region}`,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant the bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons this FIXED-NAME
        // bucket, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [bucket.bucketArn, `${bucket.bucketArn}/*`],
        });

        // Generate sample B2B commerce CSV data with parsing challenges

        const generateCSVContent = (partNumber: number): string => {
            const headers =
                'merchant_id,customerbaid,dealId,dealname,asin,originalsku,dealppu,startDate,endDate,status';
            const rows: string[] = [];
            const dealIds = [
                'DEAL_001',
                'DEAL_002',
                'DEAL_003',
                'DEAL_004',
                'DEAL_005',
                'DEAL_006',
                'DEAL_007',
                'DEAL_008',
                'DEAL_009',
                'DEAL_010',
            ];

            for (let i = partNumber * 1200; i < (partNumber + 1) * 1200; i++) {
                const dealId = dealIds[i % 10];
                const status = i % 7 === 0 ? 'ARCHIVED' : 'ACTIVE';
                const endDate = i % 11 === 0 ? '' : '2024-12-31';

                const dealName = `"Deal Name ${i}, Special Offer, Limited Time"`;

                let startDate = '2024-01-01';
                if (dealId === 'DEAL_001' || dealId === 'DEAL_002') {
                    const dates = ['2024-01-01', '2024-03-15', '2024-06-01'];
                    startDate = dates[i % 3];
                }
                rows.push(
                    [
                        `MERCHANT_${i % 100}`,
                        `CUSTOMER_${i % 50}`,
                        dealId,
                        dealName,
                        `B${String(i % 10000).padStart(10, '0')}`,
                        `"SKU-${i % 1000}, Premium"`,
                        ((i % 10000) / 100).toFixed(2),
                        startDate,
                        endDate,
                        status,
                    ].join(','),
                );
            }

            return [headers, ...rows].join('\n');
        };

        // Create 5 CSV files (part-00000 through part-00004) in a single deployment
        const csvSources = [];
        for (let i = 0; i < 5; i++) {
            const csvContent = generateCSVContent(i);
            csvSources.push(s3deploy.Source.data(`part-${String(i).padStart(5, '0')}.csv`, csvContent));
        }

        new s3deploy.BucketDeployment(this, 'DeployCSVFiles', {
            sources: csvSources,
            destinationBucket: bucket,
        });

        // Output bucket name and deal counts
        StackUtils.exportStack(this, 'BucketName', bucket.bucketName, 'S3 bucket containing B2B commerce CSV files');
    }
}
