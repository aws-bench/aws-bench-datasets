/**
 * Regression guard for: "(api-and-observability) Make env setup re-entrant
 * (avoid UPDATE_ROLLBACK_COMPLETE on re-run)".
 *
 * A second `aws-bench env setup` on api-and-observability must not leave any
 * stack in UPDATE_ROLLBACK_COMPLETE because of a deliberately-deleted/mutated
 * (fault-injected) resource. The end-to-end proof is an integration test that
 * runs `env setup` twice against a live account (documented in the CR /
 * stabilization flow) — it cannot run in this dep-free CI suite. This file
 * encodes the STATIC invariant that fixes the confirmed failure:
 *
 *   stepfunctions-9bww99xri exports `StateMachineName` as a literal string, NOT
 *   `stateMachine.stateMachineName` (which renders as `Fn::GetAtt [.., Name]` —
 *   a live-fetch attribute CloudFormation re-resolves on every UPDATE and the
 *   confirmed hard-fail once the state machine is deleted). With the literal,
 *   the in-place `cdk deploy` UPDATE on re-run no longer touches the deleted
 *   resource, so `cdk deploy --all` stays idempotent (no-op when unchanged,
 *   applies real edits otherwise — never a silent skip).
 */

import * as fs from 'fs';
import * as path from 'path';

const rootDir = path.join(__dirname, '..');
const scenarioDir = path.join(rootDir, 'scenarios', 'api-and-observability');
const stepfnStackPath = path.join(
    scenarioDir,
    'scenario',
    'cdk_app',
    'stacks',
    'stepfunctions',
    'stepfunctions_9bww99xri.ts',
);
const deployShPath = path.join(scenarioDir, 'deploy', 'deploy.sh');

/** Extract the value argument of `exportStack(this, '<name>', <value>, ...)`. */
function exportStackValue(source: string, exportName: string): string | null {
    // Matches: StackUtils.exportStack( this , 'Name' , <value> , '<desc>' )
    // <value> is captured up to the comma that precedes the description arg.
    const re = new RegExp(
        `exportStack\\(\\s*this\\s*,\\s*['"]${exportName}['"]\\s*,\\s*([\\s\\S]*?)\\s*,\\s*['"\`]`,
    );
    const m = source.match(re);
    return m ? m[1].trim() : null;
}

describe('api-and-observability stepfunctions-9bww99xri export hardening', () => {
    const source = fs.readFileSync(stepfnStackPath, 'utf8');

    test('StateMachineName is exported as a literal, not GetAtt Name', () => {
        const value = exportStackValue(source, 'StateMachineName');
        expect(value).not.toBeNull();
        // Must NOT use the L2 attribute accessor, which renders as GetAtt Name.
        expect(value).not.toContain('stateMachine.stateMachineName');
        // Must be the explicit literal (equal to the name set on the construct).
        expect(value).toContain('DanubeTaskService_StateMachine');
        expect(value).toContain('${this.account}');
        expect(value).toContain('${this.region}');
    });

    test('the state machine name literal matches the construct stateMachineName prop', () => {
        // Guards against the export literal drifting away from the actual name.
        expect(source).toContain(
            'stateMachineName: `DanubeTaskService_StateMachine-${this.account}-${this.region}`',
        );
    });
});

describe('api-and-observability deploy.sh stays idempotent (no silent skip)', () => {
    const deploy = fs.readFileSync(deployShPath, 'utf8');

    test('always runs cdk deploy --all (picks up edits; no-ops when unchanged)', () => {
        // Deploy goes through the cdk_deploy retry wrapper; assert the call
        // site AND that the wrapper really invokes cdk deploy (a stub wrapper
        // must not satisfy this guard).
        expect(deploy).toContain('cdk_deploy --profile PRIMARY --all');
        expect(deploy).toContain('npx cdk deploy "$@"');
    });

    test('does not gate cdk deploy behind an "already deployed" skip', () => {
        // A previous approach skipped cdk deploy when stacks were present, which
        // silently dropped CDK edits on re-run. Re-entrancy is instead handled by
        // the literal export above + CDK's native idempotency.
        expect(deploy).not.toMatch(/skipping cdk deploy/i);
        expect(deploy).not.toContain('all_stacks_deployed');
    });

    test('setup hooks still run after deploy', () => {
        const deployIdx = deploy.indexOf('cdk_deploy --profile PRIMARY --all');
        const setupLoopIdx = deploy.indexOf('for script in "$SETUP_DIR"/setup_*.py');
        expect(deployIdx).toBeGreaterThanOrEqual(0);
        expect(setupLoopIdx).toBeGreaterThan(deployIdx);
    });
});
