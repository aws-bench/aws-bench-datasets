import * as cdk from 'aws-cdk-lib';
import * as customerprofiles from 'aws-cdk-lib/aws-customerprofiles';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: connect_cnp4r8t2k
 *
 * Precondition for the connect-create-customer-profiles task.
 *
 * Resources:
 *  - One Amazon Connect Customer Profiles domain. The agent's job is to look
 *    up profiles for two given account numbers; create profiles where missing.
 *
 * Outputs (placeholders the task references):
 *  - ProfilesDomainName  -- the domain to operate against
 *  - AccountId1          -- synthetic 12-digit string the agent searches for
 *  - AccountId2          -- second synthetic 12-digit string
 *
 * The task does not operate on a Connect *instance* -- only the Customer
 * Profiles domain -- so we don't provision an Instance here. Customer Profiles
 * domains are free at idle.
 */
export class connect_cnp4r8t2k extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const domainName = `cust-profiles-${this.account.slice(-6)}`;

        const domain = new customerprofiles.CfnDomain(this, 'ProfilesDomain', {
            domainName,
            defaultExpirationDays: 366,
        });
        domain.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Synthetic account numbers the agent will search for. Stable across
        // deploys so verifier checks pass deterministically.
        const accountId1 = '111122223333';
        const accountId2 = '444455556666';

        StackUtils.exportStack(this, 'ProfilesDomainName', domain.domainName, 'Customer Profiles domain');
        StackUtils.exportStack(this, 'AccountId1', accountId1, 'First account number to look up');
        StackUtils.exportStack(this, 'AccountId2', accountId2, 'Second account number to look up');
    }
}
