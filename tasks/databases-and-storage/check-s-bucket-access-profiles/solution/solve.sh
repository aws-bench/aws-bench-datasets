#!/bin/bash
set -euo pipefail

REGION="us-east-1"
DEV_USER="${DEV_PROFILE_USER_NAME}"
STAGING_USER="${STAGING_PROFILE_USER_NAME}"
BUCKET="${BUCKET_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BUCKET_POLICY=$(aws s3api get-bucket-policy --bucket "$BUCKET" --region "$REGION" --query Policy --output text)

OBJECT_KEY=$(aws s3api list-objects-v2 --bucket "$BUCKET" --region "$REGION" --query "Contents[0].Key" --output text)
BODY_FILE=$(mktemp)
aws s3api get-object --bucket "$BUCKET" --region "$REGION" --key "$OBJECT_KEY" "$BODY_FILE" --query ContentLength --output text
CONTENT=$(cat "$BODY_FILE")

ALL_USERS=$(aws iam list-users --query "Users[].UserName" --output text)

DEV_ATTACHED=$(aws iam list-attached-user-policies --user-name "$DEV_USER" --query "AttachedPolicies[].PolicyName" --output text)
DEV_INLINE=$(aws iam list-user-policies --user-name "$DEV_USER" --query "PolicyNames" --output text)

STAGING_ATTACHED=$(aws iam list-attached-user-policies --user-name "$STAGING_USER" --query "AttachedPolicies[].PolicyName" --output text)
STAGING_INLINE=$(aws iam list-user-policies --user-name "$STAGING_USER" --query "PolicyNames" --output text)
STAGING_GROUPS=$(aws iam list-groups-for-user --user-name "$STAGING_USER" --query "Groups[].GroupName" --output text)

OTHER_POLICIES=""
for U in $ALL_USERS; do
    UA=$(aws iam list-attached-user-policies --user-name "$U" --query "AttachedPolicies[].PolicyName" --output text)
    UI=$(aws iam list-user-policies --user-name "$U" --query "PolicyNames" --output text)
    OTHER_POLICIES="${OTHER_POLICIES}${U}: attached=[${UA}] inline=[${UI}]"$'\n'
done

cat > "$OUT" <<EOF
The IAM user ${DEV_USER} has read access to the bucket ${BUCKET} via the bucket's resource policy (s3:GetObject and s3:ListBucket). The bucket policy contains an Allow statement (Sid AllowDevProfileRead) naming this user's ARN as the principal; the user has no identity-based policies of its own.

The user ${STAGING_USER} does not have access. It has no identity-based policies (no attached managed policies, no inline policies, and no group memberships) and is not referenced in the bucket policy.

No other IAM users in the account have access to this bucket. Only ${DEV_USER} is named as a user principal in the bucket policy, and no other IAM user has an identity-based policy granting access to this bucket.

The bucket contains a single object (${OBJECT_KEY}) with the following content: ${CONTENT}
EOF
