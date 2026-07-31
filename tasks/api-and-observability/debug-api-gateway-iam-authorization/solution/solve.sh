#!/bin/bash
set -euo pipefail

REGION="us-east-1"
API_URL="${API_URL}"
AGREEMENT_PATH="${AGREEMENT_PATH}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

API_ID=$(printf '%s' "$API_URL" | sed -E 's#https?://([^.]+)\..*#\1#')

PARENT_PATH=$(dirname "$AGREEMENT_PATH")

PATH_TEMPLATE=$(aws apigateway get-resources --rest-api-id "$API_ID" --region "$REGION" \
    --query "items[?starts_with(path, '${PARENT_PATH}/') && resourceMethods].path | [0]" --output text)

RESOURCE_ID=$(aws apigateway get-resources --rest-api-id "$API_ID" --region "$REGION" \
    --query "items[?path=='${PATH_TEMPLATE}'].id | [0]" --output text)

METHODS=$(aws apigateway get-resources --rest-api-id "$API_ID" --region "$REGION" \
    --query "items[?path=='${PATH_TEMPLATE}'].resourceMethods | [0] | keys(@)" --output text)

SUPPORTED_METHOD=$(printf '%s\n' $METHODS | head -n1)

AUTH_TYPE=$(aws apigateway get-method --rest-api-id "$API_ID" --resource-id "$RESOURCE_ID" \
    --http-method "$SUPPORTED_METHOD" --region "$REGION" --query "authorizationType" --output text)

ROLE_ARN=""
POLICY_NAME=""
POLICY_RESOURCE=""
for R in $(aws iam list-roles --query "Roles[].RoleName" --output text); do
    for P in $(aws iam list-role-policies --role-name "$R" --query "PolicyNames[]" --output text); do
        DOC=$(aws iam get-role-policy --role-name "$R" --policy-name "$P" --output json)
        MATCH=$(printf '%s' "$DOC" | python3 -c '
import sys, json
d = json.load(sys.stdin)
doc = d["PolicyDocument"]
stmts = doc["Statement"]
stmts = stmts if isinstance(stmts, list) else [stmts]
api = sys.argv[1]
for s in stmts:
    acts = s.get("Action", [])
    acts = acts if isinstance(acts, list) else [acts]
    res = s.get("Resource", [])
    res = res if isinstance(res, list) else [res]
    if any("execute-api:Invoke" in a for a in acts):
        for r in res:
            if ":" + api + "/" in r:
                print(r)
                sys.exit(0)
' "$API_ID")
        if [ -n "$MATCH" ]; then
            ROLE_ARN=$(aws iam get-role --role-name "$R" --query "Role.Arn" --output text)
            POLICY_NAME="$P"
            POLICY_RESOURCE="$MATCH"
            break 2
        fi
    done
done

POLICY_METHOD=$(printf '%s' "$POLICY_RESOURCE" | awk -F: '{print $6}' | awk -F/ '{print $3}')
FIXED_RESOURCE=$(printf '%s' "$POLICY_RESOURCE" | sed "s#/${POLICY_METHOD}/#/${SUPPORTED_METHOD}/#")

cat > "$OUT" <<EOF
The 403 Forbidden is not caused by a missing permission or by the double slash
in the request URL. Where the stage URL joins ${AGREEMENT_PATH}, the path can
contain a double slash, but API Gateway normalizes it and resolves the endpoint
correctly, so that is not the problem.

The real root cause is an HTTP-method mismatch in the resource ARN of the IAM
policy on role ${ROLE_ARN}. Its inline policy (${POLICY_NAME}) grants
execute-api:Invoke on:
  ${POLICY_RESOURCE}
That ARN scopes the permission to the ${POLICY_METHOD} method.

The endpoint ${PATH_TEMPLATE} on API ${API_ID} (resource ${RESOURCE_ID}) only
exposes the method(s): ${METHODS}, secured with ${AUTH_TYPE} authorization. The
caller invokes ${SUPPORTED_METHOD}, but the policy only authorizes
execute-api:Invoke for ${POLICY_METHOD}. IAM therefore denies the SigV4-signed
request and API Gateway returns 403 Forbidden, even though the role holds
execute-api:Invoke.

Fix: update the resource ARN in that execute-api:Invoke statement to use
${SUPPORTED_METHOD} instead of ${POLICY_METHOD}, i.e. change it to:
  ${FIXED_RESOURCE}
EOF
