exports.main = async (event) => {
    return { body: JSON.stringify({ message: 'Hello World!' }), statusCode: 200 };
};
