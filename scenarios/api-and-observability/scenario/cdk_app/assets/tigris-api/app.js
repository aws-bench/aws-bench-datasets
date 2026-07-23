require('http').createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); }
    else if (req.method === 'POST' && req.url === '/jobInstance/updateStatus') { res.writeHead(200); res.end('ok'); }
    else { res.writeHead(500); res.end('Not Found'); }
}).listen(8080);
