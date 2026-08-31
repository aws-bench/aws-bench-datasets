#!/bin/bash
# Asserts the post-setup state the account snapshot cannot see: DynamoDB seed rows,
# S3 build artifacts and run logs, SSM parameter values, ECR release tags and a live
# ECS service. Read-only; idempotent; safe to re-run.
set -euo pipefail

export AWS_PROFILE=PRIMARY
export AWS_DEFAULT_REGION=us-east-1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec python3 "${HERE}/assertions.py"
