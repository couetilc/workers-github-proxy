'use strict';
// The UPSTREAM: a real HTTPS git server standing in for the proxied service
// (in the roadmap, github.com). It presents a TLS cert (signed by upstream-ca)
// and speaks smart-HTTP by delegating to the real `git http-backend` CGI, the
// same proven pattern as the git-remote-domain-swap experiment.
//
// It is intentionally boring: the experiment's claim is about the PROXY. This
// server only has to (a) require TLS and (b) actually complete git pushes and
// fetches, so that a completed transfer proves the proxy re-encrypted correctly.
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

const tlsOpts = {
  cert: fs.readFileSync(TLS_CERT),
  key: fs.readFileSync(TLS_KEY),
  minVersion: 'TLSv1.2',
};

const server = https.createServer(tlsOpts, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const [pathInfo, queryString = ''] = req.url.split('?');

    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: PROJECT_ROOT,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: queryString,
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] || '',
      REMOTE_ADDR: req.socket.remoteAddress || '127.0.0.1',
      REMOTE_USER: 'proxy',
    };
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol'];

    const cgi = spawn(BACKEND, [], { env });
    const out = [];
    cgi.stdout.on('data', (c) => out.push(c));
    cgi.stderr.on('data', (c) => process.stderr.write('[upstream http-backend] ' + c));
    cgi.on('error', (e) => { res.writeHead(500); res.end('backend spawn error: ' + e.message + '\n'); });
    cgi.on('close', () => {
      const raw = Buffer.concat(out);
      let sep = raw.indexOf('\r\n\r\n'); let sepLen = 4;
      if (sep === -1) { sep = raw.indexOf('\n\n'); sepLen = 2; }
      const headerBlob = sep === -1 ? raw.toString('latin1') : raw.slice(0, sep).toString('latin1');
      const respBody = sep === -1 ? Buffer.alloc(0) : raw.slice(sep + sepLen);
      const headers = {};
      let status = 200;
      for (const line of headerBlob.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') { status = parseInt(v, 10) || 200; continue; }
        headers[k] = v;
      }
      console.log(`[upstream] ${req.method} ${req.url} -> ${status} (${respBody.length}b)`);
      res.writeHead(status, headers);
      res.end(respBody);
    });
    if (body.length) cgi.stdin.write(body);
    cgi.stdin.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`upstream HTTPS git server on https://localhost:${PORT}/  (serving ${PROJECT_ROOT})`);
  console.log(`  cert: ${TLS_CERT}`);
  console.log(`  git-http-backend: ${BACKEND}`);
});
