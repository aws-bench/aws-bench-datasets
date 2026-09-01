"""Post-trial restore for the ledger AccessDenied scenario.

Returns the writer role to the state the CDK template declares. That state is
broken by design, so this restores the seeded defect, not a healthy role.
"""

import os
from typing import Optional

import boto3

import reset

REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")


def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    del kwargs
    errors = reset.restore(session, region)
    for err in errors:
        # Best-effort: a restore error is reported, never raised.
        print("post_invoke: %s" % err)
    if not errors:
        print("post_invoke: writer role restored to template baseline")


if __name__ == "__main__":
    run()
