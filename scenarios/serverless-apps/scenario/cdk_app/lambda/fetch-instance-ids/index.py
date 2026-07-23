import boto3
import os


def lambda_handler(event, context):
    ec2_client = boto3.client("ec2")
    ssm_client = boto3.client("ssm")

    try:
        auto_scaling_group_name = os.environ.get("AUTO_SCALING_GROUP_NAME")
        if not auto_scaling_group_name and "autoScalingGroupName" in event:
            auto_scaling_group_name = event.get("autoScalingGroupName")

        if not auto_scaling_group_name:
            return {
                "statusCode": 400,
                "error": "Missing required parameter: AUTO_SCALING_GROUP_NAME",
            }

        ssm_parameter_name = os.environ.get("SSM_PARAMETER_NAME")
        if not ssm_parameter_name:
            return {
                "statusCode": 400,
                "error": "Missing required environment variable: SSM_PARAMETER_NAME",
            }

        # Collect all instances with pagination
        instance_ids = []
        next_token = None

        while True:
            # If we have a next token, include it in the API call
            if next_token:
                response = ec2_client.describe_instances(
                    Filters=[
                        {
                            "Name": "tag:aws:autoscaling:groupName",
                            "Values": [auto_scaling_group_name],
                        }
                    ],
                    NextToken=next_token,
                )
            else:
                response = ec2_client.describe_instances(
                    Filters=[
                        {
                            "Name": "tag:aws:autoscaling:groupName",
                            "Values": [auto_scaling_group_name],
                        }
                    ]
                )

            # Add the instance IDs from this page to our collection
            for reservation in response["Reservations"]:
                for instance in reservation["Instances"]:
                    instance_ids.append(instance["InstanceId"])

            # Check if there are more pages
            if "NextToken" in response:
                next_token = response["NextToken"]
            else:
                break

        print(
            f"Found {len(instance_ids)} instances in Auto Scaling group {auto_scaling_group_name}"
        )

        instance_ids_string = ", ".join(instance_ids) if instance_ids else ""

        ssm_client.put_parameter(
            Name=ssm_parameter_name,
            Value=instance_ids_string,
            Type="String",
            Overwrite=True,
        )

        return {
            "statusCode": 200,
            "message": f"Successfully updated SSM Parameter {ssm_parameter_name} with {len(instance_ids)} instance IDs",
            "instanceIds": instance_ids,
        }

    except Exception as e:
        print(f"Error: {str(e)}")
        return {"statusCode": 500, "error": str(e)}
