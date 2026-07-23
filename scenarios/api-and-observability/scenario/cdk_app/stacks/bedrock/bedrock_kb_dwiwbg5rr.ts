import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: bedrock-kb-dwiwbg5rr
 *
 * d708bf7d-96a5-4044-8d96-08d82d5ab29e
 *
 * What the stack does:
 * 1. Creates two S3 vector buckets + vector indexes (one per KB)
 * 2. Creates two S3 data source buckets with seed documents
 * 3. Creates an IAM role for Bedrock KB access
 * 4. Creates two real Bedrock Knowledge Bases (metadata + escalation)
 * 5. Stores KB IDs in SSM under /flint/beta/kb/
 * 6. Exports KB IDs for cross-stack reference by the agent stack
 */

const EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIMENSIONS = 1024;

export class BedrockKB_dwiwbg5rr extends cdk.Stack {
    public readonly escalationKbId: string;
    public readonly metadataKbId: string;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // --- S3 data source buckets ---
        const metadataDataBucket = new s3.Bucket(this, 'MetadataDataBucket', {
            bucketName: `flint-kb-metadata-data-${this.account}-${this.region}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        const escalationDataBucket = new s3.Bucket(this, 'EscalationDataBucket', {
            bucketName: `flint-kb-escalation-data-${this.account}-${this.region}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant each bucket
        // policy gives its exact role ARN. If that grant is stale or gone at
        // delete time, the handler fails its first call (s3:GetBucketTagging)
        // with AccessDenied, the stack delete force-abandons these FIXED-NAME
        // buckets, and every later deploy fails changeset validation with
        // "already exists" — an unrecoverable reset->redeploy loop. Granting
        // the role directly removes the dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                metadataDataBucket.bucketArn,
                `${metadataDataBucket.bucketArn}/*`,
                escalationDataBucket.bucketArn,
                `${escalationDataBucket.bucketArn}/*`,
            ],
        });

        // Seed documents so data sources are non-empty
        new cr.AwsCustomResource(this, 'SeedMetadataDoc', {
            onCreate: {
                service: 'S3',
                action: 'putObject',
                parameters: {
                    Bucket: metadataDataBucket.bucketName,
                    Key: 'metadata.txt',
                    Body: 'Flint metadata knowledge base: business contexts, terminologies, data structures for metric analysis and order processing.',
                    ContentType: 'text/plain',
                },
                physicalResourceId: cr.PhysicalResourceId.of('SeedMetadataDoc'),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [metadataDataBucket.bucketArn + '/*'] }),
        });

        new cr.AwsCustomResource(this, 'SeedEscalationDoc', {
            onCreate: {
                service: 'S3',
                action: 'putObject',
                parameters: {
                    Bucket: escalationDataBucket.bucketName,
                    Key: 'escalation.txt',
                    Body: 'Flint escalation knowledge base: writeups and escalation procedures for PR review workflows.',
                    ContentType: 'text/plain',
                },
                physicalResourceId: cr.PhysicalResourceId.of('SeedEscalationDoc'),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [escalationDataBucket.bucketArn + '/*'] }),
        });

        // --- S3 vector buckets ---
        const metadataVectorBucket = new cdk.CfnResource(this, 'MetadataVectorBucket', {
            type: 'AWS::S3Vectors::VectorBucket',
            properties: {
                VectorBucketName: `flint-kb-metadata-vectors-${this.account}`,
            },
        });
        metadataVectorBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const escalationVectorBucket = new cdk.CfnResource(this, 'EscalationVectorBucket', {
            type: 'AWS::S3Vectors::VectorBucket',
            properties: {
                VectorBucketName: `flint-kb-escalation-vectors-${this.account}`,
            },
        });
        escalationVectorBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // --- Vector indexes ---
        const metadataVectorIndex = new cdk.CfnResource(this, 'MetadataVectorIndex', {
            type: 'AWS::S3Vectors::Index',
            properties: {
                VectorBucketName: `flint-kb-metadata-vectors-${this.account}`,
                IndexName: 'metadata-index',
                DataType: 'float32',
                Dimension: EMBEDDING_DIMENSIONS,
                DistanceMetric: 'cosine',
            },
        });
        metadataVectorIndex.addDependency(metadataVectorBucket);

        const escalationVectorIndex = new cdk.CfnResource(this, 'EscalationVectorIndex', {
            type: 'AWS::S3Vectors::Index',
            properties: {
                VectorBucketName: `flint-kb-escalation-vectors-${this.account}`,
                IndexName: 'escalation-index',
                DataType: 'float32',
                Dimension: EMBEDDING_DIMENSIONS,
                DistanceMetric: 'cosine',
            },
        });
        escalationVectorIndex.addDependency(escalationVectorBucket);

        // --- IAM role for Bedrock KBs ---
        const kbRole = new iam.Role(this, 'KBRole', {
            roleName: `FlintBedrockKBRole-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
                conditions: {
                    StringEquals: { 'aws:SourceAccount': this.account },
                    ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*` },
                },
            }),
        });

        kbRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel'],
            resources: [`arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL}`],
        }));

        kbRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [
                metadataDataBucket.bucketArn,
                `${metadataDataBucket.bucketArn}/*`,
                escalationDataBucket.bucketArn,
                `${escalationDataBucket.bucketArn}/*`,
            ],
        }));

        kbRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3vectors:GetIndex',
                's3vectors:PutVectors',
                's3vectors:GetVectors',
                's3vectors:DeleteVectors',
                's3vectors:QueryVectors',
                's3vectors:ListVectors',
            ],
            resources: ['*'],
        }));

        // --- Bedrock Knowledge Bases ---
        const metadataKb = new bedrock.CfnKnowledgeBase(this, 'MetadataKB', {
            name: `flint-metadata-kb-${this.account}`,
            description: 'Comprehensive knowledge base covering business contexts, terminologies, data structures for in-depth metric analysis, order processing and customer journey investigations.',
            roleArn: kbRole.roleArn,
            knowledgeBaseConfiguration: {
                type: 'VECTOR',
                vectorKnowledgeBaseConfiguration: {
                    embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL}`,
                },
            },
            storageConfiguration: {
                type: 'S3_VECTORS',
                s3VectorsConfiguration: {
                    vectorBucketArn: cdk.Fn.getAtt(metadataVectorBucket.logicalId, 'VectorBucketArn').toString(),
                    indexName: 'metadata-index',
                },
            },
        });
        metadataKb.addDependency(metadataVectorIndex);
        metadataKb.node.addDependency(kbRole);

        const escalationKb = new bedrock.CfnKnowledgeBase(this, 'EscalationKB', {
            name: `flint-escalation-kb-${this.account}`,
            description: 'Writeups and escalation procedures for PR review workflows.',
            roleArn: kbRole.roleArn,
            knowledgeBaseConfiguration: {
                type: 'VECTOR',
                vectorKnowledgeBaseConfiguration: {
                    embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL}`,
                },
            },
            storageConfiguration: {
                type: 'S3_VECTORS',
                s3VectorsConfiguration: {
                    vectorBucketArn: cdk.Fn.getAtt(escalationVectorBucket.logicalId, 'VectorBucketArn').toString(),
                    indexName: 'escalation-index',
                },
            },
        });
        escalationKb.addDependency(escalationVectorIndex);
        escalationKb.node.addDependency(kbRole);

        // --- SSM parameters ---
        new ssm.StringParameter(this, 'MetadataKBParam', {
            parameterName: `/flint/beta/kb/metadata-${this.account}`,
            stringValue: metadataKb.attrKnowledgeBaseId,
            description: 'Metadata Knowledge Base ID',
        });

        new ssm.StringParameter(this, 'EscalationKBParam', {
            parameterName: `/flint/beta/kb/escalation-${this.account}`,
            stringValue: escalationKb.attrKnowledgeBaseId,
            description: 'Escalation Knowledge Base ID',
        });

        this.escalationKbId = escalationKb.attrKnowledgeBaseId;
        this.metadataKbId = metadataKb.attrKnowledgeBaseId;

        StackUtils.exportStack(this, 'EscalationWriteupsKBKnowledgeBaseId', escalationKb.attrKnowledgeBaseId, 'The ID of the Escalation Knowledge Base');
        StackUtils.exportStack(this, 'MetadataKBKnowledgeBaseId', metadataKb.attrKnowledgeBaseId, 'The ID of the Metadata Knowledge Base');
    }
}
