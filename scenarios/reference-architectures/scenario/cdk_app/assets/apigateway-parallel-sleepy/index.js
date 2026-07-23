exports.main = async (event) => {
    await new Promise(resolve => setTimeout(resolve, 5000));
    return { body: JSON.stringify({ message: 'Hello World zzZ! (Sleepy)' }), statusCode: 200 };
};
