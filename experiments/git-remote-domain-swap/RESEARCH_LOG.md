# Research log — git remote domain-swap interception

A running notebook: hypotheses, attempts, dead-ends, and what each taught. Newest
entries at the bottom. Dates are absolute.

---

## 2026-08-31 · Framing

**Goal.** Establish whether swapping the *domain* of a git remote URL lets me
receive and inspect the resulting pushes/fetches. Start with a remote pointing at
`localhost`.

**Hypothesis.** Git treats the remote host as a plain target, so pointing it at a
server I run should deliver git's traffic to me. Open question: how much is
readable — just that a transfer happened, or the actual object contents?

**Plan.** Build up in layers. First a dumb listener to see *whether* git talks to
us at all; then, if needed, a real git endpoint to capture *contents*. Use a
throwaway repo with a planted, fake secret string so I can prove I recovered the
specific bytes.

**Environment.** git 2.39.5, node v24. `git-http-backend` present at
`/usr/lib/git-core/git-http-backend` (not on `PATH` — lives under git's
exec-path). Everything local to `127.0.0.1`; the planted token is fake.

---

## 2026-08-31 · Attempt 1 — passive listener

Wrote `passive-interceptor.js`: an HTTP server that logs method/URL/headers/body
and returns `200 intercepted`, but does **not** implement the git protocol. Wrote
`wire.js` to decode pkt-lines and packfile headers so captures are legible.

Pointed a source repo's `origin` at `http://127.0.0.1:8080/octocat/hello-world.git`
and tried `ls-remote` and `push`.

**Result.** The server saw two requests and only two:

```
GET …/info/refs?service=git-upload-pack    (fetch probe; git-protocol: version=2)
GET …/info/refs?service=git-receive-pack   (push probe)
  -- no body --
```

Git then aborted both with `fatal: …/info/refs not valid: is this a git
repository?`.

**Learning.** Git runs the `info/refs` handshake **first** and validates the ref
advertisement (content-type + pkt-line framing) *before* sending anything. A
non-compliant endpoint never receives a `POST`, so **the packfile never leaves the
client.** A passive listener gets metadata (which repo, which service, versions,
user-agent) but not contents. To see the payload I must actually *be* a git
server.

---

## 2026-08-31 · Attempt 2 — transparent MITM via git-http-backend

Rather than reimplement the server protocol, proxy to the real thing. Wrote
`transparent-interceptor.js`: for each request it logs+decodes the body, then
spawns `git http-backend` as CGI and streams the response back, so the transfer
completes while every byte passes through us.

CGI env that mattered:
- `GIT_PROJECT_ROOT` (dir of bare repos) + `GIT_HTTP_EXPORT_ALL=1` (skip the
  `git-daemon-export-ok` marker).
- `PATH_INFO`, `QUERY_STRING`, `REQUEST_METHOD`, `CONTENT_TYPE`, `REMOTE_ADDR`.
- **`GIT_PROTOCOL`** forwarded from the `Git-Protocol` header — without it, modern
  git falls off the protocol-v2 path. This is the web server's job, not
  http-backend's.
- On the bare repo: `git config http.receivepack true`, or http-backend refuses
  the push.

CGI output is `headers \r\n\r\n body`; parse a `Status:` header if present.

**Result.** `push` succeeded (`* [new branch] main -> main`). The captured
`POST /git-receive-pack` request body showed the ref-update pkt-lines then
`PACKFILE version 2, 3 object(s)`. `ls-remote` back through the proxy showed the
v2 `command=ls-refs` negotiation and returned the ref. **Contents now visible.**

---

## 2026-08-31 · Attempt 3 — reconstruct the payload from wire bytes

Added a `DUMP_DIR` option that carves any trailing `PACK…` out of a request body
to `intercepted.pack`. Goal: prove the *intercepted bytes alone* rebuild the
sender's objects, with no access to the origin repo.

**Dead-end A.** Copied `intercepted.pack` into a fresh repo and ran
`git index-pack <path>`, then `git cat-file -p <blob>` → **empty**. Cause: I'd
left the pack at `.git/intercepted.pack`; git only consults packs under
`.git/objects/pack/`. `verify-pack` worked (I gave it the explicit `.idx`) which
masked the problem. Fix: put the pack in `objects/pack/` before indexing.

**Dead-end B.** Tried this against the pack from a *second, incremental* push and
reached for `git index-pack --fix-thin` → `fatal: the option '--fix-thin'
requires '--stdin'`. Deeper issue than the flag: an incremental push sends a
**thin pack**, delta-compressed against base objects the server is assumed to
already have. Those base objects aren't in the intercepted pack, so it can't be
completed in isolation regardless of flags.

**Learning + fix.** Reconstruct from an **initial** push to a *fresh empty* bare
repo — that push carries a **complete** (non-thin) pack. Placed it in
`objects/pack/`, ran plain `git index-pack`, and recovered all objects: both blob
versions (with the planted token and a second secret), both trees, both commits
with author/committer identity, timestamps, and messages. Matches
`cat-file -p main:payload.txt` in the bare repo we now own.

**Aside.** `git -C <bare> log` failed with "branch 'master' does not have any
commits yet" — the bare repo's default `HEAD` is `master`, but we pushed `main`.
`cat-file -p main:payload.txt` works regardless; just don't rely on the default
branch pointer.

---

## 2026-08-31 · Consolidation

Packaged the three scripts plus an end-to-end `run.sh` (temp repos, auto-cleanup,
port-wait, `KEEP=1` to retain the workdir). Verified the whole chain reproduces
from scratch: passive shows handshake-only; transparent completes and tees the
packfile; reconstruction reads the payload back out of the carved bytes. Wrote up
design + conclusions in `README.md`.

**Net conclusions** (detail in README):
1. Host swap redirects git; endpoint protocol-compliance sets depth of access
   (metadata vs. full object graph).
2. Over `http://` the payload is fully exposed — TLS/host-key identity checks, not
   git, are what protect a real push. The proxy's swapped host must present a
   valid cert and carry credentials over TLS.
3. Incremental pushes are thin packs → storage must retain base objects or fatten
   on ingest; a push is not self-contained.
4. Inspect and inject are the same seat.

**Open threads / next.**
- Run the swap against `git://` (9418) and `ssh://` — expect ssh host-key check to
  refuse the impostor. Sharpest demonstration of conclusion #2.
- Stream (not buffer) the receive-pack body to storage; measure memory on large
  pushes — mirrors the roadmap's hot-path requirement.
- Deliberately exercise the thin-pack ingest path and confirm reconstruction
  behavior without the base repo.
