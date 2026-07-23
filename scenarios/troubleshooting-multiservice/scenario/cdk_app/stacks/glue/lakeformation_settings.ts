import * as cdk from 'aws-cdk-lib';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import { Construct } from 'constructs';

/**
 * Shared stack that activates Lake Formation governance.
 *
 * Clears default permissions (CreateDatabaseDefaultPermissions and
 * CreateTableDefaultPermissions) so IAMAllowedPrincipals is not
 * auto-granted on new databases/tables. Registers the CDK execution
 * role and OrganizationAccountAccessRole as data lake admins so both
 * CloudFormation and setup scripts can manage LF permissions.
 *
 * All stacks that depend on LF governance (e.g. Glue stacks) should
 * declare a dependency on this stack.
 */
export class LakeFormationSettings extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        new lakeformation.CfnDataLakeSettings(this, 'DataLakeSettings', {
            admins: [
                {
                    dataLakePrincipalIdentifier:
                        `arn:aws:iam::${this.account}:role/cdk-hnb659fds-cfn-exec-role-${this.account}-${this.region}`,
                },
                {
                    dataLakePrincipalIdentifier:
                        `arn:aws:iam::${this.account}:role/OrganizationAccountAccessRole`,
                },
            ],
            createDatabaseDefaultPermissions: [],
            createTableDefaultPermissions: [],
        });
    }
}
