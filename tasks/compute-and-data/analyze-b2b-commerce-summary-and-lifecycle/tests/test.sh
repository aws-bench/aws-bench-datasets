#!/bin/bash
# Programmatic boto3 verifier (no LLM judge → no resolve_placeholders.py).
# boto3 transitively pulls in botocore for any rewardkit dep that needs it.
set -ex

uvx --from harbor-rewardkit --with boto3 rewardkit /tests
