'use strict';
// The UPSTREAM: a real HTTPS git server standing in for the proxied service
// (in the roadmap, github.com). It presents a TLS cert (signed by upstream-ca)
// and speaks smart-HTTP by delegating to the real `git http-backend` CGI.
//
// This is a STREAMING variant of the tls-terminate-reencrypt upstream. The
// predecessor buffered the whole request body and the whole CGI response; here we
//   * stream the request body straight into `git-http-backend` stdin, and
//   * parse only the CGI header block from the FRONT of its stdout, then stream
//     the remainder (for a clone, the unbounded packfile) to the response.
// That matters because the experiment measures the PROXY on a real large clone:
// the upstream has to actually emit a big response as a stream, or the proxy's
// response-path streaming would never be exercised.
//
// It is intentionally boring: the experiment's claim is about the proxy. This
// server only has to (a) require TLS and (b) complete git pushes/fetches.
//
// Env:
//   PORT              listen port (default 9443)
//   TLS_CERT/TLS_KEY  PEM paths for this server's leaf cert + key (required)
//   GIT_PROJECT_ROOT  directory holding the bare <repo>.git dirs to serve
//   GIT_HTTP_BACKEND  optional explicit path to git-http-backend

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.PORT || 9443;
const PROJECT_ROOT = process.env.GIT_PROJECT_ROOT || path.join(__dirname, '_work', 'bare-repos');

function req(name) {
  const v = process.env[name];
  if (!v) { console.error(`FATAL: ${name} is required`); process.exit(1); }
  return v;
}
const TLS_CERT = req('TLS_CERT');
const TLS_KEY = req('TLS_KEY');

// Locate git-http-backend via git's exec-path (portable across distros/macOS).
function resolveBackend() {
  const candidates = [];
  if (process.env.GIT_HTTP_BACKEND) candidates.push(process.env.GIT_HTTP_BACKEND);
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (execPath.status === 0 && execPath.stdout) {
    candidates.push(path.join(execPath.stdout.trim(), 'git-http-backend'));
  }
  candidates.push('/usr/lib/git-core/git-http-backend');
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  console.error('FATAL: could not locate git-http-backend. Tried:\n  ' + candidates.join('\n  '));
  process.exit(1);
}
const BACKEND = resolveBackend();

function parseCgiHeaders(blob) {
  const headers = {};
  let status = 200;
  for (const line of blob.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k.toLowerCase() === 'status') { status = parseInt(v, 10) || 200; continue; }
    headers[k] = v;
  }
  return { status, headers };
}

const tlsOpts = {
  cert: fs.readFileSync(TLS_CERT),
  key: fs.readFileSync(TLS_KEY),
  minVersion: 'TLSv1.2',
};

const server = https.createServer(tlsOpts, (creq, cres) => {
  const [pathInfo, queryString = ''] = creq.url.split('?');
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: PROJECT_ROOT,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: pathInfo,
    QUERY_STRING: queryString,
    REQUEST_METHOD: creq.method,
    CONTENT_TYPE: creq.headers['content-type'] || '',
    REMOTE_ADDR: creq.socket.remoteAddress || '127.0.0.1',
    REMOTE_USER: 'proxy',
  };
  if (creq.headers['git-protocol']) env.GIT_PROTOCOL = creq.headers['git-protocol'];

  const cgi = spawn(BACKEND, [], { env });
  cgi.on('error', (e) => { if (!cres.headersSent) cres.writeHead(500); cres.end('backend spawn error: ' + e.message + '\n'); });
  cgi.stderr.on('data', (c) => process.stderr.write('[upstream backend] ' + c));

  // Stream the (possibly huge push) request body directly into the CGI.
  creq.pipe(cgi.stdin);

  // Parse the CGI header block from the front of stdout, then STREAM the rest.
  let head = Buffer.alloc(0);
  let sentHead = false;
  const MAX_HEAD = 64 * 1024;
  cgi.stdout.on('data', (chunk) => {
    if (sentHead) {
      if (!cres.write(chunk)) cgi.stdout.pause();
      return;
    }
    head = head.length ? Buffer.concat([head, chunk]) : chunk;
    let sep = head.indexOf('\r\n\r\n'); let sepLen = 4;
    if (sep === -1) { sep = head.indexOf('\n\n'); sepLen = 2; }
    if (sep === -1) {
      if (head.length > MAX_HEAD) { // pathological: give up parsing, pass raw
        cres.writeHead(200); sentHead = true;
        if (!cres.write(head)) cgi.stdout.pause();
      }
      return;
    }
    const { status, headers } = parseCgiHeaders(head.slice(0, sep).toString('latin1'));
    const rest = head.slice(sep + sepLen);
    cres.writeHead(status, headers);
    sentHead = true;
    if (rest.length && !cres.write(rest)) cgi.stdout.pause();
  });
  cres.on('drain', () => cgi.stdout.resume());
  cgi.stdout.on('end', () => {
    if (!sentHead) cres.writeHead(200);
    cres.end();
  });
  console.log(`[upstream] ${creq.method} ${creq.url}`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`upstream HTTPS git server (streaming) on https://localhost:${PORT}/  (serving ${PROJECT_ROOT})`);
  console.log(`  cert: ${TLS_CERT}`);
  console.log(`  git-http-backend: ${BACKEND}`);
});
