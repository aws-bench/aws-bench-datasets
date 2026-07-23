import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: s3_dz8q7r549
 *
 * The stack creates the following resources:
 *
 * 1. 1 S3 bucket for storing CloudFormation template
 * 2. 1 S3 deployment for inline Elasticsearch YAML template
 *
 */

export class s3_dz8q7r549 extends cdk.Stack {
    private readonly accountId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        this.accountId = this.account;

        // S3 bucket for storing the CloudFormation template with security configurations
        const templateBucket = new s3.Bucket(this, 'TemplateBucket', {
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });
        templateBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Deploy inline CloudFormation template for Elasticsearch with SAML federation
        new s3deploy.BucketDeployment(this, 'DeployTemplate', {
            sources: [
                s3deploy.Source.data(
                    'elasticsearch-template.yaml', // Template filename in S3
                    `AWSTemplateFormatVersion: '2010-09-09'
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
      DomainName: !Sub '\${DomainName}-alpha'
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
                - !Sub 'arn:aws:iam::\${StageConfig.alpha.LambdaAccount1}:root'
                - !Sub 'arn:aws:iam::\${StageConfig.alpha.LambdaAccount2}:root'
            Action: 'es:*'
            Resource: !Sub 'arn:aws:es:\${AWS::Region}:\${AWS::AccountId}:domain/\${DomainName}-alpha/*'

Outputs:
  DomainEndpoint:
    Value: !GetAtt ElasticsearchDomain.DomainEndpoint
  KibanaEndpoint:
    Value: !Sub 'https://\${ElasticsearchDomain.DomainEndpoint}/_plugin/kibana/'
  DomainArn:
    Value: !GetAtt ElasticsearchDomain.Arn
  Stage:
    Value: alpha
`,
                ),
            ],
            destinationBucket: templateBucket, // Deploy template to the created bucket
        });

        // Output the S3 bucket name containing the CloudFormation template
        StackUtils.exportStack(this, 'BucketName', templateBucket.bucketName);
    }
}
