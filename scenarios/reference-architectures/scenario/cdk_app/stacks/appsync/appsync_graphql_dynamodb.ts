import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { AppsyncFunction, AuthorizationType, Code, Definition, FunctionRuntime, GraphqlApi, ISchema, Resolver } from 'aws-cdk-lib/aws-appsync';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { StackUtils } from '../../lib/shared';

/*
 * AppSync GraphQL DynamoDB Stack
 *
 * Converted from aws-cdk-examples/typescript/appsync-graphql-dynamodb
 *
 * Creates:
 * 1. DynamoDB Table "cars" with partition key licenseplate
 * 2. DynamoDB Table "defects" with partition key id and GSI by licenseplate
 * 3. AppSync GraphQL API with IAM authorization and X-Ray enabled
 * 4. GraphQL schema with Car and Defect types
 * 5. JS pipeline resolvers for getCar query and defects field
 */

const SCHEMA = `\
type Car {
\tlicenseplate: String!
\tbrand: String!
\ttradename: String
\texpirydateapk: String
\tfirstcolor: String!
\tcylindercount: String
\tcylindervolume: String
\tfirstregistrationdate: String
\tcatalogprice: String
\tlength: String
\twidth: String
\tdefects: [Defect]
}

type Defect {
\tlicenseplate: String!
\tdefectstartdate: String
\tdefectdescription: String
}

type Query {
\tgetCar(licenseplate: String!): Car
}

schema {
\tquery: Query
}
`;

/** Inline ISchema implementation that provides the schema definition as a string */
const inlineSchema: ISchema = {
    bind: (api: any) => ({
        apiId: api.apiId ?? cdk.Fn.select(1, cdk.Fn.split('/', api.graphQlApiRef.graphQlApiArn)),
        definition: SCHEMA,
    }),
};

export class AppsyncGraphqlDynamodbStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Create DynamoDB tables
        const carsTable = new Table(this, 'CarsTable', {
            partitionKey: { name: 'licenseplate', type: AttributeType.STRING },
            tableName: `cars-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: BillingMode.PROVISIONED,
            readCapacity: 2,
            writeCapacity: 4,
        });

        const defectsTable = new Table(this, 'DefectsTable', {
            partitionKey: { name: 'id', type: AttributeType.STRING },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            tableName: `defects-${this.account}-${this.region}`,
            billingMode: BillingMode.PROVISIONED,
            readCapacity: 2,
            writeCapacity: 4,
        });

        defectsTable.addGlobalSecondaryIndex({
            indexName: 'defect-by-licenseplate',
            partitionKey: {
                name: 'licenseplate',
                type: AttributeType.STRING,
            },
            readCapacity: 2,
            writeCapacity: 4,
        });

        const api = new GraphqlApi(this, 'CarAPI', {
            name: 'carAPI',
            definition: Definition.fromSchema(inlineSchema),
            authorizationConfig: {
                defaultAuthorization: {
                    authorizationType: AuthorizationType.IAM,
                },
            },
            xrayEnabled: true,
        });

        // Connect DynamoDB tables to the AppSync API as data sources
        const carsDataSource = api.addDynamoDbDataSource('CarsDataSource', carsTable);
        const defectsDataSource = api.addDynamoDbDataSource('DefectsDataSource', defectsTable);

        const carsResolver = new AppsyncFunction(this, 'CarsFunction', {
            name: 'getCars',
            api,
            dataSource: carsDataSource,
            code: Code.fromAsset(path.join(__dirname, '../../assets/appsync-get-car/resolver.js')),
            runtime: FunctionRuntime.JS_1_0_0,
        });

        const defectsResolver = new AppsyncFunction(this, 'DefectsFunction', {
            name: 'getDefects',
            api,
            dataSource: defectsDataSource,
            code: Code.fromAsset(path.join(__dirname, '../../assets/appsync-get-defects/resolver.js')),
            runtime: FunctionRuntime.JS_1_0_0,
        });

        new Resolver(this, 'PipelineResolverGetCars', {
            api,
            typeName: 'Query',
            fieldName: 'getCar',
            runtime: FunctionRuntime.JS_1_0_0,
            code: Code.fromAsset(path.join(__dirname, '../../assets/appsync-pipeline/resolver.js')),
            pipelineConfig: [carsResolver],
        });

        new Resolver(this, 'PipelineResolverGetDefects', {
            api,
            typeName: 'Car',
            fieldName: 'defects',
            runtime: FunctionRuntime.JS_1_0_0,
            code: Code.fromAsset(path.join(__dirname, '../../assets/appsync-pipeline/resolver.js')),
            pipelineConfig: [defectsResolver],
        });

        // Exports
        StackUtils.exportStack(this, 'GraphqlApiUrl', api.graphqlUrl, 'AppSync GraphQL API URL');
        StackUtils.exportStack(this, 'GraphqlApiId', api.apiId, 'AppSync GraphQL API ID');
        StackUtils.exportStack(this, 'GraphqlApiKey', api.apiKey || 'N/A', 'AppSync GraphQL API Key');
        StackUtils.exportStack(this, 'CarsTableName', carsTable.tableName, 'DynamoDB cars table name');
        StackUtils.exportStack(this, 'DefectsTableName', defectsTable.tableName, 'DynamoDB defects table name');
    }
}
