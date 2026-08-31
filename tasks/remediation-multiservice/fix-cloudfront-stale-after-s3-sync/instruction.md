The marketing site that CloudFront serves from `{{remediation-multiservice-WebPlatform-uobyzx8z7-us-east-1-OriginBucketName}}` is still showing the previous release, even though the publish pipeline reported success. Investigate the account, find the root cause, and make changes so that the site serves the current build at the edge AND the next publish cannot repeat the same failure. Keep any change small. Do not weaken existing security controls and do not delete anything unrelated to the fault.

This distribution has more than one cache layer. Make sure your recurrence-prevention reaches every layer that could hold a stale copy — a per-path fix on the base edge alone will leave one of them unchanged.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.
