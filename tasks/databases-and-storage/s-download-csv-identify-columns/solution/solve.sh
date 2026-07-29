#!/bin/bash
set -euo pipefail

REGION="us-east-1"
BUCKET="${CSV_BUCKET_NAME}"
FILE="${CSV_FILE_NAME}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

aws s3api get-object --region "$REGION" --bucket "$BUCKET" --key "$FILE" /tmp/products.csv

python3 - "$OUT" <<'PY'
import csv, sys, collections

out = sys.argv[1]
with open('/tmp/products.csv', newline='') as f:
    rows = [[c.strip() for c in r] for r in csv.reader(f) if any(c.strip() for c in r)]

header = rows[0]
data = rows[1:]
unique_cols, dup_cols, examples = [], [], {}
for i, col in enumerate(header):
    values = [r[i] for r in data]
    if len(set(values)) == len(values):
        unique_cols.append(col)
    else:
        dup_cols.append(col)
        counts = collections.Counter(values)
        examples[col] = next(v for v, c in counts.items() if c > 1)


def join(items):
    if len(items) <= 1:
        return ', '.join(items)
    return ', '.join(items[:-1]) + ', and ' + items[-1]


dup_parts = []
for col in dup_cols:
    dup_parts.append(f"{col} (e.g., '{examples[col]}' appears more than once)")

lines = []
lines.append(f"The CSV file has {len(header)} columns: {join(header)}.")
lines.append(f"Columns with all unique values: {join(unique_cols)}.")
label = "Column with duplicate values" if len(dup_cols) == 1 else "Columns with duplicate values"
lines.append(f"{label}: {join(dup_parts)}.")

with open(out, 'w') as f:
    f.write(' '.join(lines) + '\n')
PY
