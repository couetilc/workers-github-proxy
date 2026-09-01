'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const PORT = Number(required('PORT'));
const GITEA_PORT = Number(required('GITEA_PORT'));
const REPLICA = required('REPLICA');
const AUDIT_FILE = required('AUDIT_FILE');
const UPSTREAM_AUTH = required('UPSTREAM_AUTH');
const SLOW_DELAY_MS = Number(process.env.SLOW_DELAY_MS || 4);
const DISCONNECT_AFTER_BYTES = Number(process.env.DISCONNECT_AFTER_BYTES || 1024 * 1024);
let sequence = 0;

function append(record) {
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`);
}

function requestHeaders(request) {
  const headers = { ...request.headers };
  for (const name of [
    'host', 'connection', 'proxy-connection', 'content-length',
    'transfer-encoding', 'te', 'trailer', 'upgrade',
  ]) delete headers[name];
  headers.host = `127.0.0.1:${GITEA_PORT}`;
  return headers;
}

function pktLine(text) {
  const payload = Buffer.from(text);
  return Buffer.concat([
    Buffer.from((payload.length + 4).toString(16).padStart(4, '0')),
    payload,
  ]);
}

function commandRefs(prefix) {
  const refs = [];
  let offset = 0;
  while (offset + 4 <= prefix.length) {
    const header = prefix.subarray(offset, offset + 4).toString();
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) break;
    if (length < 4 || offset + length > prefix.length) break;
    const line = prefix.subarray(offset + 4, offset + length).toString()
      .replace(/\n$/, '').split('\0', 1)[0];
    const fields = line.split(' ');
    if (fields.length === 3 && fields[2].startsWith('refs/')) refs.push(fields[2]);
    offset += length;
  }
  return refs;
}

function rejectionBody(refs) {
  const chunks = [pktLine('unpack ok\n')];
  for (const ref of refs) chunks.push(pktLine(`ng ${ref} rejected by replica ${REPLICA}\n`));
  chunks.push(Buffer.from('0000'));
  return Buffer.concat(chunks);
}

const server = http.createServer((request, response) => {
  const started = process.hrtime.bigint();
  const requestHash = crypto.createHash('sha256');
  const responseHash = crypto.createHash('sha256');
  const requestedFault = request.headers['x-replica-b-fault'] || 'none';
  const receivePost = request.method === 'POST' && request.url.endsWith('/git-receive-pack');
  const fault = REPLICA === 'B' && receivePost ? requestedFault : 'none';
  const prefixChunks = [];
  let prefixBytes = 0;
  let finalized = false;
  let requestDone = false;
  let responseDone = false;
  const record = {
    sequence: ++sequence,
    replica: REPLICA,
    experimentCase: request.headers['x-experiment-case'] || 'unlabeled',
    method: request.method,
    path: request.url,
    requestedFault,
    appliedFault: fault,
    authorizationValid: request.headers.authorization === UPSTREAM_AUTH,
    requestBytes: 0,
    responseStatus: null,
    responseContentType: null,
    responseBytes: 0,
    firstRequestByteMs: null,
    requestEndMs: null,
    responseEndMs: null,
  };

  function elapsedMs() {
    return Number(process.hrtime.bigint() - started) / 1e6;
  }

  function finalize(extra = {}, force = false) {
    if (finalized || (!force && (!requestDone || !responseDone))) return;
    finalized = true;
    append({
      ...record,
      durationMs: Math.round(elapsedMs()),
      requestSha256: requestHash.digest('hex'),
      responseSha256: responseHash.digest('hex'),
      ...extra,
    });
  }

  request.on('data', (chunk) => {
    if (finalized) return;
    if (record.firstRequestByteMs === null) record.firstRequestByteMs = Math.round(elapsedMs());
    record.requestBytes += chunk.length;
    requestHash.update(chunk);
    if (prefixBytes < 65536) {
      const held = chunk.subarray(0, Math.min(chunk.length, 65536 - prefixBytes));
      prefixChunks.push(held);
      prefixBytes += held.length;
    }
  });
  request.on('end', () => {
    requestDone = true;
    record.requestEndMs = Math.round(elapsedMs());
    finalize();
  });
  request.on('aborted', () => {
    requestDone = true;
    record.requestEndMs = Math.round(elapsedMs());
    finalize({ requestAborted: true });
  });
  request.on('error', (error) => {
    requestDone = true;
    finalize({ requestError: error.message }, true);
  });
  response.on('finish', () => {
    responseDone = true;
    record.responseEndMs = Math.round(elapsedMs());
    finalize();
  });
  response.on('close', () => {
    if (!responseDone) {
      responseDone = true;
      record.responseEndMs = Math.round(elapsedMs());
      finalize({ responseClosed: true });
    }
  });

  function send(status, headers, body) {
    record.responseStatus = status;
    record.responseContentType = headers['content-type'] || null;
    record.responseBytes += body.length;
    responseHash.update(body);
    response.writeHead(status, headers);
    response.end(body);
  }

  if (fault === 'http-401') {
    request.resume();
    request.once('end', () => send(401, {
      'content-type': 'text/plain',
      'www-authenticate': 'Basic realm="replica-b-fault"',
      connection: 'close',
    }, Buffer.from('replica B injected authentication failure\n')));
    return;
  }

  if (fault === 'http-404') {
    request.resume();
    request.once('end', () => send(404, { 'content-type': 'text/plain', connection: 'close' },
      Buffer.from('replica B injected missing repository\n')));
    return;
  }

  if (fault === 'reject') {
    request.resume();
    request.once('end', () => {
      const body = rejectionBody(commandRefs(Buffer.concat(prefixChunks)));
      send(200, { 'content-type': 'application/x-git-receive-pack-result' }, body);
    });
    return;
  }

  if (fault === 'disconnect') {
    request.on('data', () => {
      if (record.requestBytes >= DISCONNECT_AFTER_BYTES && !finalized) {
        requestDone = true;
        responseDone = true;
        record.requestEndMs = Math.round(elapsedMs());
        record.responseEndMs = Math.round(elapsedMs());
        finalize({ disconnectedMidPack: true, disconnectAfterBytes: DISCONNECT_AFTER_BYTES }, true);
        request.socket.destroy();
      }
    });
    request.resume();
    return;
  }

  const upstream = http.request({
    host: '127.0.0.1',
    port: GITEA_PORT,
    method: request.method,
    path: request.url,
    headers: requestHeaders(request),
  }, (upstreamResponse) => {
    record.responseStatus = upstreamResponse.statusCode;
    record.responseContentType = upstreamResponse.headers['content-type'] || null;
    response.writeHead(
      upstreamResponse.statusCode || 502,
      upstreamResponse.statusMessage,
      upstreamResponse.headers,
    );
    upstreamResponse.on('data', (chunk) => {
      record.responseBytes += chunk.length;
      responseHash.update(chunk);
    });
    upstreamResponse.pipe(response);
  });
  upstream.on('error', (error) => {
    record.responseStatus = 502;
    if (!response.headersSent) {
      const body = Buffer.from('fault gateway upstream error\n');
      record.responseBytes += body.length;
      responseHash.update(body);
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(body);
    } else {
      response.destroy(error);
    }
  });

  if (fault === 'slow') {
    request.on('data', (chunk) => {
      request.pause();
      upstream.write(chunk, () => setTimeout(() => request.resume(), SLOW_DELAY_MS));
    });
    request.on('end', () => upstream.end());
  } else {
    request.pipe(upstream);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fault gateway ${REPLICA} on http://127.0.0.1:${PORT}`);
  console.log(`forwarding to Gitea ${REPLICA} on http://127.0.0.1:${GITEA_PORT}`);
});
