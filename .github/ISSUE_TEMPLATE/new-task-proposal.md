---
name: New Task Proposal
about: This issue template is used to propose tasks for the aws-bench benchmark.
title: ''
labels: ''
assignees: ''

---

## Task title

> Short, descriptive title of the contribution

> Example: *Diagnose why a Lambda function keeps reading a stale AppConfig value after a new deployment*

## Task Description

> What does the agent need to accomplish? Describe the goal, the starting state, and what "done" looks like from the agent's perspective.

> Example: *A Lambda function reads configuration from AWS AppConfig using the AWS AppConfig Agent and environment variables. After a new AppConfig deployment, it still returns the old value. The agent must investigate the Lambda configuration, IAM permissions, AppConfig resources, and Agent setup to identify the cause. Done: the agent reports the specific resource or setting responsible and a fix that restores the function to reading the current configuration — without the instruction hinting at which part of the chain is at fault.*

## Contribution type: 
- [ ] Single task
- [ ] Batch of tasks
- [ ] Scenario-only contribution

> If the contribution type is **Single task** or **Batch of tasks**, select all applicable task types:

- [ ] Read-only (introspection)
- [ ] Read-write (mutation)

## Environment Details

> What environment details are needed to execute this task? Include the AWS services/resources, relevant code or IaC, and any existing PR/branch that provides the required setup.

> Example: *New troubleshooting scenario (see PR: `<link>`). The CDK app provisions a Lambda function with the AWS AppConfig Agent attached, an AppConfig application/environment/configuration profile, and a Lambda execution role with the permissions needed to access AppConfig. It then deploys a configuration to the AppConfig environment. A post-deploy step deliberately breaks one link in that chain to establish the faulty starting state, leaving the rest of the configuration correct.*

## Proposed Evaluation Strategy

> How would you verify successful task completion? Briefly describe the expected outcome and whether it can be objectively and programmatically verified.

> Example: *An LLM judge grades the agent's identified root cause and proposed fix against a rubric derived from the injected misconfiguration and the environment's actual deployed state.*

## Task Complexity

> How challenging is this task for a frontier AI agent? Briefly describe the conceptual difficulty, estimated time for a domain expert to complete it, and the estimated pass rate for frontier agents.

> Example: *High — requires cross-referencing Lambda configuration, IAM permissions, AppConfig resources, and the Agent setup to isolate the one broken link among several healthy ones. ~20-30 min for an expert; ~20-35% estimated frontier-agent pass rate.*

## References & Resources (optional)

> Links to relevant papers, repositories, documentation, or protocols that this task is based on or that provide useful context.

## Author Information

- **Name:**
- **Affiliation (if any):**

## Contributor Acknowledgement

> Upon acceptance, contributors are welcome to implement the proposed task or scenario and submit a PR for review. 

- [ ] I intend to implement this proposal and submit a PR.
- [ ] Implementation is already available in a PR / branch: <link>
- [ ] I confirm that this task/scenario does not contain any confidential, sensitive, or proprietary information.
