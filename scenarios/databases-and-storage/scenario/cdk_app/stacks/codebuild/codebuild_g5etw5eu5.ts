import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*

* Stack ID: codebuild_g5etw5eu5
* What the stack does:
* 1. Creates a CodeBuild project with Amazon Linux 2.5 image and Node.js 24 runtime environment.
*
* */

export class codebuild_g5etw5eu5 extends cdk.Stack {
    private readonly accountId: string | undefined;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);


        const nodeJSVersion = 24;
        const Image = codebuild.LinuxBuildImage.AMAZON_LINUX_2_5;

        const buildProject = new codebuild.Project(this, 'buildProject', {
            projectName: `prodproject-${this.account}-${this.region}`,
            environment: {
                buildImage: Image,
                computeType: codebuild.ComputeType.SMALL,
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        'runtime-versions': { nodejs: nodeJSVersion },
                        commands: ['node -v', 'npm -v'],
                    },
                },
            }),
        });
        buildProject.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        StackUtils.exportStack(this, 'BuildImageID', Image.imageId, 'CodeBuild Image ID');
        StackUtils.exportStack(this, 'NodeVersion', nodeJSVersion.toString(), 'Node.js Version');
        StackUtils.exportStack(this, 'ProjectName', buildProject.projectName, 'CodeBuild Project Name');
    }
}
