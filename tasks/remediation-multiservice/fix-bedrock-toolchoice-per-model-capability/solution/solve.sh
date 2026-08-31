#!/bin/bash
# Reference solution. Two defects, both of which have to go for the alarm to
# clear and stay clear:
#
#   1. Three profile rows pair a model with a routingStrategy it rejects, so
#      their extractions fail. Fix by moving each row to an accepted strategy
#      (an equivalent alternative is to re-route the modelId to
#      Nova/Claude/Titan, which all support forced tool use):
#        receipts_v2   (mistral.mistral-large-2402-v1:0):    strict -> open
#        invoices_v7   (us.meta.llama3-3-70b-instruct-v1:0): strict -> auto
#        statements_v3 (us.meta.llama3-3-70b-instruct-v1:0): open   -> auto
#
#   2. The router publishes ExtractionFailures only on failure, and the alarm
#      treats missing data as retain-state, so the alarm cannot leave ALARM once
#      the failures stop. Fix by publishing an explicit 0 on every success.
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
WORK="$(mktemp -d)"
mkdir -p /logs/agent

echo "== profiles table snapshot: ${PROFILES_TABLE}"
aws dynamodb scan --region "$REGION" --table-name "$PROFILES_TABLE" \
    --projection-expression "profileId, documentClass, modelId, routingStrategy, toolName, enabled" \
    --output json > "$WORK/profiles.json"

echo "== run ledger snapshot: ${RUNS_TABLE}"
aws dynamodb scan --region "$REGION" --table-name "$RUNS_TABLE" --output json > "$WORK/runs.json" || echo '{"Items":[]}' > "$WORK/runs.json"

# Provider messages are redacted in the run ledger to a classification code, but
# the full text still reaches CloudWatch Logs under PROVIDER_MESSAGE_DETAIL.
# Pull a sample so the diagnosis narrative can quote the provider verbatim.
LOG_GROUP_NAME="${LOG_GROUP:-/aws/lambda/${FUNCTION_NAME}}"
echo "== provider detail from CloudWatch Logs: ${LOG_GROUP_NAME}"
aws logs filter-log-events \
    --region "$REGION" \
    --log-group-name "$LOG_GROUP_NAME" \
    --filter-pattern '"PROVIDER_MESSAGE_DETAIL"' \
    --limit 20 \
    --output json > "$WORK/provider-detail.json" || echo '{"events":[]}' > "$WORK/provider-detail.json"

# ---- STEP 1: apply the schema-only fixes ----
apply_strategy() {
    local pid="$1" strategy="$2"
    aws dynamodb update-item \
        --region "$REGION" \
        --table-name "$PROFILES_TABLE" \
        --key "{\"profileId\":{\"S\":\"${pid}\"}}" \
        --update-expression "SET routingStrategy = :m" \
        --expression-attribute-values "{\":m\":{\"S\":\"${strategy}\"}}" \
        --return-values NONE
    echo "updated ${pid}.routingStrategy -> ${strategy}"
}

apply_strategy receipts_v2 open
apply_strategy invoices_v7 auto
apply_strategy statements_v3 auto

# ---- STEP 2: make the router publish an explicit ExtractionFailures=0 on success ----
# Second defect, independent of the routing rows: the router calls
# put_metric_data("ExtractionFailures", 1) only on failure, and the alarm sums
# that metric with treatMissingData=missing. A fully green sweep therefore
# publishes no ExtractionFailures datapoint at all, the alarm has nothing to
# evaluate, and it stays latched in ALARM however healthy the service is.
# Patch the deployed code so every success publishes a 0, which lets the alarm
# transition back to OK on its own.
python3 - <<'PY'
import io
import os
import urllib.request
import zipfile

import boto3

region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
function_name = os.environ["FUNCTION_NAME"]
lam = boto3.client("lambda", region_name=region)

url = lam.get_function(FunctionName=function_name)["Code"]["Location"]
with urllib.request.urlopen(url) as resp:  # noqa: S310 — presigned Lambda code url
    blob = resp.read()

src = zipfile.ZipFile(io.BytesIO(blob))
index = src.read("index.py").decode("utf-8")

OLD_SIG = "def _put_metric(metric_name: str, profile_id: str, model_id: str) -> None:"
NEW_SIG = (
    "def _put_metric(\n"
    "    metric_name: str, profile_id: str, model_id: str, value: float = 1.0\n"
    ") -> None:"
)
if OLD_SIG not in index:
    raise SystemExit("router _put_metric signature not found; aborting patch")
index = index.replace(OLD_SIG, NEW_SIG, 1)

if index.count('"Value": 1.0') != 3:
    raise SystemExit("router metric values not in the expected shape; aborting patch")
index = index.replace('"Value": 1.0', '"Value": value')

OLD_OK = '        _put_metric("ExtractionSuccesses", profile_id, model_id)'
NEW_OK = (
    '        _put_metric("ExtractionSuccesses", profile_id, model_id)\n'
    '        _put_metric("ExtractionFailures", profile_id, model_id, 0.0)'
)
if OLD_OK not in index:
    raise SystemExit("router success branch not found; aborting patch")
index = index.replace(OLD_OK, NEW_OK, 1)

# Copy each entry with its original ZipInfo so file modes survive. A plain
# writestr(name, data) leaves external_attr at 0, and the Lambda runtime then
# cannot read the handler.
patched = io.BytesIO()
with zipfile.ZipFile(patched, "w", zipfile.ZIP_DEFLATED) as dst:
    for info in src.infolist():
        payload = (
            index.encode("utf-8") if info.filename == "index.py" else src.read(info)
        )
        dst.writestr(info, payload)

lam.update_function_code(
    FunctionName=function_name, ZipFile=patched.getvalue(), Publish=False
)
lam.get_waiter("function_updated").wait(
    FunctionName=function_name, WaiterConfig={"Delay": 3, "MaxAttempts": 40}
)
print("patched router: every success now publishes ExtractionFailures=0")
PY

# ---- STEP 3: drive a fresh sweep so the metric restarts producing successes ----
LABEL="verify-$(date +%s)-$$"
PAYLOAD_FILE="${WORK}/payload.json"
printf '{"mode":"sweep","runLabel":"%s"}' "$LABEL" > "$PAYLOAD_FILE"

RESPONSE_FILE="${WORK}/invoke-response.json"
aws lambda invoke --region "$REGION" --function-name "$FUNCTION_NAME" \
    --invocation-type RequestResponse \
    --cli-binary-format raw-in-base64-out \
    --payload "file://${PAYLOAD_FILE}" \
    "$RESPONSE_FILE" >/dev/null
echo "== router sweep response"
cat "$RESPONSE_FILE"
echo

# ---- STEP 4: emit the required output artifacts ----
WORK="$WORK" RESPONSE_FILE="$RESPONSE_FILE" python3 - <<'PY'
import json
import os

work = os.environ["WORK"]
response_file = os.environ["RESPONSE_FILE"]


def _load(path):
    with open(path) as fh:
        return json.load(fh)


def _flat(item):
    out = {}
    for k, v in item.items():
        (t, val), = v.items()
        if t == "N":
            out[k] = float(val) if "." in val else int(val)
        elif t == "BOOL":
            out[k] = val
        else:
            out[k] = val
    return out


profiles = {p["profileId"]: p for p in (_flat(i) for i in _load(os.path.join(work, "profiles.json"))["Items"])}
runs = [_flat(i) for i in _load(os.path.join(work, "runs.json")).get("Items", [])]

# Group ledger errors by profileId. errorMessage is now a classification code;
# recover the full provider message from PROVIDER_MESSAGE_DETAIL log events.
errors_by_pid: dict[str, list[str]] = {}
for r in runs:
    if r.get("status") == "FAILED":
        code = r.get("errorCode") or "unknown"
        classification = r.get("errorMessage") or ""
        errors_by_pid.setdefault(r["profileId"], []).append(f"{code} ({classification})")

provider_events: list[dict] = []
try:
    events = _load(os.path.join(work, "provider-detail.json")).get("events", [])
except FileNotFoundError:
    events = []
for ev in events:
    try:
        # CloudWatch prefixes the JSON payload with a level string; carve it out.
        msg = ev.get("message", "")
        idx = msg.find("{")
        if idx >= 0:
            provider_events.append(json.loads(msg[idx:]))
    except (json.JSONDecodeError, ValueError):
        continue

prose = []
prose.append("DIAGNOSIS — DocIntel structured-extraction failures")
prose.append("")
prose.append("The router Lambda invokes bedrock:Converse with a tool config for every")
prose.append("document class. Only (modelId, routingStrategy) varies per profile, and the")
prose.append("failing rows all share a (model, strategy) pair that the provider rejects with")
prose.append("ValidationException. The surviving successes prove the code, IAM policy, and")
prose.append("documents are not at fault: tool-choice support in the Converse API is a")
prose.append("per-model capability.")
prose.append("")
prose.append("Observed pre-remediation profile rows:")
for pid in sorted(profiles):
    p = profiles[pid]
    prose.append(
        f"  {pid:20s} model={p.get('modelId', '?'):42s} "
        f"routingStrategy={str(p.get('routingStrategy', '?')):6s} enabled={p.get('enabled')}"
    )
prose.append("")
prose.append("Sample failure classifications from the run ledger (pre-remediation):")
for pid in sorted(errors_by_pid):
    prose.append(f"  {pid}: {errors_by_pid[pid][0]}")
prose.append("")
if provider_events:
    prose.append("Sample provider messages recovered from CloudWatch Logs:")
    for ev in provider_events[:6]:
        pm = ev.get("providerMessage") or ev.get("errorMessage") or ""
        pm = str(pm).replace("\n", " ")[:180]
        prose.append(f"  {ev.get('profileId','?'):20s} {pm}")
    prose.append("")
prose.append("ROOT CAUSE 1 - failing extractions")
prose.append(
    "  Bedrock Converse tool-choice support differs per model. Mistral Large rejects the"
)
prose.append(
    "  strict (forced-tool) routing strategy but accepts open; Meta Llama 3.3 70B rejects"
)
prose.append("  both strict and open and must run with auto.")
prose.append("")
prose.append("ROOT CAUSE 2 - the alarm cannot clear itself")
prose.append(
    "  The router publishes ExtractionFailures only on failure, and the alarm sums that"
)
prose.append(
    "  metric with treatMissingData=missing. A fully green sweep therefore publishes no"
)
prose.append(
    "  datapoint, the alarm has nothing to evaluate, and it holds ALARM however healthy"
)
prose.append("  the service is. Repairing the profile rows alone does not clear it.")
prose.append("")
prose.append("REMEDIATION APPLIED")
prose.append("  receipts_v2   (mistral.mistral-large-2402-v1:0):    strict -> open")
prose.append("  invoices_v7   (us.meta.llama3-3-70b-instruct-v1:0): strict -> auto")
prose.append("  statements_v3 (us.meta.llama3-3-70b-instruct-v1:0): open   -> auto")
prose.append(
    "  router code: every success now publishes ExtractionFailures=0, so the alarm"
)
prose.append("               transitions back to OK without being told to.")
prose.append("")
prose.append("  Alternative valid fix per failing class: re-route modelId to Nova, Claude,")
prose.append("  or Amazon Titan (all support the strict forced-tool strategy).")
prose.append(
    "  Alternative valid fix for the alarm: set treatMissingData to notBreaching."
)
prose.append("")

with open(response_file) as fh:
    invoke_body = json.load(fh)
prose.append("Fresh sweep after remediation:")
prose.append(json.dumps(invoke_body, indent=2, sort_keys=True))

with open("/logs/agent/agent-output.txt", "w") as fh:
    fh.write("\n".join(prose) + "\n")

contract = {
    "fixed_profiles": ["receipts_v2", "invoices_v7", "statements_v3"],
    "remediation": {
        "receipts_v2": "routingStrategy: strict -> open (Mistral Large supports open but not strict/forced-tool)",
        "invoices_v7": "routingStrategy: strict -> auto (Meta Llama 3.3 70B rejects strict and open)",
        "statements_v3": "routingStrategy: open -> auto (Meta Llama 3.3 70B rejects strict and open)",
    },
    "root_cause": "Bedrock Converse tool-choice support is a per-model capability; the three failing (modelId, routingStrategy) pairs are rejected with ValidationException while the surviving pairs go through. Separately, the router emits ExtractionFailures only on failure and the alarm treats missing data as retain-state, so the alarm cannot leave ALARM once the failures stop.",
    "alarm_latching_fix": "router now publishes ExtractionFailures=0 on every success, so a green sweep gives the alarm a datapoint to evaluate and it returns to OK on its own.",
    "capability_matrix": {
        "us.meta.llama3-3-70b-instruct-v1:0": {
            "strict": "unsupported",
            "open": "unsupported",
            "auto": "supported",
        },
        "mistral.mistral-large-2402-v1:0": {
            "strict": "unsupported",
            "open": "supported",
            "auto": "supported",
        },
    },
}
with open("/logs/agent/agent-output.json", "w") as fh:
    json.dump(contract, fh, indent=2)

print("wrote /logs/agent/agent-output.txt and /logs/agent/agent-output.json")
PY
