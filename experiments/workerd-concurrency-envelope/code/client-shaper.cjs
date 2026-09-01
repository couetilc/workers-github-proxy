'use strict';

const fs = require('node:fs');
const http = require('node:http');
const { pipeline } = require('node:stream');
const { RateThrottle } = require('./throttle.cjs');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const PORT = Number(process.env.PORT || 9081);
const TARGET_PORT = Number(required('TARGET_PORT'));
const RESPONSE_BYTES_PER_SECOND = Number(process.env.RESPONSE_BYTES_PER_SECOND || 0);
const AUDIT_FILE = required('SHAPER_AUDIT_FILE');

function append(record) {
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`);
}

const server = http.createServer((request, response) => {
  const caseName = request.headers['x-experiment-case'] || 'unlabeled';
  const abortAfter = Number(request.headers['x-experiment-abort-after'] || 0);
  const headers = { ...request.headers, host: `127.0.0.1:${TARGET_PORT}` };
  delete headers.connection;
  delete headers['proxy-connection'];
  delete headers['x-experiment-abort-after'];

  let requestBytes = 0;
  let responseBytes = 0;
  let injectedAbort = false;
  let recorded = false;

  function record(statusCode, error) {
    if (recorded) return;
    recorded = true;
    append({
      case: caseName,
      method: request.method,
      path: request.url,
      statusCode,
      requestBytes,
      responseBytes,
      injectedAbort,
      error,
    });
  }

  const target = http.request({
    host: '127.0.0.1',
    port: TARGET_PORT,
    method: request.method,
    path: request.url,
    headers,
  }, (targetResponse) => {
    const responseHeaders = { ...targetResponse.headers };
    delete responseHeaders.connection;
    delete responseHeaders['transfer-encoding'];
    delete responseHeaders['content-length'];
    response.writeHead(targetResponse.statusCode || 502, responseHeaders);

    const throttle = new RateThrottle(RESPONSE_BYTES_PER_SECOND);
    throttle.on('data', (chunk) => {
      responseBytes += chunk.length;
      if (!injectedAbort && abortAfter > 0 &&
          request.method === 'POST' && request.url.endsWith('/git-upload-pack') &&
          responseBytes >= abortAfter) {
        injectedAbort = true;
        setImmediate(() => {
          targetResponse.destroy(new Error('injected downstream abort'));
          response.destroy();
        });
      }
    });
    pipeline(targetResponse, throttle, response, (error) => {
      record(targetResponse.statusCode || 502, error?.message);
    });
  });

  request.on('data', (chunk) => { requestBytes += chunk.length; });
  request.on('aborted', () => target.destroy());
  target.on('error', (error) => {
    if (!response.headersSent) response.writeHead(502);
    if (!response.destroyed) response.end('client shaper upstream failed\n');
    record(502, error.message);
  });
  pipeline(request, target, (error) => {
    if (error && !request.aborted) target.destroy(error);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`client response shaper on http://127.0.0.1:${PORT}`);
  console.log(`target 127.0.0.1:${TARGET_PORT}; response rate ${RESPONSE_BYTES_PER_SECOND} B/s`);
});
