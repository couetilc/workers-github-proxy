'use strict';

const fs = require('fs');
const http = require('http');
const { once } = require('events');
const {
  PolicyInputError,
  inspectReceivePackPrefix,
  rejectedRef,
} = require('./policy');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = new URL(required('UPSTREAM_ORIGIN'));
const CLIENT_AUTH = required('CLIENT_AUTH');
const UPSTREAM_AUTH = required('UPSTREAM_AUTH');
const STATS_FILE = required('STATS_FILE');
const RUN_LABEL = process.env.RUN_LABEL || 'unlabelled';
const RUN_SIZE_MIB = Number(process.env.RUN_SIZE_MIB || 0);
const MAX_POLICY_PREFIX = Number(process.env.MAX_POLICY_PREFIX || 64 * 1024);

class Measurement {
  constructor(direction, requestPath) {
    this.direction = direction;
    this.requestPath = requestPath;
    this.requestBytes = 0;
    this.responseBytes = 0;
    this.maxPolicyBufferedBytes = 0;
    this.maxRequestQueueBytes = 0;
    this.maxResponseQueueBytes = 0;
    const baseline = process.memoryUsage();
    this.baselineRssBytes = baseline.rss;
    this.baselineHeapUsedBytes = baseline.heapUsed;
    this.baselineExternalBytes = baseline.external;
    this.baselineArrayBuffersBytes = baseline.arrayBuffers;
    this.peakRssBytes = this.baselineRssBytes;
    this.peakHeapUsedBytes = this.baselineHeapUsedBytes;
    this.peakExternalBytes = this.baselineExternalBytes;
    this.peakArrayBuffersBytes = this.baselineArrayBuffersBytes;
    this.startedAt = process.hrtime.bigint();
    this.timer = setInterval(() => this.sample(), 5);
    this.timer.unref();
    this.finished = false;
  }

  sample() {
    const memory = process.memoryUsage();
    this.peakRssBytes = Math.max(this.peakRssBytes, memory.rss);
    this.peakHeapUsedBytes = Math.max(this.peakHeapUsedBytes, memory.heapUsed);
    this.peakExternalBytes = Math.max(this.peakExternalBytes, memory.external);
    this.peakArrayBuffersBytes = Math.max(this.peakArrayBuffersBytes, memory.arrayBuffers);
  }

  finish(statusCode, decision, detail = {}) {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.timer);
    this.sample();
    const elapsedMs = Number(process.hrtime.bigint() - this.startedAt) / 1e6;
    const record = {
      runLabel: RUN_LABEL,
      sizeMiB: RUN_SIZE_MIB,
      direction: this.direction,
      path: this.requestPath,
      statusCode,
      decision,
      requestBytes: this.requestBytes,
      responseBytes: this.responseBytes,
      policyPrefixLimitBytes: MAX_POLICY_PREFIX,
      maxPolicyBufferedBytes: this.maxPolicyBufferedBytes,
      maxRequestQueueBytes: this.maxRequestQueueBytes,
      maxResponseQueueBytes: this.maxResponseQueueBytes,
      baselineRssBytes: this.baselineRssBytes,
      peakRssBytes: this.peakRssBytes,
      rssDeltaBytes: this.peakRssBytes - this.baselineRssBytes,
      heapUsedDeltaBytes: this.peakHeapUsedBytes - this.baselineHeapUsedBytes,
      externalDeltaBytes: this.peakExternalBytes - this.baselineExternalBytes,
      arrayBuffersDeltaBytes: this.peakArrayBuffersBytes - this.baselineArrayBuffersBytes,
      elapsedMs: Math.round(elapsedMs),
      ...detail,
    };
    fs.appendFileSync(STATS_FILE, `${JSON.stringify(record)}\n`);
    console.log(JSON.stringify(record));
  }
}

function isReceivePack(pathname) {
  return pathname.endsWith('/git-receive-pack');
}

function isUploadPack(pathname) {
  return pathname.endsWith('/git-upload-pack');
}

function proxyHeaders(headers) {
  const result = { ...headers, authorization: UPSTREAM_AUTH };
  for (const name of [
    'host', 'connection', 'proxy-connection', 'expect', 'content-length',
    'transfer-encoding', 'te', 'trailer', 'upgrade',
  ]) delete result[name];
  return result;
}

function responseHeaders(headers) {
  const result = { ...headers };
  for (const name of [
    'connection', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  ]) delete result[name];
  return result;
}

async function writeWithBackpressure(destination, chunk, measurement) {
  if (!chunk.length) return;
  const writable = destination.write(chunk);
  measurement.maxRequestQueueBytes = Math.max(
    measurement.maxRequestQueueBytes,
    destination.writableLength || 0,
  );
  measurement.sample();
  if (!writable) await once(destination, 'drain');
}

function streamResponse(upstreamResponse, clientResponse, measurement, resolve, reject) {
  clientResponse.writeHead(
    upstreamResponse.statusCode || 502,
    responseHeaders(upstreamResponse.headers),
  );

  upstreamResponse.on('data', (chunk) => {
    measurement.responseBytes += chunk.length;
    const writable = clientResponse.write(chunk);
    measurement.maxResponseQueueBytes = Math.max(
      measurement.maxResponseQueueBytes,
      clientResponse.writableLength || 0,
    );
    measurement.sample();
    if (!writable) upstreamResponse.pause();
  });
  clientResponse.on('drain', () => upstreamResponse.resume());
  upstreamResponse.on('end', () => {
    clientResponse.end();
    resolve(upstreamResponse.statusCode || 502);
  });
  upstreamResponse.on('error', (error) => {
    clientResponse.destroy(error);
    reject(error);
  });
}

function openUpstream(clientRequest, clientResponse, measurement) {
  let upstreamRequest;
  const completed = new Promise((resolve, reject) => {
    upstreamRequest = http.request({
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      method: clientRequest.method,
      path: clientRequest.url,
      headers: proxyHeaders(clientRequest.headers),
    }, (upstreamResponse) => {
      streamResponse(upstreamResponse, clientResponse, measurement, resolve, reject);
    });
    upstreamRequest.on('error', reject);
  });
  return { upstreamRequest, completed };
}

async function readPolicyPrelude(clientRequest, measurement) {
  const iterator = clientRequest[Symbol.asyncIterator]();
  const held = [];
  let heldBytes = 0;

  while (true) {
    const { value: chunk, done } = await iterator.next();
    if (done) throw new PolicyInputError('receive-pack body ended before command flush');
    held.push(chunk);
    heldBytes += chunk.length;
    measurement.requestBytes += chunk.length;
    measurement.maxPolicyBufferedBytes = Math.max(
      measurement.maxPolicyBufferedBytes,
      heldBytes,
    );
    measurement.sample();

    const combined = Buffer.concat(held, heldBytes);
    const inspected = inspectReceivePackPrefix(combined);
    if (inspected.complete) return { iterator, held, inspected };
    if (heldBytes > MAX_POLICY_PREFIX) {
      throw new PolicyInputError(
        `receive-pack command prelude exceeds ${MAX_POLICY_PREFIX} bytes`,
        413,
      );
    }
  }
}

function sendLocal(clientRequest, clientResponse, statusCode, message) {
  clientRequest.resume();
  clientResponse.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  clientResponse.end(`${message}\n`);
}

async function handle(clientRequest, clientResponse) {
  const receivePack = isReceivePack(clientRequest.url);
  const uploadPack = isUploadPack(clientRequest.url);
  const direction = receivePack ? 'push' : uploadPack ? 'clone' : 'discovery';
  const measured = receivePack || uploadPack;
  const measurement = new Measurement(direction, clientRequest.url);

  if (clientRequest.headers.authorization !== CLIENT_AUTH) {
    sendLocal(clientRequest, clientResponse, 401, 'proxy authentication required');
    if (measured) measurement.finish(401, 'auth-rejected');
    else clearInterval(measurement.timer);
    return;
  }

  let iterator = clientRequest[Symbol.asyncIterator]();
  let held = [];
  let commandCount = 0;

  if (receivePack) {
    try {
      const prelude = await readPolicyPrelude(clientRequest, measurement);
      iterator = prelude.iterator;
      held = prelude.held;
      commandCount = prelude.inspected.commands.length;
      const denied = rejectedRef(prelude.inspected.commands);
      if (denied) {
        sendLocal(clientRequest, clientResponse, 403, `ref policy rejects ${denied.ref}`);
        measurement.finish(403, 'policy-rejected', { rejectedRef: denied.ref, commandCount });
        return;
      }
    } catch (error) {
      const statusCode = error instanceof PolicyInputError ? error.statusCode : 500;
      sendLocal(clientRequest, clientResponse, statusCode, error.message);
      measurement.finish(statusCode, 'policy-input-rejected', { error: error.message });
      return;
    }
  }

  const { upstreamRequest, completed } = openUpstream(
    clientRequest,
    clientResponse,
    measurement,
  );

  try {
    for (const chunk of held) await writeWithBackpressure(upstreamRequest, chunk, measurement);
    held = [];

    for await (const chunk of iterator) {
      measurement.requestBytes += chunk.length;
      await writeWithBackpressure(upstreamRequest, chunk, measurement);
    }
    upstreamRequest.end();
    const statusCode = await completed;
    if (measured) measurement.finish(statusCode, 'allowed', { commandCount });
    else clearInterval(measurement.timer);
  } catch (error) {
    upstreamRequest.destroy();
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      clientResponse.end('upstream streaming failure\n');
    } else {
      clientResponse.destroy(error);
    }
    if (measured) measurement.finish(502, 'stream-error', { error: error.message });
    else clearInterval(measurement.timer);
  }
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(error.stack || error);
    if (!response.headersSent) response.writeHead(500);
    response.end('proxy internal error\n');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`streaming proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`upstream: ${UPSTREAM.href}; policy-prefix limit: ${MAX_POLICY_PREFIX} bytes`);
});
