I need to invalidate the cache for my CloudFront distribution. My Distribution Domain Name is {{compute-and-data-cloudfront-492sidmdo-us-east-1-DistributionDomainName}} and I need to clear the cache for all content (/*) because I've updated the website. Can you help me create the CloudFront invalidation?

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "InvalidationID": "<the invalidation ID returned by CloudFront>"
}
```
