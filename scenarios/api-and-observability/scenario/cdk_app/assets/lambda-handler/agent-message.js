const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE_NAME || process.env.WEBSOCKET_CONNECTIONS_TABLE;
const NODES_TABLE = process.env.NODES_TABLE_NAME || process.env.NODES_TABLE;
const DEPLOYMENTS_TABLE = process.env.DEPLOYMENTS_TABLE_NAME || process.env.DEPLOYMENTS_TABLE;

// Helper function to send message to a connection
async function sendToConnection(connectionId, data) {
    const endpoint = process.env.WEBSOCKET_ENDPOINT.replace('wss://', 'https://');
    const apigwManagementApi = new AWS.ApiGatewayManagementApi({
        endpoint: endpoint
    });
    
    try {
        await apigwManagementApi.postToConnection({
            ConnectionId: connectionId,
            Data: JSON.stringify(data)
        }).promise();
    } catch (error) {
        console.error('Error sending message:', error);
        if (error.statusCode === 410) {
            console.log('Connection gone, removing from table');
            await dynamodb.delete({
                TableName: CONNECTIONS_TABLE,
                Key: { connectionId }
            }).promise();
        }
        throw error;
    }
}

// Handle agent registration
async function handleAgentRegistration(connectionId, message) {
    console.log('Agent registration:', message);
    
    const nodeId = Buffer.from(`${message.hostname}-${Date.now()}`).toString('base64').substring(0, 16);
    const timestamp = Date.now();
    
    // Store connection
    await dynamodb.put({
        TableName: CONNECTIONS_TABLE,
        Item: {
            connectionId,
            type: 'agent',
            nodeId,
            hostname: message.hostname,
            ip: message.ip,
            deploymentId: message.deploymentId,
            agentVersion: message.agentVersion,
            connectedAt: timestamp
        }
    }).promise();
    
    // Store node info
    await dynamodb.put({
        TableName: NODES_TABLE,
        Item: {
            nodeId,
            hostname: message.hostname,
            ip: message.ip,
            deploymentId: message.deploymentId,
            agentVersion: message.agentVersion,
            status: 'connected',
            lastSeen: timestamp
        }
    }).promise();
    
    // Notify UI clients about new node
    const uiConnections = await dynamodb.scan({
        TableName: CONNECTIONS_TABLE,
        FilterExpression: '#type = :type',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: { ':type': 'ui' }
    }).promise();
    
    const notification = {
        type: 'node_discovered',
        nodeId,
        hostname: message.hostname,
        ip: message.ip,
        deploymentId: message.deploymentId,
        agentVersion: message.agentVersion,
        timestamp
    };
    
    console.log('Notifying UI clients:', notification);
    
    for (const conn of uiConnections.Items || []) {
        try {
            await sendToConnection(conn.connectionId, notification);
        } catch (error) {
            console.error(`Failed to notify UI ${conn.connectionId}:`, error);
        }
    }
    
    // Send registration success back to agent
    await sendToConnection(connectionId, {
        type: 'registration_success',
        nodeId,
        message: 'Agent registered successfully'
    });
}

// Handle UI registration
async function handleUIRegistration(connectionId, message) {
    console.log('UI registration:', message);
    
    await dynamodb.put({
        TableName: CONNECTIONS_TABLE,
        Item: {
            connectionId,
            type: 'ui',
            userId: message.userId || 'anonymous',
            connectedAt: Date.now()
        }
    }).promise();
    
    // Send current nodes to UI
    const nodes = await dynamodb.scan({
        TableName: NODES_TABLE
    }).promise();
    
    await sendToConnection(connectionId, {
        type: 'nodes_list',
        nodes: nodes.Items || []
    });
}

// Handle heartbeat
async function handleHeartbeat(connectionId, message) {
    console.log('Heartbeat received:', message);
    
    // Update last seen timestamp
    const connection = await dynamodb.get({
        TableName: CONNECTIONS_TABLE,
        Key: { connectionId }
    }).promise();
    
    if (connection.Item && connection.Item.nodeId) {
        await dynamodb.update({
            TableName: NODES_TABLE,
            Key: { nodeId: connection.Item.nodeId },
            UpdateExpression: 'SET lastSeen = :timestamp',
            ExpressionAttributeValues: {
                ':timestamp': Date.now()
            }
        }).promise();
    }
    
    // Send heartbeat acknowledgment
    await sendToConnection(connectionId, {
        type: 'heartbeat_ack',
        timestamp: Date.now()
    });
}



exports.handler = async (event) => {
    console.log('Event:', JSON.stringify(event, null, 2));
    
    const connectionId = event.requestContext.connectionId;
    const routeKey = event.requestContext.routeKey;
    
    try {
        if (routeKey === '$connect') {
            console.log('Connection established:', connectionId);
            return { statusCode: 200, body: 'Connected' };
        }
        
        if (routeKey === '$disconnect') {
            console.log('Connection closed:', connectionId);
            
            // Clean up connection
            const connection = await dynamodb.get({
                TableName: CONNECTIONS_TABLE,
                Key: { connectionId }
            }).promise();
            
            if (connection.Item && connection.Item.nodeId) {
                await dynamodb.update({
                    TableName: NODES_TABLE,
                    Key: { nodeId: connection.Item.nodeId },
                    UpdateExpression: 'SET #status = :status',
                    ExpressionAttributeNames: { '#status': 'status' },
                    ExpressionAttributeValues: { ':status': 'disconnected' }
                }).promise();
            }
            
            await dynamodb.delete({
                TableName: CONNECTIONS_TABLE,
                Key: { connectionId }
            }).promise();
            
            return { statusCode: 200, body: 'Disconnected' };
        }
        
        // Handle messages
        const body = JSON.parse(event.body || '{}');
        console.log('Message received:', body);
        
        switch (body.action) {
            case 'register_ui':
                await handleUIRegistration(connectionId, body);
                break;
            case 'register':
            case 'agent_connected':
                await handleAgentRegistration(connectionId, body);
                break;
            case 'heartbeat':
                await handleHeartbeat(connectionId, body);
                break;
            // message routing
            default:
                console.log('Unknown action:', body.action);
                return { statusCode: 400, body: 'Unknown action' };
        }
        
        return { statusCode: 200, body: 'Message processed' };
    } catch (error) {
        console.error('Error:', error);
        return { statusCode: 500, body: 'Internal server error' };
    }
};
