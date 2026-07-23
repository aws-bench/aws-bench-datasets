import json
import os
import boto3

s3_client = boto3.client("s3")
glue = boto3.client("glue")
pipeline = boto3.client("codepipeline")
codecommit_client = boto3.client("codecommit")


def lambda_handler(event, context):
    job = event["CodePipeline.job"]
    try:
        data = job["data"]
        config = data["actionConfiguration"]["configuration"]
        user_params = json.loads(config["UserParameters"])
        input_artifacts = data["inputArtifacts"]
        source_code_artifact = input_artifacts[0]
        artifact_bucket = source_code_artifact["location"]["s3Location"]["bucketName"]
        artifact_key = source_code_artifact["location"]["s3Location"]["objectKey"]
        filename = os.getenv("FILENAME")
        file_key = os.path.join(artifact_key, filename)
        commit_id = source_code_artifact["revision"]
        repository_name = os.getenv("REPOSITORY_NAME")
        codecommit_resp = codecommit_client.get_file(
            repositoryName=repository_name, commitSpecifier=commit_id, filePath=filename
        )
        s3_resp = s3_client.put_object(
            Bucket=artifact_bucket, Key=file_key, Body=codecommit_resp["fileContent"]
        )
        s3_script_location = f"s3://{artifact_bucket}/{file_key}"
        glue_job_name_id = artifact_key.split("/")[-1:][0]
        glue_job_name = f"{user_params['glue_job_name']}_{glue_job_name_id}"
        default_arguments = {}
        if "additional_python_modules" in user_params:
            default_arguments["--additional-python-modules"] = user_params[
                "additional_python_modules"
            ]
        create_job_resp = glue.create_job(
            Name=glue_job_name,
            Role=user_params["glue_role"],
            Command={"Name": "glueetl", "ScriptLocation": s3_script_location},
            DefaultArguments=default_arguments,
            GlueVersion="4.0",
        )
        glue.start_job_run(JobName=create_job_resp["Name"])
        pipeline.put_job_success_result(jobId=job["id"])
    except Exception as e:
        pipeline.put_job_failure_result(
            jobId=job["id"],
            failureDetails={
                "type": "JobFailed",
                "message": str(e),
                "externalExecutionId": context.aws_request_id,
            },
        )
