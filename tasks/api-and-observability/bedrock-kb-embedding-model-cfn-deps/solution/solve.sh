#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

AGENT_STACK=$(aws cloudformation describe-stacks --region "$REGION" \
    --query "Stacks[?contains(StackName,'bedrock-agent')].StackName | [0]" --output text)

TEMPLATE=$(aws cloudformation get-template --region "$REGION" --stack-name "$AGENT_STACK" \
    --query 'TemplateBody' --output json)

IMPORTS=$(printf '%s\n' "$TEMPLATE" \
    | grep -oE '"Fn::ImportValue"[[:space:]]*:[[:space:]]*"[^"]+"' \
    | grep -oE '"[^"]+"$' \
    | tr -d '"' \
    | sort -u)

IMPORT_LIST=$(printf '%s\n' "$IMPORTS" | paste -sd ',' -)

KB_STACK=$(aws cloudformation describe-stacks --region "$REGION" \
    --query "Stacks[?contains(StackName,'bedrock-kb')].StackName | [0]" --output text)

cat > "$OUT" <<EOF
Yes. The agent stack $AGENT_STACK has Fn::ImportValue dependencies on outputs exported by the knowledge base stack $KB_STACK, specifically these exports: $IMPORT_LIST.

Because the embedding model is immutable on an existing Bedrock Knowledge Base, changing it requires replacing the KB stack. CloudFormation will not let you delete or replace a stack whose exported outputs are still imported by another stack. So you must handle the dependency first: remove those Fn::ImportValue imports from the agent stack ($AGENT_STACK) and deploy it, then replace the KB stack ($KB_STACK) to change the embedding model, and finally re-add the imports if still needed.
EOF
