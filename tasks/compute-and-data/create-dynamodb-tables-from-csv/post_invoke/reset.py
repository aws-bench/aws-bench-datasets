"""Shared data-plane reset for create-dynamodb-tables-from-csv.

Deletes all objects in the source S3 bucket and re-uploads the exact
CSV files the CDK stack creates. Then deletes any DynamoDB tables that
correspond to those CSV files. This ensures each trial starts from a
clean slate with the original S3 data and no pre-existing tables.

Imported and called by both pre_invoke and post_invoke. Config is read from environment variables.
Best-effort: returns a list of error strings rather than raising.
"""

import os

import boto3
from botocore.exceptions import ClientError, WaiterError

REGION = os.environ.get("AWS_REGION", "us-east-1")
SOURCE_BUCKET = os.environ.get("DDB_SOURCE_BUCKET", "")

# Exact CSV content from the CDK stack (s3_7894hwoc7.ts)
CSV_FILES: dict[str, str] = {
    "orders.csv": (
        "order_id,customer_id,order_date,total_amount,status\n"
        "ORD001,CUST001,2024-01-15,199.99,completed\n"
        "ORD002,CUST002,2024-01-16,349.50,processing\n"
        "ORD003,CUST001,2024-01-17,89.99,completed\n"
        "ORD004,CUST003,2024-01-17,459.98,pending\n"
        "ORD005,CUST002,2024-01-18,129.99,completed"
    ),
    "products.csv": (
        "product_id,name,category,price,stock,description\n"
        "PROD001,Gaming Laptop,Electronics,1299.99,10,High-performance gaming laptop\n"
        "PROD002,Wireless Mouse,Electronics,29.99,50,Ergonomic wireless mouse\n"
        "PROD003,Coffee Maker,Appliances,79.99,25,Programmable coffee maker\n"
        "PROD004,Running Shoes,Sports,89.99,30,Professional running shoes\n"
        "PROD005,Backpack,Accessories,49.99,40,Water-resistant backpack"
    ),
    "customers.csv": (
        "customer_id,email,name,address,phone\n"
        "CUST001,john.doe@email.com,John Doe,123 Main St,555-0101\n"
        "CUST002,jane.smith@email.com,Jane Smith,456 Oak Ave,555-0102\n"
        "CUST003,bob.wilson@email.com,Bob Wilson,789 Pine Rd,555-0103\n"
        "CUST004,alice.brown@email.com,Alice Brown,321 Elm St,555-0104\n"
        "CUST005,charlie.davis@email.com,Charlie Davis,654 Maple Dr,555-0105"
    ),
    "order_items.csv": (
        "order_id,product_id,quantity,price\n"
        "ORD001,PROD002,2,29.99\n"
        "ORD001,PROD005,1,49.99\n"
        "ORD002,PROD001,1,1299.99\n"
        "ORD003,PROD003,1,79.99\n"
        "ORD004,PROD004,2,89.99\n"
        "ORD005,PROD002,1,29.99"
    ),
    "inventory.csv": (
        "product_id,warehouse_id,quantity,location\n"
        "PROD001,WH001,5,Section A1\n"
        "PROD001,WH002,5,Section B2\n"
        "PROD002,WH001,25,Section A2\n"
        "PROD002,WH002,25,Section B3\n"
        "PROD003,WH001,15,Section A3\n"
        "PROD003,WH002,10,Section B4\n"
        "PROD004,WH001,20,Section A4\n"
        "PROD004,WH002,10,Section B5\n"
        "PROD005,WH001,20,Section A5\n"
        "PROD005,WH002,20,Section B6"
    ),
}

TABLE_NAMES = [key[: -len(".csv")] for key in CSV_FILES]


def _clear_bucket(s3, bucket: str, errors: list[str]) -> None:
    """Delete all objects (including versions) from the bucket."""
    try:
        paginator = s3.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket):
            objects = []
            for v in page.get("Versions") or []:
                objects.append({"Key": v["Key"], "VersionId": v["VersionId"]})
            for dm in page.get("DeleteMarkers") or []:
                objects.append({"Key": dm["Key"], "VersionId": dm["VersionId"]})
            if objects:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": objects})
    except ClientError as e:
        errors.append(f"clear_bucket({bucket}): {e}")


def _seed_csv_files(s3, bucket: str, errors: list[str]) -> None:
    """Upload the exact CSV files the CDK stack creates."""
    for key, content in CSV_FILES.items():
        try:
            s3.put_object(Bucket=bucket, Key=key, Body=content.encode("utf-8"))
        except ClientError as e:
            errors.append(f"put_object({bucket}/{key}): {e}")


def _delete_dynamodb_tables(dynamodb, errors: list[str]) -> None:
    """Delete DynamoDB tables that correspond to the CSV files."""
    for table_name in TABLE_NAMES:
        try:
            dynamodb.delete_table(TableName=table_name)
            waiter = dynamodb.get_waiter("table_not_exists")
            waiter.wait(TableName=table_name)
        except ClientError as e:
            if e.response["Error"]["Code"] == "ResourceNotFoundException":
                continue
            errors.append(f"delete_table {table_name}: {e}")
        except WaiterError as e:
            errors.append(f"wait_for_delete {table_name}: {e}")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Clear the S3 bucket, re-seed CSV files, and delete DynamoDB tables.

    Returns a list of error strings (empty on success). Never raises for
    per-resource failures.
    """
    if not SOURCE_BUCKET:
        return ["SOURCE_BUCKET not set; skipping reset"]

    if session is None:
        session = boto3.Session(region_name=region)
    s3 = session.client("s3", region_name=region)
    dynamodb = session.client("dynamodb", region_name=region)
    errors: list[str] = []

    _clear_bucket(s3, SOURCE_BUCKET, errors)
    _seed_csv_files(s3, SOURCE_BUCKET, errors)
    _delete_dynamodb_tables(dynamodb, errors)

    return errors
