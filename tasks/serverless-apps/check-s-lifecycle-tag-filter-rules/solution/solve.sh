#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

FILTER="Rules[?Expiration.Days != null && (Filter.Tag != null || Filter.And.Tags != null)]"

BUCKETS=$(aws s3api list-buckets --region "$REGION" --query "Buckets[].Name" --output text)

MATCH_BUCKET=""
TAGKEY=""
TAGVAL=""
DAYS=""
for b in $BUCKETS; do
    HITKEY=$(aws s3api get-bucket-lifecycle-configuration --bucket "$b" --region "$REGION" \
        --query "${FILTER}.[Filter.Tag.Key, Filter.And.Tags[0].Key][0] | [?@ != null] | [0]" --output text 2>/dev/null) || continue
    if [ -n "$HITKEY" ] && [ "$HITKEY" != "None" ]; then
        MATCH_BUCKET="$b"
        TAGKEY="$HITKEY"
        TAGVAL=$(aws s3api get-bucket-lifecycle-configuration --bucket "$b" --region "$REGION" \
            --query "${FILTER}.[Filter.Tag.Value, Filter.And.Tags[0].Value][0] | [?@ != null] | [0]" --output text)
        DAYS=$(aws s3api get-bucket-lifecycle-configuration --bucket "$b" --region "$REGION" \
            --query "${FILTER}.Expiration.Days | [0]" --output text)
    fi
done

cat > "$OUT" <<EOF
Yes, the bucket ${MATCH_BUCKET} has a lifecycle expiration rule that deletes objects after ${DAYS} day(s) when tagged with ${TAGKEY}: ${TAGVAL}.
EOF
