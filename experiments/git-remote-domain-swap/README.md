# Experiment: intercepting git by swapping a remote's domain

**Question.** If I rewrite the *domain* of a git remote URL to a host I control —
starting with `localhost` — can I receive and inspect the pushes and fetches that
git then sends?

**Short answer.** Yes. A host substitution in the remote URL is all it takes to
route git's smart-HTTP traffic to a server you run. *How much* you see depends on
one thing: whether your endpoint actually completes git's protocol.

- A **passive** listener (just a socket) sees only the opening handshake —
  which repo, which service (`git-upload-pack` vs `git-receive-pack`),
  user-agent, protocol version. Git validates the server's ref advertisement
  *before* sending any objects, so a non-compliant endpoint gets **no packfile**.
- A **transparent** endpoint that speaks the protocol (here, by proxying to the
  real `git http-backend`) makes the transfer *complete*, so the packfile flows
  through it. From those intercepted bytes alone we reconstruct the sender's full
  object graph: file contents, commit messages, author identity, timestamps.

Over plain `http://` the payload is therefore exposed **completely**. What
actually protects a real push is the transport's identity check (TLS server-cert
validation on `https://`, host keys on `ssh://`), not git itself.

## Why this experiment lives in this repo

`workers-github-proxy`'s north-star setup is *exactly* a domain swap:

```bash
git remote set-url origin "$(git remote get-url origin | sed 's/github\.com/git.cloud/')"
```

For that to work, the proxy must be able to stand where GitHub stood, terminate
git's smart-HTTP push (`info/refs` + `git-receive-pack`), and stream the packfile
to durable storage — the roadmap's "thin streaming proxy … No packfile parsing on
the hot path." This experiment is the smallest possible validation of that core
mechanic, done locally against `127.0.0.1`, and it surfaces the constraints the
real proxy inherits (see Conclusions).

## Background: how git decides where and what to send

Git's `http(s)` transport is the "smart HTTP" protocol. A push is two requests:

1. `GET /<repo>/info/refs?service=git-receive-pack` — the client asks for the
   server's **ref advertisement**. Git checks the response content-type and pkt-line
   framing; if it isn't a valid advertisement, git aborts here with
   `is this a git repository?`.
2. `POST /<repo>/git-receive-pack` — only if step 1 validated. The body is
   pkt-line ref-update commands (`<old-sha> <new-sha> <refname>`) followed by a
   **packfile** (`PACK`, version, object count, then delta/deflate-compressed
   objects). This is where the actual data lives.

A fetch is the mirror image with `service=git-upload-pack`. The remote's **scheme**
(`http`/`https`/`ssh`/`git`/`file`) selects the transport; the **host** just says
who to talk to. Swapping the host redirects the whole conversation without git
objecting — the URL is a target, not a trust anchor.

## Experimental design

Three moving parts, all under [`code/`](./code):

| Component | File | Role |
|---|---|---|
| Wire decoder | `wire.js` | Decodes pkt-lines and packfile headers so captured bytes are human-readable. |
| Passive interceptor | `passive-interceptor.js` | A bare HTTP server that logs everything and answers 200, but is **not** a git server. Tests the ceiling of a bystanding listener. |
| Transparent interceptor | `transparent-interceptor.js` | A working git server: proxies each request to `git http-backend` against bare repos it owns, teeing (and optionally dumping) the packfile as it passes. |

The subject is a throwaway source repo containing a planted, **fake** secret
(`API_TOKEN=hunter2-not-real`) so we can watch a specific string cross the wire and
prove we recovered it.

The procedure (automated in [`code/run.sh`](./code/run.sh)):

1. Build the source repo and commit the payload.
2. Point `origin` at the **passive** interceptor (`http://127.0.0.1:8080/…`);
   attempt `ls-remote` and `push`. Observe what the server captured.
3. Point `origin` at the **transparent** interceptor (`http://127.0.0.1:8081/…`);
   `push` for real; confirm with `ls-remote`. Observe the full request/response
   bodies, including the packfile.
4. Take the carved `intercepted.pack` — nothing but the bytes off the wire — index
   it in a fresh empty repo and `cat-file` the objects back out. Cross-check
   against the bare repo the proxy now owns.

## How to run

Requires Node (built-ins only, no npm deps) and `git` with `git-http-backend`
(ships in `git-core`). From this directory:

```bash
./code/run.sh          # full reproduction, temp repos, auto-cleanup
KEEP=1 ./code/run.sh   # keep the temp workdir for poking around
```

Ports default to 8080 (passive) and 8081 (transparent); override with
`PASSIVE_PORT` / `XPARENT_PORT`.

## Results

**Passive** captured both handshake probes and nothing else:

```
GET /octocat/hello-world.git/info/refs?service=git-upload-pack   git-protocol: version=2
GET /octocat/hello-world.git/info/refs?service=git-receive-pack
  -- no body --
```

Git aborted (`is this a git repository?`) before any `POST`, so the packfile never
left the client. **Metadata: yes. Contents: no.**

**Transparent** completed the push and logged the `POST /git-receive-pack` body
carrying `PACKFILE version 2, 3 object(s)`. From that carved packfile alone we
recovered every object:

```
d32c8353… commit   -> author Experimenter <exp@localhost> …, message "seed: payload"
80c51671… tree
79c7293c… blob     -> the-scent-of-discovery
                      API_TOKEN=hunter2-not-real
```

Identical to `git cat-file -p main:payload.txt` in the bare repo the proxy now
owns. **Full exposure, and full custody, of the pushed data.**

## Conclusions

1. **A domain swap is sufficient to redirect git; the endpoint's protocol
   compliance decides depth of access.** Passive = intent/metadata only;
   transparent = the complete object graph. This is the exact posture the proxy
   wants: *be* the server, stream the packfile through, ack from durable storage.

2. **What protects a real push is the transport's identity check, not git.**
   The interception here worked because it used `http://` with no TLS. On
   `https://`, a bare host swap to an impostor fails certificate validation before
   any objects move; `ssh://` is bound by host keys. Implication for the proxy:
   the swapped host **must** present a valid cert for its own domain (`git.cloud`
   in the roadmap example) and carry the client's GitHub credentials over that
   TLS channel — the swap is host-only, the trust is re-established at the new host.

3. **Incremental pushes send *thin* packs.** A push to a non-empty repo is
   delta-compressed against objects the server is assumed to already hold, so a
   single intercepted incremental push may not reconstruct standalone
   (`git index-pack --fix-thin` needs the base objects). An **initial** push sends
   a complete pack and reconstructs cleanly — which is why the clean reconstruction
   uses a fresh destination. The proxy's storage layer must therefore either keep
   the base objects (real git against a persistent repo — the roadmap's container
   route) or fatten thin packs on ingest; it can't treat each push as
   self-contained.

4. **Inspect and inject are the same seat.** The position that reads a push can
   serve a fetch of the proxy's choosing. For a *legitimate* proxy this is the
   feature (serve buffered state during a GitHub outage); it is also the reason the
   endpoint's authenticity must be unforgeable.

## Files

```
git-remote-domain-swap/
├── README.md            # this file
├── RESEARCH_LOG.md      # chronological notebook: ideas, dead-ends, fixes
└── code/
    ├── wire.js                     # pkt-line + packfile decoder
    ├── passive-interceptor.js      # logs-only HTTP endpoint (no git protocol)
    ├── transparent-interceptor.js  # MITM proxy to real git-http-backend
    ├── run.sh                      # one-command end-to-end reproduction
    └── package.json                # metadata; no dependencies
```

## Follow-ups worth running next

- Repeat the swap against `git://` (port 9418) — wholly unauthenticated and
  unencrypted — and against `ssh://`, to watch the host-key check *refuse* the
  swap. The contrast is the sharpest statement of conclusion #2.
- Stream, rather than buffer, the `git-receive-pack` body through to storage to
  mirror the roadmap's "no packfile parsing on the hot path" requirement, and
  measure memory against large pushes.
- Exercise the thin-pack path deliberately: intercept an incremental push in
  isolation and confirm what does and doesn't reconstruct without the base repo.
