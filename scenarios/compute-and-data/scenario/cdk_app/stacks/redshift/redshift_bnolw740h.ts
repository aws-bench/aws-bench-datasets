import * as cdk from 'aws-cdk-lib';
import * as redshiftServerless from 'aws-cdk-lib/aws-redshiftserverless';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { CfnOutput, Duration, CustomResource } from 'aws-cdk-lib';
import { StackUtils } from '../../lib/shared';

/*
 * Stack ID: redshift_bnolw740h
 *
 * The stack creates the following resources:
 *
 * 1. Redshift serverless namespace
 * 2. Redshift serverless workgroup
 * 3. Lambda function for table setup and loading data
 * 4. Custom resource provider
 * 5. Custom resource for the Lambda function
 */

export class redshift_bnolw740h extends cdk.Stack {
    private readonly accountId: string;
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);
        this.accountId = this.account;

        const namespaceName = `${this.accountId}-test-ns`;
        const workgroupName = `${this.accountId}-test-wg`;

        // Create Redshift Serverless Namespace
        const namespace = new redshiftServerless.CfnNamespace(this, 'TestNamespace', {
            namespaceName: namespaceName,
            adminUsername: 'admin',
            adminUserPassword: 'TestPass123!',
            dbName: 'dev',
        });
        namespace.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Create Redshift Serverless Workgroup
        const workgroup = new redshiftServerless.CfnWorkgroup(this, 'TestWorkgroup', {
            workgroupName: workgroupName,
            namespaceName: namespaceName,
            baseCapacity: 8,
        });
        workgroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
        workgroup.addDependency(namespace);

        // Create Lambda function for table setup
        const setupTableFunction = new lambda.Function(this, 'SetupTableFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
        const { RedshiftDataClient, ExecuteStatementCommand, DescribeStatementCommand } = require("@aws-sdk/client-redshift-data");
        const client = new RedshiftDataClient();
        
        async function waitForStatement(statementId) {
          while (true) {
            const describeResponse = await client.send(new DescribeStatementCommand({ Id: statementId }));
            if (describeResponse.Status === 'FINISHED') {
              return true;
            } else if (['FAILED', 'ABORTED'].includes(describeResponse.Status)) {
              throw new Error(\`SQL execution failed: \${describeResponse.Error || 'Unknown error'}\`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
        
        async function executeSQL(workgroupName, database, sql) {
          const response = await client.send(new ExecuteStatementCommand({
            WorkgroupName: workgroupName,
            Database: database,
            Sql: sql
          }));
          
          await waitForStatement(response.Id);
        }
        
        exports.handler = async (event) => {
          console.log('Event:', JSON.stringify(event, null, 2));
          const props = event.ResourceProperties;
          
          try {
            if (event.RequestType === 'Create' || event.RequestType === 'Update') {
              const createTableSQL = \`
                CREATE TABLE IF NOT EXISTS test_products (
                  id INTEGER,
                  name VARCHAR(100),
                  category VARCHAR(50),
                  price DECIMAL(10,2)
                );
              \`;
              
              const insertDataSQL = \`
                INSERT INTO test_products VALUES 
                (1, 'Laptop Computer', 'Electronics', 1299.99),
                (2, 'Office Chair', 'Furniture', 249.50),
                (3, 'Python Book', 'Books', 39.99);
              \`;
              
              // Execute create table
              await executeSQL(props.workgroupName, props.database, createTableSQL);
              
              // Execute insert data
              await executeSQL(props.workgroupName, props.database, insertDataSQL);
            }
            
            return {
              PhysicalResourceId: \`RedshiftSetup-\${props.workgroupName}\`,
              Data: {
                Message: \`Operation completed for \${event.RequestType}\`
              }
            };
          } catch (error) {
            console.error('Error:', error);
            throw error;
          }
        }
      `),
            timeout: Duration.minutes(5),
        });
        setupTableFunction.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Grant necessary permissions to Lambda
        setupTableFunction.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    'redshift-data:ExecuteStatement',
                    'redshift-data:DescribeStatement',
                    'redshift-serverless:GetCredentials',
                ],
                resources: ['*'],
            }),
        );

        // Create custom resource provider
        const provider = new cr.Provider(this, 'SetupTableProvider', {
            onEventHandler: setupTableFunction,
        });

        // Create custom resource
        const setupTableCustomResource = new CustomResource(this, 'SetupTableCustomResource', {
            serviceToken: provider.serviceToken,
            properties: {
                workgroupName: workgroupName,
                database: 'dev',
                timestamp: 1700000000, // Fixed timestamp to avoid duplicate inserts
            },
        });

        // Add dependencies
        setupTableCustomResource.node.addDependency(namespace, workgroup);

        StackUtils.exportStack(this, 'RedshiftNamespaceName', namespace.ref);
        StackUtils.exportStack(this, 'RedshiftWorkgroupName', workgroup.ref);
        StackUtils.exportStack(this, 'RedshiftDatabaseName', 'dev');
    }
}
