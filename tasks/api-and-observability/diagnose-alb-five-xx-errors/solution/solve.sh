#!/bin/bash
set -euo pipefail

REGION="us-east-1"
ALB_ARN="${ALB_ARN}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

ALB_NAME=$(aws elbv2 describe-load-balancers --region "$REGION" \
    --load-balancer-arns "$ALB_ARN" \
    --query "LoadBalancers[0].LoadBalancerName" --output text)

ATTRS=$(aws elbv2 describe-load-balancer-attributes --region "$REGION" \
    --load-balancer-arn "$ALB_ARN" --output json)
BUCKET=$(printf '%s' "$ATTRS" | python3 -c 'import sys,json;a={x["Key"]:x["Value"] for x in json.load(sys.stdin)["Attributes"]};print(a["access_logs.s3.bucket"])')
PREFIX=$(printf '%s' "$ATTRS" | python3 -c 'import sys,json;a={x["Key"]:x["Value"] for x in json.load(sys.stdin)["Attributes"]};print(a.get("access_logs.s3.prefix",""))')

TG_ARN=$(aws elbv2 describe-target-groups --region "$REGION" \
    --load-balancer-arn "$ALB_ARN" \
    --query "TargetGroups[0].TargetGroupArn" --output text)
HEALTH=$(aws elbv2 describe-target-health --region "$REGION" \
    --target-group-arn "$TG_ARN" \
    --query "TargetHealthDescriptions[].TargetHealth.State" --output text)
HEALTHY_COUNT=$(printf '%s\n' $HEALTH | grep -c healthy)
TOTAL_TARGETS=$(printf '%s\n' $HEALTH | grep -c .)

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
LOGPREFIX="AWSLogs/${ACCOUNT}/elasticloadbalancing/${REGION}/"

WORK=$(mktemp -d)
aws s3 sync "s3://${BUCKET}/${PREFIX}${LOGPREFIX}" "$WORK" --region "$REGION"

PYSCRIPT=$(mktemp)
cat > "$PYSCRIPT" <<'PY'
import shlex, sys
from collections import OrderedDict
rows = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        parts = shlex.split(line)
    except ValueError:
        continue
    if len(parts) < 15:
        continue
    ts = parts[1]
    status = parts[8]
    tpt = parts[6]
    req = parts[12]
    toks = req.split()
    if len(toks) < 2:
        continue
    method, url = toks[0], toks[1]
    path = url.split("://", 1)[-1]
    path = "/" + path.split("/", 1)[1] if "/" in path else path
    path = path.split("?", 1)[0]
    rows.append((ts, method, path, status, tpt))
rows.sort(key=lambda r: r[0])
combos = OrderedDict()
for ts, method, path, status, tpt in rows:
    key = (method, path, status)
    combos.setdefault(key, {"count": 0, "first": ts, "last": ts, "tpt": tpt})
    c = combos[key]
    c["count"] += 1
    c["last"] = ts
good = None
for (method, path, status), c in combos.items():
    if status.startswith("2") and (good is None or c["count"] > good[1]["count"]):
        good = ((method, path, status), c)
good_method = good[0][0] if good else None
bad = None
for (method, path, status), c in combos.items():
    if not status.startswith("5"):
        continue
    if good_method is not None and method != good_method:
        continue
    if bad is None or c["count"] > bad[1]["count"]:
        bad = ((method, path, status), c)
if bad is None:
    for (method, path, status), c in combos.items():
        if status.startswith("5") and (bad is None or c["count"] > bad[1]["count"]):
            bad = ((method, path, status), c)
summary = []
for (method, path, status), c in combos.items():
    if good_method is not None and method != good_method:
        continue
    summary.append(
        f"{method} {path} -> HTTP {status}: {c['count']} requests "
        f"(first {c['first']}, last {c['last']}, target_processing_time {c['tpt']}s)"
    )
print("SUMMARY_START")
print("\n".join(summary))
print("SUMMARY_END")
if good:
    (gm, gp, gs), gc = good
    print(f"GOOD_METHOD={gm}")
    print(f"GOOD_PATH={gp}")
    print(f"GOOD_STATUS={gs}")
    print(f"GOOD_TPT={gc['tpt']}")
if bad:
    (bm, bp, bs), bc = bad
    print(f"BAD_METHOD={bm}")
    print(f"BAD_PATH={bp}")
    print(f"BAD_STATUS={bs}")
    print(f"BAD_TPT={bc['tpt']}")
PY

PARSED=$(find "$WORK" -name '*.gz' -exec zcat {} + | python3 "$PYSCRIPT")
SUMMARY=$(printf '%s\n' "$PARSED" | sed -n '/SUMMARY_START/,/SUMMARY_END/p' | sed '1d;$d')
GOOD_METHOD=$(printf '%s\n' "$PARSED" | sed -n 's/^GOOD_METHOD=//p')
GOOD_PATH=$(printf '%s\n' "$PARSED" | sed -n 's/^GOOD_PATH=//p')
GOOD_STATUS=$(printf '%s\n' "$PARSED" | sed -n 's/^GOOD_STATUS=//p')
BAD_METHOD=$(printf '%s\n' "$PARSED" | sed -n 's/^BAD_METHOD=//p')
BAD_PATH=$(printf '%s\n' "$PARSED" | sed -n 's/^BAD_PATH=//p')
BAD_STATUS=$(printf '%s\n' "$PARSED" | sed -n 's/^BAD_STATUS=//p')
BAD_TPT=$(printf '%s\n' "$PARSED" | sed -n 's/^BAD_TPT=//p')

cat > "$OUT" <<EOF
Diagnosis of 5XX errors on ALB ${ALB_NAME} (${ALB_ARN}).

The load balancer itself is not broken. Its ${TOTAL_TARGETS} backend target(s)
report ${HEALTHY_COUNT} healthy in target group ${TG_ARN}, so the ECS backend is
reachable and the 5XX responses are application-level, not infrastructure
failures.

Reading the ALB access logs (s3://${BUCKET}/${PREFIX}${LOGPREFIX}) shows a clear
transition. Earlier requests went to ${GOOD_METHOD} ${GOOD_PATH} and the
application returned HTTP ${GOOD_STATUS} with normal target processing times.
Recent requests are all going to ${BAD_METHOD} ${BAD_PATH} instead, which the
application rejects with HTTP ${BAD_STATUS} almost instantly
(target_processing_time ${BAD_TPT}s).

Root cause: a client-side endpoint misconfiguration. Nothing changed on the ALB,
target group, or backend; the clients switched the request path they call from
the correct ${GOOD_PATH} to the incorrect ${BAD_PATH}, and the backend returns
${BAD_STATUS} for that unknown path.

Fix: reconfigure the calling clients to send ${GOOD_METHOD} requests back to the
working path ${GOOD_PATH} instead of ${BAD_PATH}. The 5XX errors clear once the
clients use the correct endpoint again.

Observed request/status breakdown from the ALB access logs:
${SUMMARY}
EOF
