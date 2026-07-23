Analyze B2B commerce deal data from S3 bucket {{compute-and-data-s3-dkj487ewd-us-east-1-BucketName}}:

1. Download and analyze CSV files in the bucket to identify the top 5 merchants and customers by deal count.
2. Create a JSON summary with `total_deals`, `active_deals`, `archived_deals`, `top_merchants`, `top_customers`. Each entry in `top_merchants` and `top_customers` must be a JSON object with a `count` key representing the deal count.
3. Upload the summary to `s3://{{compute-and-data-s3-dkj487ewd-us-east-1-BucketName}}/reports/summary.json` with object tags `Environment=production` and `ReportType=analysis`.
4. Add a bucket lifecycle policy that transitions objects under the `reports/` prefix to GLACIER after 90 days.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.
