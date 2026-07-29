#!/bin/bash
set -euo pipefail

REGION="us-east-1"
LOCATION="US East (N. Virginia)"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

INSTANCES=$(aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=instance-state-name,Values=running" \
    --query "Reservations[].Instances[].[InstanceType,Platform]" \
    --output text)

declare -A COUNTS
while IFS=$'\t' read -r ITYPE PLATFORM; do
    [ -z "$ITYPE" ] && continue
    LP=$(printf '%s' "$PLATFORM" | tr '[:upper:]' '[:lower:]')
    if [ "$LP" = "windows" ]; then OSN="Windows"; else OSN="Linux"; fi
    KEY="${ITYPE}|${OSN}"
    COUNTS["$KEY"]=$(( ${COUNTS["$KEY"]:-0} + 1 ))
done <<< "$INSTANCES"

PRICES=""
for KEY in "${!COUNTS[@]}"; do
    ITYPE="${KEY%|*}"
    OSN="${KEY#*|}"
    PRICE_JSON=$(aws pricing get-products \
        --region "$REGION" \
        --service-code AmazonEC2 \
        --filters \
            "Type=TERM_MATCH,Field=instanceType,Value=${ITYPE}" \
            "Type=TERM_MATCH,Field=location,Value=${LOCATION}" \
            "Type=TERM_MATCH,Field=operatingSystem,Value=${OSN}" \
            "Type=TERM_MATCH,Field=tenancy,Value=Shared" \
            "Type=TERM_MATCH,Field=preInstalledSw,Value=NA" \
            "Type=TERM_MATCH,Field=capacitystatus,Value=Used" \
            "Type=TERM_MATCH,Field=licenseModel,Value=No License required" \
        --max-results 1 \
        --query "PriceList[0]" \
        --output text)
    USD=$(python3 - "$PRICE_JSON" <<'PY'
import json,sys
raw=sys.argv[1]
p=0.0
if raw and raw != "None":
    d=json.loads(raw)
    for t in d["terms"]["OnDemand"].values():
        for dim in t["priceDimensions"].values():
            p=float(dim["pricePerUnit"]["USD"])
print(f"{p:.10f}")
PY
)
    PRICES+="${KEY}"$'\t'"${COUNTS[$KEY]}"$'\t'"${USD}"$'\n'
done

ANSWER=$(REGION="$REGION" python3 - <<PY
import os
rows=[]
for line in """${PRICES}""".strip().splitlines():
    key,count,usd=line.split("\t")
    itype,osn=key.split("|")
    rows.append((itype,osn,int(count),float(usd)))
rows.sort(key=lambda r:(r[0],r[1]))
total=0.0
parts=[]
for itype,osn,count,price in rows:
    sub=price*count
    total+=sub
    parts.append(f"{count}x {itype} {osn} @ \${price:.4f}/hr = \${sub:.4f}/hr")
region=os.environ["REGION"]
breakdown=" | ".join(parts)
print(f"The total estimated hourly on-demand cost of all running EC2 instances in {region} is \${total:.4f}. Breakdown by instance type and operating system: {breakdown}.")
PY
)

printf '%s\n' "$ANSWER" > "$OUT"
