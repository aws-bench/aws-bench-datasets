# aws-bench-datasets contributor and agent guide

## Purpose

aws-bench-datasets contains the benchmark content executed by the [aws-bench framework](https://github.com/aws-bench/aws-bench): task prompts, verifiers, reference solutions, per-task lifecycle hooks, and containerized AWS scenarios. Framework orchestration belongs in the aws-bench repository.

## Repository layout

- `tasks/<scenario-id>/<task-name>/` — published task definitions.
- `scenarios/<scenario-id>/` — published scenario manifests (`scenario.toml`), the deployment container and CDK application (`scenario/`), and lifecycle scripts: `deploy/` (required), plus optional `reset/`, `verify/`, and `cleanup/`.
- `shared/judge/` — canonical introspection-judge files copied into tasks.
- `shared/tasks/` — canonical helpers shared by task hook directories.
- `metric/` — dataset-level metric implementation.
- `test/` — repository-wide schema, consistency, and reentrancy tests.

## Task contracts

Every published task must include `task.toml`, `instruction.md`, an `environment/`, and `tests/test.sh`; a `solution/solve.sh` reference solution is optional (the oracle agent uses it when present). The task's `[scenario].scenario_id` must match a directory under `scenarios/`.

- **Introspection tasks** use `metadata.request_type = "introspection"`, run the agent with an agent role that has a read-only policy (set via `agent_role_name` in `task.toml`), write a textual answer, and use `tests/ground_truth.json` with the shared judge.
- **Mutation tasks** use `metadata.request_type = "mutation"`, run the agent with an agent role that has a write-capable policy (set via `agent_role_name` in `task.toml`), write the documented structured output, and use `tests/check.py` to verify live AWS state.
- Keep `[concurrency].mode`, the selected agent role, the instruction, the verifier, and the actual behavior of every lifecycle phase consistent. A task is read-only only when its pre-invoke, agent, verifier, and post-invoke behavior are all read-only.
- Placeholders in instructions, verifier environments, and ground truth must resolve from scenario exports or the flat string map emitted by pre-invoke.
- Pre-invoke must create `/logs/pre_invoke/placeholder.json` when it outputs placeholders.
- Verifiers must create the Harbor reward output.
- Post-invoke must be safe to retry and restore task-specific mutations.

## Scenario contracts

A published scenario must include `scenario.toml`, `scenario/Dockerfile`, and its declared lifecycle scripts. `deploy/deploy.sh` is mandatory when the scenario has a CDK application under `scenario/cdk_app/`; scenarios can also provide optional `reset/` and `cleanup/` scripts. See the [Datasets Development Guide](https://github.com/aws-bench/aws-bench/blob/main/docs/datasets-development.md) for the full lifecycle-script reference. Deployment and setup must be idempotent because the framework can rerun them after partial failure or reset. Keep Regions, account tags, quotas, CloudFormation exports, IAM roles, and task placeholders aligned.

## Safety

- Scenario and hook code can create, modify, and delete AWS resources. Do not run deployment, reset, cleanup, task solutions, or live verifiers unless the operator explicitly authorizes the target test account and Regions.
- Never test against an account that might be production.
- Do not spin up costly resources beyond what a scenario or task genuinely requires; prefer the smallest instance sizes, cluster counts, and Regions that still exercise the behavior under test.
- Clean up resources you create during development and validation so disposable test accounts stay reusable.

## Canonical and generated copies

Do not independently edit synchronized copies:

- Edit canonical judge files under `shared/judge/`, then run its sync script.
- Edit canonical task helpers under `shared/tasks/`, then run its sync script.
- Preserve executable bits on shell entry points.
- Do not commit generated output such as `node_modules/`, `build/`, `coverage/`, `cdk.out/`, or runtime logs.

## Validation

Run the repository checks from the package root using the Makefile-based build, which covers TypeScript, CDK apps, Python, shell, Docker, and config validation:

```bash
make check     # full green gate: TypeScript + CDK + Python + shell + Docker + config
make ready     # pre-submit: auto-fix Python formatting, then run the full gate
make help      # list every target
```

Also run the drift checks for synchronized copies:

```bash
./shared/judge/scripts/sync.sh --check
./shared/judge/scripts/sync.sh --check-instructions
./shared/judge/scripts/sync.sh --check-placeholders
./shared/judge/scripts/sync.sh --check-output-contract
./shared/tasks/scripts/sync.sh --check
```

Run targeted tests for any changed scenario, task, verifier, or lifecycle script in addition to these repository checks. Live AWS validation is required for behavioral changes but must use an explicitly approved disposable aws-bench environment.

## Publishing hygiene

- Keep `README.md` catalog entries synchronized with the framework registry.
- Do not add company-internal URLs, credentials, account IDs, customer data, run artifacts, or any other company-confidential material (from Amazon or any contributor's organization) to published files.
- Keep `LICENSE` and `NOTICE` at the repository root. Change legal text only with project-owner approval.
- Use inclusive terminology in documentation, identifiers, and comments.
