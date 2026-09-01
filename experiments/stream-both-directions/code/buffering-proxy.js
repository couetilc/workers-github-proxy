'use strict';
// The NEGATIVE CONTROL for the memory claim: a git remote proxy that BUFFERS the
// whole body in each direction before forwarding it -- exactly how the
// git-remote-domain-swap and tls-terminate-reencrypt proxies handled the body
// (they tee'd/concatenated it to inspect it).
//
// It still terminates+re-encrypts TLS and completes every transfer identically to
// streaming-proxy.js. The ONLY difference is that it accumulates:
//   push : Buffer.concat of the entire request body (the packfile) before sending
//   clone: Buffer.concat of the entire response body (the packfile) before sending
//
// Running this alongside the streaming proxy over the same size sweep is what makes
// the streaming result meaningful: it proves the packs really were large (this
// proxy's memory climbs linearly with them) and that the streaming proxy's flat
// memory is due to streaming, not to small inputs.
//
// Env: PORT, TLS_CERT, TLS_KEY, UPSTREAM_ORIGIN, UPSTREAM_CA, UPSTREAM_SERVERNAME.

const https = require('https');
const fs = require('fs');
const { startMemSampler } = require('./memsample');

const PORT = process.env.PORT || 8443;
function req(name) { const v = process.env[name]; if (!v) { console.error(`FATAL: ${name} is required`); process.exit(1); } return v; }
const TLS_CERT = req('TLS_CERT');
const TLS_KEY = req('TLS_KEY');
const UPSTREAM = new URL(req('UPSTREAM_ORIGIN'));
const UPSTREAM_CA = req('UPSTREAM_CA');
const UPSTREAM_SERVERNAME = process.env.UPSTREAM_SERVERNAME || UPSTREAM.hostname;

const upstreamCaPem = fs.readFileSync(UPSTREAM_CA);
const tlsOpts = { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY), minVersion: 'TLSv1.2' };
const mem = startMemSampler(10);

const server = https.createServer(tlsOpts, (creq, cres) => {
  console.log(`>> ${creq.method} ${creq.url}`);
  const reqChunks = [];
  creq.on('data', (c) => reqChunks.push(c));       // BUFFER the whole request body
  creq.on('end', () => {
    const body = Buffer.concat(reqChunks);          // <-- request pack fully in memory
    mem.sample();
    const headers = { ...creq.headers };
    delete headers.host; delete headers.connection;

    const ureq = https.request({
      protocol: UPSTREAM.protocol, hostname: UPSTREAM.hostname, port: UPSTREAM.port,
      method: creq.method, path: creq.url, headers,
      ca: upstreamCaPem, servername: UPSTREAM_SERVERNAME,
      rejectUnauthorized: true, minVersion: 'TLSv1.2',
    }, (ures) => {
      const respChunks = [];
      ures.on('data', (c) => respChunks.push(c));   // BUFFER the whole response body
      ures.on('end', () => {
        const rbody = Buffer.concat(respChunks);     // <-- response pack fully in memory
        mem.sample();
        console.log(`   << upstream ${ures.statusCode} (buffered ${body.length}b req / ${rbody.length}b resp)`);
        cres.writeHead(ures.statusCode, ures.headers);
        cres.end(rbody);
      });
    });
    ureq.on('error', (e) => {
      if (!cres.headersSent) cres.writeHead(502, { 'Content-Type': 'text/plain' });
      cres.end(`proxy: upstream error: ${e.code || e.message}\n`);
    });
    if (body.length) ureq.write(body);
    ureq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`BUFFERING git proxy (control) on https://127.0.0.1:${PORT}/  -> ${UPSTREAM.href}`);
});
