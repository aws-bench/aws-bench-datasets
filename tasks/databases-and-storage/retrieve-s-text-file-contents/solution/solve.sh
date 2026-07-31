#!/bin/bash
set -euo pipefail

REGION="us-east-1"
TARGET_BUCKET="${TARGET_BUCKET_NAME:?TARGET_BUCKET_NAME is required}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

TARGET_KEY=$(aws s3api list-objects-v2 --bucket "$TARGET_BUCKET" --region "$REGION" \
    --query "Contents[?ends_with(Key, '.txt')]|[0].Key" --output text)
TARGET_CONTENT=$(aws s3 cp "s3://$TARGET_BUCKET/$TARGET_KEY" - --region "$REGION")

WORKDIR=$(mktemp -d)
INDEX="$WORKDIR/index.tsv"
: > "$INDEX"

for BUCKET in $(aws s3api list-buckets --query "Buckets[].Name" --output text); do
    [ "$BUCKET" = "$TARGET_BUCKET" ] && continue
    LOC=$(aws s3api get-bucket-location --bucket "$BUCKET" \
        --query "LocationConstraint" --output text)
    [ "$LOC" = "None" ] && LOC="us-east-1"
    [ "$LOC" = "$REGION" ] || continue
    KEYS=$(aws s3api list-objects-v2 --bucket "$BUCKET" --region "$REGION" \
        --query "Contents[?ends_with(Key, '.txt')].Key" --output text)
    for KEY in $KEYS; do
        [ "$KEY" = "None" ] && continue
        SLOT="$WORKDIR/obj.$(printf '%s' "$BUCKET/$KEY" | md5sum | cut -c1-16)"
        aws s3 cp "s3://$BUCKET/$KEY" "$SLOT" --region "$REGION"
        printf '%s\t%s\t%s\n' "$BUCKET" "$KEY" "$SLOT" >> "$INDEX"
    done
done

read -r BEST_KEY BEST_FILE < <(TARGET_CONTENT="$TARGET_CONTENT" python3 - "$INDEX" <<'PY'
import os, re, sys

def tokens(text):
    return set(t for t in re.split(r'[^a-z0-9]+', text.lower()) if t)

target = tokens(os.environ["TARGET_CONTENT"])
best_key, best_file, best_score = "", "", -1.0
with open(sys.argv[1]) as fh:
    for line in fh:
        line = line.rstrip("\n")
        if not line:
            continue
        bucket, key, path = line.split("\t")
        with open(path, "r", errors="replace") as cf:
            cand = tokens(cf.read())
        union = target | cand
        score = len(target & cand) / len(union) if union else 0.0
        if score > best_score:
            best_score, best_key, best_file = score, key, path
print(best_key, best_file)
PY
)

MATCH_KEY="$BEST_KEY"
MATCH_CONTENT=$(cat "$BEST_FILE")

cat > "$OUT" <<EOF
The source file '$TARGET_KEY' in bucket $TARGET_BUCKET contains: "$TARGET_CONTENT".

The most similar file among all S3 buckets is the file '$MATCH_KEY', with content: '$MATCH_CONTENT'
EOF
