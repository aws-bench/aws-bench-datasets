const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});
const bucketName = process.env.BUCKET;
exports.handler = async (event) => {
    const method = event.httpMethod;
    const widgetName = event.path.startsWith('/') ? event.path.substring(1) : event.path;
    try {
        if (method === 'GET') {
            if (event.path === '/') {
                const data = await s3.send(new ListObjectsV2Command({ Bucket: bucketName }));
                return { statusCode: 200, body: JSON.stringify({ widgets: (data.Contents || []).map(e => e.Key) }) };
            }
            if (widgetName) {
                const data = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: widgetName }));
                const body = await data.Body.transformToString();
                return { statusCode: 200, body };
            }
        }
        if (method === 'POST') {
            if (!widgetName) return { statusCode: 400, body: 'Widget name missing' };
            await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: widgetName, Body: widgetName + ' created: ' + new Date().toISOString(), ContentType: 'application/json' }));
            return { statusCode: 200, body: JSON.stringify({ created: widgetName }) };
        }
        if (method === 'DELETE') {
            if (!widgetName) return { statusCode: 400, body: 'Widget name missing' };
            await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: widgetName }));
            return { statusCode: 200, body: 'Deleted ' + widgetName };
        }
        return { statusCode: 400, body: 'Unsupported method: ' + method };
    } catch (e) { return { statusCode: 500, body: e.message }; }
};
