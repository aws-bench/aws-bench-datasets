"""Data-plane reset for expand-elasticsearch-cfn-template.

Restores the versioned template bucket to a single baseline object. The reset
removes all object versions and delete markers, then re-puts the object with its
Content-Type and Metadata preserved.
"""

import os

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET_NAME = os.environ.get("BUCKET_NAME", "")

# Baseline object. Content-Type is binary/octet-stream (S3's default for .yaml)
# and there is no custom metadata; both are re-applied on restore.
ELASTICSEARCH_TEMPLATE_KEY = "elasticsearch-template.yaml"
ELASTICSEARCH_TEMPLATE_BODY = """AWSTemplateFormatVersion: '2010-09-09'
Description: 'Elasticsearch with Kibana and SAML Federation - Initial Setup (us-east-1, alpha stage)'

Parameters:
  DomainName:
    Type: String
    Default: my-es-domain
  SAMLEntityId:
    Type: String
    Default: https://your-idp.example.com
  SAMLMetadataURL:
    Type: String
    Default: https://your-idp.example.com/metadata

Mappings:
  StageConfig:
    alpha:
      InstanceType: t3.small.elasticsearch
      InstanceCount: 2
      MasterInstanceType: t3.small.elasticsearch
      MasterCount: 3
      VolumeSize: 100
      LambdaAccount1: '111111111111'
      LambdaAccount2: '222222222222'

Resources:
  ElasticsearchDomain:
    Type: AWS::Elasticsearch::Domain
    Properties:
      DomainName: !Sub '${DomainName}-alpha'
      ElasticsearchVersion: '7.10'
      ElasticsearchClusterConfig:
        InstanceType: !FindInMap [StageConfig, alpha, InstanceType]
        InstanceCount: !FindInMap [StageConfig, alpha, InstanceCount]
        DedicatedMasterEnabled: true
        DedicatedMasterType: !FindInMap [StageConfig, alpha, MasterInstanceType]
        DedicatedMasterCount: !FindInMap [StageConfig, alpha, MasterCount]
        ZoneAwarenessEnabled: true
        ZoneAwarenessConfig:
          AvailabilityZoneCount: 2
      EBSOptions:
        EBSEnabled: true
        VolumeSize: !FindInMap [StageConfig, alpha, VolumeSize]
        VolumeType: gp3
      EncryptionAtRestOptions:
        Enabled: true
      NodeToNodeEncryptionOptions:
        Enabled: true
      DomainEndpointOptions:
        EnforceHTTPS: true
        TLSSecurityPolicy: Policy-Min-TLS-1-2-2019-07
      AdvancedSecurityOptions:
        Enabled: true
        InternalUserDatabaseEnabled: false
        SAMLOptions:
          Enabled: true
          Idp:
            EntityId: !Ref SAMLEntityId
            MetadataContent: !Ref SAMLMetadataURL
          RolesKey: Role
          SessionTimeoutMinutes: 60
      AccessPolicies:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS:
                - !Sub 'arn:aws:iam::${StageConfig.alpha.LambdaAccount1}:root'
                - !Sub 'arn:aws:iam::${StageConfig.alpha.LambdaAccount2}:root'
            Action: 'es:*'
            Resource: !Sub 'arn:aws:es:${AWS::Region}:${AWS::AccountId}:domain/${DomainName}-alpha/*'

Outputs:
  DomainEndpoint:
    Value: !GetAtt ElasticsearchDomain.DomainEndpoint
  KibanaEndpoint:
    Value: !Sub 'https://${ElasticsearchDomain.DomainEndpoint}/_plugin/kibana/'
  DomainArn:
    Value: !GetAtt ElasticsearchDomain.Arn
  Stage:
    Value: alpha
"""


def _empty(s3, bucket: str, errors: list[str]) -> None:
    """Delete every object version and delete marker in the versioned bucket."""
    try:
        paginator = s3.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket):
            to_delete = [
                {"Key": v["Key"], "VersionId": v["VersionId"]}
                for v in page.get("Versions", []) + page.get("DeleteMarkers", [])
            ]
            if to_delete:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete})
    except ClientError as e:
        errors.append(f"empty {bucket}: {e}")


def reset_data_plane(
    session: boto3.Session | None = None, region: str = REGION
) -> list[str]:
    """Empty the versioned bucket, then re-put the baseline template object.

    Returns a list of error strings (empty on success). Never raises.
    """
    if not BUCKET_NAME:
        return ["BUCKET_NAME env var not set"]
    if session is None:
        session = boto3.Session(region_name=region)
    s3 = session.client("s3", region_name=region)

    errors: list[str] = []
    _empty(s3, BUCKET_NAME, errors)

    # Restore the single baseline object with its Content-Type and Metadata.
    try:
        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=ELASTICSEARCH_TEMPLATE_KEY,
            Body=ELASTICSEARCH_TEMPLATE_BODY.encode("utf-8"),
            ContentType="binary/octet-stream",
            Metadata={},
        )
    except ClientError as e:
        errors.append(f"put_object {ELASTICSEARCH_TEMPLATE_KEY}: {e}")

    return errors
