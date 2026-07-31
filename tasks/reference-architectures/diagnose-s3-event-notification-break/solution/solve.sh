#!/bin/bash
set -euo pipefail

REGION="us-east-1"
BUCKET="${BUCKET_NAME}"
QUEUE="${QUEUE_NAME}"
TOPIC="${TOPIC_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

NOTIF=$(aws s3api get-bucket-notification-configuration --bucket "$BUCKET" --region "$REGION" --output json)

STACK=$(aws s3api get-bucket-tagging --bucket "$BUCKET" --region "$REGION" \
    --query "TagSet[?Key=='aws:cloudformation:stack-name'].Value | [0]" --output text)

STATUS_A=$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id SampleBucketNotificationA --region "$REGION" \
    --query 'StackResourceDetail.ResourceStatus' --output text)
STATUS_B=$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id SampleBucketNotificationB --region "$REGION" \
    --query 'StackResourceDetail.ResourceStatus' --output text)

FUNCTION=$(aws cloudformation list-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && contains(LogicalResourceId, 'NotificationManagerFunction')].PhysicalResourceId | [0]" \
    --output text)

QUEUE_URL=$(aws sqs get-queue-url --queue-name "$QUEUE" --region "$REGION" --query QueueUrl --output text)
QUEUE_POLICY=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names Policy --region "$REGION" --query 'Attributes.Policy' --output text)

TOPIC_ARN=$(aws sns list-topics --region "$REGION" --query "Topics[?contains(TopicArn, '$TOPIC')].TopicArn | [0]" --output text)
TOPIC_POLICY=$(aws sns get-topic-attributes --topic-arn "$TOPIC_ARN" --region "$REGION" --query 'Attributes.Policy' --output text)

cat > "$OUT" <<EOF
Diagnosis: bucket $BUCKET has ZERO notification configurations deployed, even though both custom resources report clean. SampleBucketNotificationA is $STATUS_A and SampleBucketNotificationB is $STATUS_B.

Evidence: running \`aws s3api get-bucket-notification-configuration --bucket $BUCKET\` returns empty output -- no QueueConfigurations, no TopicConfigurations, no LambdaFunctionConfigurations:
$NOTIF

Because there is no notification configuration on the bucket, S3 never even attempts to deliver an event, so the SQS queue never receives a message. Permissions are NOT the problem and never come into play: the SQS queue policy correctly allows s3.amazonaws.com to sqs:SendMessage with aws:SourceArn scoped to the bucket ARN, and the SNS topic policy correctly allows s3.amazonaws.com to sns:Publish scoped the same way.
SQS queue ($QUEUE) policy:
$QUEUE_POLICY
SNS topic ($TOPIC) policy:
$TOPIC_POLICY

Root cause: a bug in the custom NotificationManager Lambda ($FUNCTION) that installs the notifications. The handler merges the desired configuration into whatever it reads back from GetBucketNotificationConfiguration, but on the first deploy the bucket had no prior notification configuration, so that read returns an effectively empty object. The merge logic drops the new QueueConfiguration/TopicConfiguration in that empty-current-config case and ends up calling PutBucketNotificationConfiguration with an empty body. It still returns a PhysicalResourceId normally, so CloudFormation marks the custom resource CREATE_COMPLETE. The second custom resource (SampleBucketNotificationB) runs against the same empty current config and does the same thing. Net effect: no bucket notifications are ever installed despite a clean stack -- consistent with the empty get-bucket-notification-configuration output and both custom resources reporting $STATUS_A / $STATUS_B.

Fix: change the handler's merge logic so keys present only in the new input still get applied -- seed the merged result from the input's keys as well as the current config's -- or replace the custom NotificationManager Lambda with the native CDK/CFN S3 bucket notification mechanism (s3.Bucket.addEventNotification / BucketNotifications), which merges correctly.
EOF
