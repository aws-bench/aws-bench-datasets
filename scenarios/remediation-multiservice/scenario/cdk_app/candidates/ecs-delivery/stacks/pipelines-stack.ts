import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { StackUtils } from '../lib/shared';
import { CONTAINER_PORT, NAMES } from './names';

/**
 * Build pipelines for the checkout platform.
 *
 *  - checkout-api-release-build   : builds a release artifact, pushes <RELEASE_TAG> + latest
 *                                   and records the immutable digest the deployment pins to.
 *  - checkout-api-canary-build    : scheduled base-image refresh. Pushes the canary image as
 *                                   `latest` and, when an optional secondary tag is set in
 *                                   SSM, also publishes that tag onto the canary image.
 *  - checkout-worker-nightly-build: nightly worker image, unrelated repository.
 */
export class PipelinesStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const registryHost = `${this.account}.dkr.ecr.${this.region}.amazonaws.com`;
        const apiRepoUri = `${registryHost}/${NAMES.apiRepo}`;
        const workerRepoUri = `${registryHost}/${NAMES.workerRepo}`;

        const apiRepo = ecr.Repository.fromRepositoryName(this, 'ApiRepoRef', NAMES.apiRepo);
        const workerRepo = ecr.Repository.fromRepositoryName(this, 'WorkerRepoRef', NAMES.workerRepo);
        const registryTable = dynamodb.Table.fromTableName(this, 'RegistryTableRef', NAMES.registryTable);

        // intentional: broken by design - the value seeded here matches the current release tag.
        const extraParam = new ssm.StringParameter(this, 'CanaryExtraTag', {
            parameterName: NAMES.extraTagParam,
            stringValue: 'v2.1',
            description: 'Optional secondary tag published alongside the canary refresh.',
            tier: ssm.ParameterTier.STANDARD,
        });

        const dockerfileCommands = (variant: string) => [
            "echo 'FROM public.ecr.aws/docker/library/busybox:1.36' > Dockerfile",
            "echo 'ARG BUILD_STAMP=local' >> Dockerfile",
            `echo 'RUN mkdir -p /www && echo ok > /www/health && echo "checkout-api ${variant} build \${BUILD_STAMP}" > /www/index.html && echo "\${BUILD_STAMP}" > /www/build.txt' >> Dockerfile`,
            `echo 'EXPOSE ${CONTAINER_PORT}' >> Dockerfile`,
            `echo 'CMD ["httpd","-f","-v","-p","${CONTAINER_PORT}","-h","/www"]' >> Dockerfile`,
        ];

        const dockerLogin = 'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $REGISTRY_HOST';

        // ------------------------------------------------------------------
        // Release build
        // ------------------------------------------------------------------
        const releaseLogs = new logs.LogGroup(this, 'ReleaseBuildLogs', {
            logGroupName: `/aws/codebuild/${NAMES.releaseProject}`,
            retention: logs.RetentionDays.THREE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const releaseProject = new codebuild.Project(this, 'ReleaseBuild', {
            projectName: NAMES.releaseProject,
            description: 'Builds and publishes a checkout-api release artifact',
            timeout: cdk.Duration.minutes(20),
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
                computeType: codebuild.ComputeType.SMALL,
                privileged: true,
            },
            environmentVariables: {
                REGISTRY_HOST: { value: registryHost },
                REPO_URI: { value: apiRepoUri },
                REPO_NAME: { value: NAMES.apiRepo },
                REGISTRY_TABLE: { value: NAMES.registryTable },
                RELEASE_TAG: { value: 'v2.0' },
            },
            logging: { cloudWatch: { logGroup: releaseLogs } },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    pre_build: {
                        commands: [
                            'echo "release build $CODEBUILD_BUILD_ID tag=$RELEASE_TAG"',
                            dockerLogin,
                        ],
                    },
                    build: {
                        commands: [
                            ...dockerfileCommands('release'),
                            'docker build --build-arg BUILD_STAMP="$CODEBUILD_BUILD_ID" -t $REPO_URI:$RELEASE_TAG .',
                            'docker tag $REPO_URI:$RELEASE_TAG $REPO_URI:latest',
                            'docker push $REPO_URI:$RELEASE_TAG',
                            'docker push $REPO_URI:latest',
                        ],
                    },
                    post_build: {
                        commands: [
                            'DIGEST=$(aws ecr describe-images --repository-name $REPO_NAME --image-ids imageTag=$RELEASE_TAG --query "imageDetails[0].imageDigest" --output text)',
                            'echo "deployments for this release pin the immutable digest $DIGEST"',
                            'aws dynamodb put-item --table-name $REGISTRY_TABLE --item "{\\"pk\\":{\\"S\\":\\"channel:A34F\\"},\\"sk\\":{\\"S\\":\\"$RELEASE_TAG\\"},\\"imageDigest\\":{\\"S\\":\\"$DIGEST\\"},\\"repository\\":{\\"S\\":\\"$REPO_NAME\\"},\\"buildId\\":{\\"S\\":\\"$CODEBUILD_BUILD_ID\\"},\\"pinPolicy\\":{\\"S\\":\\"digest\\"}}"',
                        ],
                    },
                },
            }),
        });
        apiRepo.grantPullPush(releaseProject);
        apiRepo.grant(releaseProject, 'ecr:DescribeImages', 'ecr:ListImages');
        registryTable.grantWriteData(releaseProject);

        // ------------------------------------------------------------------
        // Canary build (scheduled base image refresh)
        // ------------------------------------------------------------------
        const canaryLogs = new logs.LogGroup(this, 'CanaryBuildLogs', {
            logGroupName: `/aws/codebuild/${NAMES.canaryProject}`,
            retention: logs.RetentionDays.THREE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const canaryProject = new codebuild.Project(this, 'CanaryBuild', {
            projectName: NAMES.canaryProject,
            description: 'Scheduled canary: rebuilds checkout-api on the current base image and refreshes the canary channel',
            timeout: cdk.Duration.minutes(20),
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
                computeType: codebuild.ComputeType.SMALL,
                privileged: true,
            },
            environmentVariables: {
                REGISTRY_HOST: { value: registryHost },
                REPO_URI: { value: apiRepoUri },
                REPO_NAME: { value: NAMES.apiRepo },
                REGISTRY_TABLE: { value: NAMES.registryTable },
                CANARY_TAG: { value: 'latest' },
                EXTRA_TAG: {
                    value: NAMES.extraTagParam,
                    type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
                },
            },
            logging: { cloudWatch: { logGroup: canaryLogs } },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    pre_build: {
                        commands: [
                            'echo "canary refresh build $CODEBUILD_BUILD_ID canary_tag=$CANARY_TAG extra_tag=$EXTRA_TAG"',
                            dockerLogin,
                        ],
                    },
                    build: {
                        commands: [
                            ...dockerfileCommands('canary'),
                            'docker build --build-arg BUILD_STAMP="$CODEBUILD_BUILD_ID" -t $REPO_URI:$CANARY_TAG .',
                            'docker push $REPO_URI:$CANARY_TAG',
                            'if [ -n "$EXTRA_TAG" ]; then echo "publishing extra tag $EXTRA_TAG"; docker tag $REPO_URI:$CANARY_TAG $REPO_URI:$EXTRA_TAG; docker push $REPO_URI:$EXTRA_TAG; fi',
                        ],
                    },
                    post_build: {
                        commands: [
                            'DIGEST=$(aws ecr describe-images --repository-name $REPO_NAME --image-ids imageTag=$CANARY_TAG --query "imageDetails[0].imageDigest" --output text)',
                            'aws dynamodb put-item --table-name $REGISTRY_TABLE --item "{\\"pk\\":{\\"S\\":\\"channel:C71B\\"},\\"sk\\":{\\"S\\":\\"$CODEBUILD_BUILD_ID\\"},\\"imageDigest\\":{\\"S\\":\\"$DIGEST\\"},\\"canaryTag\\":{\\"S\\":\\"$CANARY_TAG\\"},\\"extraTag\\":{\\"S\\":\\"$EXTRA_TAG\\"},\\"repository\\":{\\"S\\":\\"$REPO_NAME\\"}}"',
                        ],
                    },
                },
            }),
        });
        apiRepo.grantPullPush(canaryProject);
        apiRepo.grant(canaryProject, 'ecr:DescribeImages', 'ecr:ListImages');
        registryTable.grantWriteData(canaryProject);
        extraParam.grantRead(canaryProject);
        canaryProject.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameters', 'ssm:GetParameter'],
            resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/platform/checkout-api/*`],
        }));

        new events.Rule(this, 'CanarySchedule', {
            ruleName: 'checkout-api-canary-nightly',
            description: 'Nightly canary refresh of the checkout-api container image',
            schedule: events.Schedule.cron({ minute: '0', hour: '3' }),
            enabled: true,
            targets: [new targets.CodeBuildProject(canaryProject)],
        });

        // ------------------------------------------------------------------
        // Worker nightly build (unrelated repository)
        // ------------------------------------------------------------------
        const workerLogs = new logs.LogGroup(this, 'WorkerBuildLogs', {
            logGroupName: `/aws/codebuild/${NAMES.workerProject}`,
            retention: logs.RetentionDays.THREE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const workerProject = new codebuild.Project(this, 'WorkerNightlyBuild', {
            projectName: NAMES.workerProject,
            description: 'Nightly checkout-worker image build',
            timeout: cdk.Duration.minutes(20),
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
                computeType: codebuild.ComputeType.SMALL,
                privileged: true,
            },
            environmentVariables: {
                REGISTRY_HOST: { value: registryHost },
                REPO_URI: { value: workerRepoUri },
                REPO_NAME: { value: NAMES.workerRepo },
                REGISTRY_TABLE: { value: NAMES.registryTable },
            },
            logging: { cloudWatch: { logGroup: workerLogs } },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    pre_build: {
                        commands: [
                            'echo "worker nightly build $CODEBUILD_BUILD_ID"',
                            dockerLogin,
                            'NIGHTLY_TAG=nightly-$(date -u +%Y%m%d%H%M)',
                            'echo "nightly tag $NIGHTLY_TAG"',
                        ],
                    },
                    build: {
                        commands: [
                            "echo 'FROM public.ecr.aws/docker/library/busybox:1.36' > Dockerfile",
                            "echo 'ARG BUILD_STAMP=local' >> Dockerfile",
                            'echo \'RUN mkdir -p /opt/worker && echo "${BUILD_STAMP}" > /opt/worker/build.txt\' >> Dockerfile',
                            'echo \'CMD ["sh","-c","while true; do echo settlement batch drained; sleep 30; done"]\' >> Dockerfile',
                            'NIGHTLY_TAG=nightly-$(date -u +%Y%m%d%H%M)',
                            'docker build --build-arg BUILD_STAMP="$CODEBUILD_BUILD_ID" -t $REPO_URI:$NIGHTLY_TAG .',
                            'docker tag $REPO_URI:$NIGHTLY_TAG $REPO_URI:latest',
                            'docker push $REPO_URI:$NIGHTLY_TAG',
                            'docker push $REPO_URI:latest',
                        ],
                    },
                },
            }),
        });
        workerRepo.grantPullPush(workerProject);
        workerRepo.grant(workerProject, 'ecr:DescribeImages', 'ecr:ListImages');

        new events.Rule(this, 'WorkerSchedule', {
            ruleName: 'checkout-worker-nightly',
            description: 'Nightly checkout-worker image build',
            schedule: events.Schedule.cron({ minute: '30', hour: '4' }),
            enabled: true,
            targets: [new targets.CodeBuildProject(workerProject)],
        });

        StackUtils.exportStack(this, 'ReleaseProjectName', NAMES.releaseProject, 'CodeBuild project publishing checkout-api releases');
        StackUtils.exportStack(this, 'CanaryProjectName', NAMES.canaryProject, 'CodeBuild project running the scheduled canary refresh');
        StackUtils.exportStack(this, 'WorkerProjectName', NAMES.workerProject, 'CodeBuild project building the checkout-worker image');
        StackUtils.exportStack(this, 'ExtraTagParameterName', NAMES.extraTagParam, 'SSM parameter holding the optional secondary tag the canary publishes');
    }
}
