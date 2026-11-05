#!/bin/bash
set -euo pipefail

cd /app/cdk_app

# aws-bench has written ~/.aws/config with one profile per account tag.
# CDK assumes the role declared in the profile (auto-refreshing on expiry)
# when invoked with --profile.
export CDK_DEFAULT_ACCOUNT="$PRIMARY"

npm run build

# Bootstrapping is idempotent.
for region in us-east-1 us-west-1 us-west-2; do
    npx cdk bootstrap --profile PRIMARY "aws://${PRIMARY}/${region}"
done

# One retry for transient create races: IAM propagation can lag role creation
# enough that Lambda CreateFunction fails ("The role defined for the function
# cannot be assumed by Lambda"), rolling the stack back to ROLLBACK_COMPLETE.
# On the retry, cdk deletes the creation-failed stack and recreates it;
# already-completed stacks are no-op'd.
cdk_deploy() {
    if ! npx cdk deploy "$@"; then
        echo "cdk deploy failed; retrying once for transient CFN/IAM races..." >&2
        npx cdk deploy "$@"
    fi
}

cdk_deploy --profile PRIMARY --all --require-approval never --concurrency 10

# Wait for the scenario AMI before handing back to the framework.
# The CreateAmi custom resource (stack EC2-ks84v1fh12, us-east-1) calls
# ec2:CreateImage, which returns as soon as the AMI is registered: EC2 reboots
# the instance and creates the AMI's EBS snapshot afterwards. So `cdk deploy`
# can finish before the snapshot exists. aws-bench captures the post-setup
# baseline right after this script, and a snapshot that appears later is
# reported as a new resource by the pre-run verification ("New resources
# detected - AWS::EC2::Snapshot"). Once the AMI is `available`, its snapshot is
# complete and lands in the baseline.
# Idempotent: an AMI that is already available returns immediately.
wait_for_scenario_ami() {
    local region="us-east-1"
    local name="ami-${PRIMARY}-${region}" # amiName in stacks/ec2_ks84v1fh1.ts
    local image_id attempt
    image_id=$(aws ec2 describe-images --profile PRIMARY --region "$region" --owners self \
        --filters "Name=name,Values=${name}" --query 'Images[0].ImageId' --output text)
    if [ -z "$image_id" ] || [ "$image_id" = "None" ]; then
        echo "AMI ${name} not found in ${region} after cdk deploy" >&2
        return 1
    fi
    # Each waiter call polls for up to 10 minutes; allow two within the deploy
    # phase's 30-minute budget. A `failed` AMI makes the waiter fail at once.
    for attempt in 1 2; do
        if aws ec2 wait image-available --profile PRIMARY --region "$region" \
            --image-ids "$image_id"; then
            echo "AMI ${image_id} (${name}) is available"
            return 0
        fi
        echo "AMI ${image_id} not available yet (wait ${attempt}/2)" >&2
    done
    aws ec2 describe-images --profile PRIMARY --region "$region" --image-ids "$image_id" \
        --query 'Images[0].[State,StateReason.Message]' --output text >&2 || true
    return 1
}

wait_for_scenario_ami
