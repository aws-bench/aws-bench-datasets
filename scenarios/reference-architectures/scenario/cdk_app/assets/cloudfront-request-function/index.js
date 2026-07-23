function handler(event) {
    if (event.request.uri === '/' && event.request.querystring !== {}) {
        event.request.querystring = {};
    }

    var domain = event.request.headers.host.value;
    var redirects = {
        '/test.html': 'https://' + domain + '/subdir/test.html',
        '/test': 'https://' + domain + '/subdir/test.html'
    };
    var redirectUrl = redirects[event.request.uri];

    if (redirectUrl) {
        return {
            statusCode: 308,
            statusDescription: 'Permanent Redirect',
            headers: {
                'location': {value: redirectUrl}
            }
        };
    }

    if (new RegExp('^/invalid').test(event.request.uri)) {
        return {
            statusCode: 403,
            statusDescription: 'Forbidden',
        };
    }

    if (event.request.headers['x-correlation-id'] && event.request.headers['x-correlation-id'].value === 'abcde') {
        event.request.headers['x-correlation-id'].value = 'random-correlation-id';
    }

    if (event.request.cookies['foo'] && event.request.cookies['foo'].value === 'bar') {
        event.request.cookies['should-cache'] = {value: 'true'};
    }

    return event.request;
}
