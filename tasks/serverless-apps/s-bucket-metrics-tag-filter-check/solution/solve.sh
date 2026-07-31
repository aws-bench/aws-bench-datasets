#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

BUCKETS=$(aws s3api list-buckets --region "$REGION" --query "Buckets[].Name" --output text)

TAG_BUCKETS=""
for b in $BUCKETS; do
    LOC=$(aws s3api get-bucket-location --region "$REGION" --bucket "$b" --query "LocationConstraint" --output text)
    if [ "$LOC" = "None" ]; then LOC="us-east-1"; fi
    if [ "$LOC" != "$REGION" ]; then continue; fi
    IDS=$(aws s3api list-bucket-metrics-configurations --bucket "$b" --region "$REGION" \
        --query "MetricsConfigurationList[?Filter.Tag || Filter.And.Tags].Id" --output text)
    if [ -n "$IDS" ] && [ "$IDS" != "None" ]; then
        TAG_BUCKETS="${TAG_BUCKETS}${b} "
    fi
done

TAG_BUCKETS=$(printf '%s' "$TAG_BUCKETS" | sed 's/ *$//')
TAG_COUNT=$(printf '%s\n' $TAG_BUCKETS | awk 'NF{c++} END{print c+0}')

S3_ALARMS=""
for b in $TAG_BUCKETS; do
    A=$(aws cloudwatch describe-alarms --region "$REGION" \
        --query "MetricAlarms[?Namespace=='AWS/S3' && contains(Dimensions[?Name=='BucketName'].Value, '$b')].AlarmName" \
        --output text)
    if [ -n "$A" ]; then
        S3_ALARMS="${S3_ALARMS}${A} "
    fi
done
S3_ALARMS=$(printf '%s' "$S3_ALARMS" | sed 's/ *$//')

if [ -z "$S3_ALARMS" ]; then
    ALARM_LINE="No CloudWatch alarms are defined on these tag-filtered metrics, so the answer is: no, there are no alarms defined on tag-filtered metrics for any of the S3 buckets."
else
    ALARM_LINE="The following CloudWatch alarms are defined on these tag-filtered metrics: ${S3_ALARMS}"
fi

cat > "$OUT" <<EOF
I checked every S3 bucket in ${REGION} for metrics configurations that filter objects by object tag (Filter.Tag or Filter.And.Tags) and then looked for CloudWatch alarms on those tag-filtered metrics.

${TAG_COUNT} bucket(s) use tag-filtered metrics: ${TAG_BUCKETS}

${ALARM_LINE}
EOF
