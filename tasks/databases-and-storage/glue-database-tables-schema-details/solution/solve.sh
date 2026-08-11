#!/bin/bash
set -euo pipefail

REGION="us-east-1"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

TABLE_NAMES=$(aws glue get-tables --database-name "$DATABASE_NAME" --region "$REGION" \
    --query "TableList[].Name" --output text)
# Split table names into array for safe iteration
read -ra TABLE_ARRAY <<< "$TABLE_NAMES"
TABLE_COUNT=${#TABLE_ARRAY[@]}

{
    echo "The database ${DATABASE_NAME} contains ${TABLE_COUNT} table(s): ${TABLE_NAMES}."
    echo ""
    for NAME in "${TABLE_ARRAY[@]}"; do
        TYPE=$(aws glue get-table --database-name "$DATABASE_NAME" --name "$NAME" --region "$REGION" \
            --query "Table.TableType" --output text)
        LOCATION=$(aws glue get-table --database-name "$DATABASE_NAME" --name "$NAME" --region "$REGION" \
            --query "Table.StorageDescriptor.Location" --output text)
        COLS=$(aws glue get-table --database-name "$DATABASE_NAME" --name "$NAME" --region "$REGION" \
            --query "Table.StorageDescriptor.Columns[].[Name,Type]" --output text)
        COL_COUNT=$(printf '%s\n' "$COLS" | grep -c .)
        COL_LIST=$(printf '%s\n' "$COLS" | awk '{printf "%s%s (%s)", sep, $1, $2; sep=", "}')
        echo "Table ${NAME} (TableType: ${TYPE}) has ${COL_COUNT} columns: ${COL_LIST}."
        echo "Its data is stored externally in S3 at ${LOCATION}, so it is an external table."
        echo ""
    done
} > "$OUT"
