#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
BUCKET="${DDB_SOURCE_BUCKET}"
OUT=/logs/agent/agent-output.txt
JSON=/logs/agent/agent-output.json

TABLES=$(REGION="$REGION" BUCKET="$BUCKET" python3 - <<'PY'
import csv, io, json, os, boto3

region = os.environ["REGION"]
bucket = os.environ["BUCKET"]
s3 = boto3.client("s3", region_name=region)
ddb = boto3.client("dynamodb", region_name=region)
res = boto3.resource("dynamodb", region_name=region)

keys = []
paginator = s3.get_paginator("list_objects_v2")
for page in paginator.paginate(Bucket=bucket):
    for obj in page.get("Contents") or []:
        k = obj["Key"]
        if k.split("/")[-1].lower().endswith(".csv"):
            keys.append(k)

tables = []
for key in keys:
    name = key.split("/")[-1][:-4]
    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
    rows = list(csv.DictReader(io.StringIO(body)))
    cols = rows[0].keys() if rows else []
    cols = list(cols)
    hash_key = cols[0]
    range_key = cols[1] if len(cols) > 1 else cols[0]

    ddb.create_table(
        TableName=name,
        AttributeDefinitions=[
            {"AttributeName": hash_key, "AttributeType": "S"},
            {"AttributeName": range_key, "AttributeType": "S"},
        ],
        KeySchema=[
            {"AttributeName": hash_key, "KeyType": "HASH"},
            {"AttributeName": range_key, "KeyType": "RANGE"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": f"{name}-gsi",
                "KeySchema": [
                    {"AttributeName": range_key, "KeyType": "HASH"},
                    {"AttributeName": hash_key, "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
        BillingMode="PAY_PER_REQUEST",
    )

    ddb.get_waiter("table_exists").wait(TableName=name)

    table = res.Table(name)
    with table.batch_writer() as batch:
        for row in rows:
            item = {c: ("" if v is None else str(v)) for c, v in row.items()}
            batch.put_item(Item=item)

    tables.append(name)

print(json.dumps(tables))
PY
)

mkdir -p "$(dirname "$OUT")"
python3 -c "import json,sys; json.dump({'TableNamesList': json.loads(sys.argv[1])}, open('$JSON','w'))" "$TABLES"
echo "Done." > "$OUT"
