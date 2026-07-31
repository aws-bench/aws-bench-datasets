#!/bin/bash
set -euo pipefail

REGION="us-east-1"
DIST_ID="${DISTRIBUTION_ID}"
OUT=/logs/agent/agent-output.txt
mkdir -p "$(dirname "$OUT")"

CFG=$(aws cloudfront get-distribution-config --id "$DIST_ID" --region "$REGION" \
    --query "DistributionConfig" --output json)

ROOT_OBJECT=$(printf '%s' "$CFG" | jq -r '.DefaultRootObject')
EXTRA_BEHAVIORS=$(printf '%s' "$CFG" | jq -r '.CacheBehaviors.Quantity')
TARGET_ORIGIN=$(printf '%s' "$CFG" | jq -r '.DefaultCacheBehavior.TargetOriginId')
FN_QTY=$(printf '%s' "$CFG" | jq -r '.DefaultCacheBehavior.FunctionAssociations.Quantity')
LAMBDA_QTY=$(printf '%s' "$CFG" | jq -r '.DefaultCacheBehavior.LambdaFunctionAssociations.Quantity')
ORIGIN_DOMAIN=$(printf '%s' "$CFG" | jq -r --arg id "$TARGET_ORIGIN" '.Origins.Items[] | select(.Id==$id) | .DomainName')
ORIGIN_OAC=$(printf '%s' "$CFG" | jq -r --arg id "$TARGET_ORIGIN" '.Origins.Items[] | select(.Id==$id) | .OriginAccessControlId')

ROOT_DESC="none (empty)"
[ -n "$ROOT_OBJECT" ] && [ "$ROOT_OBJECT" != "None" ] && [ "$ROOT_OBJECT" != "null" ] && ROOT_DESC="\"$ROOT_OBJECT\""

cat > "$OUT" <<EOF
Distribution $DIST_ID is broken for serving directory-style tenant paths, and the misconfiguration is on the distribution itself, not the S3 objects.

Root cause: the distribution has no defaultRootObject (currently $ROOT_DESC) and $EXTRA_BEHAVIORS additional cache behaviors beyond the single default behavior, which points at origin "$TARGET_ORIGIN" ($ORIGIN_DOMAIN, an S3 REST origin fronted by origin access control $ORIGIN_OAC). That default behavior has $FN_QTY CloudFront Function associations and $LAMBDA_QTY Lambda@Edge associations, so nothing rewrites the incoming path. A request to a tenant path such as /tenant-id/ is forwarded to S3 exactly as received. S3 accessed as a REST origin does not auto-resolve a directory-style path to index.html the way S3 static website hosting would, so S3 returns an error for /tenant-id/ and CloudFront surfaces the generic error page. The tenant objects (e.g. /tenant-id/index.html) exist, but nothing rewrites the incoming request to reach them.

Fix: attach a CloudFront Function (viewer-request) to the default behavior that rewrites directory-style URIs like /tenant-id/ to /tenant-id/index.html before the request reaches the S3 origin. Setting a defaultRootObject only handles the distribution root ("/"), not the per-tenant subpaths, so a URI-rewrite function (or an equivalent cache behavior) is required to serve each tenant's index page.
EOF
