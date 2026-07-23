import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

/*
* Stack ID: waf-18b01a0

* What the stack does:
1. The stack creates a single Web ACL with basic security rules.
*/

export class WAF_18b01a02d extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const DefaultAction = 'allow';

        const rules1 = [
            {
                name: 'RateLimitRule',
                priority: 1,
                statement: {
                    rateBasedStatement: {
                        limit: 2000,
                        aggregateKeyType: 'IP',
                    },
                },
                action: {
                    block: {},
                },
                visibilityConfig: {
                    sampledRequestsEnabled: true,
                    cloudWatchMetricsEnabled: true,
                    metricName: 'RateLimitRule',
                },
            },
        ];

        // Create WAFv2 Web ACL
        const WebAcl1 = new wafv2.CfnWebACL(this, 'WebAcl', {
            defaultAction: { allow: {} },
            scope: 'REGIONAL',
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: 'WebACLMetric',
                sampledRequestsEnabled: true,
            },
            name: `WebAcl1-${this.account}-${this.region}`,
            description: 'Web ACL with basic security rules',
            rules: rules1,
        });

        // Output the Web ACL ID
        new cdk.CfnOutput(this, 'WebAclId', {
            value: WebAcl1.attrId,
            description: 'Web ACL ID',
            exportName: `${this.stackName}-WebAclId`,
        });

        // WebAcl Arn
        new cdk.CfnOutput(this, 'WebAclArn', {
            value: WebAcl1.attrArn,
            description: 'Web ACL ARN',
            exportName: `${this.stackName}-WebAclArn`,
        });

        // Waf Console Url
        new cdk.CfnOutput(this, 'WafConsoleUrl', {
            value: `https://console.aws.amazon.com/wafv2/homev2/web-acl/${WebAcl1.attrId}/${WebAcl1.scope}`,
            description: 'WAF Console URL',
            exportName: `${this.stackName}-WafConsoleUrl`,
        });

        // WebAcl default Action
        new cdk.CfnOutput(this, 'WebAcldefaultAction', {
            value: DefaultAction,
            description: 'WebAcl default action',
            exportName: `${this.stackName}-WebAcldefaultAction`,
        });

        // Rule Name
        new cdk.CfnOutput(this, 'RuleName', {
            value: rules1[0].name,
            description: 'WAF Rule Name',
            exportName: `${this.stackName}-RuleName`,
        });

        // Rule Priority
        new cdk.CfnOutput(this, 'RulePriority', {
            value: rules1[0].priority.toString(),
            description: 'WAF Rule Priority',
            exportName: `${this.stackName}-RulePriority`,
        });

        // Rule Rate Limit
        new cdk.CfnOutput(this, 'RuleRateLimit', {
            value: rules1[0].statement.rateBasedStatement.limit.toString(),
            description: 'WAF Rule Rate Limit',
            exportName: `${this.stackName}-RuleRateLimit`,
        });
    }
}
