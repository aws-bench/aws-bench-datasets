#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
BUCKET="${BUCKET_NAME}"
TEMPLATE_KEY="${TEMPLATE_KEY:-elasticsearch-template-multi.yaml}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json
TMP="$(mktemp)"

cat > "$TMP" <<'YAML'
AWSTemplateFormatVersion: '2010-09-09'
Description: 'Elasticsearch with Kibana and SAML Federation - Multi-region and multi-stage'

Parameters:
  DomainName:
    Type: String
    Default: my-es-domain
  Stage:
    Type: String
    AllowedValues:
      - alpha
      - beta
      - gamma
    Default: alpha
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
    beta:
      InstanceType: t3.medium.elasticsearch
      InstanceCount: 3
      MasterInstanceType: t3.medium.elasticsearch
      MasterCount: 3
      VolumeSize: 200
    gamma:
      InstanceType: r6g.large.elasticsearch
      InstanceCount: 4
      MasterInstanceType: r6g.large.elasticsearch
      MasterCount: 3
      VolumeSize: 500
  RegionMap:
    us-east-1:
      LambdaAccount1: '111111111111'
      LambdaAccount2: '222222222222'
      AvailabilityZoneCount: 2
    us-west-2:
      LambdaAccount1: '333333333333'
      LambdaAccount2: '444444444444'
      AvailabilityZoneCount: 3

Resources:
  ElasticsearchDomain:
    Type: AWS::Elasticsearch::Domain
    Properties:
      DomainName: !Sub '${DomainName}-${Stage}'
      ElasticsearchVersion: '7.10'
      ElasticsearchClusterConfig:
        InstanceType: !FindInMap [StageConfig, !Ref Stage, InstanceType]
        InstanceCount: !FindInMap [StageConfig, !Ref Stage, InstanceCount]
        DedicatedMasterEnabled: true
        DedicatedMasterType: !FindInMap [StageConfig, !Ref Stage, MasterInstanceType]
        DedicatedMasterCount: !FindInMap [StageConfig, !Ref Stage, MasterCount]
        ZoneAwarenessEnabled: true
        ZoneAwarenessConfig:
          AvailabilityZoneCount: !FindInMap [RegionMap, !Ref 'AWS::Region', AvailabilityZoneCount]
      EBSOptions:
        EBSEnabled: true
        VolumeSize: !FindInMap [StageConfig, !Ref Stage, VolumeSize]
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
                - !Sub
                  - 'arn:aws:iam::${Acct}:root'
                  - Acct: !FindInMap [RegionMap, !Ref 'AWS::Region', LambdaAccount1]
                - !Sub
                  - 'arn:aws:iam::${Acct}:root'
                  - Acct: !FindInMap [RegionMap, !Ref 'AWS::Region', LambdaAccount2]
            Action: 'es:*'
            Resource: !Sub 'arn:aws:es:${AWS::Region}:${AWS::AccountId}:domain/${DomainName}-${Stage}/*'

Outputs:
  DomainEndpoint:
    Value: !GetAtt ElasticsearchDomain.DomainEndpoint
  KibanaEndpoint:
    Value: !Sub 'https://${ElasticsearchDomain.DomainEndpoint}/_plugin/kibana/'
  DomainArn:
    Value: !GetAtt ElasticsearchDomain.Arn
  Stage:
    Value: !Ref Stage
YAML

aws s3 cp "$TMP" "s3://${BUCKET}/${TEMPLATE_KEY}" --region "$REGION"
rm -f "$TMP"

mkdir -p "$(dirname "$OUT")"
printf '{"template_key": "%s"}\n' "$TEMPLATE_KEY" > "$OUT_JSON"
echo "Done." > "$OUT"
