"""Post-deploy seeding for the static site delivery scenario.

Creates:
  * two immutable releases of the marketing site in the build artifacts bucket
    (2024.11.02-a41c9d = previously published, 2025.06.18-f7b3e2 = current)
  * the ``releases/current/`` pointer copy that the publish pipeline consumes
  * the marketing origin bucket loaded with the *previously published* release
  * a pw-alpha portal release plus its already-in-sync origin bucket
  * a baseline snapshot of the marketing publisher role/function config used by
    the per-trial reset tooling

Uploading ``releases/current/manifest.json`` fires the real publish pipeline via
the S3 object-created notification, which is exactly how a production publish
happens.
"""

import hashlib
import json
import time
from typing import Optional

import boto3
from botocore.exceptions import ClientError

REGION = "us-east-1"
STACK_NAME = "remediation-multiservice-WebPlatform-uobyzx8z7-us-east-1"

PREV_BUILD = "2024.11.02-a41c9d"
CURRENT_BUILD = "2025.06.18-f7b3e2"

PW_ALPHA_PREV_BUILD = "2025.06.02-pwa003"
PW_ALPHA_BUILD = "2025.06.16-pwa004"

HTML_CACHE = "public, max-age=86400"
PW_ALPHA_CACHE = "public, max-age=3600"

MKTG_SYNC_MODE_INITIAL = "md5-len-only"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json",
    ".css": "text/css; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
}


# ---------------------------------------------------------------------------
# site content
# ---------------------------------------------------------------------------
def index_html(build_id: str, self_serve_trial: bool) -> bytes:
    """Marketing landing page.

    ``build_id`` values are the same length by convention and the two CTA
    strings are the same length, so two different builds of this page can have
    byte-identical sizes.
    """
    cta = "Start free trial" if self_serve_trial else "Book a live demo"
    href = "/sign-up" if self_serve_trial else "/demoreq"
    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '  <meta charset="utf-8">\n'
        '  <meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f'  <meta name="x-build-id" content="{build_id}">\n'
        "  <title>Northwind Analytics - Cloud Cost Intelligence</title>\n"
        '  <link rel="stylesheet" href="/assets/styles.css">\n'
        "</head>\n"
        "<body>\n"
        "  <header><h1>Northwind Analytics</h1></header>\n"
        "  <main>\n"
        '    <section id="hero">\n'
        "      <h2>See every dollar of cloud spend</h2>\n"
        "      <p>Real-time cost allocation across 40+ AWS services.</p>\n"
        f'      <a class="cta" href="{href}">{cta}</a>\n'
        "    </section>\n"
        '    <section id="pricing">\n'
        "      <h3>Plans</h3>\n"
        "      <ul><li>Team</li><li>Business</li><li>Enterprise</li></ul>\n"
        "    </section>\n"
        "  </main>\n"
        f"  <footer><small>build {build_id}</small></footer>\n"
        '  <script src="/assets/app.js"></script>\n'
        "</body>\n"
        "</html>\n"
    ).encode()


def config_json(build_id: str, self_serve_trial: bool) -> bytes:
    """Runtime config consumed by app.js.

    Flipping ``selfServeTrial`` off and ``usageForecast`` on keeps the byte
    length identical between builds.
    """
    return (
        "{\n"
        '  "apiBase": "https://api.northwind-analytics.example.com/v3",\n'
        f'  "build": "{build_id}",\n'
        '  "featureFlags": {\n'
        f'    "selfServeTrial": {"true" if self_serve_trial else "false"},\n'
        f'    "usageForecast": {"false" if self_serve_trial else "true"}\n'
        "  }\n"
        "}\n"
    ).encode()


APP_JS_BASE = """(function () {
  'use strict';
  var cfg = null;

  function loadConfig() {
    return fetch('/assets/config.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (c) { cfg = c; return c; });
  }

  function trackCta() {
    var cta = document.querySelector('a.cta');
    if (!cta) { return; }
    cta.addEventListener('click', function () {
      navigator.sendBeacon(cfg.apiBase + '/events', JSON.stringify({
        name: 'cta_click', build: cfg.build
      }));
    });
  }

  loadConfig().then(trackCta);
})();
"""

APP_JS_DEMO_ADDITION = """(function () {
  'use strict';
  var cfg = null;

  function loadConfig() {
    return fetch('/assets/config.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (c) { cfg = c; return c; });
  }

  function trackCta() {
    var cta = document.querySelector('a.cta');
    if (!cta) { return; }
    cta.addEventListener('click', function () {
      navigator.sendBeacon(cfg.apiBase + '/events', JSON.stringify({
        name: 'cta_click', build: cfg.build
      }));
    });
  }

  function mountDemoRequest() {
    if (!cfg.featureFlags || !cfg.featureFlags.usageForecast) { return; }
    var host = document.getElementById('hero');
    if (!host) { return; }
    var form = document.createElement('form');
    form.id = 'demoreq';
    form.action = cfg.apiBase + '/demo-requests';
    form.method = 'POST';
    form.innerHTML = '<input name="email" type="email" required>' +
                     '<button type="submit">Request demo</button>';
    host.appendChild(form);
  }

  loadConfig().then(trackCta).then(mountDemoRequest);
})();
"""

STYLES_CSS = """:root { --ink: #14213d; --accent: #0b7285; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; color: var(--ink); }
header { padding: 24px 32px; border-bottom: 1px solid #e9ecef; }
main { max-width: 880px; margin: 0 auto; padding: 32px; }
a.cta { display: inline-block; padding: 12px 20px; border-radius: 6px;
        background: var(--accent); color: #fff; text-decoration: none; }
#pricing ul { list-style: none; padding: 0; display: flex; gap: 16px; }
footer { padding: 24px 32px; color: #868e96; }
"""

ROBOTS_TXT = """User-agent: *
Allow: /
Disallow: /demoreq
Sitemap: https://www.northwind-analytics.example.com/sitemap.xml
"""


def sitemap_xml(build_id: str, self_serve_trial: bool) -> bytes:
    """Sitemap. Both variants use 6-character `changefreq` values and 4-character
    `priority` values, so the two builds produce byte-identical files.
    """
    freq_home = "hourly" if self_serve_trial else "weekly"
    freq_docs = "weekly" if self_serve_trial else "hourly"
    priority_home = "0.90" if self_serve_trial else "0.80"
    priority_docs = "0.80" if self_serve_trial else "0.90"
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        "  <url>\n"
        "    <loc>https://www.northwind-analytics.example.com/</loc>\n"
        f"    <changefreq>{freq_home}</changefreq>\n"
        f"    <priority>{priority_home}</priority>\n"
        "  </url>\n"
        "  <url>\n"
        "    <loc>https://www.northwind-analytics.example.com/docs</loc>\n"
        f"    <changefreq>{freq_docs}</changefreq>\n"
        f"    <priority>{priority_docs}</priority>\n"
        "  </url>\n"
        "</urlset>\n"
    ).encode()


PW_ALPHA_INDEX = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Northwind Preview Workspace</title>
<link rel="stylesheet" href="/assets/portal.css"></head>
<body>
  <h1>Northwind Preview Workspace</h1>
  <ul>
    <li><a href="/panels/onboarding.html">Onboarding</a></li>
    <li><a href="/panels/allocation.html">Allocation tags</a></li>
  </ul>
  <footer><small>pw-alpha build {build}</small></footer>
</body>
</html>
"""

PW_ALPHA_ONBOARDING = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Onboarding</title>
<link rel="stylesheet" href="/assets/portal.css"></head>
<body><h1>Onboarding</h1>
<ol><li>Create a read-only IAM role.</li><li>Enable Cost and Usage Reports.</li>
<li>Point Northwind at the CUR bucket.</li></ol>
<footer><small>pw-alpha build {build}</small></footer></body>
</html>
"""

PW_ALPHA_CSS = """body { font-family: Georgia, serif; max-width: 760px; margin: 40px auto; }
h1 { border-bottom: 2px solid #0b7285; padding-bottom: 8px; }
code { background: #f1f3f5; padding: 2px 4px; }
"""


def marketing_files(build_id: str, self_serve_trial: bool) -> "dict[str, bytes]":
    return {
        "index.html": index_html(build_id, self_serve_trial),
        "assets/app.js": (
            APP_JS_BASE if self_serve_trial else APP_JS_DEMO_ADDITION
        ).encode(),
        "assets/config.json": config_json(build_id, self_serve_trial),
        "assets/styles.css": STYLES_CSS.encode(),
        "robots.txt": ROBOTS_TXT.encode(),
        "sitemap.xml": sitemap_xml(build_id, self_serve_trial),
    }


def pw_alpha_files(build_id: str) -> "dict[str, bytes]":
    return {
        "index.html": PW_ALPHA_INDEX.format(build=build_id).encode(),
        "panels/onboarding.html": PW_ALPHA_ONBOARDING.format(build=build_id).encode(),
        "assets/portal.css": PW_ALPHA_CSS.encode(),
    }


def content_type(key: str) -> str:
    for ext, ctype in CONTENT_TYPES.items():
        if key.endswith(ext):
            return ctype
    return "binary/octet-stream"


def manifest_bytes(build_id: str, files: "dict[str, bytes]") -> bytes:
    return json.dumps(
        {
            "buildId": build_id,
            "releaseDate": build_id.split("-")[0],
            "files": [
                {
                    "key": key,
                    "bytes": len(body),
                    "md5": hashlib.md5(body).hexdigest(),
                }
                for key, body in sorted(files.items())
            ],
        },
        indent=2,
    ).encode()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def stack_outputs(session: boto3.Session, region: str) -> "dict[str, str]":
    cfn = session.client("cloudformation", region_name=region)
    stacks = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"]
    return {o["OutputKey"]: o["OutputValue"] for o in stacks[0].get("Outputs", [])}


def put_tree(
    s3, bucket: str, prefix: str, files: "dict[str, bytes]", cache: str
) -> None:
    """Upload every file, manifest last (the manifest is the pipeline trigger)."""
    for key, body in sorted(files.items()):
        s3.put_object(
            Bucket=bucket,
            Key=prefix + key,
            Body=body,
            ContentType=content_type(key),
            CacheControl=cache,
        )


def clear_prefix(s3, bucket: str, prefix: str = "") -> None:
    token = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        page = s3.list_objects_v2(**kwargs)
        keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        if keys:
            s3.delete_objects(Bucket=bucket, Delete={"Objects": keys})
        if not page.get("IsTruncated"):
            return
        token = page.get("NextContinuationToken")


def snapshot_publisher_baseline(
    session: boto3.Session, region: str, outputs: "dict[str, str]"
) -> None:
    iam = session.client("iam")
    lam = session.client("lambda", region_name=region)
    ssm = session.client("ssm", region_name=region)

    role_name = outputs["PublisherRoleName"]
    fn_name = outputs["PublisherFunctionName"]

    inline = {}
    for name in iam.list_role_policies(RoleName=role_name)["PolicyNames"]:
        doc = iam.get_role_policy(RoleName=role_name, PolicyName=name)["PolicyDocument"]
        inline[name] = doc
    attached = [
        p["PolicyArn"]
        for p in iam.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]
    ]
    env = (
        lam.get_function_configuration(FunctionName=fn_name)
        .get("Environment", {})
        .get("Variables", {})
    )

    sync_mode_param = outputs.get("MktgSyncModeParameterName", "")
    sync_mode_value = ""
    if sync_mode_param:
        try:
            sync_mode_value = ssm.get_parameter(Name=sync_mode_param)["Parameter"][
                "Value"
            ]
        except ClientError:
            sync_mode_value = ""

    snapshot = json.dumps(
        {
            "capturedAt": int(time.time()),
            "roleName": role_name,
            "functionName": fn_name,
            "inlinePolicies": inline,
            "attachedPolicies": attached,
            "environment": env,
            "syncModeParameter": sync_mode_param,
            "syncModeValue": sync_mode_value or MKTG_SYNC_MODE_INITIAL,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    if len(snapshot) > 4000:
        raise RuntimeError("baseline snapshot too large for a standard SSM parameter")

    ssm.put_parameter(
        Name=outputs["RoleBaselineParameterName"],
        Value=snapshot,
        Type="String",
        Overwrite=True,
    )
    print(
        f"captured publisher baseline ({len(snapshot)} bytes) for {role_name}/{fn_name}"
    )


def wait_for_publish(
    session: boto3.Session,
    region: str,
    log_group: str,
    started: float,
    pattern: str = '"publish complete"',
) -> None:
    """Wait until the pipeline logged ``pattern`` after ``started``."""
    lg = session.client("logs", region_name=region)
    deadline = time.time() + 300
    while time.time() < deadline:
        try:
            events = lg.filter_log_events(
                logGroupName=log_group,
                startTime=int(started * 1000),
                filterPattern=pattern,
                limit=5,
            ).get("events", [])
        except ClientError as err:
            if err.response["Error"]["Code"] != "ResourceNotFoundException":
                raise
            events = []
        if events:
            print("publish pipeline ran: " + events[0]["message"].strip())
            return
        time.sleep(10)
    raise RuntimeError(f"pattern {pattern} never logged in {log_group}")


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
def run(session: Optional[boto3.Session] = None, region: str = REGION, **kwargs):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    outputs = stack_outputs(session, region)
    s3 = session.client("s3", region_name=region)
    ssm = session.client("ssm", region_name=region)

    build_bucket = outputs["BuildArtifactsBucketName"]
    mktg_origin = outputs["OriginBucketName"]
    pw_alpha_origin = outputs["PwAlphaOriginBucketName"]
    source_prefix = outputs["SourcePrefix"]

    if outputs.get("MktgSyncModeParameterName"):
        ssm.put_parameter(
            Name=outputs["MktgSyncModeParameterName"],
            Value=MKTG_SYNC_MODE_INITIAL,
            Type="String",
            Overwrite=True,
        )

    prev_files = marketing_files(PREV_BUILD, self_serve_trial=True)
    cur_files = marketing_files(CURRENT_BUILD, self_serve_trial=False)

    # Guard the property the whole scenario depends on.
    for same_size in ("index.html", "assets/config.json", "sitemap.xml"):
        if len(prev_files[same_size]) != len(cur_files[same_size]):
            raise RuntimeError(
                f"{same_size} must have identical byte size across builds "
                f"({len(prev_files[same_size])} != {len(cur_files[same_size])})"
            )
        if prev_files[same_size] == cur_files[same_size]:
            raise RuntimeError(
                f"{same_size} must differ in content across builds "
                f"(otherwise there is nothing to drift)"
            )
    if len(prev_files["assets/app.js"]) == len(cur_files["assets/app.js"]):
        raise RuntimeError("assets/app.js must differ in size across builds")

    # --- immutable release history -------------------------------------
    for build_id, files in ((PREV_BUILD, prev_files), (CURRENT_BUILD, cur_files)):
        prefix = f"releases/{build_id}/"
        clear_prefix(s3, build_bucket, prefix)
        put_tree(s3, build_bucket, prefix, files, HTML_CACHE)
        s3.put_object(
            Bucket=build_bucket,
            Key=prefix + "manifest.json",
            Body=manifest_bytes(build_id, files),
            ContentType="application/json",
        )
        print(f"seeded release s3://{build_bucket}/{prefix}")

    # --- origin bucket reflects the previously published release --------
    clear_prefix(s3, mktg_origin)
    put_tree(s3, mktg_origin, "", prev_files, HTML_CACHE)
    print(f"loaded s3://{mktg_origin} with build {PREV_BUILD}")

    # --- pw-alpha pipeline ---------------------------------------------
    pw_alpha_prev = pw_alpha_files(PW_ALPHA_PREV_BUILD)
    pw_alpha_cur = pw_alpha_files(PW_ALPHA_BUILD)
    for build_id, files in (
        (PW_ALPHA_PREV_BUILD, pw_alpha_prev),
        (PW_ALPHA_BUILD, pw_alpha_cur),
    ):
        prefix = f"pw-alpha-releases/{build_id}/"
        clear_prefix(s3, build_bucket, prefix)
        put_tree(s3, build_bucket, prefix, files, PW_ALPHA_CACHE)
        s3.put_object(
            Bucket=build_bucket,
            Key=prefix + "manifest.json",
            Body=manifest_bytes(build_id, files),
            ContentType="application/json",
        )
    clear_prefix(s3, pw_alpha_origin)
    put_tree(s3, pw_alpha_origin, "", pw_alpha_prev, PW_ALPHA_CACHE)
    pw_alpha_started = time.time() - 5
    clear_prefix(s3, build_bucket, "pw-alpha-releases/current/")
    put_tree(
        s3, build_bucket, "pw-alpha-releases/current/", pw_alpha_cur, PW_ALPHA_CACHE
    )
    s3.put_object(
        Bucket=build_bucket,
        Key="pw-alpha-releases/current/manifest.json",
        Body=manifest_bytes(PW_ALPHA_BUILD, pw_alpha_cur),
        ContentType="application/json",
    )
    print(f"published pw-alpha build {PW_ALPHA_BUILD} over {PW_ALPHA_PREV_BUILD}")

    # --- baseline snapshot before anything mutates the pipeline ---------
    snapshot_publisher_baseline(session, region, outputs)

    # --- publish the current marketing build through the real pipeline --
    started = time.time() - 5
    clear_prefix(s3, build_bucket, source_prefix)
    put_tree(s3, build_bucket, source_prefix, cur_files, HTML_CACHE)
    s3.put_object(
        Bucket=build_bucket,
        Key=source_prefix + "manifest.json",
        Body=manifest_bytes(CURRENT_BUILD, cur_files),
        ContentType="application/json",
    )
    print(f"published pointer s3://{build_bucket}/{source_prefix} -> {CURRENT_BUILD}")
    wait_for_publish(session, region, outputs["PublisherLogGroupName"], started)

    # Also drive the pw-alpha portal pipeline.
    try:
        wait_for_publish(
            session,
            region,
            f"/aws/lambda/{outputs['PwAlphaPublisherFunctionName']}",
            pw_alpha_started,
            pattern='"publish complete"',
        )
    except RuntimeError as err:
        # pw-alpha may finish before the log group appears; do not fail setup on it.
        print(f"pw-alpha publish wait skipped: {err}")

    print("setup complete")


if __name__ == "__main__":
    run()
