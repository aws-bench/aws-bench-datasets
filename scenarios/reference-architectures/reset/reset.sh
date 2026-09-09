#!/bin/bash
# Scenario reset hook for reference-architectures.
#
# Runs BEFORE the framework's reset (new-resource scan + stack teardown). Its job
# is to restore scenario state that AWS itself mutates and CloudFormation cannot
# see, so every trial starts from the same observable state:
#
#   1. The diagnose-rabbitmq-consumer-failure task deploys a Lambda event source
#      mapping that polls 'testQueue', a queue the scenario never creates. The ESM
#      therefore fails to connect on every poll, and AWS eventually transitions it
#      from Enabled to Disabled on its own (reporting StateTransitionReason
#      USER_INITIATED, not one of the documented auto-disable reasons).
#   2. The CDK declares no 'enabled' property on the mapping, so the change is
#      absent from the stack template and CloudFormation drift detection cannot
#      report it. Nothing in the framework reset restores it.
#
# The result is a one-way ratchet: early trials in a fresh account observe an
# Enabled mapping reporting connection errors, later trials observe a Disabled
# one, and the task's observable state depends on how many trials the account has
# already served. Re-enabling here makes the starting state deterministic.
#
# Best-effort and idempotent: an already-enabled mapping is a no-op, and a missing
# broker or mapping is skipped. Never fail the phase — the framework reset runs
# afterwards regardless.
set -uo pipefail

REGION="us-east-1"
BROKER_ARN="${BROKER_ARN:-}"

echo "[reset.sh] reference-architectures reset"

export AWS_PROFILE="PRIMARY"

if [ -z "${BROKER_ARN}" ]; then
    echo "[reset.sh] BROKER_ARN not set; skipping event source mapping restore."
    exit 0
fi

ESM_UUID=""
ESM_STATE=""
read -r ESM_UUID ESM_STATE < <(aws lambda list-event-source-mappings --region "${REGION}" \
    --event-source-arn "${BROKER_ARN}" \
    --query "EventSourceMappings[0].[UUID,State]" --output text 2>/dev/null) || true

if [ -z "${ESM_UUID}" ] || [ "${ESM_UUID}" = "None" ]; then
    echo "[reset.sh] No event source mapping found for ${BROKER_ARN}; skipping."
    exit 0
fi

echo "[reset.sh] Event source mapping ${ESM_UUID} is ${ESM_STATE}"

case "${ESM_STATE}" in
    Enabled | Enabling | Creating | Updating)
        echo "[reset.sh] Already enabled or converging; nothing to restore."
        ;;
    *)
        if aws lambda update-event-source-mapping --region "${REGION}" \
            --uuid "${ESM_UUID}" --enabled >/dev/null 2>&1; then
            echo "[reset.sh] Re-enable requested for ${ESM_UUID} (was ${ESM_STATE})."
        else
            echo "[reset.sh] WARNING: could not re-enable ${ESM_UUID}; continuing."
        fi
        ;;
esac

echo "[reset.sh] Done. Framework reset will handle the rest."
exit 0
