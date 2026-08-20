# aws-bench-datasets

Scenarios and tasks for evaluating AI agents on real-world AWS automation tasks. Use the [aws-bench framework](https://github.com/aws-bench/aws-bench) to provision isolated AWS environments, run agents, and evaluate their results.

## Getting started

Provision a test environment and run your first benchmark by following the framework's [README](https://github.com/aws-bench/aws-bench). You can use the `aws-bench-quickstart` dataset to run a smoke-test by passing `-d aws-bench-quickstart`.

> **Note:** Set `AWS_REGION=us-east-1` before running aws-bench — these scenarios expect the `us-east-1` region. Also export `AWS_DEFAULT_REGION=us-east-1` in your shell so your own AWS CLI/SDK calls resolve to the same region.

## Task families

- **Introspection** (read-only diagnosis): agent runs and writes its answer to `/logs/agent/agent-output.txt`; an LLM judge (rewardkit) compares it against `tests/ground_truth.json`.
- **Mutation** (create/modify resources): agent runs and writes structured JSON to `/logs/agent/agent-output.json` where the instruction requires it; a programmatic boto3 verifier (`tests/check.py`) checks live AWS state.

## Dataset catalog

Datasets are versioned in the framework's [`registry.json`](https://github.com/aws-bench/aws-bench/blob/main/registry.json). Run a dataset with `aws-bench run -d <dataset>` (latest version) or pin a version with `-d <dataset>@<version>`.

The dataset is made of 134 tasks (total): 99 tasks require acquiring information about the account's state
without making changes (introspection), while 35 tasks lead to mutations.

The dataset is partitioned in three subsets:
* QUICKSTART: 9 simple tasks to test the setup
* BASIC: 78 tasks to assess the fundamental knowledge needed to interact with the AWS services
* ADVANCED: 47 tasks challenging also for recent frontier models


## Structure

Tasks in extended Harbor format are under `tasks/`, scenarios (containerized CDK environments) under `scenarios/`:

```
tasks/<scenario-id>/<task-name>/
    task.toml              # task config: scenario, roles, metadata, timeouts, placeholders
    instruction.md         # prompt given to the agent
    tests/
        ground_truth.json  # reference answer for LLM judge (introspection tasks)
        check.py           # programmatic boto3 verifier (mutation tasks)
        test.sh            # verifier entrypoint
    solution/
        solve.sh           # reference solution
    environment/
        Dockerfile
        docker-compose.yaml
    pre_invoke/            # (optional) runs before agent, e.g. to seed dynamic state
    post_invoke/           # (optional) runs after agent, e.g. to roll back mutations

scenarios/<scenario-id>/
    scenario.toml          # account tags, regions, quotas, timeouts
    deploy/deploy.sh       # bootstraps regions, deploys all stacks, runs setup scripts
    cleanup/cleanup.sh     # tears down deployed stacks
    reset/, verify/        # (optional) reset helpers / post-deploy verification
    scenario/
        Dockerfile         # deployment tooling container
        cdk_app/           # self-contained CDK app (stacks, lambda assets, QA roles)
        setup/             # post-deploy setup scripts (where applicable)
```

Each task references a scenario via `scenario_id` in `task.toml`. Multiple tasks can share the same scenario. Each scenario maps to one AWS account (via `account_tags`) and can deploy stacks across multiple regions.

## Agent steering

`shared/steering/` holds AWS-awareness instructions that steer agents to use the AWS CLI/SDK instead of searching the local filesystem. Registry datasets attach them automatically; local `--path` runs pass them with the framework's `--extra-instruction-path` flag.

## Deploying a scenario

Scenarios are deployed by the aws-bench harness, which builds `scenario/Dockerfile` and runs `deploy/deploy.sh` inside it with account credentials injected. You can use the `aws-bench env` commands to deploy scenarios and manage the AWS test environment. For more details consult the docs in the [aws-bench](https://github.com/aws-bench/aws-bench) package.

## Adding a scenario and tasks

1. Create `scenarios/<scenario-id>/` with `scenario.toml`, `deploy/deploy.sh`, and a self-contained CDK app under `scenario/cdk_app/` (see an existing scenario for the pattern).
2. Create one or more `tasks/<scenario-id>/<task-name>/` directories (see an existing task for the pattern).
3. For introspection tasks, copy the shared judge files: `./shared/judge/scripts/sync.sh`.

See the [Datasets Development Guide](https://github.com/aws-bench/aws-bench/blob/main/docs/datasets-development.md) for more details on running benchmarks or contributing your own dataset.

## Building

Prerequisites: `make`, `node`/`npm`, [`uv`](https://docs.astral.sh/uv/) (provides
`uvx`), and `docker`. `ruff`, `ty`, and `shellcheck` are fetched on demand via
`uvx`; `hadolint` runs from its official Docker image; the CDK apps use their own
locally-pinned toolchain. Run `make tools` to check what's available.

```bash
make check     # full green gate: TypeScript + CDK + Python + shell + Docker + config
make build     # compile only: root TypeScript + all stable CDK apps
make test      # checks only, no heavy CDK installs: jest + linters + config
make help      # list every target
```

| Target | Covers | Tooling |
|--------|--------|---------|
| `ts`   | Root TypeScript | `tsc` typecheck + `jest` (task/reentrancy suite) |
| `cdk`  | Each stable `scenarios/*/scenario/cdk_app` | per-app `tsc` compile |
| `py`   | Python scripts | `ruff` lint + `ty` typecheck |
| `shell`| Shell scripts | `shellcheck` (severity `error`) |
| `docker`| Dockerfiles | `hadolint` + 3P-license check |
| `config`| `task.toml` / verifier metadata | field + toolchain-pinning checks |

Each gate is calibrated to pass on current content; thresholds and rule sets are
tunable via `pyproject.toml` (`[tool.ruff]`, `[tool.ty]`), `.hadolint.yaml`,
`.shellcheckrc`, and the variables at the top of the `Makefile`. Notes:

- **Formatting is enforced.** `make py` (and thus `make check`) fails on `ruff`
  formatting drift. Run `make py-fmt` to apply formatting, or `make fix` /
  `make ready` to auto-fix and format before submitting.
- **CDK compile, not synth**, is the gate — `cdk synth` needs account
  context/credentials, whereas compilation is hermetic and offline.

## Running Tests

Repo-level CI tests (task.toml field validation, AWS service tag validation):

```bash
npm install
npm test
```

CI drift checks for shared judge files and instruction/ground-truth consistency:

```bash
./shared/judge/scripts/sync.sh --check
./shared/judge/scripts/sync.sh --check-instructions
./shared/judge/scripts/sync.sh --check-placeholders
./shared/judge/scripts/sync.sh --check-output-contract
```

CI drift check for canonical per-task helpers (e.g. `reset.py` shared between a
task's `pre_invoke/` and `post_invoke/`, authored under `shared/tasks/`):

```bash
./shared/tasks/scripts/sync.sh          # copy shared/tasks/<scenario>/<task>/* into the task's hook dirs
./shared/tasks/scripts/sync.sh --check  # CI: verify the hook-dir copies match canonical
```

## Contributing

We welcome new tasks, batches of tasks, and scenarios. The contribution flow is
Propose → Build → Review:

1. **Propose** your task idea by opening a [New Task Proposal](../../issues/new?template=new-task-proposal.md) issue.
2. **Build** the task after a maintainer reviews your proposal. If you prefer to contribute only
   the idea, the aws-bench team or another contributor can take care of the implementation. See
   [CONTRIBUTING.md](CONTRIBUTING.md) for a step-by-step guide, task quality guidelines, and
   examples of tasks that are too easy versus genuinely challenging.
3. **Review** — every task PR receives maintainer review before it can be merged.

## Citing aws-bench

A BibTeX citation will be added when the technical report is published.

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
