# Contributing to aws-bench-datasets

Welcome! We're excited that you're interested in contributing to aws-bench-datasets.

**Why contribute?**

1. **Make AI agents better at AWS.** Frontier labs optimize for what benchmarks measure. By contributing realistic, challenging AWS tasks, you directly push agent providers to improve on the operational problems that matter in your domain.
2. **Gain experience in agentic evaluation.** Get hands-on experience designing rigorous evaluations for frontier AI agents—and see firsthand where today's best models succeed, struggle, and fail on real AWS workflows.
3. **Contribute to a citable benchmark.** Accepted tasks become part of a published benchmark and dataset, giving you a concrete research contribution that can be cited and used by the broader AI and AWS communities (see [Citing aws-bench](README.md#citing-aws-bench)).

This guide walks you through proposing, building, and submitting a task, batch of tasks, or
scenario to aws-bench. For how to run the benchmark itself, see the [aws-bench framework](https://github.com/aws-bench/aws-bench).

## Ways to contribute

- **Single task** — one new task (`tasks/<scenario-id>/<task-name>/`) paired with a new scenario.
  Pick a task type: **read-only** (introspection — a diagnosis judged by an LLM against
  `tests/ground_truth.json`) or **read-write** (mutation — creates/modifies resources, verified
  programmatically by `tests/check.py` against live AWS state).
- **Batch of tasks** — several related tasks in one proposal/PR against the same new scenario, e.g.
  an introspection and a mutation task. Each task still gets its own `task.toml`/`tests/` and its
  own review.
- **Scenario-only** — a new containerized AWS environment (`scenarios/<scenario-id>/`, with
  `scenario.toml`, `deploy/deploy.sh`, and a self-contained CDK app under `scenario/cdk_app/`) with
  no task yet. Useful when you have an environment worth adding but haven't nailed down which
  task(s) should run against it — someone else (or you, later) can build those on top.

## Task Guidelines

Read this before proposing or building a task. Browse [existing tasks](tasks/) for concrete examples.

### Task Difficulty

Tasks should extend beyond the current frontier of agent capability: frontier agents should fail reliably due to genuine gaps in AWS reasoning, not incidental errors. Difficulty should arise from substantive reasoning challenges — not unnecessary steps, resource sprawl, or arbitrary complexity. Avoid selecting tasks solely because current models fail them; such tasks often expose transient model quirks rather than durable gaps in AWS reasoning.

Instructions and verifiers need not be complex to produce a challenging task. Strategies that tend to create genuine difficulty include:

- Longer-horizon dependencies: Cascading failures where a misconfiguration in one service silently breaks dependent services several steps downstream.
- Rich, realistic environments: Multiple interacting services and realistic seeded state, rather than isolated resources.
- Specialized AWS expertise: Non-obvious service limits, defaults, behaviors, or cross-service interactions that require genuine domain knowledge.
- Real operational provenance: Tasks derived from authentic AWS workflows, rather than constructed around a known specific model weakness.

In the proposal, provide an honest estimate of required expert time and frontier agent pass rate, supported by evidence where available: for example, results from comparable tasks, including observed failure modes and their underlying causes. (see "Task Complexity" in the [proposal template](.github/ISSUE_TEMPLATE/new-task-proposal.md)).

### Task Diversity

We target breadth across AWS services, scenarios, and ways of working with them, so a wide range of
proposals is welcome. Each task is tagged in `task.toml`'s `[metadata]` along a taxonomy of a few
independent axes. Check existing tasks under `tasks/<scenario-id>/` to see where coverage already exists before proposing:

| Field | Values | Meaning |
|---|---|---|
| `request_type` | `introspection`, `mutation` | read-only diagnosis vs. create/modify resources |
| `intent` | `Discovery`, `Diagnosis`, `Configuration`, `Provisioning`, `Remediation` | what the agent is trying to accomplish |
| `complexity` | `Atomic`, `Sequential`, `Orchestrated` | one call vs. a chain of dependent calls vs. coordinating multiple resources/services |
| `layer` | `ControlPlane`, `DataPlane`, `CrossPlane` | AWS API calls vs. reading/writing actual data vs. spanning both |

Any realistic, valuable, and challenging AWS task that can be accomplished through the AWS CLI/SDK
and verified programmatically or by an LLM judge is worth exploring — this taxonomy is a lens for
spotting gaps, not a gate.

We don't hold contributions to fixed quotas per category or AWS service, and we may rebalance the
final task distribution for broad coverage. Lean into the scenarios and AWS services you know
best — even a couple of very high quality, challenging tasks in an underused category or service
is a meaningful contribution.

### Task Quality

A high quality aws-bench task is:

- Realistic: Grounded in a genuine AWS operational workflow, not a toy or contrived exercise.
- Challenging: Requires substantial multi-service reasoning rather than tedious work or obscure facts; frontier models should fail regularly, with typical proposals targeting ~20–35% pass rates.
- Verifiable: Defines a clear goal with a robust verifier that passes if and only if the requested outcome is achieved.
- Unambiguous: Has a single, precise interpretation; resource references are uniquely identifiable, and the task cannot be satisfied through a broader or unintended interpretation.
- Non-guessable: Requires inspecting and reasoning about the AWS environment; the description does not reveal the fault, solution, or verifier-specific values.

### Examples

**Too easy (reject):** *"How many old S3 buckets are there in this account?"*

- **Scenario:** the scenario deploys about a dozen S3 buckets as ordinary
  baseline infrastructure — nothing injected, nothing to uncover.
- **Solution:** one `list-buckets` call, then count the array — but "old" is never defined, so the
  count depends entirely on which cutoff you happen to assume.
- **Pass rate:** not meaningfully measurable — different graders (or an LLM judge run twice) would
  accept different counts depending on their own idea of "old," so there's no stable target to
  measure a pass rate against.
- **Unambiguous:** no — "old" has no defined threshold. A day, a week, and a year are all reasonable
  readings and each produces a different correct answer, so there's no single verifiable target.
- **Diversity:** `introspection` / `Discovery` / `Atomic` / `ControlPlane` — the same classification
  as the real task below, but missing the one precise threshold that would make grading well-defined.

**Genuinely hard (accept):** *"Why is my Lambda function not reading the updated AppConfig value after a new deployment?"*

- **Scenario**: The environment deploys a Lambda function, an AppConfig application/environment/configuration profile, and an execution role with the required AppConfig permissions. The Lambda's environment variables, however, contain the CloudFormation logical IDs rather than the deployed AppConfig resources' actual names.
- **Solution**: The agent must inspect the Lambda configuration, identify the AppConfig resources in the live environment, and trace the resulting mismatch. AppConfig requests using the logical IDs return `ResourceNotFoundException`; the function handles the failure by retaining its previous value. Lambda deployment health and IAM permissions are both correct, so ruling them out is part of the diagnosis.
- **Pass rate**: Estimated at ~20–35% for frontier agents, based on comparable tasks. Common failures include stopping after confirming healthy IAM and deployment status, or applying plausible but irrelevant fixes such as adding the AppConfig Lambda extension.
- **Unambiguous**: The task identifies a single Lambda function and establishes a single intended failure in its configuration path. The diagnosis requires determining why the function cannot resolve the deployed AppConfig resources rather than guessing from the symptom.
- **Diversity**: `introspection` / `Diagnosis` / `Orchestrated` / `ControlPlane`, spanning Lambda, AppConfig, and IAM. The root cause is only apparent after cross-referencing configuration and state across all three services.

## Process

1. **Propose.** Open a [New Task Proposal](../../issues/new?template=new-task-proposal.md) issue.
   Describe the task, environment, evaluation strategy, and an estimated complexity/pass-rate —
   see the template for guidance and examples for each field. In the "Contributor Acknowledgement"
   section, confirm whether you intend to implement it yourself or would rather leave the build to the
   aws-bench team (or another contributor) — either is a welcome contribution.
2. **Get feedback.** Wait for a maintainer to weigh in before you start implementing. This
   avoids wasted effort on proposals that overlap existing tasks, need a different evaluation
   approach, or aren't a good fit for the benchmark.
3. **Implement, if you're building it.** If you'd rather hand the build off, you're done here — an
   accepted proposal is a complete contribution on its own, and a maintainer or another contributor
   may pick it up later. If you're building it yourself, once the proposal looks good, build it
   following the repository and task contracts in [AGENTS.md](AGENTS.md) and the layout described
   in [README.md](README.md#structure). Keep the safety rules in [AGENTS.md](AGENTS.md#safety) in
   mind — only run deployment, reset, cleanup, or live verification against an explicitly approved
   disposable AWS test account, never anything that could be production, and don't commit
   confidential or company-internal material.
4. **Validate.** Run the repository checks before opening a PR:
   ```bash
   make ready     # auto-fix formatting, then run the full gate
   ```
   Also run the sync/drift checks relevant to what you changed (see
   [README.md](README.md#running-tests) and [AGENTS.md](AGENTS.md#validation)).
5. **Submit a PR.** Include in the PR description:
   - [ ] Link to the approved proposal issue
   - [ ] `make ready` (or `make check`) passes locally
   - [ ] Relevant sync/drift checks pass, if you touched shared judge/task-helper files
   - [ ] Task type (introspection vs. mutation) is consistent across the instruction, agent role,
     and verifier
   - [ ] No confidential, company-internal, or customer data (see [AGENTS.md](AGENTS.md#publishing-hygiene))

   CI runs `make check` on every pull request.
6. **Review.** A maintainer reviews the PR and may ask for changes before merging.

## Questions and bugs

- General questions: use [Discussions Q&A](../../discussions/categories/q-a).
- Bugs: open a [Bug Report](../../issues/new?template=bug_report.yml).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
