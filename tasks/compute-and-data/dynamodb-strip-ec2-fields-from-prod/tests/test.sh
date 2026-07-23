#!/bin/bash
# Rewardkit verifier entry point for mutation tasks.
#
# Mutation tasks have no ground_truth.json placeholder file to resolve;
# rewardkit just discovers tests/check.py and runs the @criterion functions.
# boto3 is pulled in for transitive botocore (LiteLLM-Bedrock needs it if
# the task mixes in LLM judges; harbor-rewardkit doesn't declare it itself)
# and for the @criterion calls that hit AWS.
set -ex

uvx --from harbor-rewardkit --with boto3 rewardkit /tests
