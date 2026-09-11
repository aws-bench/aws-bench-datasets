import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as neptune from 'aws-cdk-lib/aws-neptune';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: neptune_npt5d8h2v
 *
 * Precondition for the neptune-bulk-load-and-shortest-path task.
 *
 * Workflow the agent must complete:
 *   1. Call start_loader (via the bridge Lambda) pointing at the
 *      pre-seeded S3 bucket of vertices.csv + edges.csv.
 *   2. Poll loader_status until LOAD_COMPLETED.
 *   3. Run a Gremlin shortest-path query alice -> eve.
 *
 * Verification: Neptune sits in a private VPC with no internet egress,
 * so the verifier (which runs OUTSIDE the VPC) cannot reach Neptune's
 * data API directly. We provision a bridge Lambda inside the cluster's
 * VPC that the verifier invokes via lambda.invoke (RequestResponse).
 * The Lambda dispatches on an `action` key (engine_status, vertex_count,
 * edge_count, shortest_path, start_loader, loader_status, ...). The
 * same Lambda is used by the agent during the task and by check.py at
 * verify time.
 *
 * AWS-doc-confirmed gotchas baked into this stack:
 *  - Neptune trust policy uses `rds.amazonaws.com` (Neptune runs on
 *    RDS infrastructure), NOT neptune.amazonaws.com.
 *  - Loader requires a Gateway-type S3 VPC endpoint on the cluster's
 *    route tables -- provided by `vpc.addGatewayEndpoint('S3Endpoint')`.
 *  - The IAM role used in start_loader_job must be associated with the
 *    cluster via associatedRoles at create-time (or via
 *    add_role_to_db_cluster post-deploy).
 *  - IAM resource ARN format for neptune-db actions:
 *    arn:aws:neptune-db:<region>:<account>:<cluster-resource-id>/*
 *    where cluster-resource-id is DBCluster.DbClusterResourceId
 *    (different from cluster identifier).
 *  - The REST POST /loader body uses field name `region` (NOT
 *    `s3BucketRegion` -- that's only the boto3 kwarg). Bridge sends raw
 *    signed POST to surface the actual server response.
 *  - Cluster SG MUST allow egress to the S3 managed prefix list on
 *    tcp/443. The bulk loader hangs on its first call without this
 *    even though the S3 Gateway endpoint is present (Neptune appears
 *    to do a synchronous role-bootstrap that needs SG egress to S3).
 *    Once the bootstrap succeeds, the cluster caches it, so a missing
 *    rule is invisible after first success -- this is a deploy-time
 *    correctness bar, not a runtime debugging exercise.
 *
 * Cost: db.t3.medium ~$0.10/hr -> ~$70/mo. Tear down between iterations.
 */
export class neptune_npt5d8h2v extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // -------------------------------------------------------------
        // VPC + S3 Gateway endpoint (loader requirement)
        // -------------------------------------------------------------
        const vpc = new ec2.Vpc(this, 'NeptuneVpc', {
            ipAddresses: ec2.IpAddresses.cidr('10.80.0.0/16'),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                { name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
            ],
            restrictDefaultSecurityGroup: false,
        });

        // S3 Gateway endpoint -- required for the Neptune loader to read
        // from S3 in a private VPC with no NAT.
        // https://docs.aws.amazon.com/neptune/latest/userguide/bulk-load-tutorial-vpc.html
        vpc.addGatewayEndpoint('S3Endpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
        });

        const subnetGroup = new neptune.CfnDBSubnetGroup(this, 'NeptuneSubnetGroup', {
            dbSubnetGroupDescription: 'Subnet group for the Neptune cluster',
            subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
        });

        // Neptune cluster SG: ingress on 8182 from anywhere in the VPC.
        // No outbound needed -- Neptune only listens.
        // Cluster SG: ingress 8182 from the VPC; explicit egress to
        // S3 managed prefix list on 443 so the bulk loader's first
        // role-bootstrap call doesn't silently hang. Without this rule
        // POST /loader hangs on the very first call even though the S3
        // Gateway VPC endpoint is wired up -- see neptune-loader-sg-
        // egress-gotcha memory for the empirical evidence.
        const sg = new ec2.SecurityGroup(this, 'NeptuneSg', {
            vpc,
            description: 'Neptune cluster SG: Gremlin in, S3 out',
            allowAllOutbound: false,
        });
        sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(8182), 'Neptune Gremlin');
        // S3 managed prefix list per region. us-east-1 is the only
        // region this scenario deploys to today; extend the map if we
        // add others.
        const S3_PREFIX_LIST: Record<string, string> = {
            'us-east-1': 'pl-63a5400a',
        };
        const s3PrefixList = S3_PREFIX_LIST[this.region];
        if (!s3PrefixList) {
            throw new Error(`No S3 prefix list mapping for region ${this.region}; add it to S3_PREFIX_LIST.`);
        }
        sg.addEgressRule(
            ec2.Peer.prefixList(s3PrefixList),
            ec2.Port.tcp(443),
            'Loader bootstrap to S3',
        );

        // Bridge Lambda SG: egress is what matters here; the Lambda must
        // reach Neptune on 8182 and S3/other AWS APIs on 443.
        // allowAllOutbound=true is the default and is fine for our use.
        const bridgeSg = new ec2.SecurityGroup(this, 'NeptuneBridgeSg', {
            vpc,
            description: 'Bridge Lambda SG (outbound to Neptune + AWS endpoints)',
            allowAllOutbound: true,
        });
        // Permit the bridge Lambda's SG to reach Neptune on 8182. Adding a
        // rule on Neptune's SG that whitelists bridgeSg by ID is the
        // canonical pattern (more precise than CIDR).
        sg.addIngressRule(bridgeSg, ec2.Port.tcp(8182), 'Bridge Lambda to Neptune');

        // -------------------------------------------------------------
        // Loader IAM role (passed to start_loader_job's iamRoleArn)
        //
        // Trust principal MUST be rds.amazonaws.com -- Neptune is built on
        // RDS infrastructure. Permissions: read from the loader bucket.
        // https://docs.aws.amazon.com/neptune/latest/userguide/bulk-load-tutorial-IAM-add-role-cluster.html
        // -------------------------------------------------------------
        const loaderBucket = new s3.Bucket(this, 'LoaderBucket', {
            bucketName: `neptune-loader-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        // Harden the autoDeleteObjects handler with identity-based S3 grants.
        // By default the handler role's ONLY S3 access is the grant the
        // bucket policy gives its exact role ARN. If that grant is stale or
        // gone at delete time, the handler fails its first call
        // (s3:GetBucketTagging) with AccessDenied, the stack delete
        // force-abandons this FIXED-NAME bucket, and every later deploy fails
        // changeset validation with "already exists" — an unrecoverable
        // reset->redeploy loop. Granting the role directly removes the
        // dependence on bucket-policy survival.
        const autoDeleteProvider = this.node.tryFindChild(
            'Custom::S3AutoDeleteObjectsCustomResourceProvider',
        ) as cdk.CustomResourceProviderBase | undefined;
        autoDeleteProvider?.addToRolePolicy({
            Effect: 'Allow',
            Action: ['s3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutBucketPolicy'],
            Resource: [
                loaderBucket.bucketArn,
                `${loaderBucket.bucketArn}/*`,
            ],
        });

        // Seed the loader bucket with a deterministic graph: 5 users +
        // 6 friendship edges. The shortest path from `alice` to `eve` has
        // length 3 (alice -> bob -> diana -> eve OR alice -> carol -> diana ->
        // eve). The verifier asserts the agent's reported path length.
        new s3deploy.BucketDeployment(this, 'SeedGraph', {
            destinationBucket: loaderBucket,
            destinationKeyPrefix: 'graph/',
            sources: [
                s3deploy.Source.data(
                    'vertices.csv',
                    [
                        '~id,~label,name:String',
                        'v1,user,alice',
                        'v2,user,bob',
                        'v3,user,carol',
                        'v4,user,diana',
                        'v5,user,eve',
                    ].join('\n') + '\n',
                ),
                s3deploy.Source.data(
                    'edges.csv',
                    [
                        '~id,~from,~to,~label',
                        // alice -- bob
                        'e1,v1,v2,knows',
                        // alice -- carol
                        'e2,v1,v3,knows',
                        // bob -- diana
                        'e3,v2,v4,knows',
                        // carol -- diana
                        'e4,v3,v4,knows',
                        // diana -- eve
                        'e5,v4,v5,knows',
                        // bob -- carol (extra edge to keep graph dense)
                        'e6,v2,v3,knows',
                    ].join('\n') + '\n',
                ),
            ],
        });

        const loaderRole = new iam.Role(this, 'NeptuneLoaderRole', {
            roleName: `neptune-loader-role-${this.account.slice(-6)}`,
            assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
            description: 'Role Neptune assumes to read from the loader bucket. Trust principal is rds.amazonaws.com per AWS docs.',
        });
        loaderBucket.grantRead(loaderRole);

        // -------------------------------------------------------------
        // Neptune cluster + instance, with loader role pre-associated
        // -------------------------------------------------------------
        const cluster = new neptune.CfnDBCluster(this, 'NeptuneCluster', {
            dbClusterIdentifier: `app-neptune-${this.account.slice(-6)}`,
            engineVersion: '1.3.0.0',
            iamAuthEnabled: true,
            dbSubnetGroupName: subnetGroup.ref,
            vpcSecurityGroupIds: [sg.securityGroupId],
            deletionProtection: false,
            backupRetentionPeriod: 1,
            // associatedRoles binds the loader IAM role to the cluster
            // at create-time, avoiding a post-deploy add_role_to_db_cluster
            // call. Required before start_loader_job will accept the role.
            associatedRoles: [
                { roleArn: loaderRole.roleArn },
            ],
        });
        cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const instance = new neptune.CfnDBInstance(this, 'NeptuneInstance', {
            dbInstanceIdentifier: `app-neptune-${this.account.slice(-6)}-instance-1`,
            dbInstanceClass: 'db.t3.medium',
            dbClusterIdentifier: cluster.ref,
        });
        instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // -------------------------------------------------------------
        // Bridge Lambda -- runs inside the cluster VPC. Verifier outside
        // the VPC invokes it via lambda.invoke(RequestResponse) to query
        // Neptune.
        // -------------------------------------------------------------

        // Build the IAM resource ARN for neptune-db actions.
        // Format: arn:aws:neptune-db:<region>:<account>:<cluster-resource-id>/*
        // cluster-resource-id is DbClusterResourceId (NOT identifier).
        // CfnDBCluster exposes it via cluster.attrClusterResourceId.
        const neptuneDbResourceArn = cdk.Fn.sub(
            'arn:aws:neptune-db:${region}:${account}:${resourceId}/*',
            {
                region: this.region,
                account: this.account,
                resourceId: cluster.attrClusterResourceId,
            },
        );

        const bridgeRole = new iam.Role(this, 'NeptuneBridgeLambdaRole', {
            roleName: `neptune-bridge-role-${this.account.slice(-6)}`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AWSLambdaVPCAccessExecutionRole',
                ),
            ],
        });
        bridgeRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'neptune-db:ReadDataViaQuery',
                    'neptune-db:WriteDataViaQuery',
                    'neptune-db:DeleteDataViaQuery',
                    'neptune-db:GetEngineStatus',
                    'neptune-db:GetLoaderJobStatus',
                    'neptune-db:ListLoaderJobs',
                    'neptune-db:StartLoaderJob',
                    'neptune-db:CancelLoaderJob',
                ],
                resources: [neptuneDbResourceArn],
            }),
        );

        const bridgeLambda = new lambda.Function(this, 'NeptuneBridgeLambda', {
            functionName: `neptune-bridge-${this.account.slice(-6)}`,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            // 5 min: Lambda cold-start ENI provisioning in a private VPC
            // can take 30-90s on first invoke, and start_loader_job inside
            // the handler may chain with poll loops in some agents'
            // approaches. Generous ceiling avoids spurious timeouts.
            timeout: cdk.Duration.minutes(5),
            memorySize: 512,
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [bridgeSg],
            role: bridgeRole,
            environment: {
                NEPTUNE_ENDPOINT: cluster.attrEndpoint,
                NEPTUNE_PORT: '8182',
            },
            logRetention: logs.RetentionDays.ONE_DAY,
            code: lambda.Code.fromInline(BRIDGE_LAMBDA_CODE),
        });

        // -------------------------------------------------------------
        // Outputs (CFN exports)
        // -------------------------------------------------------------
        StackUtils.exportStack(this, 'NeptuneClusterId', cluster.ref, 'Neptune cluster identifier');
        StackUtils.exportStack(this, 'NeptuneEndpoint', cluster.attrEndpoint, 'Neptune writer endpoint');
        StackUtils.exportStack(this, 'NeptuneClusterResourceId', cluster.attrClusterResourceId, 'Cluster resource id (for IAM ARN)');
        StackUtils.exportStack(this, 'LoaderBucketName', loaderBucket.bucketName, 'S3 bucket pre-seeded with vertices.csv + edges.csv');
        StackUtils.exportStack(this, 'LoaderRoleArn', loaderRole.roleArn, 'IAM role to pass to start_loader_job (already associated with cluster)');
        StackUtils.exportStack(this, 'BridgeLambdaName', bridgeLambda.functionName, 'Lambda inside VPC for Neptune queries');
        StackUtils.exportStack(this, 'VpcId', vpc.vpcId, 'VPC hosting Neptune');
    }
}

// =================================================================
// Bridge Lambda -- runs inside the cluster VPC, dispatched on `action`.
// Uses boto3.neptunedata which signs with SigV4 from the Lambda's
// execution role automatically.
// =================================================================
const BRIDGE_LAMBDA_CODE = `import json
import logging
import os
import socket
import time
import urllib.request
import urllib.error
import boto3
from botocore.config import Config
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

LOG = logging.getLogger(); LOG.setLevel(logging.INFO)
NEPTUNE_ENDPOINT = os.environ['NEPTUNE_ENDPOINT']
NEPTUNE_PORT = os.environ.get('NEPTUNE_PORT', '8182')
REGION = os.environ.get('AWS_REGION', 'us-east-1')

# Short timeouts on the boto3 client. Default neptunedata config uses
# 60s read x 5 retries which would mask the precondition's deliberate
# server-side hang as a 5-min Lambda timeout. Keep the surface clean.
_NEPT_CFG = Config(connect_timeout=10, read_timeout=15, retries={'max_attempts': 1})
_client = None
def _neptunedata():
    global _client
    if _client is None:
        _client = boto3.client('neptunedata', endpoint_url=f'https://{NEPTUNE_ENDPOINT}:{NEPTUNE_PORT}', config=_NEPT_CFG)
    return _client

def _signed_request(method, path, body, timeout=25):
    """Sign an arbitrary request to the Neptune data plane with SigV4 and
    return the raw HTTP outcome ({ok, http_status, body, elapsed_s}).
    Used for start_loader so the agent can see the actual server
    response (or absence thereof) rather than a boto3-laundered error.
    """
    session = boto3.Session(region_name=REGION)
    creds = session.get_credentials().get_frozen_credentials()
    body_bytes = json.dumps(body).encode('utf-8') if body is not None else b''
    url = f'https://{NEPTUNE_ENDPOINT}:{NEPTUNE_PORT}{path}'
    headers = {'Host': f'{NEPTUNE_ENDPOINT}:{NEPTUNE_PORT}'}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = AWSRequest(method=method, url=url, data=body_bytes, headers=headers)
    SigV4Auth(creds, 'neptune-db', REGION).add_auth(req)
    LOG.info('signed_req method=%s url=%s body=%s', method, url, body)
    urlreq = urllib.request.Request(url, data=body_bytes if body_bytes else None, method=method)
    for k, v in req.headers.items():
        urlreq.add_header(k, v)
    t0 = time.time()
    try:
        with urllib.request.urlopen(urlreq, timeout=timeout) as resp:
            return {'ok': True, 'http_status': resp.status, 'elapsed_s': time.time()-t0,
                    'body': resp.read().decode('utf-8', errors='replace')}
    except urllib.error.HTTPError as e:
        text = e.read().decode('utf-8', errors='replace') if hasattr(e, 'read') else ''
        return {'ok': False, 'http_status': e.code, 'elapsed_s': time.time()-t0, 'body': text, 'error': str(e)}
    except (socket.timeout, TimeoutError):
        return {'ok': False, 'error': f'socket_timeout after {time.time()-t0:.1f}s'}
    except Exception as e:  # noqa: BLE001
        return {'ok': False, 'error': f'{type(e).__name__}: {e}', 'elapsed_s': time.time()-t0}


def _unwrap_int(d):
    """Walk Neptune's Gremlin response (plain list, dict-wrapped list, or
    GraphSON {'@type': ..., '@value': ...}) down to a single int."""
    if isinstance(d, dict):
        v = d.get('@value')
        return _unwrap_int(v) if v is not None else 0
    if isinstance(d, list):
        return _unwrap_int(d[0]) if d else 0
    if isinstance(d, int):
        return d
    try:
        return int(d)
    except (TypeError, ValueError):
        return 0


def handler(event, context):
    """Dispatch on action. Catches all exceptions; returns
    {ok: False, error: <str>} so the verifier sees structured failure
    rather than a Lambda crash trace.
    """
    try:
        a = event.get('action')
        if a == 'engine_status':
            return {'ok': True, 'result': _neptunedata().get_engine_status()}
        if a == 'vertex_count':
            r = _neptunedata().execute_gremlin_query(gremlinQuery='g.V().count()')
            return {'ok': True, 'count': _unwrap_int(r.get('result',{}).get('data'))}
        if a == 'edge_count':
            r = _neptunedata().execute_gremlin_query(gremlinQuery='g.E().count()')
            return {'ok': True, 'count': _unwrap_int(r.get('result',{}).get('data'))}
        if a == 'shortest_path':
            f = event.get('from'); t = event.get('to')
            if not f or not t:
                return {'ok': False, 'error': 'shortest_path requires from + to'}
            q = (f"g.V().has('name','{f}').repeat(both().simplePath())"
                 f".until(has('name','{t}').or().loops().is(6))"
                 f".has('name','{t}').path().limit(1).count(local)")
            r = _neptunedata().execute_gremlin_query(gremlinQuery=q)
            d = r.get('result',{}).get('data')
            if d is None:
                return {'ok': True, 'path_length': None}
            n = _unwrap_int(d)
            return {'ok': True, 'path_length': (n-1) if n>0 else None}
        if a == 'raw':
            # Generic signed request -- useful for ad-hoc REST diagnostics.
            return _signed_request(event.get('method','GET'), event['path'], event.get('body'), int(event.get('timeout',25)))
        if a == 'start_loader':
            # REST field names differ from boto3 kwargs:
            #   boto3 kwarg \`s3BucketRegion\` -> REST \`region\`
            #   boto3 kwarg \`failOnError\` (bool) -> REST \`failOnError\` (string TRUE/FALSE)
            # Send the raw signed POST so the agent sees actual server
            # behavior (fast 4xx vs silent hang). 25s read timeout caps
            # the wait so a hang is reported as socket_timeout, not a
            # Lambda timeout.
            src = event.get('source'); role = event.get('iam_role_arn')
            if not src or not role:
                return {'ok': False, 'error': 'start_loader requires source + iam_role_arn'}
            payload = {
                'source': src,
                'format': event.get('format','csv'),
                'iamRoleArn': role,
                'mode': event.get('mode','AUTO'),
                'failOnError': str(bool(event.get('fail_on_error',True))).upper(),
                'parallelism': event.get('parallelism','OVERSUBSCRIBE'),
            }
            if event.get('include_region', True):
                payload['region'] = event.get('s3_bucket_region', REGION)
            return _signed_request('POST', '/loader', payload, int(event.get('raw_timeout', 25)))
        if a == 'loader_status':
            lid = event.get('load_id')
            if not lid:
                return {'ok': False, 'error': 'loader_status requires load_id'}
            r = _neptunedata().get_loader_job_status(loadId=lid)
            return {'ok': True, 'result': r}
        if a == 'list_loader_jobs':
            return {'ok': True, 'result': _neptunedata().list_loader_jobs()}
        if a == 'reset_data':
            # Used by post_invoke to clear all vertices + edges between runs.
            r = _neptunedata().execute_gremlin_query(gremlinQuery='g.V().drop()')
            return {'ok': True, 'result': str(r)}
        return {'ok': False, 'error': f'unknown action: {a}'}
    except Exception as e:  # noqa: BLE001
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}
`;
