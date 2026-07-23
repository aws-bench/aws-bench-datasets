import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack: ImageBuilderPipeline
 *
 * Converted from aws-cdk-examples/typescript/imagebuilder.
 * Skips cdk-nag dependency.
 *
 * Resources created:
 * 1. ECR Repository (lifecycle: maxImageCount 10, DESTROY, emptyOnDelete)
 * 2. IAM Role with managed policies for Image Builder
 * 3. IAM Instance Profile
 * 4. CfnComponent for Git install (LINUX, inline YAML)
 * 5. CfnComponent for Node.js install (LINUX, inline YAML)
 * 6. CfnComponent for Docker install (LINUX, inline YAML)
 * 7. CfnContainerRecipe (DOCKER, Amazon Linux 2023 parent image)
 * 8. CfnInfrastructureConfiguration
 * 9. CfnDistributionConfiguration (distribute to same region ECR)
 * 10. CfnImagePipeline
 */

export class ImageBuilderPipeline extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // ECR Repository
        const repository = new ecr.Repository(this, 'ImageBuilderRepo', {
            lifecycleRules: [
                {
                    maxImageCount: 10,
                    description: 'Keep only 10 images',
                },
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
        });

        // IAM Role for Image Builder
        const role = new iam.Role(this, 'ImageBuilderRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilderECRContainerBuilds'),
            ],
        });

        // IAM Instance Profile
        const instanceProfile = new iam.CfnInstanceProfile(this, 'ImageBuilderInstanceProfile', {
            roles: [role.roleName],
        });

        // CfnComponent: Install Git
        const installGitComponent = new imagebuilder.CfnComponent(this, 'InstallGitComponent', {
            name: `InstallGit-${this.account}-${this.region}`,
            platform: 'Linux',
            version: '1.0.0',
            data: [
                'name: InstallGit',
                'schemaVersion: 1.0',
                'phases:',
                '  - name: build',
                '    steps:',
                '      - name: InstallGit',
                '        action: ExecuteBash',
                '        inputs:',
                '          commands:',
                '            - yum install -y git',
            ].join('\n'),
        });

        // CfnComponent: Install Node.js
        const installNodejsComponent = new imagebuilder.CfnComponent(this, 'InstallNodejsComponent', {
            name: `InstallNodejs-${this.account}-${this.region}`,
            platform: 'Linux',
            version: '1.0.0',
            data: [
                'name: InstallNodejs',
                'schemaVersion: 1.0',
                'phases:',
                '  - name: build',
                '    steps:',
                '      - name: InstallNodejs',
                '        action: ExecuteBash',
                '        inputs:',
                '          commands:',
                '            - dnf install -y nodejs20',
            ].join('\n'),
        });

        // CfnComponent: Install Docker
        const installDockerComponent = new imagebuilder.CfnComponent(this, 'InstallDockerComponent', {
            name: `InstallDocker-${this.account}-${this.region}`,
            platform: 'Linux',
            version: '1.0.0',
            data: [
                'name: InstallDocker',
                'schemaVersion: 1.0',
                'phases:',
                '  - name: build',
                '    steps:',
                '      - name: InstallDocker',
                '        action: ExecuteBash',
                '        inputs:',
                '          commands:',
                '            - yum install -y docker',
                '            - systemctl enable docker',
                '            - systemctl start docker',
            ].join('\n'),
        });

        // CfnContainerRecipe (DOCKER, Amazon Linux 2023 parent image)
        const containerRecipe = new imagebuilder.CfnContainerRecipe(this, 'ContainerRecipe', {
            name: `ImageBuilderRecipe-${this.account}-${this.region}`,
            containerType: 'DOCKER',
            version: '2.1.2',
            parentImage: `arn:aws:imagebuilder:${this.region}:aws:image/amazon-linux-2023-x86-latest/x.x.x`,
            components: [
                { componentArn: installGitComponent.attrArn },
                { componentArn: installNodejsComponent.attrArn },
                { componentArn: installDockerComponent.attrArn },
            ],
            targetRepository: {
                repositoryName: repository.repositoryName,
                service: 'ECR',
            },
            dockerfileTemplateData: [
                'FROM {{{ imagebuilder:parentImage }}}',
                '{{{ imagebuilder:environments }}}',
                '{{{ imagebuilder:components }}}',
            ].join('\n'),
        });

        // CfnInfrastructureConfiguration
        const infraConfig = new imagebuilder.CfnInfrastructureConfiguration(this, 'InfraConfig', {
            name: `ImageBuilderInfra-${this.account}-${this.region}`,
            instanceProfileName: instanceProfile.ref,
            instanceTypes: ['t3.medium'],
            terminateInstanceOnFailure: true,
        });
        infraConfig.addDependency(instanceProfile);

        // CfnDistributionConfiguration (distribute to same region ECR)
        const distributionConfig = new imagebuilder.CfnDistributionConfiguration(this, 'DistributionConfig', {
            name: `ImageBuilderDist-${this.account}-${this.region}`,
            distributions: [
                {
                    region: this.region,
                    containerDistributionConfiguration: {
                        targetRepository: {
                            repositoryName: repository.repositoryName,
                            service: 'ECR',
                        },
                    },
                },
            ],
        });

        // CfnImagePipeline
        const pipeline = new imagebuilder.CfnImagePipeline(this, 'ImagePipeline', {
            name: `ImageBuilderPipeline-${this.account}-${this.region}`,
            containerRecipeArn: containerRecipe.attrArn,
            infrastructureConfigurationArn: infraConfig.attrArn,
            distributionConfigurationArn: distributionConfig.attrArn,
            status: 'ENABLED',
            imageTestsConfiguration: {
                imageTestsEnabled: false,
            },
        });

        // Exports
        StackUtils.exportStack(this, 'EcrRepositoryUri', repository.repositoryUri, 'ECR repository URI');
        StackUtils.exportStack(this, 'EcrRepositoryName', repository.repositoryName, 'ECR repository name');
        StackUtils.exportStack(this, 'PipelineArn', pipeline.attrArn, 'Image Builder pipeline ARN');
        StackUtils.exportStack(this, 'InfrastructureConfigArn', infraConfig.attrArn, 'Infrastructure configuration ARN');
        StackUtils.exportStack(this, 'DistributionConfigArn', distributionConfig.attrArn, 'Distribution configuration ARN');
        StackUtils.exportStack(this, 'RecipeArn', containerRecipe.attrArn, 'Container recipe ARN');
        StackUtils.exportStack(this, 'InstanceProfileName', instanceProfile.ref, 'Instance profile name');
        StackUtils.exportStack(this, 'ComponentNames', 'InstallGit,InstallNodejs,InstallDocker', 'Names of Image Builder components');
    }
}
