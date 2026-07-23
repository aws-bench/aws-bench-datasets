Expand my Elasticsearch CloudFormation template stored in S3 bucket {{compute-and-data-s3-dz8q7r549-us-east-1-BucketName}} by creating a new template that adds multi-region and multi-stage support:

- Multi-stage: add a `Stage` parameter (allowed values `alpha`, `beta`, and `gamma`) and a `StageConfig` mapping with an entry per stage, and have the domain select its configuration from `StageConfig` based on the chosen stage instead of hardcoding one.
- Multi-region: add a `RegionMap` mapping keyed by region with entries for at least `us-east-1` and `us-west-2`, and have the domain derive its region-specific values from `RegionMap`.

Upload the enhanced template back to the same bucket.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:
```json
{"template_key": "<s3 key of new template>"}
```
