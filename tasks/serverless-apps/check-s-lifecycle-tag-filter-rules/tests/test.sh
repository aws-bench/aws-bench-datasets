#!/bin/bash
# Rewardkit verifier entry point for introspection tasks.
#
# Resolves {{placeholder}} tokens in tests/ground_truth.json (see
# resolve_placeholders.py for details), then invokes rewardkit. boto3 is
# pulled in for transitive botocore (LiteLLM-Bedrock needs it; harbor-rewardkit
# doesn't declare it itself).
set -ex

uv run --no-project /tests/resolve_placeholders.py
uvx --from harbor-rewardkit --with boto3 rewardkit /tests
