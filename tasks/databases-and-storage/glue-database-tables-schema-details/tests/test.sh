#!/bin/bash
# Rewardkit verifier entry point for introspection tasks.
#
# Resolves {{placeholder}} tokens in tests/ground_truth.json (see
# resolve_placeholders.py for details), then invokes rewardkit. boto3 is
# pulled in for transitive botocore (LiteLLM-Bedrock needs it; harbor-rewardkit
# doesn't declare it itself).
set -exo pipefail

uv run --no-project /tests/resolve_placeholders.py

# rewardkit only retries its own judge call on a malformed JSON response ---
# a transient Bedrock/LiteLLM error (throttling, 5xx, connection reset)
# fails the whole invocation, and with it the whole trial, even though the
# agent's own work was fine. Retry the invocation, but only when the
# failure looks transient: a real rubric/config bug should fail fast rather
# than burn the verifier's timeout budget on retries that can't succeed.
#
# Keep the retry budget modest: rewardkit's LLMJudge defaults to a 300s
# per-call timeout while several tasks set [verifier].timeout_sec as low as
# 240s for the *entire* verify step, so a large retry budget can itself
# cause a timeout. Tasks with slower judges can raise these via
# [verifier.env] in task.toml.
REWARDKIT_RETRY_MAX_ATTEMPTS="${REWARDKIT_RETRY_MAX_ATTEMPTS:-3}"
REWARDKIT_RETRY_BASE_DELAY_SEC="${REWARDKIT_RETRY_BASE_DELAY_SEC:-5}"
REWARDKIT_RETRY_TRANSIENT_PATTERN='throttl|rate.?limit|too many requests|service.?unavailable|internal.?server|bad.?gateway|connection reset|connection aborted|read timeout|connect.?timeout|remoteprotocolerror|apiconnectionerror|modeltimeoutexception|modelnotreadyexception|http status code: (429|500|502|503|504)'

attempt=1
while true; do
    # $? right after `fi` is the if-statement's own exit status (0 when the
    # condition is false and there's no else), not the condition's exit
    # status -- capture it inside `else` instead, before anything else runs.
    if output="$(uvx --from harbor-rewardkit --with boto3 rewardkit /tests 2>&1 | tee /dev/stderr)"; then
        break
    else
        status=$?
    fi
    if [[ "$attempt" -ge "$REWARDKIT_RETRY_MAX_ATTEMPTS" ]] \
        || ! grep -qiE "$REWARDKIT_RETRY_TRANSIENT_PATTERN" <<< "$output"; then
        exit "$status"
    fi
    delay=$((REWARDKIT_RETRY_BASE_DELAY_SEC * (2 ** (attempt - 1))))
    echo "rewardkit: transient Bedrock/LiteLLM error on attempt $attempt/$REWARDKIT_RETRY_MAX_ATTEMPTS; retrying in ${delay}s..." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
done
