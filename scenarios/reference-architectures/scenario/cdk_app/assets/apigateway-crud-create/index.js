const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const client = new DynamoDBClient({});
exports.handler = async (event) => {
    const item = JSON.parse(event.body);
    item[process.env.PRIMARY_KEY] = 'item-' + Date.now();
    await client.send(new PutItemCommand({ TableName: process.env.TABLE_NAME, Item: marshall(item) }));
    return { statusCode: 201, body: JSON.stringify(item) };
};
