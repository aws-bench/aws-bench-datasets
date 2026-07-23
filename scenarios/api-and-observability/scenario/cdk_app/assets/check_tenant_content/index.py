import json
import boto3
import os

s3 = boto3.client("s3")


def handler(event, context):
    """Check if tenant content exists in S3"""
    tenant_id = event["tenant_id"]
    bucket_name = os.environ["TENANT_SERVICES_BUCKET"]

    # Check for required files
    required_files = ["index.html", "app.js"]
    files_exist = []

    for file_name in required_files:
        key = f"{tenant_id}/{file_name}"
        try:
            s3.head_object(Bucket=bucket_name, Key=key)
            files_exist.append(file_name)
        except:
            pass

    content_ready = len(files_exist) == len(required_files)

    return {
        "tenant_id": tenant_id,
        "content_ready": content_ready,
        "files_found": files_exist,
    }
