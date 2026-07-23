const { RDSDataClient, ExecuteStatementCommand, BatchExecuteStatementCommand } = require('@aws-sdk/client-rds-data');
const rdsData = new RDSDataClient();

exports.handler = async (event) => {
    const clusterArn = process.env.CLUSTER_ARN;
    const secretArn = process.env.SECRET_ARN;
    const database = process.env.DATABASE_NAME;

    try {
        await rdsData.send(new ExecuteStatementCommand({
            resourceArn: clusterArn,
            secretArn: secretArn,
            database: database,
            sql: 'CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())'
        }));

        const message = event.message || 'Hello from Lambda via Data API!';
        await rdsData.send(new ExecuteStatementCommand({
            resourceArn: clusterArn,
            secretArn: secretArn,
            database: database,
            sql: 'INSERT INTO messages (content) VALUES (:msg)',
            parameters: [{ name: 'msg', value: { stringValue: message } }]
        }));

        const result = await rdsData.send(new ExecuteStatementCommand({
            resourceArn: clusterArn,
            secretArn: secretArn,
            database: database,
            sql: 'SELECT id, content, created_at FROM messages ORDER BY created_at DESC LIMIT 10'
        }));

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Query executed successfully via RDS Data API',
                records: result.records,
                numberOfRecords: result.numberOfRecordsUpdated
            })
        };
    } catch (error) {
        console.error('Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
