'use strict';
// The experiment's subject: a git remote proxy that TERMINATES the client's TLS
// and RE-ENCRYPTS to the upstream service, working on the plaintext smart-HTTP
// exchange in between. This is the roadmap's core transport claim in miniature:
//
//   "HTTPS-only. The proxy terminates TLS at the edge and works on the plaintext
//    smart-HTTP exchange -- the only architecture that supports buffering and
//    replay."
//
// Two independently authenticated TLS legs meet here:
//
//   git client  --TLS(proxy leaf, trusted via proxy-ca)-->  [ PROXY ]  --TLS(upstream leaf, verified via upstream-ca)-->  upstream
//                    client leg: WE terminate it                            upstream leg: WE originate + verify it
//
// Between the legs the bytes are plaintext git smart-HTTP, so we can decode the
// pkt-lines, see the packfile, and (with DUMP_DIR) carve it to disk -- the thing
// a tunnel (SNI/TCP passthrough) could never do. We tee the request body while
// STREAMING it upstream, mirroring "thin streaming proxy, no packfile parsing on
// the hot path": inspection reads a copy, forwarding never waits on it.
//
// Env:
//   PORT                listen port for the client leg (default 8443)
//   TLS_CERT/TLS_KEY    the proxy's leaf cert + key (signed by proxy-ca)   [required]
//   UPSTREAM_ORIGIN     where to re-encrypt to, e.g. https://localhost:9443 [required]
//   UPSTREAM_CA         CA file used to VERIFY the upstream cert            [required]
//   UPSTREAM_SERVERNAME SNI + hostname to validate upstream against (default: UPSTREAM_ORIGIN host)
//   DUMP_DIR            if set, carve any plaintext packfile here

const https = require('https');
const fs = require('fs');
const path = require('path');
const { describeBody } = require('./wire');

const PORT = process.env.PORT || 8443;
const DUMP_DIR = process.env.DUMP_DIR || '';

function req(name) {
  const v = process.env[name];
  if (!v) { console.error(`FATAL: ${name} is required`); process.exit(1); }
  return v;
}
const TLS_CERT = req('TLS_CERT');
const TLS_KEY = req('TLS_KEY');
const UPSTREAM = new URL(req('UPSTREAM_ORIGIN'));
const UPSTREAM_CA = req('UPSTREAM_CA');
const UPSTREAM_SERVERNAME = process.env.UPSTREAM_SERVERNAME || UPSTREAM.hostname;

const upstreamCaPem = fs.readFileSync(UPSTREAM_CA);

const tlsOpts = {
  cert: fs.readFileSync(TLS_CERT),
  key: fs.readFileSync(TLS_KEY),
  minVersion: 'TLSv1.2',
};

const server = https.createServer(tlsOpts, (creq, cres) => {
  const sock = creq.socket;
  console.log('\n' + '='.repeat(72));
  console.log(`>> ${creq.method} ${creq.url}`);
  // Prove the client leg is real, terminated TLS -- not a passthrough tunnel.
  console.log(`   client-leg TLS: ${sock.getProtocol && sock.getProtocol()} ` +
    `cipher=${sock.getCipher && sock.getCipher().name} ` +
    `sni=${sock.servername || '(none/IP)'}`);
  console.log('   git-protocol:', creq.headers['git-protocol'] || '(v0/v1)',
    '| content-type:', creq.headers['content-type'] || '-',
    '| user-agent:', creq.headers['user-agent'] || '-');

  // Build the upstream request headers: pass through, but drop hop-by-hop and
  // the client's Host (Node sets Host from the upstream target).
  const headers = { ...creq.headers };
  delete headers.host;
  delete headers.connection;

  const upOpts = {
    protocol: UPSTREAM.protocol,
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port,
    method: creq.method,
    path: creq.url,
    headers,
    // The re-encrypt leg: originate a fresh TLS session and VERIFY the upstream
    // against its own CA. rejectUnauthorized:true is the whole point -- the proxy
    // authenticates the service exactly as a normal client would.
    ca: upstreamCaPem,
    servername: UPSTREAM_SERVERNAME,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };

  const ureq = https.request(upOpts, (ures) => {
    console.log(`   << upstream ${ures.statusCode} ${ures.headers['content-type'] || ''}`);
    let respBytes = 0;
    ures.on('data', (c) => { respBytes += c.length; });
    ures.on('end', () => console.log(`   << streamed ${respBytes} response bytes back over the client TLS session`));
    cres.writeHead(ures.statusCode, ures.headers);
    ures.pipe(cres); // stream the (re-encrypted-from-upstream, plaintext-to-us) body back to the client
  });

  ureq.on('error', (e) => {
    // Fail closed. In control C (proxy given the wrong upstream CA) this is where
    // the re-encrypt leg refuses to trust an unverifiable upstream.
    console.log(`   !! upstream leg failed: ${e.code || ''} ${e.message}`);
    if (!cres.headersSent) cres.writeHead(502, { 'Content-Type': 'text/plain' });
    cres.end(`proxy: upstream TLS/connection error: ${e.code || e.message}\n`);
  });

  // Tee: forward each plaintext chunk upstream immediately, keep a copy to decode.
  const teed = [];
  creq.on('data', (c) => { teed.push(c); ureq.write(c); });
  creq.on('end', () => {
    ureq.end();
    const body = Buffer.concat(teed);
    if (body.length) {
      console.log(`   -- plaintext request body seen at the proxy (${body.length} bytes) --`);
      console.log(describeBody(body));
      if (DUMP_DIR) {
        const packAt = body.indexOf(Buffer.from('PACK'));
        if (packAt !== -1) {
          fs.mkdirSync(DUMP_DIR, { recursive: true });
          const out = path.join(DUMP_DIR, 'intercepted-plaintext.pack');
          fs.writeFileSync(out, body.slice(packAt));
          console.log(`   -- carved plaintext packfile -> ${out} (${body.length - packAt} bytes) --`);
        }
      }
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`TLS-terminating re-encrypt proxy on https://127.0.0.1:${PORT}/`);
  console.log(`  client leg  : presents ${TLS_CERT}`);
  console.log(`  upstream leg: re-encrypts to ${UPSTREAM.href} verifying against ${UPSTREAM_CA} (servername=${UPSTREAM_SERVERNAME})`);
  if (DUMP_DIR) console.log(`  plaintext packfiles carved to ${DUMP_DIR}/intercepted-plaintext.pack`);
});
