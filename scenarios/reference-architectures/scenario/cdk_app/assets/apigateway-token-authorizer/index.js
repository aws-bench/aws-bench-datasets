exports.handler = function (event, context, callback) {
    var token = event.authorizationToken;
    switch (token) {
        case 'allow':
            callback(null, generatePolicy('user', 'Allow', event.methodArn));
            break;
        case 'deny':
            callback(null, generatePolicy('user', 'Deny', event.methodArn));
            break;
        case 'unauthorized':
            callback("Unauthorized");
            break;
        default:
            callback("Error: Invalid token");
    }
};
function generatePolicy(principalId, effect, resource) {
    return {
        principalId: principalId,
        policyDocument: {
            Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
            Version: '2012-10-17'
        }
    };
}
