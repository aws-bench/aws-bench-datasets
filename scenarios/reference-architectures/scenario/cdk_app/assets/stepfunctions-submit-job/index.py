def main(event, context):
    print("The job is submitted successfully!")
    return {"id": event["id"], "status": "SUCCEEDED"}
