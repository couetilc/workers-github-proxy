# Research log — stream both directions through a fixed memory budget

A running notebook: hypotheses, attempts, dead-ends, and what each taught. Newest
entries at the bottom. Dates are absolute.

---

## 2026-09-01 · Framing

**Goal.** Establish that a git remote proxy can stream **both** directions through a
fixed, small memory budget: a push (pack in the *request*) and a clone (pack in the
*response*), while still enforcing header auth and front-of-stream ref policy
without buffering the pack.

**Why now.** The two predecessors (`git-remote-domain-swap`,
`tls-terminate-reencrypt`) both proxied by **buffering** the whole body to inspect
it — the domain-swap concatenated it, the TLS one tee'd it (`teed.push(c)` →
`Buffer.concat`). The TLS experiment's own follow-up list named this exact next
step: "Stream a large push and measure memory … confirm the forward path stays O(1)
in body size." The roadmap commits to a "thin streaming proxy … no packfile parsing
on the hot path," but only ever benchmarks the **request** ceiling; the read path
(Phase 1.5's `git-upload-pack`, pack in the response) is added as a feature with its
memory behavior unstated. So the unstated claim to establish: the budget is fixed in
*both* directions.

**Hypothesis.** If the proxy forwards each chunk as it arrives and keeps only a
bounded window, peak memory is independent of pack size — on push and on clone. Auth
(headers) and ref policy (the command section that precedes the pack) are both
decidable from bounded prefixes, so neither forces buffering.

**Key structural insight (why this is even possible).** Smart-HTTP puts the small
control data first and the unbounded pack last, in whichever direction carries it.
Push: ref-update commands, then a flush pkt (`0000`), then `PACK…`. Clone: the pack
is in the response, preceded by a bounded negotiation. So a proxy can read up to the
flush (bounded by ref count, not pack size), police it, and stream the rest opaquely.

**Design decisions.**
- **Reuse the TLS terminate+re-encrypt posture** (two-CA PKI, copied `gen-certs.sh`)
  so the subject is a real proxy, not a plaintext toy — the *only* new variable vs.
  the predecessor is streaming-instead-of-buffering.
- **A/B against a buffering proxy over the same size sweep.** Streaming's flatness
  is only meaningful if the packs were actually large; the buffering control climbing
  linearly is the evidence the inputs were real. This is the scientific control.
- **Measure `arrayBuffers`, not just `rss`.** Node Buffers (socket reads, `concat`
  results) are backed by `arrayBuffers`; it's the cleanest "git bytes held" signal
  and drops to ~0 when nothing is accumulated. `rss` corroborates but is noisier and
  sticky.
- **Fresh proxy process per measurement.** Kill via SIGTERM, print the lifetime peak
  on the way out. One op per process = that op's peak against a clean baseline, no
  residual-RSS confounds.
- **Incompressible packs.** `head -c N /dev/urandom` → pack ≈ N, a controllable and
  effectively unbounded pack. (A compressible blob would let git shrink the pack and
  muddy the size axis.)

**Environment.** git 2.39.5, node v24.20.0, openssl 3.0.20, 8 GB RAM, 8 vCPU.
`git-http-backend` at `/usr/lib/git-core`. Planted auth token and locked-ref name
are throwaway.

---

## 2026-09-01 · Building the pieces

- Copied `wire.js` from the TLS experiment and **added `scanReceivePackCommands`** —
  a streaming scanner that reads pkt-line commands until the flush and returns
  `commandBytes` (= where the pack begins). This is the primitive that makes
  "policy from a bounded prefix" work: feed it whatever's arrived, it says
  `{done:false}` (need more) or hands back the commands + the pack offset.
- `memsample.js`: interval poll of `process.memoryUsage()`, lifetime peak, dumps a
  `PEAK rss=… arrayBuffers=…` line on SIGTERM for `run.sh` to grep.
- `upstream-server.js`: **rewrote the predecessor's buffering upstream to stream** —
  `req.pipe(cgi.stdin)`, and parse only the CGI header block from the front of
  `cgi.stdout` before streaming the rest. Without this the clone response would be
  buffered *at the upstream* and the proxy's response-path streaming would never see
  a real large stream.
- `streaming-proxy.js` (the subject): header auth first (0 body bytes on reject);
  strip the client's Authorization on the upstream leg; for receive-pack, buffer only
  up to the flush, run policy, then forward with manual backpressure
  (`if(!ureq.write(c)){creq.pause(); ureq.once('drain',…)}`); response via
  `ures.pipe(cres)`. On policy DENY: destroy the upstream request, then *drain and
  discard* the incoming pack (bounded) rather than buffering it.
- `buffering-proxy.js` (the control): the naive both-directions `Buffer.concat`.

---

## 2026-09-01 · Smoke test (4 MB) — two cosmetic bugs, logic sound

First run at `SIZES=4`. Everything completed; both controls behaved. Two things to
fix, neither in the subject's memory path:

1. **"packfile size … 0".** I reported `du .git/objects/pack`, but a fresh commit
   stores **loose** objects — the pack dir is empty until a repack; git builds the
   transfer pack on push. Switched the report to `du .git/objects` (≈ 17 MB for a 16
   MB blob — the loose, zlib-stored-but-incompressible object).

2. **A mysterious empty receive-pack POST** — `POLICY ALLOW: [] policed 4 bytes`
   (body = just `0000`) appearing before the real `[refs/heads/main]` POST. This is
   **git's normal flush-only preflight**: libcurl sends a tiny authenticated probe
   before uploading the real pack (so it never uploads the big body pre-auth). Not a
   bug — if anything it reinforces that the pack only rides the second POST. Reworded
   the log to say "preflight, no ref updates" for the empty command list.

**Lesson echoed from the predecessor.** At 4 MB the streaming and buffering numbers
were indistinguishable (63–72 MB rss for all). Small inputs can't tell O(1) from
O(n); the whole experiment needs a *size sweep* to say anything.

---

## 2026-09-01 · The sweep (16 / 64 / 256 MB) — clean flat-vs-linear split

```
 PUSH                                        CLONE
 size | stream rss / arrayBuf | buffer      || stream rss / arrayBuf | buffer
 16   | 73.1 /  7.5           | 105 /  32   ||  79.0 / 12.9          | 116 /  36
 64   | 78.6 /  9.4           | 258 / 128   ||  86.1 / 18.4          | 266 / 136
 256  | 71.7 /  5.9           | 847 / 512   ||  76.6 /  9.9          | 868 / 535
```

- **Streaming: flat.** ~6–18 MB of git bytes held at every size, push and clone
  alike. 16× the pack, no movement.
- **Buffering: linear, ~2× the pack in `arrayBuffers`.** The 2× is the chunk array
  and the `Buffer.concat` result coexisting at the peak (the sampler catches it via
  an explicit `mem.sample()` right after concat). RSS follows with overhead; at 256
  MB it's ~11× the streaming proxy's.
- **Identical split on push and clone** — the response leg (clone) is as flat as the
  request leg (push). That's the read-path gap closed.

**Reading `arrayBuffers` > pack at times for buffering (534 MB for a 256 MB clone):**
expected — concat transiently doubles. **Reading streaming clone `arrayBuffers`
(~10–18 MB) > a few KB:** that's Node's TLS + pipe in-flight buffering plus the
socket high-water marks; crucially it does **not** grow with pack size, which is the
claim. If it had grown, backpressure would have been broken.

---

## 2026-09-01 · Controls

- **Auth.** Push with no creds → git gets 401 at `info/refs`, has no credentials,
  aborts ("could not read Username … prompts disabled"). Proxy log: `AUTH-DENY … 0
  body bytes read`. With creds → streams and completes. Confirmed the client's
  Authorization is stripped on the upstream leg (never forwarded).
- **Policy.** Push the locked ref carrying a 64 MB pack → `POLICY DENY … decided from
  16378 head bytes; DRAINED, never buffered`, then `drained + discarded 66060156
  pack bytes`, process peak `arrayBuffers=5.5MB`. The same 64 MB pack to `main` →
  allowed and completes. So policy is enforced from a 16 KB front window and the 64
  MB pack is discarded, not buffered, on the reject path — peak stays flat.

  The DENY window is 16 KB (one socket read that happened to carry the command
  section *and* the start of the pack), not the ~179-byte command section. Bounded
  either way (one read, independent of pack size); noted as a follow-up to tighten
  the reported minimum prefix.

  Git's client-side reaction to the early 403 is noisy (`RPC failed; HTTP 403`,
  `unexpected disconnect`, `Everything up-to-date`) — cosmetic; the push is rejected
  and the proxy stays bounded. A cleaner report-status could be emitted, but it
  doesn't change the memory result.

---

## 2026-09-01 · Consolidation

Second full pass (and an `SIZES=8` re-run): exit 0, no lingering listeners on
8443/9443 (the `trap` cleans PIDs), numbers reproduce within noise. Packaged the
five code files + `wire.js`/`gen-certs.sh` (copied for standalone reproduction) and
`run.sh`; wrote up design + conclusions in `README.md`; added this experiment to the
top-level index.

**Net conclusions** (detail in README):
1. **Yes** — peak proxy memory is flat as the pack grows, on push *and* on clone
   (~6–18 MB held vs. a 16→256 MB pack). The budget is fixed in both directions.
2. Buffering is the linear baseline (what the predecessors did): ~2× the pack held,
   ~11× the streaming RSS at 256 MB — the control that makes the flat result mean
   something.
3. Header auth needs zero body bytes; front-of-stream ref policy needs only a
   bounded prefix and drains (not buffers) a rejected pack. Enforcement and flat
   memory are not in tension.
4. The trade: a streaming relay can't hold the pack for durable replay or read its
   contents (the custody the TLS experiment showed). Front-of-stream policy is
   exactly the inspection that survives the trade — it reads what precedes the pack.

**Open threads / next.**
- Stream the request straight **into Artifacts** (the roadmap's real durability
  point) and confirm the ack waits only on the storage write.
- **Concurrency:** N simultaneous large transfers → confirm `O(N × window)`, not
  `O(N × pack)`.
- Re-run **inside workerd** (not Node) to validate the 128 MB heap ceiling never
  binds when nothing is buffered.
- **Slow-reader backpressure:** confirm flatness when the client reads a clone (or
  the upstream ingests a push) slowly — the classic way a "streaming" proxy quietly
  starts buffering.
