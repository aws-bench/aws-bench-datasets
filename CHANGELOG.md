## Unreleased

### Feat

- Merge integration-testing into main (#72)
- **judge**: decomposed per-claim rubrics for all 99 introspection tasks (#68)
- **oracle**: solutions for troubleshooting-multiservice (#26)
- **oracle**: solutions for databases-and-storage (#21)
- **oracle**: solutions for serverless-apps (#16)
- **oracle**: solutions for api-and-observability (#19)
- **oracle**: solutions for reference-architectures (#14)
- **ec2-multiregion**: ec2-multiregion oracle solutions (#13)

### Fix

- **streaming-and-iot**: bump MSK Kafka version 3.6.0 -> 3.9.x (#79)
- **judge**: repair four over-strict per-claim criteria in two tasks (#78)
- **scenarios**: drop explicit S3VectorsReadOnlyAccess policy name in AppRolesStack (#75) (#76)
- **judge**: replace wrong placeholder value in glue-job-wrong-deployment-region judge + add matching lint checker (#74)
- **reset**: wire CLUSTER_NAME into streaming-and-iot reset hooks (#64)
- **verifier**: call system rewardkit instead of uvx (#62)
- **tasks**: remove duplicate AWS_REGION keys (#42)
- **tasks**: port ground-truth/config fixes to main (#28-#31) (#40)
- **verifier**: retry rewardkit judge call on transient Bedrock errors (#27)
- **verifier**: ensure check.py uses correct region scoping (#15)

### Refactor

- migrate compute-and-data + streaming-and-iot to AWS_REGION (#20)

## v0.7.0 (2026-07-24)

### Feat

- **ci**: harden Slack notification workflows against script injection (#10)
- **ci**: run make check as a Github Action (#9)
- **dependabot**: add Dependabot Github Action (#8)

### Fix

- **api-and-observability**: enforce TLS 1.2 minimum in apigateway setup script (#12)
- explicitly set to no permissions (#11)
- **package.json**: Adding override for handlebars 4.7.9 (#3)
