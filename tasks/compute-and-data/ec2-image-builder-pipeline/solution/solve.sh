#!/bin/bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ROLE_NAME="${ROLE_NAME:-EC2ImageBuilderRole}"
PROFILE_NAME="${INSTANCE_PROFILE_NAME:-EC2ImageBuilderInstanceProfile}"
COMPONENT_NAME="${COMPONENT_NAME:-install-awscli-v2}"
DIST_REGION="${DISTRIBUTION_REGION:-us-east-2}"
OUT=/logs/agent/agent-output.txt
OUT_JSON=/logs/agent/agent-output.json

cat > /tmp/ib-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF

aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document file:///tmp/ib-trust.json --region "$REGION"
for POLICY in EC2InstanceProfileForImageBuilder AmazonSSMManagedInstanceCore EC2InstanceProfileForImageBuilderECRContainerBuilds; do
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "arn:aws:iam::aws:policy/${POLICY}"
done
aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" --region "$REGION"
aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME"
sleep 10

cat > /tmp/ib-component.yaml <<'EOF'
name: install-awscli-v2
description: Installs AWS CLI version 2 on Amazon Linux 2
schemaVersion: 1.0
phases:
  - name: build
    steps:
      - name: InstallAWSCLIv2
        action: ExecuteBash
        inputs:
          commands:
            - curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
            - unzip /tmp/awscliv2.zip -d /tmp
            - sudo /tmp/aws/install
            - aws --version
            - rm -rf /tmp/awscliv2.zip /tmp/aws
  - name: validate
    steps:
      - name: ValidateAWSCLIv2
        action: ExecuteBash
        inputs:
          commands:
            - aws --version | grep -q "aws-cli/2"
EOF

COMPONENT_ARN=$(aws imagebuilder create-component --name "$COMPONENT_NAME" --semantic-version "1.0.0" --description "Installs AWS CLI v2 on Amazon Linux 2" --platform "Linux" --data file:///tmp/ib-component.yaml --region "$REGION" --query 'componentBuildVersionArn' --output text)

DEFAULT_VPC=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text --region "$REGION")
DEFAULT_SUBNET=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=${DEFAULT_VPC}" "Name=defaultForAz,Values=true" --query 'Subnets[0].SubnetId' --output text --region "$REGION")
DEFAULT_SG=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=${DEFAULT_VPC}" "Name=group-name,Values=default" --query 'SecurityGroups[0].GroupId' --output text --region "$REGION")

INFRA_CONFIG_ARN=$(aws imagebuilder create-infrastructure-configuration --name "imagebuilder-infra-t3medium" --instance-types "t3.medium" --instance-profile-name "$PROFILE_NAME" --subnet-id "$DEFAULT_SUBNET" --security-group-ids "$DEFAULT_SG" --terminate-instance-on-failure --region "$REGION" --query 'infrastructureConfigurationArn' --output text)

DIST_CONFIG_ARN=$(aws imagebuilder create-distribution-configuration --name "imagebuilder-dist-${DIST_REGION}" --description "Distribute AMI to ${DIST_REGION}" --distributions "[{\"region\":\"${DIST_REGION}\",\"amiDistributionConfiguration\":{\"name\":\"custom-al2-awscli-v2-{{ imagebuilder:buildDate }}\",\"amiTags\":{\"Name\":\"custom-al2-awscli-v2\",\"CreatedBy\":\"EC2ImageBuilder\"}}}]" --region "$REGION" --query 'distributionConfigurationArn' --output text)

RECIPE_ARN=$(aws imagebuilder create-image-recipe --name "al2-with-awscli-v2" --description "Amazon Linux 2 with AWS CLI v2" --semantic-version "1.0.0" --components "[{\"componentArn\":\"${COMPONENT_ARN}\"}]" --parent-image "arn:aws:imagebuilder:${REGION}:aws:image/amazon-linux-2-x86/x.x.x" --block-device-mappings '[{"deviceName":"/dev/xvda","ebs":{"encrypted":false,"deleteOnTermination":true,"volumeSize":20,"volumeType":"gp3"}}]' --region "$REGION" --query 'imageRecipeArn' --output text)

PIPELINE_ARN=$(aws imagebuilder create-image-pipeline --name "al2-awscli-v2-pipeline" --description "Pipeline for AL2 AMI with AWS CLI v2" --image-recipe-arn "$RECIPE_ARN" --infrastructure-configuration-arn "$INFRA_CONFIG_ARN" --distribution-configuration-arn "$DIST_CONFIG_ARN" --image-tests-configuration '{"imageTestsEnabled":true,"timeoutMinutes":60}' --status "ENABLED" --region "$REGION" --query 'imagePipelineArn' --output text)

aws imagebuilder start-image-pipeline-execution --image-pipeline-arn "$PIPELINE_ARN" --region "$REGION" --query 'imageBuildVersionArn' --output text

AMI_ID=""
for _ in $(seq 1 150); do
  AMI_ID=$(aws imagebuilder list-image-pipeline-images --image-pipeline-arn "$PIPELINE_ARN" --region "$REGION" --query "imageSummaryList[].outputResources.amis[?region=='${REGION}'].image | [] | [0]" --output text 2>/dev/null || true)
  if [ -n "$AMI_ID" ] && [ "$AMI_ID" != "None" ]; then
    break
  fi
  sleep 30
done

aws ec2 create-launch-template --launch-template-name "al2-awscli-v2-launch-template" --version-description "Custom AL2 AMI with AWS CLI v2" --launch-template-data "{\"ImageId\":\"${AMI_ID}\",\"InstanceType\":\"t3.medium\"}" --tag-specifications 'ResourceType=launch-template,Tags=[{Key=CreatedBy,Value=EC2 Image Builder}]' --region "$REGION" --query 'LaunchTemplate.LaunchTemplateId' --output text

mkdir -p "$(dirname "$OUT_JSON")"
printf '{"image_pipeline_arn": "%s"}\n' "$PIPELINE_ARN" > "$OUT_JSON"
echo "Done." > "$OUT"
