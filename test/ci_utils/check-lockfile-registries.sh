#!/usr/bin/env bash
# Guard: scenario CDK lockfiles must resolve dependencies only from the public
# npm registry (https://registry.npmjs.org).
#
# Why: scenario container images build with a public base image and no registry
# credentials. If a package-lock.json pins a dependency's "resolved" URL to a
# private registry (e.g. an internal CodeArtifact mirror), `npm install` inside
# the container fails with "E401 Unable to authenticate" for anyone without a
# token for that registry — breaking the build in open-source / external and
# CI environments. Lockfiles generated on a machine configured against a private
# mirror capture those URLs, so this check fails the build before that happens.
#
# Fix when this fails: regenerate the offending lockfile against the public
# registry, e.g.
#   (cd <scenario>/scenario/cdk_app && npm install --package-lock-only \
#        --registry=https://registry.npmjs.org)
set -euo pipefail

allowed_prefix='https://registry.npmjs.org/'
fail=0

while IFS= read -r lf; do
  # Every "resolved" tarball URL must live on the public registry. Entries
  # without a "resolved" field (root/link deps) are ignored.
  offenders=$(grep -oE '"resolved": "https?://[^"]+"' "$lf" \
    | grep -vF "\"resolved\": \"${allowed_prefix}" || true)
  if [ -n "$offenders" ]; then
    echo "ERROR: non-public registry URL(s) in $lf:"
    printf '%s\n' "$offenders" | sed 's/^/  /'
    fail=1
  fi
done < <(find scenarios -name package-lock.json -not -path '*/node_modules/*' | sort)

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Scenario lockfiles must resolve dependencies only from ${allowed_prefix}."
  echo "Regenerate the offending cdk_app lockfile against the public registry:"
  echo "  (cd <scenario>/scenario/cdk_app && npm install --package-lock-only --registry=https://registry.npmjs.org)"
  exit 1
fi

echo "ok   all scenario lockfiles resolve from the public npm registry"
