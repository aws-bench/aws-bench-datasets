#!/bin/bash
# Cleanup hook for ec2-multiregion — teardown counterpart to deploy/deploy.sh
# (cdk deploy --all -> cdk destroy --all). Runs in the scenario container before
# the framework's own teardown (trial.py::_run_cleanup), which is authoritative.
#
# This scenario's agent tasks create EC2 instances, route table associations, and
# other resources that are NOT CloudFormation-managed. If left in place they cause
# DependencyViolation errors during CDK destroy (subnets/VPCs/IGWs can't be deleted)
# and survive as orphans that fail the post-cleanup scan.
#
#
# Best-effort/idempotent: never fails the phase (exit 0 always).
set -uo pipefail

cd /app/cdk_app || { echo "[cleanup.sh] FATAL: /app/cdk_app missing" >&2; exit 0; }

export CDK_DEFAULT_ACCOUNT="$PRIMARY"
REGIONS="us-east-1 us-west-1 us-west-2"

echo "[cleanup.sh] ec2-multiregion teardown for account ${PRIMARY}"

# ===========================================================================
# Phase 1: Clean resources before CDK destroy
# ===========================================================================
# Agent tasks launch EC2 instances (creating VolumeAttachments), associate
# subnets to route tables (creating SubnetRouteTableAssociations), and may
# create/attach internet gateways. These block VPC/subnet deletion.
cleanup_residuals() {
    for region in $REGIONS; do
        echo "[cleanup.sh]   [Phase 1] Cleaning residuals in ${region}..."

        # 1a. Terminate all EC2 instances (releases VolumeAttachments and ENIs)
        instance_ids=$(aws ec2 describe-instances --profile PRIMARY --region "$region" \
            --filters "Name=instance-state-name,Values=pending,running,stopping,stopped" \
            --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null || true)
        if [ -n "$instance_ids" ] && [ "$instance_ids" != "None" ]; then
            echo "[cleanup.sh]     Terminating instances in ${region}: ${instance_ids}"
            aws ec2 terminate-instances --profile PRIMARY --region "$region" \
                --instance-ids $instance_ids >/dev/null 2>&1 || true
            aws ec2 wait instance-terminated --profile PRIMARY --region "$region" \
                --instance-ids $instance_ids 2>/dev/null || true
        fi

        # 1b. Disassociate non-main route table associations
        #     (removes SubnetRouteTableAssociations created by the agent)
        assoc_ids=$(aws ec2 describe-route-tables --profile PRIMARY --region "$region" \
            --query 'RouteTables[].Associations[?!Main].RouteTableAssociationId' \
            --output text 2>/dev/null || true)
        if [ -n "$assoc_ids" ] && [ "$assoc_ids" != "None" ]; then
            for assoc in $assoc_ids; do
                echo "[cleanup.sh]     Disassociating route table association: ${assoc}"
                aws ec2 disassociate-route-table --profile PRIMARY --region "$region" \
                    --association-id "$assoc" 2>/dev/null || true
            done
        fi

        # 1c. Detach internet gateways (safety net for IGWs left attached)
        for igw in $(aws ec2 describe-internet-gateways --profile PRIMARY --region "$region" \
            --query 'InternetGateways[].InternetGatewayId' --output text 2>/dev/null || true); do
            [ -z "$igw" ] || [ "$igw" = "None" ] && continue
            vpc_id=$(aws ec2 describe-internet-gateways --profile PRIMARY --region "$region" \
                --internet-gateway-ids "$igw" \
                --query 'InternetGateways[0].Attachments[0].VpcId' --output text 2>/dev/null || true)
            if [ -n "$vpc_id" ] && [ "$vpc_id" != "None" ]; then
                echo "[cleanup.sh]     Detaching IGW ${igw} from VPC ${vpc_id}"
                aws ec2 detach-internet-gateway --profile PRIMARY --region "$region" \
                    --internet-gateway-id "$igw" --vpc-id "$vpc_id" 2>/dev/null || true
            fi
        done
    done
}
cleanup_residuals || echo "[cleanup.sh]   Phase 1 incomplete; continuing"

# ===========================================================================
# Phase 2: CDK destroy
# ===========================================================================
npx cdk destroy --profile PRIMARY --all --force --concurrency 10 || \
    echo "[cleanup.sh]   cdk destroy incomplete; framework cleanup will finish teardown"

# ===========================================================================
# Phase 3: Post-destroy residual cleanup
# ===========================================================================
# CDK's CustomVpcRestrictDefault Lambda leaves behind a CloudWatch log group.
cleanup_post_destroy_residuals() {
    for region in $REGIONS; do
        echo "[cleanup.sh]   [Phase 3] Cleaning post-destroy residuals in ${region}..."

        # 3a. Delete Lambda log groups from CDK custom resources
        log_groups=$(aws logs describe-log-groups --profile PRIMARY --region "$region" \
            --log-group-name-prefix "/aws/lambda/ec2-multiregion" \
            --query 'logGroups[].logGroupName' --output text 2>/dev/null || true)
        if [ -n "$log_groups" ] && [ "$log_groups" != "None" ]; then
            for lg in $log_groups; do
                echo "[cleanup.sh]     Deleting log group: ${lg}"
                aws logs delete-log-group --profile PRIMARY --region "$region" \
                    --log-group-name "$lg" 2>/dev/null || true
            done
        fi
    done
}
cleanup_post_destroy_residuals || echo "[cleanup.sh]   Phase 3 incomplete; continuing"

# ===========================================================================
# Phase 4: Remove orphaned CDK bootstrap buckets
# ===========================================================================
# When CDKToolkit is deleted or in a bad state but its S3 bucket persists
# (non-empty versioned bucket), future bootstraps fail with "Resource already
# exists". Always remove CDK assets buckets — the deploy will re-bootstrap.
cleanup_orphaned_cdk_buckets() {
    for region in $REGIONS; do
        # Find CDK assets buckets for this account+region
        buckets=$(aws s3api list-buckets --profile PRIMARY \
            --query "Buckets[?starts_with(Name, 'cdk-') && contains(Name, '${region}')].Name" \
            --output text 2>/dev/null || true)

        [ -z "$buckets" ] || [ "$buckets" = "None" ] && continue

        for bucket in $buckets; do
            # Only target CDK bootstrap assets buckets (pattern: cdk-QUALIFIER-assets-ACCOUNT-REGION)
            echo "$bucket" | grep -q "assets" || continue

            echo "[cleanup.sh]   [Phase 4] Deleting CDK bucket: ${bucket} in ${region}"

            # Empty current objects
            aws s3 rm "s3://${bucket}" --recursive --profile PRIMARY --region "$region" 2>/dev/null || true

            # Delete versioned objects
            aws s3api list-object-versions --bucket "$bucket" --region "$region" --profile PRIMARY \
                --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null | \
                aws s3api delete-objects --bucket "$bucket" --region "$region" --profile PRIMARY \
                --delete file:///dev/stdin 2>/dev/null || true

            # Delete markers
            aws s3api list-object-versions --bucket "$bucket" --region "$region" --profile PRIMARY \
                --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null | \
                aws s3api delete-objects --bucket "$bucket" --region "$region" --profile PRIMARY \
                --delete file:///dev/stdin 2>/dev/null || true

            # Delete bucket
            aws s3api delete-bucket --bucket "$bucket" --region "$region" --profile PRIMARY 2>/dev/null || \
                echo "[cleanup.sh]     Could not delete bucket ${bucket} (may still have objects)"
        done
    done
}
cleanup_orphaned_cdk_buckets || echo "[cleanup.sh]   Phase 4 incomplete; continuing"

echo "[cleanup.sh] Done."
exit 0