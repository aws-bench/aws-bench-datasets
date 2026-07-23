const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const client = new DynamoDBClient({});
exports.handler = async (event) => {
    const params = { TableName: process.env.TABLE_NAME, Key: { [process.env.PRIMARY_KEY]: { S: event.pathParameters.id } } };
    const data = await client.send(new GetItemCommand(params));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data.Item || {}) };
};
