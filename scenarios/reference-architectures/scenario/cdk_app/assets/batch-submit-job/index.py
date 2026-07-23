import boto3
import json
import os


def handler(event, context):
    batch = boto3.client("batch")
    job_queue = os.environ["JOB_QUEUE"]
    job_definition = os.environ["JOB_DEFINITION"]
    response = batch.submit_job(
        jobName="openmp-benchmark-job",
        jobQueue=job_queue,
        jobDefinition=job_definition,
        parameters={
            "size": "600000000",
            "threads": "2",
            "benchmark-type": "simple",
            "matrix-size": "1200",
        },
    )
    return {"statusCode": 200, "body": json.dumps({"jobId": response["jobId"]})}
