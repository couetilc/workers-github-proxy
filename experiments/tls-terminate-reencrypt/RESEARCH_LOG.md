# Research log — TLS terminate + re-encrypt for a git remote proxy

A running notebook: hypotheses, attempts, dead-ends, and what each taught. Newest
entries at the bottom. Dates are absolute.

---

## 2026-08-31 · Framing

**Goal.** Establish whether a git remote proxy can **terminate** the client's TLS,
operate on the **plaintext** smart-HTTP exchange, and **re-encrypt** onward to the
proxied upstream service — with a completed `git push`/`fetch` as proof the
re-encrypt leg is real.

**Why now.** The predecessor experiment (`git-remote-domain-swap`) ended on the
note that over `http://` the payload is fully exposed and *"what protects a real
push is the transport's identity check, not git"* — the proxy's swapped host must
present a valid cert and re-establish trust at the new host. The roadmap commits to
exactly this: *"HTTPS-only. The proxy terminates TLS at the edge and works on the
plaintext smart-HTTP exchange — the only architecture that supports buffering and
replay."* This experiment is the smallest validation of that transport claim.

**Hypothesis.** A Node HTTPS server can terminate the client's TLS (presenting a
cert the client trusts for the swapped host), hand us plaintext git smart-HTTP, and
we can originate a *fresh, independently verified* TLS session to the upstream and
stream the bytes through. Both legs should verify with real certs — no
`sslVerify=false`, no `-k` — or the experiment proves nothing (that was conclusion
#2 of the predecessor).

**Design decisions.**
- **Two independent CAs**, not one. `proxy-ca` signs the proxy's leaf (the client
  trusts this — stands in for whoever issues `git.cloud`'s cert); `upstream-ca`
  signs the upstream's leaf (the *proxy* trusts this — stands in for the public CA
  behind `github.com`). Different roots on each leg model the real situation and
  make it impossible to accidentally share trust between them.
- **Root-free, cross-platform.** No `/etc/hosts`, no root. SANs are picked so the
  client validates the proxy by `IP:127.0.0.1` and the proxy validates the upstream
  by `DNS:localhost` — both resolve on loopback without configuration.
- **Negative controls baked in.** Deliberately omit `localhost` from the proxy's
  SAN so a `https://localhost:PORT` request to the *same* proxy is a genuine
  hostname mismatch — a control that needs no extra infrastructure.

**Environment.** git 2.39.5, node v24.20.0, openssl 3.0.20, curl 7.88.1 built
against **OpenSSL** — this matters: git shells out to libcurl, and the OpenSSL
backend honors `http.sslCAInfo` / `GIT_SSL_CAINFO`, so we can scope trust to our
throwaway CA per-command. `git-http-backend` at `/usr/lib/git-core`. Planted token
is fake.

---

## 2026-08-31 · Building the PKI

Wrote `gen-certs.sh` (openssl 3.0): two self-signed CAs, then a leaf per side via
`x509 -req … -extfile <(…SAN…)`. EC (`prime256v1`) keys for speed. Verified
immediately before writing any server code:

- `proxy.crt`  SAN = `IP:127.0.0.1, DNS:proxy.git.local`  (no `localhost` — on purpose)
- `upstream.crt` SAN = `DNS:localhost, IP:127.0.0.1`
- `openssl verify -CAfile proxy-ca.crt proxy.crt` → OK; same for upstream.
- Cross-check: `proxy.crt` against `upstream-ca.crt` → **rejected** (`unable to get
  local issuer certificate`). Good — the two trust domains really are disjoint.

**Learning.** Validate the PKI in isolation *first*. A cert bug and a proxy bug look
identical from `git push` (both surface as an opaque HTTPS error); proving the certs
are sound up front means any later failure is the code, not the chain.

---

## 2026-08-31 · Servers

- `upstream-server.js`: `https.createServer` (upstream leaf) wrapping the same
  `git http-backend` CGI pattern the predecessor proved. Intentionally boring — its
  only jobs are *require TLS* and *actually complete git ops*.
- `tls-reencrypt-proxy.js`: `https.createServer` (proxy leaf) that, per request,
  logs the terminated client-leg TLS parameters, **tees** the plaintext body
  (decode + carve while forwarding), and issues an `https.request` to the upstream
  with `ca: upstream-ca`, `rejectUnauthorized: true`. Tee = forward each chunk
  upstream immediately and keep a copy for inspection, so decoding never sits on the
  hot path (the roadmap's "no packfile parsing on the hot path").

---

## 2026-08-31 · Attempt 1 — first end-to-end run: MAIN push 502s

`run.sh` wired it together. The MAIN push failed:

```
remote: proxy: upstream TLS/connection error: UNABLE_TO_VERIFY_LEAF_SIGNATURE
fatal: … 502
```

**Debugging.** `UNABLE_TO_VERIFY_LEAF_SIGNATURE` means the proxy couldn't verify the
upstream's cert — but `openssl verify` had passed. Isolated the upstream TLS three
ways against a fresh PKI: `openssl s_client` (Verify return code: 0), `curl
--cacert upstream-ca.crt` (works), and a 10-line Node `tls.connect({ca:
upstream-ca})` client (`authorized: true`). All three verified fine. So the proxy
*logic* was correct; the failure was in what I fed it.

**Cause.** `run.sh` started the MAIN proxy with `UPSTREAM_CA=$CERTS/upstream.crt` —
the upstream **leaf**, not `upstream-ca.crt` the **CA**. Node was asked to verify the
presented leaf using that same leaf as the trust anchor; a non-CA leaf can't be its
own issuer → `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. A one-token path bug, not a protocol
problem.

**Fix.** Point MAIN at `upstream-ca.crt`. (The bug was almost the *design* of
control C, which deliberately feeds the proxy the wrong CA to force this very error
— so the mistake previewed the negative control.)

**Aside.** The temp source repo tripped a host-global `post-commit` hook
(`skipping auto-push … protect-branch ruleset`). Harmless, but set
`core.hooksPath=/dev/null` in the throwaway repo to keep the reproduction hermetic.

---

## 2026-08-31 · Attempt 2 — green across the board

Re-ran. All four cases behaved as designed:

- **MAIN.** `push` → `* [new branch] main -> main`; `ls-remote` returns the ref; the
  upstream bare repo holds `API_TOKEN=hunter2-not-real`. The proxy log shows the
  client leg terminated as **TLSv1.3 / TLS_AES_256_GCM_SHA384**, the decoded
  plaintext (`PACKFILE version 2, 3 object(s)`), and `<< upstream 200` for the
  re-encrypted leg. The carved plaintext pack re-indexed in a fresh repo and
  `cat-file` returned the payload — the proxy has plaintext custody, which is the
  whole point of terminating.
- **Control A** (client without `proxy-ca`): `server certificate verification
  failed`. Client leg is genuinely verified.
- **Control B** (`https://localhost:8443`, name absent from SAN): `certificate
  subject name (proxy.git.local) does not match target host name 'localhost'`. The
  cert must match the swapped host — a bare host swap to an impostor fails.
- **Control C** (proxy given `proxy-ca` as its upstream CA): `UNABLE_TO_VERIFY_
  LEAF_SIGNATURE` → 502. The re-encrypt leg verifies the upstream too; the proxy
  fails closed rather than trusting an unauthenticated upstream.

**Observation — SNI shows `(none/IP)` on the client leg.** Expected: git connects to
the IP literal `127.0.0.1`, and SNI carries hostnames only, so no SNI is sent. curl
still validates the connection against the cert's `IP:127.0.0.1` SAN. In production
the swapped host is a DNS name (`git.cloud`), so SNI *would* be present — worth
noting because SNI is exactly what a pure TCP/SNI passthrough would route on without
ever decrypting. We decrypt; that's the distinction the experiment turns on.

**Reproducibility.** Ran a second full pass: exit 0, identical outcomes, no lingering
listeners on 8443/9443 (the `trap` cleans PIDs).

---

## 2026-08-31 · Consolidation

Packaged `gen-certs.sh`, `upstream-server.js`, `tls-reencrypt-proxy.js`, `wire.js`
(copied from the predecessor so this reproduces standalone), and `run.sh`. Wrote up
design + conclusions in `README.md`.

**Net conclusions** (detail in README):
1. **Yes** — a git remote proxy can terminate the client's TLS, act on the plaintext
   smart-HTTP, and re-encrypt to the upstream; pushes and fetches complete.
2. Termination (not tunneling) is what buys plaintext custody: we decoded and carved
   the packfile between the legs. A TCP/SNI passthrough could not.
3. Both legs must — and here do — authenticate independently. Client→proxy trust and
   proxy→upstream trust are separate decisions; the proxy re-verifies the upstream
   rather than inheriting the client's session.
4. The proxy is a designed-in MITM. That is the feature (buffer/replay during an
   outage) and the whole risk surface: it sees plaintext contents and, in the real
   product, credentials. Self-host is the trust answer (roadmap).

**Open threads / next.**
- Carry **credentials** across the seam: mint/inject a real `Authorization` on the
  re-encrypt leg (the roadmap's short-lived scoped tokens) instead of a blind
  pass-through, and confirm the client's proxy token never reaches the upstream.
- **Stream a large push** through the tee and measure proxy memory — confirm the
  forward path stays O(1) in body size while inspection reads a bounded copy (or a
  sampled prefix), matching "no packfile parsing on the hot path".
- Terminate against a **real DNS host** (SNI present) to exercise the production
  path where the swapped name is validated via SNI, closing the `(none/IP)` gap.
- Point the upstream leg at **real github.com** (public repo, read-only) to prove the
  re-encrypt verifies against the public CA store, not just our throwaway `upstream-ca`.
