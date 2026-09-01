'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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
const MAX_CGI_HEADERS = 64 * 1024;

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

function audit(request, accepted) {
  const authorization = request.headers.authorization;
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({
    method: request.method,
    path: request.url,
    accepted,
    clientCredentialLeaked: authorization === CLIENT_AUTH,
    credentialClass: authorization === UPSTREAM_AUTH ? 'upstream' : 'other',
  })}\n`);
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
  if (request.headers.authorization !== UPSTREAM_AUTH) {
    audit(request, false);
    request.resume();
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('upstream credential required\n');
    return;
  }
  audit(request, true);

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
    REMOTE_USER: 'streaming-proxy',
  };
  if (request.headers['git-protocol']) environment.GIT_PROTOCOL = request.headers['git-protocol'];

  const backend = spawn(BACKEND, [], { env: environment });
  let headerBuffer = Buffer.alloc(0);
  let headersSent = false;

  function writeBody(chunk) {
    if (!chunk.length) return;
    if (!response.write(chunk)) backend.stdout.pause();
  }

  response.on('drain', () => backend.stdout.resume());
  request.pipe(backend.stdin);
  request.on('aborted', () => backend.kill());
  backend.stdin.on('error', () => {});
  backend.stderr.on('data', (chunk) => process.stderr.write(`[git-http-backend] ${chunk}`));
  backend.on('error', (error) => {
    if (!response.headersSent) response.writeHead(500);
    response.end(`git-http-backend failed: ${error.message}\n`);
  });
  backend.stdout.on('data', (chunk) => {
    if (headersSent) {
      writeBody(chunk);
      return;
    }

    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    if (headerBuffer.length > MAX_CGI_HEADERS) {
      backend.kill();
      response.writeHead(502);
      response.end('oversized CGI headers\n');
      return;
    }
    const parsed = parseCgiHeaders(headerBuffer);
    if (!parsed) return;
    headersSent = true;
    response.writeHead(parsed.statusCode, parsed.headers);
    writeBody(headerBuffer.subarray(parsed.bodyOffset));
    headerBuffer = Buffer.alloc(0);
  });
  backend.stdout.on('end', () => {
    if (!headersSent) {
      response.writeHead(502);
      response.end('git-http-backend returned no CGI headers\n');
    } else {
      response.end();
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`streaming git upstream listening on http://127.0.0.1:${PORT}`);
  console.log(`serving ${PROJECT_ROOT} with ${BACKEND}`);
});
