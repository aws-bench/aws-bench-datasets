import * as cdk from 'aws-cdk-lib';
import { Fn, CfnParameter, CfnOutput } from 'aws-cdk-lib';
import * as servicecatalog from 'aws-cdk-lib/aws-servicecatalog';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Service Catalog Portfolio Stack
 *
 * Converted from aws-cdk-examples/typescript/servicecatalog/portfolio-with-ec2-product
 *
 * Creates:
 * 1. Service Catalog Portfolio
 * 2. EC2 Product (CloudFormationProduct with two product versions)
 * 3. Portfolio-Product association with CloudFormation parameter constraint
 * 4. SNS Topic for launch notifications
 * 5. IAM Developer role and Testers group with portfolio access
 * 6. Tag options
 */

class Ec2InstanceProduct extends servicecatalog.ProductStack {
    constructor(scope: Construct, id: string) {
        super(scope, id);

        const vpc = new ec2.Vpc(this, 'VPC', {
            natGateways: 0,
            restrictDefaultSecurityGroup: false,
            subnetConfiguration: [{
                cidrMask: 24,
                name: 'public',
                subnetType: ec2.SubnetType.PUBLIC,
            }],
        });

        const role = new iam.Role(this, 'ec2Role', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        });

        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

        // Use Latest Amazon Linux Image - CPU Type ARM64
        const ami = new ec2.AmazonLinuxImage({
            generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
            cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        });

        // EC2 Instance Type parameter
        const ec2InstanceType = new CfnParameter(this, 'InstanceType', {
            type: 'String',
            description: 'The instance type of an EC2 instance.',
        });

        // Create the instance using the AMI and role defined in the VPC created
        const ec2Instance = new ec2.Instance(this, 'Instance', {
            vpc,
            instanceType: new ec2.InstanceType(ec2InstanceType.valueAsString),
            machineImage: ami,
            allowAllOutbound: true,
            role: role,
        });

        new CfnOutput(this, 'IP Address', { value: ec2Instance.instancePublicIp });
        new CfnOutput(this, 'Download Key Command', { value: 'aws secretsmanager get-secret-value --secret-id ec2-ssh-key/cdk-keypair/private --query SecretString --output text > cdk-key.pem && chmod 400 cdk-key.pem' });
        new CfnOutput(this, 'ssh command', { value: 'ssh -i cdk-key.pem -o IdentitiesOnly=yes ec2-user@' + ec2Instance.instancePublicIp });
    }
}

export class ServiceCatalogPortfolioStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const portfolio = new servicecatalog.Portfolio(this, 'Portfolio', {
            displayName: `EC2 Portfolio ${this.account}`,
            providerName: 'IT Services',
            description: 'Portfolio containing EC2 instance products',
        });

        // EC2 Product with two product versions
        const product = new servicecatalog.CloudFormationProduct(this, 'Ec2Product', {
            productName: 'EC2 Instance',
            owner: 'IT Services',
            description: 'Provision an EC2 instance in a private VPC',
            productVersions: [
                {
                    productVersionName: 'v1',
                    cloudFormationTemplate: servicecatalog.CloudFormationTemplate.fromProductStack(
                        new Ec2InstanceProduct(this, 'Ec2InstanceProduct'),
                    ),
                    description: 'A VPC containing an EC2 Instance',
                },
                {
                    productVersionName: 'v2',
                    cloudFormationTemplate: servicecatalog.CloudFormationTemplate.fromProductStack(
                        new Ec2InstanceProduct(this, 'Ec2InstanceProductV2'),
                    ),
                    description: 'A VPC containing an EC2 Instance',
                },
            ],
        });

        // Parameter constraint on allowed EC2 instance types
        portfolio.constrainCloudFormationParameters(product, {
            rule: {
                ruleName: 'EC2InstanceTypes',
                assertions: [
                    {
                        assert: Fn.conditionContains(['t4g.micro', 't4g.small'], Fn.ref('InstanceType')),
                        description: 'For test environment, valid instance types are t4g.micro or t4g.small',
                    },
                ],
            },
        });

        portfolio.addProduct(product);

        const launchRole = new iam.Role(this, 'LaunchRole', {
            roleName: `sc-launch-role-${this.account}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('servicecatalog.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2FullAccess'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonVPCFullAccess'),
            ],
        });

        portfolio.setLocalLaunchRole(product, launchRole);

        // Developer role with portfolio access
        const devRole = new iam.Role(this, 'DevRole', {
            assumedBy: new iam.AccountRootPrincipal(),
            roleName: 'Developer',
        });
        portfolio.giveAccessToRole(devRole);

        // Testers group with portfolio access
        const testGroup = new iam.Group(this, 'TestGroup', {
            groupName: 'Testers',
        });
        portfolio.giveAccessToGroup(testGroup);

        const notificationTopic = new sns.Topic(this, 'LaunchNotificationTopic', {
            topicName: `sc-launch-notifications-${this.account}-${this.region}`,
            enforceSSL: true,
        });
        notificationTopic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        portfolio.notifyOnStackEvents(product, notificationTopic);

        const tagOptions = new servicecatalog.TagOptions(this, 'TagOptions', {
            allowedValuesForTags: {
                Environment: ['dev', 'staging', 'prod'],
                CostCenter: ['100', '200', '300'],
            },
        });
        portfolio.associateTagOptions(tagOptions);

        StackUtils.exportStack(this, 'PortfolioName', portfolio.node.id, 'Service Catalog Portfolio construct ID');
        StackUtils.exportStack(this, 'PortfolioId', portfolio.portfolioId, 'Service Catalog Portfolio ID');
        StackUtils.exportStack(this, 'ProductName', 'EC2 Instance', 'Service Catalog Product name');
        StackUtils.exportStack(this, 'ProductId', product.productId, 'Service Catalog Product ID');
        StackUtils.exportStack(this, 'LaunchRoleArn', launchRole.roleArn, 'Launch role ARN');
        StackUtils.exportStack(this, 'DevRoleArn', devRole.roleArn, 'Developer role ARN');
        StackUtils.exportStack(this, 'TestGroupName', testGroup.groupName, 'Testers group name');
        StackUtils.exportStack(this, 'NotificationTopicArn', notificationTopic.topicArn, 'Launch notification SNS topic ARN');
    }
}
