import json
import os
import boto3

dynamodb = boto3.resource("dynamodb")


def handler(event, context):
    """
    Lambda handler to retrieve data agreement by ID from DynamoDB.
    """
    table_name = os.environ["TABLE_NAME"]
    table = dynamodb.Table(table_name)

    # Extract agreementId from path parameters
    agreement_id = event.get("pathParameters", {}).get("agreementId")

    if not agreement_id:
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "Missing agreementId parameter"}),
        }

    try:
        response = table.get_item(Key={"agreementId": agreement_id})

        if "Item" not in response:
            return {
                "statusCode": 404,
                "body": json.dumps({"error": "Agreement not found"}),
            }

        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(response["Item"]),
        }

    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
