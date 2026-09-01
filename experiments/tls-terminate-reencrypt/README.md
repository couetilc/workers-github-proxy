# Experiment: terminate TLS, then re-encrypt, in a git remote proxy

**Question.** Can a git remote proxy **terminate** the client's TLS, work on the
**plaintext** git smart-HTTP exchange, and then **re-encrypt** and pass the request
on to the proxied upstream service — with the transfer actually completing and both
TLS legs genuinely authenticated?

**Short answer.** Yes. A Node HTTPS server presenting a cert the client trusts
terminates the client leg; the decrypted smart-HTTP is fully readable in the middle
(we decode the pkt-lines and carve the packfile); and the proxy originates a *fresh,
independently verified* TLS session to the upstream and streams the bytes through.
`git push` and `git fetch` complete, and the pushed objects land upstream.

- The **client leg** (git → proxy) is terminated by us: real TLSv1.3, our cert,
  verified by git against the CA we told it to trust. We hold plaintext.
- The **upstream leg** (proxy → upstream) is a new TLS session *we* originate and
  *we* verify — against a **different** CA, exactly as the real product verifies
  `github.com` against a public CA independent of whoever issues its own edge cert.

What makes this the load-bearing mechanic: terminating (not tunneling) is the only
way the proxy gets plaintext, and plaintext is what buffering and replay require.
Three negative controls confirm the identity checks are real, not switched off.

## Why this experiment lives in this repo

The predecessor experiment ([`git-remote-domain-swap`](../git-remote-domain-swap))
established that swapping a remote's domain redirects git, and that over `http://`
the payload is fully exposed — *"what protects a real push is the transport's
identity check, not git"*. Its conclusion #2 is the setup for this one: on `https://`
the swapped host **must** present a valid cert for its own domain and re-establish
trust to the upstream. The roadmap makes it a hard commitment:

> **HTTPS-only.** The proxy terminates TLS at the edge and works on the plaintext
> smart-HTTP exchange — the only architecture that supports buffering and replay.
> The proxy's server-side mapping mints short-lived scoped tokens…

This experiment is the smallest end-to-end validation of that transport line, done
locally on loopback with a throwaway PKI.

## Background: what "terminate then re-encrypt" has to mean here

A TLS-terminating proxy is deliberately a man-in-the-middle. Three things must all
hold for it to be a *legitimate* one for git:

1. **The client must accept it.** git validates the proxy's cert (chain + hostname)
   against its trust store. A bare host swap to an impostor with no valid cert fails
   here — this is the protection the predecessor identified.
2. **We must see plaintext.** Once terminated, the body is ordinary git smart-HTTP:
   `GET info/refs`, then `POST git-receive-pack` (ref-update pkt-lines + a `PACK…`
   packfile). If we can decode and store those bytes, buffer/replay is possible. A
   pure TCP/SNI passthrough routes on SNI **without** decrypting and could not.
3. **We must re-encrypt with our own verification.** The proxy is a normal HTTPS
   client to the upstream: it originates a new session and verifies the upstream's
   cert. It does not — cannot — forward the client's TLS session; trust is
   re-established leg by leg.

## Experimental design

Everything runs on `127.0.0.1` with a throwaway PKI and disposable repos in a temp
dir. All parts are under [`code/`](./code):

| Component | File | Role |
|---|---|---|
| PKI | `gen-certs.sh` | Two independent CAs; a leaf for the proxy, a leaf for the upstream (see trust model below). |
| Upstream | `upstream-server.js` | An HTTPS git server (TLS + real `git http-backend`) standing in for the proxied service (github.com). Intentionally boring. |
| **Proxy** | `tls-reencrypt-proxy.js` | **The subject.** Terminates the client's TLS, decodes/carves the plaintext, and re-encrypts to the upstream over a freshly verified TLS session. |
| Wire decoder | `wire.js` | pkt-line + packfile decoder (copied from the predecessor) so captured plaintext is legible. |

**Trust model — two CAs on purpose.** The two legs authenticate against *different*
roots, which is how production actually looks (git trusts a public CA for
`git.cloud`; the proxy independently trusts a public CA for `github.com`):

```
                proxy-ca  ── signs ──▶  proxy leaf        upstream-ca ── signs ──▶ upstream leaf
                    ▲                       │                   ▲                       │
   git trusts ──────┘                       ▼                   │                       ▼
                                    ┌──────────────┐            │              ┌──────────────┐
   git client ──TLS (verified via ─▶│    PROXY     │──TLS (verified via ───────▶│   UPSTREAM   │
                proxy-ca) ──────────│  terminate + │  upstream-ca) ─────────────│  git server  │
                                    │  re-encrypt  │                            └──────────────┘
                                    └──────────────┘
                                     plaintext here
```

**SANs (chosen to run root-free, and to enable a control):**
- proxy leaf: `IP:127.0.0.1, DNS:proxy.git.local` — client connects to `127.0.0.1`.
  `localhost` is **deliberately absent** (see control B).
- upstream leaf: `DNS:localhost, IP:127.0.0.1` — proxy connects to `localhost`.

**The subject repo** is a throwaway with a planted, **fake** secret
(`API_TOKEN=hunter2-not-real`) so we can watch that exact string appear *in
plaintext at the proxy* and reconstruct it from the carved packfile.

**Procedure** (automated in [`code/run.sh`](./code/run.sh)):

1. Mint the PKI; build the source repo; create a fresh empty upstream bare repo (so
   the initial push carries a **complete**, non-thin pack that reconstructs cleanly).
2. Start the upstream HTTPS git server and the re-encrypt proxy.
3. **MAIN:** point `origin` at the proxy (`https://127.0.0.1:8443/…`), trusting only
   `proxy-ca`, verification **on**. `push`, then `ls-remote`. Observe the proxy's
   plaintext capture; confirm the upstream repo received it; reconstruct the payload
   from the carved plaintext pack alone.
4. **Three negative controls** (below).

## How to run

Requires Node (built-ins only), `git` with `git-http-backend`, and `openssl`. git's
libcurl must use a backend that honors `http.sslCAInfo` (OpenSSL/GnuTLS — the common
case; not Secure Transport). From this directory:

```bash
./code/run.sh          # full reproduction, temp PKI + repos, auto-cleanup
KEEP=1 ./code/run.sh   # keep the temp workdir (certs, logs, dumps) to poke around
```

Ports default to 8443 (proxy) and 9443 (upstream); override with `PROXY_PORT` /
`UPSTREAM_PORT`. Certs and servers locate `git-http-backend` via `git --exec-path`,
so it works across platforms; set `GIT_HTTP_BACKEND` for an unusual install.

## Results

**MAIN — the transfer completes and the proxy holds plaintext.**

```
git:  * [new branch]      main -> main
git:  9e2ca83…  refs/heads/main                    (ls-remote back through the proxy)
upstream>  API_TOKEN=hunter2-not-real              (upstream bare repo now holds it)
```

The proxy log shows the client leg is a genuinely terminated session and the body is
readable plaintext, then re-encrypted onward:

```
>> POST /hello-world.git/git-receive-pack
   client-leg TLS: TLSv1.3 cipher=TLS_AES_256_GCM_SHA384 sni=(none/IP)
   -- plaintext request body seen at the proxy (443 bytes) --
   … 0000 FLUSH
   --- PACKFILE at offset 179: version 2, 3 object(s), 264 bytes … ---
   -- carved plaintext packfile -> …/intercepted-plaintext.pack (264 bytes) --
   << upstream 200 application/x-git-receive-pack-result
```

Re-indexing that carved plaintext pack in a fresh empty repo recovers every object —
proving the proxy has full plaintext custody of the push:

```
79c7293c… blob     -> the-scent-of-discovery / API_TOKEN=hunter2-not-real
80c51671… tree
9e2ca837… commit
```

**Negative controls — both legs are really verified (nothing was switched off).**

| Control | Setup | Result |
|---|---|---|
| **A. Client distrusts the proxy** | git without `proxy-ca` in its trust | `server certificate verification failed` — refused before any push. |
| **B. Wrong host for the proxy cert** | connect via `https://localhost:8443` (name not in the proxy SAN) while trusting `proxy-ca` | `certificate subject name (proxy.git.local) does not match target host name 'localhost'` — the cert must match the swapped host. |
| **C. Proxy distrusts the upstream** | proxy given `proxy-ca` (wrong) as its upstream CA | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` → the proxy **502s** — the re-encrypt leg verifies the upstream too, and fails closed. |

The MAIN run never uses `-k` or `http.sslVerify=false`; it succeeds *because* trust
is correctly configured on both legs, and A/B/C show it fails the moment either leg's
identity check is not satisfied.

## Conclusions

1. **Yes — terminate-then-re-encrypt works for git smart-HTTP.** A proxy presenting
   a trusted cert terminates the client's TLS, exposes the plaintext `info/refs` +
   `git-receive-pack`/`git-upload-pack` exchange, and re-encrypts to the upstream
   over a fresh session; `push` and `fetch` complete and objects land upstream. This
   is the exact transport posture the roadmap's "HTTPS-only, plaintext at the edge"
   line requires.

2. **Termination — not tunneling — is what unlocks buffer/replay.** Because we
   decrypt, we decoded the pkt-lines and carved the packfile, then rebuilt the pushed
   objects from those bytes alone. A TCP/SNI passthrough (routing on SNI without
   decrypting) would move the same bytes but never see them, and so could not buffer,
   replay, or ack from durable storage. The plaintext seam **is** the feature.

3. **Each leg authenticates independently; the proxy re-verifies upstream.** Trust is
   not forwarded. Client→proxy is verified against one CA, proxy→upstream against
   another, and the proxy fails closed (502) if it cannot verify the upstream. The
   swapped host must present a valid cert *for its own name* (control B), and the
   upstream identity is the proxy's responsibility to check, not the client's.

4. **The proxy is a designed-in MITM — that is both the capability and the entire
   risk surface.** The seat that buffers a push during a GitHub outage is the same
   seat that reads its plaintext (and, in the real product, its credentials).
   Legitimacy rests on the cert being unforgeable (this experiment) and on the
   deployment model — the roadmap's self-host answer ("your Worker, your account,
   your secrets"), plus pass-through client-side encryption for users who want the
   proxy blind to contents.

## Files

```
tls-terminate-reencrypt/
├── README.md            # this file
├── RESEARCH_LOG.md      # chronological notebook: design, the CA-vs-leaf bug, controls
└── code/
    ├── gen-certs.sh              # two-CA throwaway PKI (proxy leaf + upstream leaf)
    ├── upstream-server.js        # HTTPS git server (TLS + real git-http-backend) = "github.com"
    ├── tls-reencrypt-proxy.js    # THE SUBJECT: terminate client TLS, tee plaintext, re-encrypt upstream
    ├── wire.js                   # pkt-line + packfile decoder (copied from git-remote-domain-swap)
    ├── run.sh                    # one-command reproduction: MAIN + 3 negative controls
    └── package.json              # metadata; no dependencies
```

## Follow-ups worth running next

- **Credentials across the seam.** Replace the blind header pass-through with the
  roadmap's model: mint a short-lived scoped upstream token and inject
  `Authorization` on the re-encrypt leg, and assert the client's proxy token never
  reaches the upstream. This experiment proves the *channel*; that proves the *auth
  swap* that rides it.
- **Stream a large push and measure memory.** The proxy tees while forwarding; feed
  it a multi-hundred-MB pack and confirm the forward path stays O(1) in body size
  (inspection reads a bounded copy or a sampled prefix), matching "no packfile
  parsing on the hot path."
- **Terminate against a real DNS host (SNI present).** Here the client hits an IP so
  no SNI is sent (`sni=(none/IP)`); production swaps to a DNS name (`git.cloud`),
  which is validated via SNI — the very field a passthrough would route on. Close
  that gap to exercise the production validation path.
- **Point the upstream leg at real github.com** (public repo, read-only) to prove the
  re-encrypt verifies against the public CA store, not just our throwaway CA.
