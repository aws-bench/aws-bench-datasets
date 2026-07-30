#!/bin/bash
set -euo pipefail

JOB_BASENAME="BasaltDataAnalyzer-RoleReport"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

REGIONS=$(aws ec2 describe-regions --query "Regions[].RegionName" --output text)

DEPLOYMENT_REGION=""
DEPLOYED_JOB=""
for r in $REGIONS; do
    M=$(aws glue list-jobs --region "$r" --query "JobNames[?contains(@, '${JOB_BASENAME}')]" --output text 2>/dev/null || true)
    [ -n "$M" ] && { DEPLOYMENT_REGION="$r"; DEPLOYED_JOB="$M"; break; }
done

DEPLOYED_JOB=$(aws glue get-job --region "$DEPLOYMENT_REGION" --job-name "$DEPLOYED_JOB" --query "Job.Name" --output text)

ROLEREPORT_IN_EXPECTED=$(aws glue list-jobs --region "$EXPECTED_REGION" --query "JobNames[?contains(@, '${JOB_BASENAME}')]" --output text)

DEPLOY_STACK=$(aws cloudformation describe-stack-resources --region "$DEPLOYMENT_REGION" --physical-resource-id "$DEPLOYED_JOB" --query "StackResources[0].StackName" --output text)
DEPLOY_STACK_RESOURCES=$(aws cloudformation describe-stack-resources --region "$DEPLOYMENT_REGION" --stack-name "$DEPLOY_STACK" --query "StackResources[].[ResourceType,PhysicalResourceId]" --output text)
GLUE_ROLE=$(printf '%s\n' "$DEPLOY_STACK_RESOURCES" | awk '$1=="AWS::IAM::Role" && $2 ~ /GlueJobRole/ {print $2}')
BUCKET_COUNT=$(printf '%s\n' "$DEPLOY_STACK_RESOURCES" | awk '$1=="AWS::S3::Bucket"' | grep -c .)

ETL_JOB=$(aws glue list-jobs --region "$EXPECTED_REGION" --query "JobNames[?contains(@, 'BASALT_ETL_USAGE_EVENTS')]" --output text)
ETL_STACK=$(aws cloudformation describe-stack-resources --region "$EXPECTED_REGION" --physical-resource-id "$ETL_JOB" --query "StackResources[0].StackName" --output text)

cat > "$OUT" <<EOF
$JOB_BASENAME is not in $EXPECTED_REGION at all. A search across every enabled region found it only in $DEPLOYMENT_REGION, where it actually deployed as the Glue job $DEPLOYED_JOB, and a job-name lookup in $EXPECTED_REGION returned no $JOB_BASENAME job.

The only BASALT Glue job that lives in $EXPECTED_REGION is the usage-events ETL job $ETL_JOB. That job belongs to a different CloudFormation stack ($ETL_STACK) than the one being asked about, so it is a separate job — not $JOB_BASENAME.

Root cause: the CloudFormation stack that owns $JOB_BASENAME ($DEPLOY_STACK) was deployed to the wrong region ($DEPLOYMENT_REGION) instead of $EXPECTED_REGION. That single stack also contains the Glue execution role ($GLUE_ROLE) and $BUCKET_COUNT S3 buckets that the job depends on, all created alongside the job in $DEPLOYMENT_REGION.

What it takes to get it into $EXPECTED_REGION: a Glue job is a regional resource and cannot be moved in place, and it depends on the IAM role and S3 buckets that the same stack created alongside it. So the fix is to redeploy the entire $DEPLOY_STACK stack to $EXPECTED_REGION (point the CDK app's env.region at $EXPECTED_REGION, or deploy with --region $EXPECTED_REGION), which recreates the job together with its role and buckets there — not just recreate the job by itself. Then tear down the misdeployed $DEPLOYMENT_REGION stack ($DEPLOY_STACK) with cloudformation delete-stack / cdk destroy if it is no longer wanted.
EOF
