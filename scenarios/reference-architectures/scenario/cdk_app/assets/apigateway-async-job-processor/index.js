const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { PutCommand, DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
exports.handler = async (event) => {
    const jobId = event.jobId || 'job-' + Date.now();
    await docClient.send(new PutCommand({ TableName: process.env.JOB_TABLE, Item: { jobId, status: 'Processed', createdAt: new Date().toISOString() } }));
    return { statusCode: 200, body: JSON.stringify({ jobId }) };
};
