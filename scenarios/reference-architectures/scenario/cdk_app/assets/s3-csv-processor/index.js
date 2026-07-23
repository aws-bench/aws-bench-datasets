exports.handler = async (event) => {
    console.log('CSV upload event:', JSON.stringify(event, undefined, 2));
    return { statusCode: 200, body: JSON.stringify(event) };
};
