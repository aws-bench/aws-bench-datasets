const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DeleteCommand, DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
exports.handler = async (event) => {
    await docClient.send(new DeleteCommand({ TableName: process.env.TABLE_NAME, Key: { connectionId: event.requestContext.connectionId } }));
    return { statusCode: 200, body: 'Disconnected.' };
};
