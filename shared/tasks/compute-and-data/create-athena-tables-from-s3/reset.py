"""Data-plane reset for create-athena-tables-from-s3.

Drops the Glue/Athena databases whose tables are backed by this task's CSV
bucket, empties the bucket, and re-puts every baseline object with the correct
Content-Type. Best-effort: returns a list of error strings rather than raising.
"""

import mimetypes
import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
CSV_BUCKET = os.environ.get("CSV_BUCKET", "")


def _transaction_log_csv() -> str:
    """Build logs/transaction_log.csv: header plus 50 rows."""
    rows = [
        f"{i + 1},TXN{str(i + 1).zfill(6)},{(i * 7 + 13) % 1000},"
        f"2023-01-{str((i % 31) + 1).zfill(2)}"
        for i in range(50)
    ]
    return "id,transaction_id,amount,date\n" + "\n".join(rows)


# Baseline S3 objects keyed by object key -> body.
BASELINE_OBJECTS: dict[str, str] = {
    # Core data files
    "data/raw/sales/Q1/jan_sales_final_v2.csv": (
        "ID,Product Name,Amount (USD),Transaction Date,Customer ID,Region\n"
        '1,"Laptop, Gaming",1200.50,2023-01-15,C001,"North America"\n'
        "2,Mouse Wireless,25.99,2023-01-16,C002,Europe\n"
        '3,"Keyboard, Mechanical",75.00,,C003,Asia'
    ),
    "data/processed/customers/customer_master_file.csv": (
        "cust_id,full_name,email_address,phone,address_line_1,city,state,zip\n"
        'C001,"John, Doe Jr.",john@example.com,555-1234,'
        '"123 Main St, Apt 4B",New York,NY,10001\n'
        "C002,Jane Smith,jane@example.com,,456 Oak Ave,London,,SW1A 1AA\n"
        "C003,Bob Wilson,bob@example.com,555-5678,789 Pine Rd,Tokyo,,100-0001"
    ),
    "exports/financial_data_export.csv": (
        "# Financial Export - Generated 2023-01-20\n"
        "# Contains sensitive data\n"
        "revenue,costs,profit,quarter\n"
        "150000,120000,30000,Q1\n"
        "180000,140000,40000,Q2\n"
        "# Note: Q3 data pending\n"
        "200000,160000,40000,Q4"
    ),
    "temp/inventory/stock_levels.csv": (
        "item_code;quantity;warehouse_location;last_updated\n"
        "LAP001;50;WH-NYC;2023-01-15 10:30:00\n"
        "MOU001;200;WH-LON;2023-01-16 14:45:00\n"
        "KEY001;75;WH-TOK;2023-01-17 09:15:00"
    ),
    # Transaction logs and department files
    "logs/transaction_log.csv": _transaction_log_csv(),
    "dept/hr/employees_2023.csv": "emp_id,name,dept\n1,Alice,HR\n2,Bob,IT",
    "dept/it/servers.csv": (
        "server_id,hostname,status\n1,web01,active\n2,db01,maintenance"
    ),
    "dept/finance/budgets.csv": ("dept,budget,year\nHR,50000,2023\nIT,100000,2023"),
    # Regional sales data
    "regions/us/sales_us.csv": (
        "region,sales,month\nUS-East,10000,Jan\nUS-West,15000,Jan"
    ),
    "regions/eu/sales_eu.csv": (
        "region,sales,month\nEU-North,8000,Jan\nEU-South,12000,Jan"
    ),
    "regions/asia/sales_asia.csv": (
        "region,sales,month\nAsia-Pacific,20000,Jan\nAsia-Central,5000,Jan"
    ),
    # Product categories
    "products/category_a/items.csv": (
        "item_id,name,price\n1,Widget A,10\n2,Gadget A,20"
    ),
    "products/category_b/items.csv": (
        "item_id,name,price\n3,Widget B,15\n4,Gadget B,25"
    ),
    "products/category_c/items.csv": (
        "item_id,name,price\n5,Widget C,12\n6,Gadget C,22"
    ),
    # Time-based data
    "quarterly/q1/summary.csv": "metric,value\nrevenue,100000\nprofit,20000",
    "quarterly/q2/summary.csv": "metric,value\nrevenue,120000\nprofit,25000",
    "quarterly/q3/summary.csv": "metric,value\nrevenue,110000\nprofit,22000",
    "quarterly/q4/summary.csv": "metric,value\nrevenue,130000\nprofit,28000",
    "monthly/jan/orders.csv": "order_id,amount\n1001,500\n1002,750",
    "monthly/feb/orders.csv": "order_id,amount\n1003,600\n1004,800",
    "monthly/mar/orders.csv": "order_id,amount\n1005,550\n1006,900",
}


def _content_type(key: str) -> str:
    guessed, _ = mimetypes.guess_type(key)
    return guessed or "application/octet-stream"


def _empty(s3, bucket: str, errors: list[str]) -> None:
    """Delete every object in the bucket.

    list_object_versions returns current objects with VersionId 'null' on a
    non-versioned bucket, so this single path covers both cases. The
    paginator caps each page at 1000, matching the delete_objects limit.
    """
    paginator = s3.get_paginator("list_object_versions")
    try:
        for page in paginator.paginate(Bucket=bucket):
            to_delete = [
                {"Key": v["Key"], "VersionId": v["VersionId"]}
                for v in page.get("Versions", []) + page.get("DeleteMarkers", [])
            ]
            if to_delete:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete})
    except ClientError as e:
        errors.append(f"empty {bucket}: {e}")


def _location_bucket(location: str) -> str:
    """Return the S3 bucket portion of an ``s3://bucket/key`` location, else ''."""
    if location.startswith("s3://"):
        return location[len("s3://") :].split("/", 1)[0]
    return ""


def _clean_task_databases(glue, bucket: str, errors: list[str]) -> None:
    """Drop the Glue databases with a table backed by ``bucket`` (never ``default``)."""
    if not bucket:
        return
    try:
        owned: list[str] = []
        for page in glue.get_paginator("get_databases").paginate():
            for db in page.get("DatabaseList", []):
                name = db["Name"]
                if name == "default":
                    continue
                try:
                    is_owned = any(
                        _location_bucket(
                            (tbl.get("StorageDescriptor") or {}).get("Location", "")
                        )
                        == bucket
                        for tpage in glue.get_paginator("get_tables").paginate(
                            DatabaseName=name
                        )
                        for tbl in tpage.get("TableList", [])
                    )
                except ClientError as e:
                    errors.append(f"get_tables {name}: {e}")
                    continue
                if is_owned:
                    owned.append(name)
        for name in owned:
            try:
                glue.delete_database(Name=name)
            except ClientError as e:
                errors.append(f"delete_database {name}: {e}")
    except ClientError as e:
        errors.append(f"get_databases: {e}")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Drop the task's Glue databases, empty the CSV bucket, re-put the seeds.

    Returns a list of error strings (empty on success). Never raises for a
    per-object failure.
    """
    errors: list[str] = []
    if not CSV_BUCKET:
        return []

    if session is None:
        session = boto3.Session(region_name=region)
    s3 = session.client("s3", region_name=region)
    glue = session.client("glue", region_name=region)

    _clean_task_databases(glue, CSV_BUCKET, errors)

    _empty(s3, CSV_BUCKET, errors)

    for key, body in BASELINE_OBJECTS.items():
        try:
            s3.put_object(
                Bucket=CSV_BUCKET,
                Key=key,
                Body=body.encode("utf-8"),
                ContentType=_content_type(key),
            )
        except ClientError as e:
            errors.append(f"put {key}: {e}")

    return errors
