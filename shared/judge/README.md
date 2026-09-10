# Shared rewardkit verifier files

Canonical copies of the files that every rewardkit-based introspection task ships in its `tests/` dir:

- `judge_prompt.md` — senior/junior rubric prompt template (rewardkit `prompt_template`).
- `judge.toml` — rewardkit `[judge]` + `[[criterion]]` config.
- `test.sh` — rewardkit invocation: resolves placeholders, then runs rewardkit.
- `resolve_placeholders.py` — substitutes `{{name}}` tokens in `ground_truth.json` in place, against env vars declared in `[verifier.env]` of `task.toml`.

Tasks copy these into their own `tests/` directory rather than symlinking, because Harbor's container `upload_dir` (via `docker compose cp`) does not follow relative symlinks pointing outside the upload root.

`scripts/sync.sh` also runs CI drift checks for **mutation tasks** (`tests/check.py`-based, no judge files) — see `--check-output-contract` below. Those tasks don't ship the four shared judge files, but they do reuse the same sync entry point.

**Customized tasks**: a task whose `judge.toml` no longer has the canonical `answers_equivalent` criterion has an intentionally per-claim rubric. `sync.sh` detects this and only syncs/checks `test.sh` and `resolve_placeholders.py` for such tasks — never `judge.toml`/`judge_prompt.md`.

## Propagating edits

```
./scripts/sync.sh                          # copy shared/ into every introspection task
./scripts/sync.sh --check                  # CI: verify shared files match across tasks
./scripts/sync.sh --check-instructions     # CI: verify instruction.md and ground_truth.json[instruction] agree
./scripts/sync.sh --check-placeholders     # CI: verify every {{name}} in ground_truth.json is declared in [verifier.env]
./scripts/sync.sh --check-output-contract  # CI: mutation tasks — verify the JSON schema in instruction.md's
                                           # `agent-output.json` fence matches AGENT_OUTPUT.get("KEY") consumers
                                           # in tests/check.py. Catches schema drift and undeclared/unused keys.
```

If `--check-placeholders` reports drift, run `python3 scripts/fix_verifier_env.py --apply` to extend each task's `[verifier.env]` with the missing keys (this assumes the placeholder names are CFN/SSM exports the framework already publishes — if not, the run will still fail loud at verifier time).

If `--check-output-contract` reports drift, edit either `instruction.md` (declare/remove a key in the JSON fence) or `tests/check.py` (add/remove a `REQUIRED_OUTPUT_KEYS` entry and matching `AGENT_OUTPUT.get(...)` consumer) so the two agree. There's no auto-fix for this one — the right choice is task-specific.

## Rewardkit's task-level mental model

Rewardkit treats each task's `tests/` directory as the verifier's universe. The judge LLM is shown the files declared in `[judge].files` and the rubric in `prompt_template` — that's it. There is no native mechanism to access the task's `instruction.md` (the prompt the agent sees), and `tests/` is the only directory Harbor uploads to the verifier container.

This is somewhat at odds with how an LLM-judge benchmark naturally wants to work, where the judge benefits from knowing *what was asked* in addition to seeing the agent's answer and the reference. The canonical rewardkit pattern (visible in [harbor's example tasks](https://github.com/harbor-framework/harbor/tree/main/examples/tasks)) is to push instruction-derived language into `[[criterion]].description` strings — making each criterion self-contained rather than passing the instruction separately.

We chose a different tradeoff: our `tests/ground_truth.json` carries `{instruction, expected_answer}`. The instruction is duplicated between `instruction.md` (agent's view) and `ground_truth.json` (judge's view). Drift is checked by `sync.sh --check-instructions`. This keeps the criterion description short and reusable across all 131 introspection tasks, while still giving the judge full task context.

If you're considering a different judge prompt or schema, it's worth iterating on `judge_prompt.md` first — the `[criteria]` block is the only thing rewardkit substitutes there, so it's free-form otherwise.
