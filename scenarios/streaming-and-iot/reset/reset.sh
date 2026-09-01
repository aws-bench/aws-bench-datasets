#!/bin/bash
# Scenario reset hook for streaming-and-iot.
#
# Runs BEFORE the framework's reset (new-resource scan + stack teardown). Its job
# is to remove the run-created residuals the framework can't clean on its own,
# because they are NOT CloudFormation stack resources and they BLOCK deletion of
# resources that are:
#
#   1. The dms-rds-mysql-to-s3-tables task makes the agent create a DMS
#      replication instance. AWS attaches a service-managed (RequesterManaged)
#      ENI into the rds_rdsdms9k4 stack's private subnet. That ENI pins the
#      subnet, so the stack cannot be deleted until the instance is gone.
#   2. The replication writes a namespace (+ tables) into the pre-deployed
#      S3 Tables bucket. A non-empty table bucket cannot be deleted, so the
#      stack delete fails on it too.
#
# Both surface as the RDS stack wedging in DELETE_FAILED on a later teardown.
# Reaping them here lets the framework reset/cleanup converge.
#
# Best-effort and idempotent: a fresh environment (no DMS instance, empty bucket)
# is a no-op, and every step tolerates "already gone". Never fail the phase — the
# framework reset runs afterwards regardless.
set -uo pipefail

REGION="us-east-1"
PROFILE="PRIMARY"
AWS="aws --profile ${PROFILE} --region ${REGION}"
ACCOUNT_SUFFIX="${PRIMARY: -6}"
TABLE_BUCKET_ARN="arn:aws:s3tables:${REGION}:${PRIMARY}:bucket/app-tables-${ACCOUNT_SUFFIX}"

echo "[reset.sh] streaming-and-iot reset for account ${PRIMARY} (${REGION})"

# ── 1. Reap DMS replication tasks → instances → subnet groups ─────────────────
# Order matters: DMS refuses to delete an instance while a task references it,
# and a subnet group while an instance uses it. Tasks → instances → subnet groups.
echo "[reset.sh] Reaping DMS replication tasks..."
for task_arn in $($AWS dms describe-replication-tasks \
        --query 'ReplicationTasks[].ReplicationTaskArn' --output text 2>/dev/null); do
    echo "[reset.sh]   stopping + deleting replication task ${task_arn}"
    $AWS dms stop-replication-task --replication-task-arn "${task_arn}" >/dev/null 2>&1 || true
    $AWS dms wait replication-task-stopped --filters "Name=replication-task-arn,Values=${task_arn}" >/dev/null 2>&1 || true
    $AWS dms delete-replication-task --replication-task-arn "${task_arn}" >/dev/null 2>&1 || true
    # DMS rejects deleting a replication instance while a task on it is still
    # deleting, so wait for the task to be fully gone before touching instances.
    echo "[reset.sh]   waiting for task ${task_arn} to fully delete..."
    $AWS dms wait replication-task-deleted --filters "Name=replication-task-arn,Values=${task_arn}" >/dev/null 2>&1 || true
done

echo "[reset.sh] Reaping DMS endpoints..."
for ep_arn in $($AWS dms describe-endpoints \
        --query 'Endpoints[].EndpointArn' --output text 2>/dev/null); do
    echo "[reset.sh]   deleting endpoint ${ep_arn}"
    $AWS dms delete-endpoint --endpoint-arn "${ep_arn}" >/dev/null 2>&1 || true
done

echo "[reset.sh] Reaping DMS replication instances..."
instance_arns="$($AWS dms describe-replication-instances \
    --query 'ReplicationInstances[].ReplicationInstanceArn' --output text 2>/dev/null)"
for inst_arn in ${instance_arns}; do
    # Retry the delete: even after the task is gone, the instance may briefly
    # report an in-use/invalid state. Retry until DMS accepts it (or it's gone).
    echo "[reset.sh]   deleting replication instance ${inst_arn}"
    for attempt in 1 2 3 4 5 6; do
        status="$($AWS dms describe-replication-instances \
            --filters "Name=replication-instance-arn,Values=${inst_arn}" \
            --query 'ReplicationInstances[0].ReplicationInstanceStatus' --output text 2>/dev/null)"
        # Gone or already deleting -> nothing more to issue.
        if [ -z "${status}" ] || [ "${status}" = "None" ] || [ "${status}" = "deleting" ]; then
            break
        fi
        if $AWS dms delete-replication-instance --replication-instance-arn "${inst_arn}" >/dev/null 2>&1; then
            break
        fi
        echo "[reset.sh]     delete not accepted yet (status=${status}); retry ${attempt}/6 in 20s"
        sleep 20
    done
done
# Wait for instances to fully delete so their ENIs are released before the
# framework reset / stack teardown tries to delete the subnet.
for inst_arn in ${instance_arns}; do
    echo "[reset.sh]   waiting for ${inst_arn} to delete (releases its ENI)..."
    $AWS dms wait replication-instance-deleted \
        --filters "Name=replication-instance-arn,Values=${inst_arn}" >/dev/null 2>&1 || true
done

echo "[reset.sh] Reaping DMS replication subnet groups..."
for sng in $($AWS dms describe-replication-subnet-groups \
        --query 'ReplicationSubnetGroups[].ReplicationSubnetGroupIdentifier' --output text 2>/dev/null); do
    echo "[reset.sh]   deleting subnet group ${sng}"
    $AWS dms delete-replication-subnet-group --replication-subnet-group-identifier "${sng}" >/dev/null 2>&1 || true
done

# ── 2. Empty the S3 Tables bucket (delete tables → namespaces) ────────────────
# A non-empty table bucket blocks DeleteTableBucket during stack teardown. The
# bucket itself is a stack resource and is recreated by setup, so we only empty
# it here, never delete it.
echo "[reset.sh] Emptying S3 Tables bucket ${TABLE_BUCKET_ARN}..."
if $AWS s3tables get-table-bucket --table-bucket-arn "${TABLE_BUCKET_ARN}" >/dev/null 2>&1; then
    for ns in $($AWS s3tables list-namespaces --table-bucket-arn "${TABLE_BUCKET_ARN}" \
            --query 'namespaces[].namespace[0]' --output text 2>/dev/null); do
        for tbl in $($AWS s3tables list-tables --table-bucket-arn "${TABLE_BUCKET_ARN}" \
                --namespace "${ns}" --query 'tables[].name' --output text 2>/dev/null); do
            echo "[reset.sh]   deleting table ${ns}.${tbl}"
            $AWS s3tables delete-table --table-bucket-arn "${TABLE_BUCKET_ARN}" \
                --namespace "${ns}" --name "${tbl}" >/dev/null 2>&1 || true
        done
        echo "[reset.sh]   deleting namespace ${ns}"
        $AWS s3tables delete-namespace --table-bucket-arn "${TABLE_BUCKET_ARN}" \
            --namespace "${ns}" >/dev/null 2>&1 || true
    done
else
    echo "[reset.sh]   table bucket not present (fresh env) — nothing to empty"
fi

# ── 3. Run per-task post_invoke scripts ────────────────────────────────────────
# Execute each task's post_invoke/post_invoke.py to roll back agent-created
# mutations. Discovers tasks by listing directories in reset/post_invokes/.
# Best-effort: a failure in one task doesn't block others.
POST_INVOKES_DIR="/reset/post_invokes"

if [ ! -d "${POST_INVOKES_DIR}" ]; then
    echo "[reset.sh] No post_invokes/ directory found, skipping."
else
    echo "[reset.sh] Running per-task post_invoke scripts..."
    export AWS_PROFILE="PRIMARY"

    for task_dir in "${POST_INVOKES_DIR}"/*; do
        [ -d "${task_dir}" ] || continue
        task_name="$(basename "${task_dir}")"
        post_invoke_sh="${task_dir}/post_invoke.sh"
        if [ ! -f "${post_invoke_sh}" ]; then
            echo "[reset.sh]   SKIP: ${task_name} (no post_invoke.sh)"
            continue
        fi
        echo "[reset.sh]   running post_invoke for ${task_name}"
        if ! (cd "${task_dir}" && bash post_invoke.sh); then
            echo "[reset.sh]   ERROR: post_invoke failed for ${task_name}"
        fi
    done
fi

echo "[reset.sh] Done. Framework reset will handle the rest."
exit 0