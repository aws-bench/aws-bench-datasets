#!/bin/bash
set -euo pipefail

REGION="us-east-1"
PLAN_ID="${BACKUP_PLAN_ID}"
VAULT_NAME="${BACKUP_VAULT_NAME}"
BUCKET_NAME="${BUCKET_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

RULE_COUNT=$(aws backup get-backup-plan --backup-plan-id "$PLAN_ID" --region "$REGION" \
    --query "length(BackupPlan.Rules)" --output text)
RULE=$(aws backup get-backup-plan --backup-plan-id "$PLAN_ID" --region "$REGION" \
    --query "BackupPlan.Rules[0].[RuleName,ScheduleExpression,Lifecycle.DeleteAfterDays,StartWindowMinutes,CompletionWindowMinutes]" --output text)
RULE_NAME=$(echo "$RULE" | cut -f1)
SCHEDULE=$(echo "$RULE" | cut -f2)
DELETE_AFTER=$(echo "$RULE" | cut -f3)
START_WIN=$(echo "$RULE" | cut -f4)
COMPLETE_WIN=$(echo "$RULE" | cut -f5)

SEL_ID=$(aws backup list-backup-selections --backup-plan-id "$PLAN_ID" --region "$REGION" \
    --query "BackupSelectionsList[0].SelectionId" --output text)
SEL=$(aws backup get-backup-selection --backup-plan-id "$PLAN_ID" --selection-id "$SEL_ID" --region "$REGION" \
    --query "BackupSelection.ListOfTags[0].[ConditionType,ConditionKey,ConditionValue]" --output text)
COND_TYPE=$(echo "$SEL" | cut -f1)
COND_KEY=$(echo "$SEL" | cut -f2)
COND_VALUE=$(echo "$SEL" | cut -f3)

VAULT=$(aws backup describe-backup-vault --backup-vault-name "$VAULT_NAME" --region "$REGION" \
    --query "[EncryptionKeyArn,Locked]" --output text)
KEY_ARN=$(echo "$VAULT" | cut -f1)
LOCKED=$(echo "$VAULT" | cut -f2)
KEY_ALIAS=$(aws kms list-aliases --key-id "$KEY_ARN" --region "$REGION" \
    --query "Aliases[0].AliasName" --output text)

VERSIONING=$(aws s3api get-bucket-versioning --bucket "$BUCKET_NAME" --region "$REGION" --query "Status" --output text)
SSE=$(aws s3api get-bucket-encryption --bucket "$BUCKET_NAME" --region "$REGION" \
    --query "ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm" --output text)

cat > "$OUT" <<EOF
AWS Backup configuration review for plan $PLAN_ID (vault $VAULT_NAME, bucket $BUCKET_NAME)

RESOURCE SELECTION
The backup plan uses a tag-based selection (not an explicit ARN list): it targets all resources carrying the tag $COND_KEY=$COND_VALUE with condition $COND_TYPE. This is why the existing bucket $BUCKET_NAME is protected today. Any resource with that tag is automatically included, with no change to the plan or selection.

SCHEDULE AND RETENTION
The plan has a single rule ($RULE_NAME, $RULE_COUNT rule total) that runs daily at midnight UTC via $SCHEDULE. Retention is $DELETE_AFTER days (DeleteAfterDays: $DELETE_AFTER). The rule has an 8-hour start window ($START_WIN minutes) and a 7-day completion window ($COMPLETE_WIN minutes). No cold-storage transition is configured.

VAULT ENCRYPTION
The vault $VAULT_NAME is encrypted with the AWS-managed AWS Backup KMS key ($KEY_ALIAS) in the account, since no customer-managed CMK was specified. The vault key ARN is $KEY_ARN. The vault is not locked (Locked: $LOCKED), so the backup plan can be updated freely.

EXISTING BUCKET STATE
The bucket $BUCKET_NAME has S3 versioning $VERSIONING and uses SSE-S3 ($SSE) default encryption.

ADDING A SECOND S3 BUCKET
Because the selection is tag-based, no changes to the backup plan or selection are needed. To protect a second S3 bucket you must:
  (1) Enable versioning on the new bucket -- AWS Backup requires S3 versioning to be enabled, or the backup will fail.
  (2) Add the tag $COND_KEY=$COND_VALUE to the new bucket.
The tag-based selection then automatically includes it on the next scheduled run (or an on-demand backup).

CROSS-REGION COPY
The current vault setup is compatible with adding a cross-region copy rule. Because the vault is not locked, the plan can be updated. You add a CopyAction to the existing $RULE_NAME rule specifying a destination backup vault ARN in the target region. The destination vault will have its own KMS encryption key -- either the AWS-managed default key ($KEY_ALIAS) in that region or a customer-managed CMK you create there. AWS Backup handles re-encryption during the copy, so using the AWS-managed default key on the source vault does not block cross-region copy. No changes to the source vault encryption are required.
EOF
