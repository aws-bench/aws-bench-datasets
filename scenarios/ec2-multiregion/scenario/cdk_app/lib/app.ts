import * as cdk from 'aws-cdk-lib';
import { createEnvironment } from '../environment';

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account) throw new Error('CDK_DEFAULT_ACCOUNT is not set.');

createEnvironment(app, 'ec2-multiregion', { account });

app.synth();
