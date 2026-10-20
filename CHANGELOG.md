# Changelog

## [1.0.0](https://github.com/aws-bench/aws-bench-datasets/compare/v0.7.0...v1.0.0) (2026-10-20)


### Features

* **ec2-multiregion:** ec2-multiregion oracle solutions ([#13](https://github.com/aws-bench/aws-bench-datasets/issues/13)) ([630fef3](https://github.com/aws-bench/aws-bench-datasets/commit/630fef3f02fe853f82d715dbd4cfa574cd4c87a5))
* **judge:** decomposed per-claim rubrics for all 99 introspection tasks ([#68](https://github.com/aws-bench/aws-bench-datasets/issues/68)) ([75ad8f7](https://github.com/aws-bench/aws-bench-datasets/commit/75ad8f72a742eda3972ad6a3299c6c4efb74c395))
* Merge integration-testing into main ([#72](https://github.com/aws-bench/aws-bench-datasets/issues/72)) ([a45996f](https://github.com/aws-bench/aws-bench-datasets/commit/a45996f548e588d1a6c4c2faeeeaac1b177e83fe))
* **oracle:** solutions for api-and-observability ([#19](https://github.com/aws-bench/aws-bench-datasets/issues/19)) ([a9dc62e](https://github.com/aws-bench/aws-bench-datasets/commit/a9dc62e299c3ca034d586fd26c5461a1fd261309))
* **oracle:** solutions for databases-and-storage ([#21](https://github.com/aws-bench/aws-bench-datasets/issues/21)) ([269df70](https://github.com/aws-bench/aws-bench-datasets/commit/269df7044f07a5b5de0c0462ec8e7a36b7e0681d))
* **oracle:** solutions for reference-architectures ([#14](https://github.com/aws-bench/aws-bench-datasets/issues/14)) ([5267efc](https://github.com/aws-bench/aws-bench-datasets/commit/5267efc0041c19b46ab3b9ac27f4e886c8b012df))
* **oracle:** solutions for serverless-apps ([#16](https://github.com/aws-bench/aws-bench-datasets/issues/16)) ([90ce537](https://github.com/aws-bench/aws-bench-datasets/commit/90ce537aaf8f8456f7aad1281e1fca4cd6e71403))
* **oracle:** solutions for troubleshooting-multiservice ([#26](https://github.com/aws-bench/aws-bench-datasets/issues/26)) ([2bff693](https://github.com/aws-bench/aws-bench-datasets/commit/2bff693fb1f6cf45ceb9798815476cc21c476446))


### Bug Fixes

* **ci:** send PR notifications for fork PRs ([#83](https://github.com/aws-bench/aws-bench-datasets/issues/83)) ([dda79c6](https://github.com/aws-bench/aws-bench-datasets/commit/dda79c6d9412198e01855e13c46d2259c7041cc7))
* **judge:** repair four over-strict per-claim criteria in two tasks ([#78](https://github.com/aws-bench/aws-bench-datasets/issues/78)) ([c0f0845](https://github.com/aws-bench/aws-bench-datasets/commit/c0f0845cd91256bb834bd4ab97b222c4c2ebadd2))
* **judge:** replace wrong placeholder value in glue-job-wrong-deployment-region judge + add matching lint checker ([#74](https://github.com/aws-bench/aws-bench-datasets/issues/74)) ([820f80d](https://github.com/aws-bench/aws-bench-datasets/commit/820f80d86adcda2d833d155ad98b5ad1c8d3e4c8))
* **reset:** wire CLUSTER_NAME into streaming-and-iot reset hooks ([#64](https://github.com/aws-bench/aws-bench-datasets/issues/64)) ([c3f54ab](https://github.com/aws-bench/aws-bench-datasets/commit/c3f54ab8022f21dfe5b0898d77b1a6eb07e36294))
* **scenarios:** drop explicit S3VectorsReadOnlyAccess policy name in AppRolesStack ([#75](https://github.com/aws-bench/aws-bench-datasets/issues/75)) ([#76](https://github.com/aws-bench/aws-bench-datasets/issues/76)) ([b1b2225](https://github.com/aws-bench/aws-bench-datasets/commit/b1b22256aedd2651d40214764bd17ac13e315d9b))
* **streaming-and-iot:** bump MSK Kafka version 3.6.0 -&gt; 3.9.x ([#79](https://github.com/aws-bench/aws-bench-datasets/issues/79)) ([a001c48](https://github.com/aws-bench/aws-bench-datasets/commit/a001c48c9f0c9ba3761633c8e90f0a14ac171c45))
* **tasks:** port ground-truth/config fixes to main ([#28](https://github.com/aws-bench/aws-bench-datasets/issues/28)-[#31](https://github.com/aws-bench/aws-bench-datasets/issues/31)) ([#40](https://github.com/aws-bench/aws-bench-datasets/issues/40)) ([aafc9db](https://github.com/aws-bench/aws-bench-datasets/commit/aafc9db61a67c30f42043d07472d4b933abca965))
* **tasks:** remove duplicate AWS_REGION keys ([#42](https://github.com/aws-bench/aws-bench-datasets/issues/42)) ([80f5dd3](https://github.com/aws-bench/aws-bench-datasets/commit/80f5dd36e9746f4ee0294545799937ba7bfb6238))
* **verifier:** call system rewardkit instead of uvx ([#62](https://github.com/aws-bench/aws-bench-datasets/issues/62)) ([2accd28](https://github.com/aws-bench/aws-bench-datasets/commit/2accd28646cf6844b04e769667493dd3079ec0f6))
* **verifier:** cap litellm below 1.106 in task images ([#82](https://github.com/aws-bench/aws-bench-datasets/issues/82)) ([968b207](https://github.com/aws-bench/aws-bench-datasets/commit/968b207422a2004c44b85b041d612952286b006e))
* **verifier:** ensure check.py uses correct region scoping ([#15](https://github.com/aws-bench/aws-bench-datasets/issues/15)) ([42cc575](https://github.com/aws-bench/aws-bench-datasets/commit/42cc57547b774dbd9a2780d5d3d3bd9e64b71e2e))
* **verifier:** retry rewardkit judge call on transient Bedrock errors ([#27](https://github.com/aws-bench/aws-bench-datasets/issues/27)) ([96b101f](https://github.com/aws-bench/aws-bench-datasets/commit/96b101fa1de0890f94e9ec7aea38c7b64ed49136))


### Refactoring

* migrate compute-and-data + streaming-and-iot to AWS_REGION ([#20](https://github.com/aws-bench/aws-bench-datasets/issues/20)) ([7214635](https://github.com/aws-bench/aws-bench-datasets/commit/7214635d5616d6875d9dba19fb0f815155ca4fac))

## v0.7.0 (2026-07-24)

### Features

- **ci**: harden Slack notification workflows against script injection (#10)
- **ci**: run make check as a Github Action (#9)
- **dependabot**: add Dependabot Github Action (#8)

### Bug Fixes

- **api-and-observability**: enforce TLS 1.2 minimum in apigateway setup script (#12)
- explicitly set to no permissions (#11)
- **package.json**: Adding override for handlebars 4.7.9 (#3)
