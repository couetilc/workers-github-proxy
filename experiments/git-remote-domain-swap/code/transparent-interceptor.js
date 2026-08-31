'use strict';
// A TRANSPARENT (man-in-the-middle) interceptor. It IS a working git server:
// every request is proxied to the real `git http-backend` CGI against bare
// repos we own, so pushes and fetches actually COMPLETE. Because the bytes flow
// through us, we log and decode the full request AND response bodies -- this is
// where the packfile (the real object data) becomes visible and storable.
//
// This is the miniature of the project's inbound push path: a thin streaming
// proxy for smart-HTTP (info/refs + git-receive-pack) sitting on a swapped
// remote host, teeing the packfile as it passes.
//
// Env:
//   PORT              listen port (default 8081)
//   GIT_PROJECT_ROOT  directory holding the bare <repo>.git dirs to serve
//   DUMP_DIR          if set, carve any received packfile to $DUMP_DIR/intercepted.pack

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { describeBody } = require('./wire');

const PORT = process.env.PORT || 8081;
const PROJECT_ROOT = process.env.GIT_PROJECT_ROOT || path.join(__dirname, '_work', 'bare-repos');
const DUMP_DIR = process.env.DUMP_DIR || '';

// git-http-backend is not on PATH; it lives under git's exec-path, which differs
// by platform and install (e.g. /usr/lib/git-core on Debian,
// /opt/homebrew/.../libexec/git-core or the CommandLineTools path on macOS). Ask
// git itself where it is rather than hardcoding a Linux path.
function resolveBackend() {
  const candidates = [];
  if (process.env.GIT_HTTP_BACKEND) candidates.push(process.env.GIT_HTTP_BACKEND);
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (execPath.status === 0 && execPath.stdout) {
    candidates.push(path.join(execPath.stdout.trim(), 'git-http-backend'));
  }
  candidates.push('/usr/lib/git-core/git-http-backend'); // last-resort fallback
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  console.error('FATAL: could not locate git-http-backend. Tried:\n  ' +
    candidates.join('\n  ') +
    '\nSet GIT_HTTP_BACKEND to its path, or check `git --exec-path`.');
  process.exit(1);
}
const BACKEND = resolveBackend();

function log(...a) { console.log(...a); }

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const reqBody = Buffer.concat(chunks);
    const [pathInfo, queryString = ''] = req.url.split('?');

    log('\n' + '='.repeat(72));
    log(`>> ${req.method} ${req.url}`);
    log('   git-protocol:', req.headers['git-protocol'] || '(v0/v1)',
        '| content-type:', req.headers['content-type'] || '-',
        '| user-agent:', req.headers['user-agent'] || '-');
    if (reqBody.length) {
      log(`   -- REQUEST body (${reqBody.length} bytes) --`);
      log(describeBody(reqBody));
      // Carve out any trailing packfile and drop it to disk so we can prove the
      // intercepted bytes alone reconstruct the sender's objects.
      if (DUMP_DIR) {
        const packAt = reqBody.indexOf(Buffer.from('PACK'));
        if (packAt !== -1) {
          const fs = require('fs');
          fs.mkdirSync(DUMP_DIR, { recursive: true });
          const out = path.join(DUMP_DIR, 'intercepted.pack');
          fs.writeFileSync(out, reqBody.slice(packAt));
          log(`   -- carved packfile -> ${out} (${reqBody.length - packAt} bytes) --`);
        }
      }
    }

    // Translate HTTP request into the CGI environment git-http-backend expects.
    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: PROJECT_ROOT,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: queryString,
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] || '',
      REMOTE_ADDR: req.socket.remoteAddress || '127.0.0.1',
      REMOTE_USER: 'interceptor',
    };
    // Forward protocol-v2 negotiation so modern git stays on the v2 path.
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol'];

    const cgi = spawn(BACKEND, [], { env });
    const outChunks = [];
    cgi.stdout.on('data', (c) => outChunks.push(c));
    cgi.stderr.on('data', (c) => process.stderr.write('[http-backend stderr] ' + c));
    cgi.on('error', (e) => {
      log('   !! failed to spawn backend:', e.message);
      res.writeHead(500); res.end('backend spawn error\n');
    });
    cgi.on('close', () => {
      const raw = Buffer.concat(outChunks);
      // CGI output = header lines, blank line, then body.
      let sep = raw.indexOf('\r\n\r\n');
      let sepLen = 4;
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

      log(`   << ${status} ${headers['Content-Type'] || ''} (${respBody.length} body bytes)`);
      if (respBody.length) {
        log('   -- RESPONSE body decoded --');
        log(describeBody(respBody));
      }

      res.writeHead(status, headers);
      res.end(respBody);
    });
    if (reqBody.length) cgi.stdin.write(reqBody);
    cgi.stdin.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`transparent git backend on http://127.0.0.1:${PORT}/  (serving ${PROJECT_ROOT})`);
  log(`using git-http-backend: ${BACKEND}`);
  if (DUMP_DIR) log(`packfiles will be carved to ${DUMP_DIR}/intercepted.pack`);
});
