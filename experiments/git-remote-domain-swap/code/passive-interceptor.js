'use strict';
// A PASSIVE interceptor. It speaks just enough HTTP to be the far end of a git
// remote whose domain you swapped to point here. It does NOT implement the git
// server protocol, so real transfers won't *complete* -- but every byte git
// tries to send is captured and decoded. This is the "can I even see it?" test.
//
// Usage:  PORT=8080 node passive-interceptor.js
// Then point a remote at http://127.0.0.1:8080/<owner>/<repo>.git and push/fetch.

const http = require('http');
const { describeBody } = require('./wire');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const stamp = new Date().toISOString();
    console.log('\n' + '='.repeat(72));
    console.log(`[${stamp}] ${req.method} ${req.url}`);
    console.log('  remote:', req.socket.remoteAddress + ':' + req.socket.remotePort);
    console.log('  -- headers --');
    for (const [k, v] of Object.entries(req.headers)) console.log(`     ${k}: ${v}`);
    if (body.length) {
      console.log(`  -- body (${body.length} bytes) decoded --`);
      console.log(describeBody(body));
    } else {
      console.log('  -- no body --');
    }
    // Reply with a plausible-looking 200 but deliberately NOT a valid git ref
    // advertisement, so git aborts after the handshake. The point is to show
    // what a bystanding listener can and cannot see.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('intercepted\n');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`passive git interceptor listening on http://127.0.0.1:${PORT}/`);
  console.log('point a remote at it, e.g.:  http://127.0.0.1:' + PORT + '/any/repo.git');
});
