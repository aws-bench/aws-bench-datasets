const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const client = new DynamoDBClient({});
exports.handler = async () => {
    const data = await client.send(new ScanCommand({ TableName: process.env.TABLE_NAME }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data.Items || []) };
};
