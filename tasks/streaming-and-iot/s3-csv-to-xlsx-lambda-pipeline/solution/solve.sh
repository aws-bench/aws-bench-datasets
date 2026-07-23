#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
BUCKET="${ETL_BUCKET}"
PREFIX="${OUTPUT_PREFIX:-converted/}"
FN_NAME="csv-to-xlsx-converter"
ROLE_NAME="csv-to-xlsx-lambda-role"
WORK="$(mktemp -d)"
OUT=/logs/agent/agent-output.json

cat > "$WORK/lambda_function.py" <<'PY'
import csv
import io
import os
import urllib.parse
import zipfile

import boto3

s3 = boto3.client("s3")
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "converted/")


def _esc(v):
    return (
        str(v)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _xlsx_bytes(rows):
    row_xml = []
    for r, row in enumerate(rows, start=1):
        cells = []
        for c, val in enumerate(row):
            ref = f"{chr(ord('A') + c)}{r}"
            cells.append(
                f'<c r="{ref}" t="inlineStr"><is><t>{_esc(val)}</t></is></c>'
            )
        row_xml.append(f'<row r="{r}">' + "".join(cells) + "</row>")
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<sheetData>" + "".join(row_xml) + "</sheetData></worksheet>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>"
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        "</Relationships>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", root_rels)
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        zf.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()


def handler(event, context):
    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        if not key.startswith("raw/") or not key.lower().endswith(".csv"):
            continue
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
        rows = list(csv.reader(io.StringIO(body)))
        base = key[len("raw/"):].rsplit("/", 1)[-1]
        out_name = base[:-4] if base.lower().endswith(".csv") else base
        out_key = f"{OUTPUT_PREFIX}{out_name}.xlsx"
        s3.put_object(
            Bucket=bucket,
            Key=out_key,
            Body=_xlsx_bytes(rows),
            ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    return {"ok": True}
PY

(cd "$WORK" && zip -q function.zip lambda_function.py)

ROLE_ARN=$(aws iam create-role --role-name "$ROLE_NAME" --region "$REGION" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --query 'Role.Arn' --output text)

aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name s3-access \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\"],\"Resource\":\"arn:aws:s3:::${BUCKET}/*\"}]}"

until aws lambda create-function --function-name "$FN_NAME" --region "$REGION" \
  --runtime python3.12 --handler lambda_function.handler --role "$ROLE_ARN" \
  --timeout 60 --environment "Variables={OUTPUT_PREFIX=${PREFIX}}" \
  --zip-file "fileb://${WORK}/function.zip"; do
  sleep 5
done

aws lambda wait function-active-v2 --function-name "$FN_NAME" --region "$REGION"

FN_ARN=$(aws lambda get-function --function-name "$FN_NAME" --region "$REGION" \
  --query 'Configuration.FunctionArn' --output text)

aws lambda add-permission --function-name "$FN_NAME" --region "$REGION" \
  --statement-id s3invoke --action lambda:InvokeFunction \
  --principal s3.amazonaws.com --source-arn "arn:aws:s3:::${BUCKET}"

aws s3api put-bucket-notification-configuration --bucket "$BUCKET" --region "$REGION" \
  --notification-configuration "{\"LambdaFunctionConfigurations\":[{\"LambdaFunctionArn\":\"${FN_ARN}\",\"Events\":[\"s3:ObjectCreated:*\"],\"Filter\":{\"Key\":{\"FilterRules\":[{\"Name\":\"prefix\",\"Value\":\"raw/\"},{\"Name\":\"suffix\",\"Value\":\".csv\"}]}}}]}"

for KEY in $(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "raw/" --region "$REGION" \
  --query "Contents[?ends_with(Key, '.csv')].Key" --output text); do
  aws lambda invoke --function-name "$FN_NAME" --region "$REGION" \
    --cli-binary-format raw-in-base64-out \
    --payload "{\"Records\":[{\"s3\":{\"bucket\":{\"name\":\"${BUCKET}\"},\"object\":{\"key\":\"${KEY}\"}}}]}" \
    "$WORK/out.json"
done

mkdir -p "$(dirname "$OUT")"
printf '{"lambda_function_name": "%s"}\n' "$FN_NAME" > "$OUT"
echo "Done." > /logs/agent/agent-output.txt
