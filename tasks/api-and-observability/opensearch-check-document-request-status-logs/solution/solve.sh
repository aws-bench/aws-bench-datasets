#!/bin/bash
set -euo pipefail

REGION="us-east-1"
DOMAIN="${OPENSEARCH_DOMAIN_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

LOG_OPTS=$(aws opensearch describe-domain --domain-name "$DOMAIN" --region "$REGION" \
    --query "DomainStatus.LogPublishingOptions" --output json)

ENABLED=$(printf '%s' "$LOG_OPTS" | python3 -c '
import sys, json
opts = json.load(sys.stdin)
labels = {
    "AUDIT_LOGS": "audit",
    "ES_APPLICATION_LOGS": "application (error)",
    "SEARCH_SLOW_LOGS": "slow-search",
    "INDEX_SLOW_LOGS": "slow-index",
}
on = [labels.get(k, k) for k, v in opts.items() if v.get("Enabled")]
print(", ".join(sorted(on)))
')

cat > "$OUT" <<EOF
You can't check this from the logs. OpenSearch domain ${DOMAIN} has these log types enabled: ${ENABLED}. None of them record HTTP response status codes.

OpenSearch audit logs only capture authentication and authorization events (for example AUTHENTICATED and GRANTED_PRIVILEGES). They confirm that the GET for document changeset-a3f8b921 (path /changesets/_doc/changeset-a3f8b921) was authenticated and authorized, but they never record whether the response was 200 or 404.

The other enabled log types do not help either: application (error) logs only capture engine errors, slow-search logs only capture queries slower than the configured threshold, and slow-index logs only capture slow indexing operations. None of them log per-request status codes.

OpenSearch has no built-in access log that records HTTP response codes, so there is no way to determine from the logs whether that GET returned 200 or 404.
EOF
