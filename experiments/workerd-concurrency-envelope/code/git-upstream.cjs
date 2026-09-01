'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream');
const { RateThrottle } = require('./throttle.cjs');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const PORT = Number(process.env.PORT || 9080);
const PROJECT_ROOT = required('GIT_PROJECT_ROOT');
const UPSTREAM_AUTH = required('UPSTREAM_AUTH');
const CLIENT_AUTH = required('CLIENT_AUTH');
const AUDIT_FILE = required('AUDIT_FILE');
const REQUEST_BYTES_PER_SECOND = Number(process.env.REQUEST_BYTES_PER_SECOND || 0);
const RESPONSE_BYTES_PER_SECOND = Number(process.env.RESPONSE_BYTES_PER_SECOND || 0);
const ACTIVE_THRESHOLD_BYTES = Number(process.env.ACTIVE_THRESHOLD_BYTES || 1024 * 1024);
const MAX_CGI_HEADERS = 64 * 1024;
let operationSequence = 0;
let activeTransfers = 0;

function resolveBackend() {
  const candidates = [];
  if (process.env.GIT_HTTP_BACKEND) candidates.push(process.env.GIT_HTTP_BACKEND);
  const result = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (result.status === 0) candidates.push(path.join(result.stdout.trim(), 'git-http-backend'));
  candidates.push('/usr/lib/git-core/git-http-backend');
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`could not find git-http-backend; tried ${candidates.join(', ')}`);
  return found;
}

const BACKEND = resolveBackend();

function append(record) {
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`);
}

function parseCgiHeaders(buffer) {
  let separator = buffer.indexOf('\r\n\r\n');
  let separatorLength = 4;
  if (separator === -1) {
    separator = buffer.indexOf('\n\n');
    separatorLength = 2;
  }
  if (separator === -1) return null;

  const headers = {};
  let statusCode = 200;
  for (const line of buffer.subarray(0, separator).toString('latin1').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') statusCode = Number.parseInt(value, 10) || 200;
    else headers[name] = value;
  }
  return { statusCode, headers, bodyOffset: separator + separatorLength };
}

const server = http.createServer((request, response) => {
  const operationId = ++operationSequence;
  const caseName = request.headers['x-experiment-case'] || 'unlabeled';
  const kind = request.url.endsWith('/git-receive-pack') ? 'push' :
    request.url.endsWith('/git-upload-pack') ? 'clone' : 'control';
  const accepted = request.headers.authorization === UPSTREAM_AUTH;
  const clientCredentialLeaked = request.headers.authorization === CLIENT_AUTH;

  if (!accepted) {
    request.resume();
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('upstream credential required\n');
    append({ recordType: 'request', operationId, case: caseName, method: request.method,
      path: request.url, kind, accepted, clientCredentialLeaked, statusCode: 401,
      requestBytes: 0, responseBytes: 0, completed: true });
    return;
  }

  const [pathInfo, queryString = ''] = request.url.split('?');
  const environment = {
    ...process.env,
    GIT_PROJECT_ROOT: PROJECT_ROOT,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: pathInfo,
    QUERY_STRING: queryString,
    REQUEST_METHOD: request.method,
    CONTENT_TYPE: request.headers['content-type'] || '',
    CONTENT_LENGTH: request.headers['content-length'] || '',
    REMOTE_ADDR: request.socket.remoteAddress || '127.0.0.1',
    REMOTE_USER: 'workerd-proxy',
  };
  if (request.headers['git-protocol']) environment.GIT_PROTOCOL = request.headers['git-protocol'];

  const backend = spawn(BACKEND, [], { env: environment });
  const requestThrottle = new RateThrottle(REQUEST_BYTES_PER_SECOND);
  const responseThrottle = new RateThrottle(RESPONSE_BYTES_PER_SECOND);
  let headerBuffer = Buffer.alloc(0);
  let headersSent = false;
  let statusCode = 200;
  let requestBytes = 0;
  let responseBytes = 0;
  let active = false;
  let completed = false;
  let recorded = false;

  function maybeActivate() {
    const bytes = kind === 'push' ? requestBytes : responseBytes;
    if (active || kind === 'control' || bytes < ACTIVE_THRESHOLD_BYTES) return;
    active = true;
    activeTransfers += 1;
    append({ recordType: 'active-start', operationId, case: caseName, kind,
      active: activeTransfers, requestBytes, responseBytes });
  }

  function deactivate(reason) {
    if (!active) return;
    active = false;
    activeTransfers -= 1;
    append({ recordType: 'active-end', operationId, case: caseName, kind,
      active: activeTransfers, reason, requestBytes, responseBytes });
  }

  function record(reason) {
    if (recorded) return;
    recorded = true;
    deactivate(reason);
    append({ recordType: 'request', operationId, case: caseName, method: request.method,
      path: request.url, kind, accepted, clientCredentialLeaked, statusCode,
      requestBytes, responseBytes, completed, reason });
  }

  function writeBody(chunk) {
    if (!chunk.length || response.destroyed) return;
    if (!responseThrottle.write(chunk)) backend.stdout.pause();
  }

  request.on('data', (chunk) => {
    requestBytes += chunk.length;
    maybeActivate();
  });
  responseThrottle.on('data', (chunk) => {
    responseBytes += chunk.length;
    maybeActivate();
  });
  responseThrottle.on('drain', () => backend.stdout.resume());
  responseThrottle.pipe(response);
  request.on('aborted', () => backend.kill());
  response.on('finish', () => {
    completed = true;
    record('completed');
  });
  response.on('close', () => {
    if (!completed) {
      backend.kill();
      responseThrottle.destroy();
      record('downstream-closed');
    }
  });
  pipeline(request, requestThrottle, backend.stdin, (error) => {
    if (error && !request.aborted) backend.kill();
  });
  backend.stderr.on('data', (chunk) => process.stderr.write(`[git-http-backend] ${chunk}`));
  backend.on('error', (error) => {
    statusCode = 500;
    if (!response.headersSent) response.writeHead(statusCode);
    if (!response.destroyed) response.end(`git-http-backend failed: ${error.message}\n`);
    record(`backend-error: ${error.message}`);
  });
  backend.stdout.on('data', (chunk) => {
    if (headersSent) {
      writeBody(chunk);
      return;
    }

    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    if (headerBuffer.length > MAX_CGI_HEADERS) {
      statusCode = 502;
      backend.kill();
      response.writeHead(statusCode);
      response.end('oversized CGI headers\n');
      record('oversized-headers');
      return;
    }
    const parsed = parseCgiHeaders(headerBuffer);
    if (!parsed) return;
    headersSent = true;
    statusCode = parsed.statusCode;
    response.writeHead(statusCode, parsed.headers);
    writeBody(headerBuffer.subarray(parsed.bodyOffset));
    headerBuffer = Buffer.alloc(0);
  });
  backend.stdout.on('end', () => {
    if (recorded) return;
    if (!headersSent) {
      statusCode = 502;
      responseThrottle.destroy();
      response.writeHead(statusCode);
      response.end('git-http-backend returned no CGI headers\n');
    } else {
      responseThrottle.end();
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`instrumented Git upstream on http://127.0.0.1:${PORT}`);
  console.log(`serving ${PROJECT_ROOT} with ${BACKEND}`);
  console.log(`request rate ${REQUEST_BYTES_PER_SECOND} B/s; response rate ${RESPONSE_BYTES_PER_SECOND} B/s`);
  console.log(`large transfer active after ${ACTIVE_THRESHOLD_BYTES} B`);
});
