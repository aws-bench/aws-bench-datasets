import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: lambda_layer
 *
 * Converted from aws-cdk-examples/typescript/lambda-layer.
 * Creates a LayerVersion (helper module exposing layerFunction()) and a Lambda Function
 * that requires 'helper' from the layer.
 *
 * The layer payload must live at nodejs/node_modules/helper/ for Node.js runtime
 * resolution. We materialize that structure at synth time from inlined source so the
 * asset doesn't need to be committed to git (where node_modules/ is ignored).
 */

const HELPER_INDEX_JS = `const layerFunction = function () {
    return 'Hello From Helper Layer!';
};

module.exports = { layerFunction };
`;

const HELPER_PACKAGE_JSON = JSON.stringify(
    {
        name: 'helper',
        version: '1.0.0',
        description: 'Helper layer for lambda-layer example',
        main: 'index.js',
    },
    null,
    2,
);

function materializeHelperLayer(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-layer-helper-'));
    const helperDir = path.join(root, 'nodejs', 'node_modules', 'helper');
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(path.join(helperDir, 'index.js'), HELPER_INDEX_JS);
    fs.writeFileSync(path.join(helperDir, 'package.json'), HELPER_PACKAGE_JSON);
    return root;
}

export class LambdaLayer extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        const layer = new lambda.LayerVersion(this, 'HelperLayer', {
            code: lambda.Code.fromAsset(materializeHelperLayer()),
            description: 'Common helper utility',
            compatibleRuntimes: [lambda.Runtime.NODEJS_LATEST],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const fn = new lambda.Function(this, 'LambdaFunction', {
            functionName: `LambdaLayer-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_LATEST,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/lambda-layer-handler')),
            layers: [layer],
        });
        fn.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        StackUtils.exportStack(this, 'FunctionName', fn.functionName, 'Lambda function name');
        StackUtils.exportStack(this, 'FunctionArn', fn.functionArn, 'Lambda function ARN');
        StackUtils.exportStack(this, 'LayerArn', layer.layerVersionArn, 'Helper layer version ARN');
    }
}
