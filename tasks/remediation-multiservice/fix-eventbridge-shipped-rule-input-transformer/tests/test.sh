#!/bin/bash
# Rewardkit verifier entry point for mutation tasks.
#
# Mutation tasks have no ground_truth.json placeholder file to resolve;
# rewardkit just discovers tests/check.py and runs the @criterion functions.
# boto3 is pulled in for transitive botocore and for the @criterion calls
# that hit AWS.
set -ex

uvx --from harbor-rewardkit --with boto3 rewardkit /tests
