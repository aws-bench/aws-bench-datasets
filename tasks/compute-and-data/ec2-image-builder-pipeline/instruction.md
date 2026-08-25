In us-east-1, create a complete EC2 Image Builder pipeline using Amazon Linux 2 as the base image. First, create a build component 'install-awscli-v2' that installs AWS CLI version 2. Then create an infrastructure configuration using t3.medium instances with the necessary IAM roles and instance profile. Set up a distribution configuration to copy the resulting AMI to the us-east-2 region. Create an image recipe that combines the Amazon Linux 2 base image with the AWS CLI v2 component. Build the complete image pipeline, execute it to create the custom AMI, and finally create a launch template that uses this new AMI.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.

Additionally, write `/logs/agent/agent-output.json` containing exactly:

```json
{
  "image_pipeline_arn": "the ARN of the EC2 Image Builder pipeline the agent created"
}
```
