def main(event, context):
    import logging as log

    log.getLogger().setLevel(log.INFO)
    physical_id = "TheOnlyCustomResource"
    try:
        log.info("Input event: %s", event)
        if event["RequestType"] == "Create" and event["ResourceProperties"].get(
            "FailCreate", False
        ):
            raise RuntimeError("Create failure requested")
        message = event["ResourceProperties"]["message"]
        attributes = {"Response": 'You said "%s"' % message}
        return {"Data": attributes}
    except Exception as e:
        log.exception(e)
        return {"Data": {}}
