A GitHub Actions job in the acme-corp organisation is failing at its AWS credential setup step and cannot deploy. The affected pipeline is blocked; other pipelines in the same organisation are still shipping normally. Investigate the account, find the root cause, and make changes so the failing pipeline federates and deploys again. Do not affect any other repository, widen the deploy role's blast radius, or break jobs that are currently working.

The failing runner is `{{remediation-multiservice-CicdOidc-a2ltm5dey-us-east-1-FailingProjectName}}`; the deploy role it targets is `{{remediation-multiservice-CicdOidc-a2ltm5dey-us-east-1-DeployRoleName}}`.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.
