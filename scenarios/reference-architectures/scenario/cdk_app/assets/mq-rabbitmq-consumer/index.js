exports.handler = async (event) => {
    console.log('Received RabbitMQ event:', JSON.stringify(event, undefined, 2));
    for (const [queue, messages] of Object.entries(event.rmqMessagesByQueue || {})) {
        for (const msg of messages) {
            const body = Buffer.from(msg.data, 'base64').toString('utf-8');
            console.log('Queue:', queue, 'Message:', body);
        }
    }
    return { statusCode: 200, body: 'Messages processed' };
};
