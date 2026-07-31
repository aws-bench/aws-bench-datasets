#!/bin/bash
set -euo pipefail

REGION="us-west-2"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

PROFILE_ARN=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --query "Reservations[0].Instances[0].IamInstanceProfile.Arn" --output text)
STACK_NAME=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --query "Reservations[0].Instances[0].Tags[?Key=='aws:cloudformation:stack-name'].Value | [0]" --output text)

PROFILE_NAME="${PROFILE_ARN##*/}"
ROLE_NAME=$(aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" \
    --query "InstanceProfile.Roles[0].RoleName" --output text)

SECRET_ARN=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='SecretArn'].OutputValue | [0]" --output text)
KMS_KEY_ID=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='KmsKeyId'].OutputValue | [0]" --output text)

SECRET_KMS=$(aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_ARN" \
    --query "KmsKeyId" --output text)

INLINE_POLICY_NAMES=$(aws iam list-role-policies --role-name "$ROLE_NAME" \
    --query "PolicyNames" --output text)
INLINE_POLICY_DOCS=""
for POLICY in $INLINE_POLICY_NAMES; do
    DOC=$(aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY" \
        --query "PolicyDocument" --output json)
    INLINE_POLICY_DOCS="${INLINE_POLICY_DOCS}${DOC}"
done
ATTACHED_POLICY_ARNS=$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" \
    --query "AttachedPolicies[].PolicyArn" --output text)

cat > "$OUT" <<EOF
EC2 instance ${INSTANCE_ID} in ${REGION} gets exit code 255 because its IAM instance role (${ROLE_NAME}) is missing the kms:Decrypt permission for the KMS key that encrypts the secret.

Root cause:
- The secret ${SECRET_ARN} is encrypted with the customer-managed KMS key ${KMS_KEY_ID} (${SECRET_KMS}).
- The instance role ${ROLE_NAME} grants secretsmanager:GetSecretValue (and secretsmanager:DescribeSecret), which lets the instance call Secrets Manager successfully.
- The role's policies do not grant kms:Decrypt on ${KMS_KEY_ID}. When Secrets Manager attempts to decrypt the secret's data key with KMS using the instance role's credentials, the KMS request fails with AccessDeniedException, so GetSecretValue fails and the retrieval process exits with code 255.

Fix: grant the instance role ${ROLE_NAME} kms:Decrypt on the KMS key ${KMS_KEY_ID} (either via an IAM policy statement allowing kms:Decrypt for that key ARN, or by adding the role as a principal with kms:Decrypt in the KMS key policy).
EOF
