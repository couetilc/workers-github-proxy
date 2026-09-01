'use strict';

const fs = require('fs');
const http = require('http');

const port = Number(process.env.PORT || 24005);
const recordFile = process.env.RECORD_FILE;
if (!recordFile) throw new Error('RECORD_FILE is required');

const descriptor = fs.openSync(recordFile, 'a');

function appendDurably(record) {
  const line = Buffer.from(`${JSON.stringify(record)}\n`);
  fs.writeSync(descriptor, line);
  fs.fsyncSync(descriptor);
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok\n');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/records') {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found\n');
    return;
  }

  const chunks = [];
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= 1024 * 1024) chunks.push(chunk);
  });
  request.on('end', () => {
    if (bytes > 1024 * 1024) {
      response.writeHead(413, { 'content-type': 'text/plain' });
      response.end('record too large\n');
      return;
    }
    try {
      const record = JSON.parse(Buffer.concat(chunks).toString());
      appendDurably(record);
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(`${JSON.stringify({ recorded: true, id: record.id })}\n`);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end(`invalid record: ${error.message}\n`);
    }
  });
});

function close() {
  server.close(() => {
    fs.closeSync(descriptor);
    process.exit(0);
  });
}
process.on('SIGTERM', close);
process.on('SIGINT', close);

server.listen(port, '127.0.0.1', () => {
  console.log(`reconciliation recorder on http://127.0.0.1:${port}`);
  console.log(`append-and-fsync journal: ${recordFile}`);
});
