const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { PutCommand, DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
exports.handler = async (event) => {
    await docClient.send(new PutCommand({ TableName: process.env.TABLE_NAME, Item: { connectionId: event.requestContext.connectionId } }));
    return { statusCode: 200, body: 'Connected.' };
};
