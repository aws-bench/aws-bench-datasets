const { DynamoDBClient, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');
const client = new DynamoDBClient({});
exports.handler = async (event) => {
    await client.send(new DeleteItemCommand({ TableName: process.env.TABLE_NAME, Key: { [process.env.PRIMARY_KEY]: { S: event.pathParameters.id } } }));
    return { statusCode: 200, body: 'Deleted' };
};
