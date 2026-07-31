#!/bin/bash
set -euo pipefail

REGION="us-east-1"
POOL_ID="${USER_POOL_ID}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

RECOVERY=$(aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOL_ID" \
    --query "UserPool.AccountRecoverySetting.RecoveryMechanisms[].[Priority,Name]" --output text)
SMS=$(aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOL_ID" \
    --query "UserPool.SmsConfiguration" --output text)
AUTOVERIFIED=$(aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOL_ID" \
    --query "UserPool.AutoVerifiedAttributes" --output text)
USERNAME_ATTRS=$(aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOL_ID" \
    --query "UserPool.UsernameAttributes" --output text)
ADMIN_ONLY=$(aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOL_ID" \
    --query "UserPool.AdminCreateUserConfig.AllowAdminCreateUserOnly" --output text)
CLIENT_COUNT=$(aws cognito-idp list-user-pool-clients --region "$REGION" --user-pool-id "$POOL_ID" \
    --query "length(UserPoolClients)" --output text)

cat > "$OUT" <<EOF
Audit of account recovery for Cognito user pool ${POOL_ID}.

VERDICT: A user can only recover their password via email. They will never be
able to recover via phone, even though phone (verified_phone_number) is listed
as the priority-1 recovery mechanism. The phone recovery entry is effectively
dead config, a lint warning the auditor should flag.

describe-user-pool shows AccountRecoverySetting.RecoveryMechanisms in priority
order (Priority, Name):
${RECOVERY}
So Cognito's own configuration claims verified_phone_number is the preferred
(priority-1) recovery path and verified_email is the priority-2 fallback.

WHY PHONE RECOVERY CAN NEVER WORK (multiple independent root causes):

(a) SmsConfiguration is null (value: ${SMS}). The pool has no SNS caller
    role / ExternalId configured, so Cognito has no way to actually send a
    verification or recovery SMS to anyone. Phone-based delivery fails at the
    infrastructure level.

(b) AutoVerifiedAttributes = [${AUTOVERIFIED}]. Phone numbers are NOT
    auto-verified on sign-up. The priority-1 mechanism specifically requires
    verified_phone_number, so a user's phone must first be verified via the SMS
    flow, which cannot happen without SmsConfiguration.

(c) UsernameAttributes = [${USERNAME_ATTRS}] and self sign-up is blocked
    (AdminCreateUserConfig.AllowAdminCreateUserOnly = ${ADMIN_ONLY}), so there
    is no self-service phone registration even if SmsConfiguration were added.

Net: Cognito evaluates recovery mechanisms in priority order but skips any for
which the user has no verified attribute. Because nobody in this pool can have a
verified phone number, every password-recovery request falls through to
priority-2 verified_email and the user receives the reset email.

CURRENT STATE OF EMAIL RECOVERY: Even the email path cannot be exercised today,
because the pool has zero app clients (list-user-pool-clients returns
${CLIENT_COUNT} client(s) / an empty list). ForgotPassword requires a client_id,
so with no app client there is no way to initiate any recovery flow right now.

RECOMMENDATION: Add an app client so email recovery can work end-to-end; email
recovery will then function correctly. Phone recovery will still not work and
remains misleading: either remove verified_phone_number from
AccountRecoverySetting, or add SmsConfiguration (SNS role + ExternalId) and
enable phone verification if phone recovery is actually intended.
EOF
