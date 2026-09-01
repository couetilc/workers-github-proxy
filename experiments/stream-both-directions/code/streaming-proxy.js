'use strict';
// THE SUBJECT. A git remote proxy that terminates the client's TLS, re-encrypts
// to the upstream, and moves BOTH directions through a fixed, small memory budget:
//
//   push : the unbounded packfile rides in the REQUEST  (client -> upstream)
//   clone: the unbounded packfile rides in the RESPONSE (upstream -> client)
//
// The predecessor experiments (git-remote-domain-swap, tls-terminate-reencrypt)
// proxied by BUFFERING the whole body to inspect it. This proxy never does. The
// insight it demonstrates: being on the byte path does not mean holding the pack.
//
//   1. HEADER-LEVEL AUTH is decided from request headers alone, before a single
//      body byte is read. Rejected requests read zero pack bytes.
//   2. FRONT-OF-STREAM REF POLICY reads only the receive-pack command section (the
//      ref-update pkt-lines that PRECEDE the pack, terminated by a flush), decides
//      allow/deny from that bounded prefix, then forwards the packfile as an
//      opaque stream it never accumulates.
//   3. Both legs FORWARD WITH BACKPRESSURE: at most one chunk plus a bounded head
//      window is ever in flight. Memory stays flat as the pack grows.
//
// Compare against buffering-proxy.js (same transfers, buffers both directions) to
// see flat-vs-linear memory. Both complete the transfer; only memory differs.
//
// Env:
//   PORT                listen port for the client leg (default 8443)
//   TLS_CERT/TLS_KEY    the proxy's leaf cert + key (signed by proxy-ca)   [required]
//   UPSTREAM_ORIGIN     where to re-encrypt to, e.g. https://localhost:9443 [required]
//   UPSTREAM_CA         CA file used to VERIFY the upstream cert            [required]
//   UPSTREAM_SERVERNAME SNI + hostname to validate upstream against (default: UPSTREAM host)
//   AUTH_TOKEN          required basic-auth password (git sends x:<token>)  [required]
//   LOCKED_REF          a ref the front-of-stream policy refuses to update  (default refs/heads/locked)
//   MAX_HEAD_BYTES      hard cap on the buffered command-section window      (default 1048576)

const https = require('https');
const fs = require('fs');
const { scanReceivePackCommands } = require('./wire');
const { startMemSampler } = require('./memsample');

const PORT = process.env.PORT || 8443;

function req(name) {
  const v = process.env[name];
  if (!v) { console.error(`FATAL: ${name} is required`); process.exit(1); }
  return v;
}
const TLS_CERT = req('TLS_CERT');
const TLS_KEY = req('TLS_KEY');
const UPSTREAM = new URL(req('UPSTREAM_ORIGIN'));
const UPSTREAM_CA = req('UPSTREAM_CA');
const AUTH_TOKEN = req('AUTH_TOKEN');
const UPSTREAM_SERVERNAME = process.env.UPSTREAM_SERVERNAME || UPSTREAM.hostname;
const LOCKED_REF = process.env.LOCKED_REF || 'refs/heads/locked';
const MAX_HEAD = parseInt(process.env.MAX_HEAD_BYTES || String(1024 * 1024), 10);

const upstreamCaPem = fs.readFileSync(UPSTREAM_CA);
const tlsOpts = { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY), minVersion: 'TLSv1.2' };
const mem = startMemSampler(10);

// --- header-level auth: git basic auth "x:<token>" -> we check the password ----
function authOk(creq) {
  const h = creq.headers['authorization'] || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return pass === AUTH_TOKEN;
}

// --- front-of-stream ref policy: decided from the command section alone ---------
function policy(commands) {
  for (const c of commands) {
    if (c.ref === LOCKED_REF) {
      return { ok: false, reason: `ref ${c.ref} is locked (front-of-stream policy)` };
    }
  }
  return { ok: true };
}

const server = https.createServer(tlsOpts, (creq, cres) => {
  const pathOnly = creq.url.split('?')[0];
  console.log('\n' + '='.repeat(72));
  console.log(`>> ${creq.method} ${creq.url}`);

  // (1) AUTH from HEADERS ONLY -- before we read any body byte.
  if (!authOk(creq)) {
    console.log('   AUTH-DENY: no/invalid credentials -> 401 (0 body bytes read)');
    cres.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git-proxy"', 'Content-Type': 'text/plain' });
    cres.end('proxy: authentication required\n');
    creq.resume(); // drain anything already in flight without buffering
    return;
  }

  // Upstream leg: fresh, independently verified TLS. The client's Authorization is
  // STRIPPED here -- the client's proxy token never reaches the upstream (roadmap:
  // the proxy mints its own upstream auth). This upstream is open, so none is added.
  const headers = { ...creq.headers };
  delete headers.host; delete headers.connection; delete headers.authorization;

  const ureq = https.request({
    protocol: UPSTREAM.protocol, hostname: UPSTREAM.hostname, port: UPSTREAM.port,
    method: creq.method, path: creq.url, headers,
    ca: upstreamCaPem, servername: UPSTREAM_SERVERNAME,
    rejectUnauthorized: true, minVersion: 'TLSv1.2',
  }, (ures) => {
    // (3b) RESPONSE DIRECTION -- clone/fetch pack rides here. Stream it back with
    // backpressure; never accumulate. pipe() bounds in-flight bytes to the stream
    // high-water marks, so proxy memory is independent of response size.
    console.log(`   << upstream ${ures.statusCode} ${ures.headers['content-type'] || ''} -- streaming response body back (not buffered)`);
    cres.writeHead(ures.statusCode, ures.headers);
    ures.pipe(cres);
  });
  ureq.on('error', (e) => {
    console.log(`   !! upstream leg failed: ${e.code || ''} ${e.message}`);
    if (!cres.headersSent) cres.writeHead(502, { 'Content-Type': 'text/plain' });
    cres.end(`proxy: upstream error: ${e.code || e.message}\n`);
  });

  const isReceivePack = creq.method === 'POST' && /\/git-receive-pack$/.test(pathOnly);
  if (!isReceivePack) {
    // info/refs and upload-pack: no receive command section to police. The request
    // body (upload-pack wants/haves) is bounded by ref count, not pack size; stream
    // it straight through.
    creq.pipe(ureq);
    return;
  }

  // (2)+(3a) RECEIVE-PACK: police the command section at the FRONT of the stream,
  // then forward the packfile as an opaque stream with backpressure.
  let head = Buffer.alloc(0);
  let phase = 'head'; // head -> forward | deny
  let drained = 0;

  const forwardChunk = (chunk) => {
    if (!ureq.write(chunk)) { creq.pause(); ureq.once('drain', () => creq.resume()); }
  };

  const deny = (status, reason) => {
    phase = 'deny';
    console.log(`   POLICY DENY (${reason})`);
    console.log(`   decided from ${head.length} head bytes; the packfile will be DRAINED, never buffered`);
    ureq.destroy(); // don't forward anything upstream
    if (!cres.headersSent) cres.writeHead(status, { 'Content-Type': 'text/plain' });
    head = Buffer.alloc(0); // release the tiny head window
  };

  creq.on('data', (chunk) => {
    if (phase === 'forward') return forwardChunk(chunk);
    if (phase === 'deny') { drained += chunk.length; return; } // discard: bounded memory even while rejecting
    // phase === 'head': accumulate only until the command section is complete.
    head = head.length ? Buffer.concat([head, chunk]) : chunk;
    const scan = scanReceivePackCommands(head);
    if (!scan.done) {
      if (head.length > MAX_HEAD) deny(413, 'command section exceeds bounded window');
      return;
    }
    const verdict = policy(scan.commands);
    if (!verdict.ok) return deny(403, verdict.reason);
    // Allowed: forward the command section + any pack bytes already in `head`, then
    // switch to opaque streaming. `head` here is bounded by the command section
    // (one socket read), never by the pack.
    phase = 'forward';
    if (scan.commands.length === 0) {
      console.log(`   POLICY ALLOW: preflight, no ref updates (policed ${scan.commandBytes} bytes)`);
    } else {
      console.log(`   POLICY ALLOW: [${scan.commands.map((c) => `${c.isDelete ? 'delete ' : ''}${c.ref}`).join(', ')}] ` +
                  `-- policed ${scan.commandBytes} command bytes, pack now streams through`);
    }
    const buffered = head; head = null;
    forwardChunk(buffered);
  });

  creq.on('end', () => {
    if (phase === 'forward') ureq.end();
    else if (phase === 'deny') {
      console.log(`   drained + discarded ${drained} pack bytes after the DENY (peak memory unaffected)`);
      cres.end(`proxy: push rejected by ref policy\n`);
    } else {
      // Never reached a flush (empty/truncated command section) -- forward as-is.
      if (head && head.length) ureq.write(head);
      ureq.end();
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`STREAMING git proxy on https://127.0.0.1:${PORT}/`);
  console.log(`  upstream leg -> ${UPSTREAM.href} (verify against ${UPSTREAM_CA}, servername=${UPSTREAM_SERVERNAME})`);
  console.log(`  auth: required (basic x:<token>) | locked ref: ${LOCKED_REF} | head window cap: ${MAX_HEAD} bytes`);
});
