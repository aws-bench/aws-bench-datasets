const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const ddb = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddb);
exports.handler = async (event) => {
    const connections = await docClient.send(new ScanCommand({ TableName: process.env.TABLE_NAME, ProjectionExpression: 'connectionId' }));
    const callbackUrl = 'https://' + event.requestContext.domainName + '/' + event.requestContext.stage;
    const apigw = new ApiGatewayManagementApiClient({ endpoint: callbackUrl });
    const postData = JSON.parse(event.body).data;
    for (const conn of (connections.Items || [])) {
        const connId = conn.connectionId.S;
        try {
            await apigw.send(new PostToConnectionCommand({ ConnectionId: connId, Data: postData }));
        } catch (e) {
            if (e.statusCode === 410) {
                await docClient.send(new DeleteCommand({ TableName: process.env.TABLE_NAME, Key: { connectionId: connId } }));
            }
        }
    }
    return { statusCode: 200, body: 'Data sent.' };
};
