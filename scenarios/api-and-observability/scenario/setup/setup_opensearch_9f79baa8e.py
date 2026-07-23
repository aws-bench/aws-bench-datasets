"""
Setup script for stack opensearch-9f79baa8e (api-and-observability).
1. Generates a self-signed TLS certificate and imports it into ACM
2. Creates an HTTPS:443 listener on the ALB pointing to the target group
3. Registers OpenSearch VPC endpoint IPs in the ALB target group
4. Sets the Cognito callback URL to the raw VPC endpoint (intentional misconfiguration)
"""

import os
import sys
import subprocess
import tempfile
import traceback
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

config = Config(connect_timeout=5, read_timeout=60)

REGION = "us-east-1"
STACK_NAME = "api-and-observability-opensearch-9f79baa8e-us-east-1"


def _get_stack_outputs(cfn) -> dict:
    outputs = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
    return {o["OutputKey"]: o["OutputValue"] for o in outputs}


def _ensure_acm_cert(session, region: str, alb_dns: str) -> str:
    """Import a self-signed cert into ACM if one doesn't already exist for this ALB."""
    acm = session.client("acm", config=config, region_name=region)

    # Check for existing cert tagged with our stack
    paginator = acm.get_paginator("list_certificates")
    for page in paginator.paginate():
        for cert_summary in page["CertificateSummaryList"]:
            try:
                tags_resp = acm.list_tags_for_certificate(
                    CertificateArn=cert_summary["CertificateArn"]
                )
                tags = {t["Key"]: t["Value"] for t in tags_resp.get("Tags", [])}
                if tags.get("basalt-stack") == STACK_NAME:
                    print(f"Found existing ACM cert: {cert_summary['CertificateArn']}")
                    return cert_summary["CertificateArn"]
            except ClientError as e:
                if e.response["Error"]["Code"] == "ResourceNotFoundException":
                    continue
                raise

    # Generate self-signed cert via openssl config file.
    # CN is limited to 64 chars so we use a short CN and put the full ALB
    # DNS in a SAN (required by OpenSearch custom endpoint validation and
    # needed for ALB FQDN requirement). Config-file approach works with
    # OpenSSL 1.0.2+ which lacks -addext.
    with tempfile.TemporaryDirectory() as tmpdir:
        key_path = os.path.join(tmpdir, "key.pem")
        cert_path = os.path.join(tmpdir, "cert.pem")
        conf_path = os.path.join(tmpdir, "openssl.cnf")
        with open(conf_path, "w") as f:
            f.write(
                "[req]\n"
                "distinguished_name = dn\n"
                "x509_extensions = v3\n"
                "prompt = no\n"
                "[dn]\n"
                "CN = basalt-alb.internal\n"
                "[v3]\n"
                f"subjectAltName = DNS:{alb_dns}\n"
            )
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-keyout",
                key_path,
                "-out",
                cert_path,
                "-days",
                "365",
                "-nodes",
                "-config",
                conf_path,
            ],
            check=True,
            capture_output=True,
        )
        with open(cert_path, "rb") as f:
            cert_body = f.read()
        with open(key_path, "rb") as f:
            private_key = f.read()

    resp = acm.import_certificate(
        Certificate=cert_body,
        PrivateKey=private_key,
        Tags=[{"Key": "basalt-stack", "Value": STACK_NAME}],
    )
    cert_arn = resp["CertificateArn"]
    print(f"Imported self-signed cert: {cert_arn}")
    return cert_arn


def _ensure_https_listener(elbv2, alb_arn: str, tg_arn: str, cert_arn: str):
    """Create HTTPS:443 listener if it doesn't already exist."""
    existing = elbv2.describe_listeners(LoadBalancerArn=alb_arn)["Listeners"]
    for listener in existing:
        if listener["Port"] == 443 and listener["Protocol"] == "HTTPS":
            print(f"HTTPS listener already exists: {listener['ListenerArn']}")
            return listener["ListenerArn"]

    resp = elbv2.create_listener(
        LoadBalancerArn=alb_arn,
        Protocol="HTTPS",
        Port=443,
        SslPolicy="ELBSecurityPolicy-TLS13-1-2-2021-06",
        Certificates=[{"CertificateArn": cert_arn}],
        DefaultActions=[{"Type": "forward", "TargetGroupArn": tg_arn}],
    )
    arn = resp["Listeners"][0]["ListenerArn"]
    print(f"Created HTTPS listener: {arn}")
    return arn


def _discover_endpoint_ips(ec2, domain_name: str) -> list[str]:
    """Discover the OpenSearch domain's node IPs via its VPC ENIs.

    VPC OpenSearch endpoints resolve through private DNS that the deploy
    container may not be able to reach, so we read the private IPs straight
    from the domain's elastic network interfaces instead of resolving DNS.
    OpenSearch tags each domain ENI with the description 'ES <domain-name>'.
    """
    enis = ec2.describe_network_interfaces(
        Filters=[
            {"Name": "description", "Values": [f"ES {domain_name}"]},
            {"Name": "status", "Values": ["in-use"]},
        ]
    )["NetworkInterfaces"]
    ips = sorted({eni["PrivateIpAddress"] for eni in enis})
    if not ips:
        raise RuntimeError(f"No in-use ENIs found for OpenSearch domain {domain_name}")
    return ips


def run(session: Optional[boto3.Session] = None, region: str = REGION, **parameters):
    if session is None:
        session = boto3.Session(profile_name="PRIMARY")

    try:
        cfn = session.client("cloudformation", config=config, region_name=region)
        outputs = _get_stack_outputs(cfn)

        alb_arn = outputs["AlbArn"]
        alb_dns = outputs["AlbDnsName"]
        tg_arn = outputs["TargetGroupArn"]
        user_pool_id = outputs["UserPoolId"]
        user_pool_client_id = outputs["UserPoolClientId"]
        opensearch_endpoint = outputs["OpenSearchDomainEndpoint"]
        opensearch_domain_name = outputs["OpenSearchDomainName"]

        # Step 1: self-signed cert + HTTPS listener
        cert_arn = _ensure_acm_cert(session, region, alb_dns)
        elbv2 = session.client("elbv2", config=config, region_name=region)
        _ensure_https_listener(elbv2, alb_arn, tg_arn, cert_arn)

        # Step 2: register OpenSearch VPC node IPs in the target group.
        # Discover IPs from the domain's ENIs (no DNS: the VPC endpoint's
        # private DNS is not resolvable from the deploy container).
        ec2 = session.client("ec2", config=config, region_name=region)
        ips = _discover_endpoint_ips(ec2, opensearch_domain_name)
        print(f"Discovered OpenSearch node IPs from ENIs: {ips}")

        existing = elbv2.describe_target_health(TargetGroupArn=tg_arn)
        old_targets = [
            {"Id": t["Target"]["Id"], "Port": t["Target"]["Port"]}
            for t in existing["TargetHealthDescriptions"]
        ]
        if old_targets:
            elbv2.deregister_targets(TargetGroupArn=tg_arn, Targets=old_targets)

        elbv2.register_targets(
            TargetGroupArn=tg_arn,
            Targets=[{"Id": ip, "Port": 443} for ip in ips],
        )
        print(f"Registered {len(ips)} targets in target group")

        # Step 3: set callback URL to the raw VPC endpoint (intentional bug)
        cognito = session.client("cognito-idp", config=config, region_name=region)
        current = cognito.describe_user_pool_client(
            UserPoolId=user_pool_id,
            ClientId=user_pool_client_id,
        )["UserPoolClient"]

        wrong_callback_url = f"https://{opensearch_endpoint}/_dashboards/app/home"

        cognito.update_user_pool_client(
            UserPoolId=user_pool_id,
            ClientId=user_pool_client_id,
            AllowedOAuthFlows=current.get("AllowedOAuthFlows", []),
            AllowedOAuthScopes=current.get("AllowedOAuthScopes", []),
            AllowedOAuthFlowsUserPoolClient=current.get(
                "AllowedOAuthFlowsUserPoolClient", True
            ),
            SupportedIdentityProviders=current.get(
                "SupportedIdentityProviders", ["COGNITO"]
            ),
            CallbackURLs=[wrong_callback_url],
            LogoutURLs=current.get("LogoutURLs", []),
            RefreshTokenValidity=current.get("RefreshTokenValidity", 30),
        )
        print(f"Set callback URL to VPC endpoint: {wrong_callback_url}")

    except Exception:
        traceback.print_exc()
        return {"success": False, "output_values": None}

    return {"success": True, "output_values": None}


if __name__ == "__main__":
    result = run()
    print(result)
    raise SystemExit(0 if result["success"] else 1)
