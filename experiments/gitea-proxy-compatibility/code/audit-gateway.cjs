'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const PORT = Number(process.env.PORT || 23001);
const GITEA_PORT = Number(required('GITEA_PORT'));
const AUDIT_FILE = required('AUDIT_FILE');
const CLIENT_AUTH = required('CLIENT_AUTH');
const UPSTREAM_AUTH = required('UPSTREAM_AUTH');
let sequence = 0;

function authorizationClass(value) {
  if (value === UPSTREAM_AUTH) return 'upstream';
  if (value === CLIENT_AUTH) return 'client';
  if (!value) return 'missing';
  return 'other';
}

function rawHeaderCount(request, wantedName) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === wantedName) count += 1;
  }
  return count;
}

function append(record) {
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`);
}

const server = http.createServer((request, response) => {
  const requestHash = crypto.createHash('sha256');
  const responseHash = crypto.createHash('sha256');
  const authorization = request.headers.authorization;
  const record = {
    sequence: ++sequence,
    method: request.method,
    path: request.url,
    experimentCase: request.headers['x-experiment-case'] || 'unlabeled',
    authorizationClass: authorizationClass(authorization),
    authorizationHeaderCount: rawHeaderCount(request, 'authorization'),
    clientCredentialLeaked: authorization === CLIENT_AUTH,
    gitProtocol: request.headers['git-protocol'] || null,
    requestContentType: request.headers['content-type'] || null,
    requestBytes: 0,
    responseStatus: null,
    responseContentType: null,
    responseBytes: 0,
    responseLocation: null,
    responseAuthenticateScheme: null,
  };
  let finalized = false;

  function finalize(extra = {}) {
    if (finalized) return;
    finalized = true;
    append({
      ...record,
      requestSha256: requestHash.digest('hex'),
      responseSha256: responseHash.digest('hex'),
      ...extra,
    });
  }

  const headers = { ...request.headers };
  for (const name of [
    'host', 'connection', 'proxy-connection', 'content-length',
    'transfer-encoding', 'te', 'trailer', 'upgrade',
  ]) delete headers[name];
  headers.host = `127.0.0.1:${GITEA_PORT}`;

  const upstream = http.request({
    host: '127.0.0.1',
    port: GITEA_PORT,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    record.responseStatus = upstreamResponse.statusCode;
    record.responseContentType = upstreamResponse.headers['content-type'] || null;
    record.responseLocation = upstreamResponse.headers.location || null;
    const authenticate = upstreamResponse.headers['www-authenticate'];
    record.responseAuthenticateScheme = authenticate ? authenticate.split(/\s+/, 1)[0] : null;

    response.writeHead(
      upstreamResponse.statusCode || 502,
      upstreamResponse.statusMessage,
      upstreamResponse.headers,
    );
    upstreamResponse.on('data', (chunk) => {
      record.responseBytes += chunk.length;
      responseHash.update(chunk);
    });
    upstreamResponse.on('end', () => finalize());
    upstreamResponse.on('error', (error) => finalize({ upstreamResponseError: error.message }));
    upstreamResponse.pipe(response);
  });

  request.on('data', (chunk) => {
    record.requestBytes += chunk.length;
    requestHash.update(chunk);
  });
  request.on('aborted', () => {
    upstream.destroy();
    finalize({ clientAborted: true });
  });
  request.on('error', (error) => finalize({ requestError: error.message }));
  upstream.on('error', (error) => {
    record.responseStatus = 502;
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
    response.end('audit gateway upstream error\n');
    finalize({ upstreamError: error.message });
  });
  request.pipe(upstream);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`credential-classifying audit gateway on http://127.0.0.1:${PORT}`);
  console.log(`forwarding to Gitea on http://127.0.0.1:${GITEA_PORT}`);
});
