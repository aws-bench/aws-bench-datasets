function handler(event) {
    console.log(event);

    if (event.request.uri.endsWith('test.html')) {
        event.response.headers['cache-control'] = {value: 'max-age=60'};
        event.response.headers['x-test-header'] = {value: 'this is a test'};
    }

    return event.response;
}
