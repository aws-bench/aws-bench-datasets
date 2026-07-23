import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * Shared stack that ensures the OpenSearch Service-Linked Role exists.
 *
 * VPC-based OpenSearch domains require the SLR
 * `AWSServiceRoleForAmazonOpenSearchService` to manage ENIs. This role is an
 * **account-wide singleton**: AWS also creates it lazily on the first VPC
 * OpenSearch domain, and it must not be deleted per-scenario (other scenarios,
 * leftover domains, or AWS's own lazy creation may depend on it).
 *
 * A plain `CfnServiceLinkedRole` is unsuitable here because it is:
 *   - not idempotent on create — it fails with `InvalidInput`
 *     ("Service role name ... has been taken in this account") when the role
 *     already exists, which breaks repeated setup/cleanup cycles on the same
 *     account; and
 *   - unsafe on delete — CloudFormation attempts to delete the shared role,
 *     which can wedge teardown.
 *
 * Instead this uses an `AwsCustomResource` that:
 *   - `onCreate` calls `iam:createServiceLinkedRole`, tolerating the
 *     already-exists case via `ignoreErrorCodesMatching: 'InvalidInput'`
 *     → idempotent; and
 *   - has no `onUpdate`/`onDelete` → the account-shared role is retained on
 *     teardown, so the stack deletes cleanly and never spins.
 *
 * All VPC-based OpenSearch stacks in this environment should declare a
 * dependency on this stack.
 */
export class OpenSearchSlr extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        new cr.AwsCustomResource(this, 'OpenSearchSLR', {
            onCreate: {
                service: 'IAM',
                action: 'createServiceLinkedRole',
                parameters: {
                    AWSServiceName: 'opensearchservice.amazonaws.com',
                },
                // Idempotent: tolerate the account-wide singleton already existing
                // (from a prior cycle or AWS's lazy creation on first VPC domain).
                ignoreErrorCodesMatching: 'InvalidInput',
                physicalResourceId: cr.PhysicalResourceId.of('OpenSearchServiceLinkedRole'),
            },
            // No onUpdate/onDelete: the SLR is an account-wide singleton and is
            // intentionally retained when this stack is torn down.
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
            }),
        });
    }
}
