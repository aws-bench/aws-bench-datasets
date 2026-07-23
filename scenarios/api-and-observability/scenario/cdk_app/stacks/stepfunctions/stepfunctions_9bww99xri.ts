import * as cdk from "aws-cdk-lib";
import * as stepfunctions from "aws-cdk-lib/aws-stepfunctions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { StackUtils } from "../../lib/shared";

/*
 * Stack ID: stepfunctions-9bww99xri
 *
 * df290edf-f12e-4dda-b732-160f50012e0f_18_70
 *
 * What the stack does:
 * 1. Creates a Step Functions state machine for task orchestration
 * 2. Creates an IAM role for Step Functions execution
 * 3. Creates a CloudWatch log group for Step Functions
 * 4. Exports the state machine ARN for cross-stack reference
 */

export class Stepfunctions_9bww99xri extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // CloudWatch Log Group for Step Functions
    const stepFunctionsLogGroup = new logs.LogGroup(
      this,
      "StepFunctionsLogGroup",
      {
        logGroupName: `/aws/vendedlogs/states/DanubeTaskServiceStepfunctionLogGroup-${this.account}-${this.region}`,
        retention: logs.RetentionDays.ONE_YEAR,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    // IAM Role for Step Functions
    const stateMachineRole = new iam.Role(this, "StateMachineRole", {
      roleName: `DanubeTaskService-SfnRole-${this.account}-${this.region}`,
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
    });

    // Grant CloudWatch Logs permissions to Step Functions role
    stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups",
        ],
        resources: ["*"],
      }),
    );

    // Step Functions State Machine
    const stateMachine = new stepfunctions.StateMachine(
      this,
      "TaskOrchestratorStateMachine",
      {
        stateMachineName: `DanubeTaskService_StateMachine-${this.account}-${this.region}`,
        definitionBody: stepfunctions.DefinitionBody.fromString(
          JSON.stringify({
            Comment: "Task orchestration workflow",
            StartAt: "ProcessTask",
            States: {
              ProcessTask: {
                Type: "Task",
                Resource: "arn:aws:states:::lambda:invoke",
                Parameters: {
                  FunctionName: "placeholder-task-processor",
                  "Payload.$": "$",
                },
                ResultPath: "$.taskResult",
                Next: "CheckResult",
                Catch: [
                  {
                    ErrorEquals: ["States.ALL"],
                    Next: "TaskFailed",
                  },
                ],
              },
              CheckResult: {
                Type: "Choice",
                Choices: [
                  {
                    Variable: "$.taskResult.status",
                    StringEquals: "SUCCESS",
                    Next: "TaskSucceeded",
                  },
                ],
                Default: "TaskFailed",
              },
              TaskSucceeded: {
                Type: "Succeed",
              },
              TaskFailed: {
                Type: "Fail",
                Error: "TaskProcessingFailed",
                Cause: "Task processing did not complete successfully",
              },
            },
          }),
        ),
        role: stateMachineRole,
        stateMachineType: stepfunctions.StateMachineType.STANDARD,
        logs: {
          destination: stepFunctionsLogGroup,
          level: stepfunctions.LogLevel.ALL,
          includeExecutionData: true,
        },
      },
    );

    // Export stack outputs
    StackUtils.exportStack(
      this,
      "StateMachineArn",
      stateMachine.stateMachineArn,
      "The ARN of the Step Functions state machine",
    );

    StackUtils.exportStack(
      this,
      "StateMachineName",
      `DanubeTaskService_StateMachine-${this.account}-${this.region}`,
      "The name of the Step Functions state machine",
    );
    StackUtils.exportStack(
      this,
      "StepFunctionsLogGroupName",
      stepFunctionsLogGroup.logGroupName,
      "The name of the Step Functions log group",
    );
  }
}
