# Experiment: stream both directions through a fixed memory budget

**Question.** Can a git remote proxy stream **both** directions through a fixed,
small memory budget — a **push** (the unbounded packfile rides in the *request*)
and a **clone/fetch** (the unbounded packfile rides in the *response*) — while
still enforcing **header-level auth** and **front-of-stream ref policy** *without*
buffering the pack?

**Short answer.** Yes, and the gap between streaming and buffering is stark. A
TLS-terminating proxy that forwards each chunk as it arrives holds a flat **~6–18
MB** of git bytes whether the pack is 16 MB or 256 MB, on push *and* on clone. The
buffering proxy that the two predecessor experiments used holds **~2× the pack**
(512 MB for a 256 MB push). Auth is decided from request headers before a single
body byte is read; ref policy is decided from the receive-pack command section (a
~16 KB window) before the pack — and a rejected push drains the pack instead of
buffering it, so even *refusing* a 64 MB push stays flat.

## Why this experiment lives in this repo

The two predecessors put a proxy on the byte path but both **buffered the whole
body** to inspect it — `git-remote-domain-swap` concatenated it, and
`tls-terminate-reencrypt` tee'd it (`teed.push(c)` → `Buffer.concat`). Their own
follow-up list said the next thing to prove was:

> **Stream a large push and measure memory.** The proxy tees while forwarding;
> feed it a multi-hundred-MB pack and confirm the forward path stays O(1) in body
> size … matching "no packfile parsing on the hot path."

The roadmap makes it a hard architectural commitment for the *inbound* direction:

> **Thin streaming proxy for smart-HTTP** (`info/refs` + `git-receive-pack`) →
> Artifacts. **No packfile parsing on the hot path.**

But the roadmap only ever benchmarks the **request** ceiling (Phase 0: "probe the
inbound request-body ceiling"; Phase 3: "the inbound request-body ceiling"). The
**read path** — Phase 1.5's `git-upload-pack`, where a clone's pack rides in the
*response* — is added as a feature but its streaming/memory behavior is left
unstated. This experiment closes that gap: it proves the budget is fixed in **both**
directions, and that being on the byte path never means holding the pack.

## Background: where the pack sits, and why order lets you stay small

Git smart-HTTP puts the small control data **first** and the unbounded packfile
**last**, in whichever direction carries it:

```
PUSH  (POST git-receive-pack)              CLONE (POST git-upload-pack)
  request:                                   request:
    <old> <new> refs/heads/main\0caps          want <sha> <caps>
    <old> <new> refs/heads/other               have <sha> ...
    0000                 <- flush              0000
    PACK…… (UNBOUNDED)   <- pack in REQUEST   response:
  response:                                     …ack/nak negotiation…
    unpack ok / ng … (small)                    PACK…… (UNBOUNDED)  <- pack in RESPONSE
```

Two consequences the proxy exploits:

1. **Auth is in the headers**, which arrive before any body. The decision needs
   *zero* body bytes.
2. **Ref-update commands precede the pack** and are terminated by a flush pkt
   (`0000`). A proxy can read just up to that flush — a bounded prefix, sized by
   the number of refs, not the pack — apply policy, and then forward the pack as an
   opaque stream it never accumulates. On the read side the equivalent bounded data
   (the ref advertisement, the `want`/`have` negotiation) is likewise small; only
   the response pack is unbounded, and it is only ever *relayed*, never inspected.

## Experimental design

Everything runs on `127.0.0.1` with a throwaway two-CA PKI (reused from
`tls-terminate-reencrypt`, so the proxy is a genuine TLS **terminate + re-encrypt**,
not a plaintext toy) and disposable repos in a temp dir. All parts are under
[`code/`](./code):

| Component | File | Role |
|---|---|---|
| PKI | `gen-certs.sh` | Two independent CAs; a leaf for the proxy, a leaf for the upstream (copied from the predecessor). |
| Upstream | `upstream-server.js` | HTTPS git server (`git http-backend`), rewritten to **stream** req→CGI→resp so a clone's response pack is genuinely large and streamed. |
| **Subject** | `streaming-proxy.js` | **The subject.** Terminates client TLS, re-encrypts upstream, and streams both directions with header auth + front-of-stream ref policy, never buffering the pack. |
| Control | `buffering-proxy.js` | The **memory control**: same transfers, but `Buffer.concat`s the whole body in each direction — exactly how the predecessors handled it. |
| Instrument | `memsample.js` | Polls `process.memoryUsage()` and reports the process-lifetime peak of `rss` and `arrayBuffers` (the bytes backing Node Buffers — i.e. held git bytes). |
| Wire | `wire.js` | pkt-line decoder (copied) **plus** `scanReceivePackCommands`, which finds where the command section ends / the pack begins. |

**Measurement method.** For each pack size we start a **fresh proxy process**, run
one git operation through it, then `SIGTERM` it — the sampler prints its lifetime
peak on the way out. A fresh process per measurement means the peak is that
operation's peak against a clean baseline, with no residual-RSS carryover. The
packfile is `SIZE` MB of `/dev/urandom` (incompressible, so pack ≈ blob), giving a
controllable, effectively unbounded pack. The lead signal is **`arrayBuffers`** —
the memory backing git's bytes; a buffering proxy's `Buffer.concat` lives there and
grows with the pack, a streaming proxy never accumulates there. `rss` corroborates.

**The A/B is the whole point.** Streaming's flat memory only *means* something if
the packs were actually large — so we run the **same** sizes through the buffering
proxy. Its memory climbing linearly is the proof the inputs were real; streaming
staying flat next to it is the result.

**Procedure** (automated in [`code/run.sh`](./code/run.sh)):

1. Mint the PKI; start the streaming upstream git server.
2. **SWEEP:** for each size in `SIZES` (default `16 64 256` MB), build a source repo
   with that much random data, then **push** it (pack in request) and **clone** it
   (pack in response) through *both* the streaming and the buffering proxy — a fresh
   proxy per measurement — recording each proxy's peak memory.
3. **AUTH control:** a push with no credentials, then with credentials.
4. **POLICY control:** a push to a *locked* ref carrying a 64 MB pack, then a push to
   an allowed ref carrying the same pack.

## How to run

Requires Node (built-ins only), `git` with `git-http-backend`, and `openssl`. From
this directory:

```bash
./code/run.sh                 # full reproduction (16/64/256 MB sweep + 2 controls)
SIZES="32 128 512" ./code/run.sh   # push the sweep further (buffering RSS ≈ 2×top-size)
KEEP=1 ./code/run.sh          # keep the temp workdir (certs, logs) to poke around
```

Ports default to 8443 (proxy) / 9443 (upstream); override with `PROXY_PORT` /
`UPSTREAM_PORT`. Larger `SIZES` cost the **buffering** proxy ~2× the top size in
RAM (the streaming proxy stays flat); 256 MB tops out ~850 MB RSS on the buffering
control, well within an 8 GB box.

## Results

**MAIN — peak proxy memory vs pack size** (one representative run; `arrayBuffers` =
git bytes held, `rss` = total resident). Streaming is **flat**; buffering is
**linear**, in *both* directions:

```
 PUSH  (pack in request)                     CLONE (pack in response)
 size  | stream rss / arrayBuf | buffer rss / arrayBuf || stream rss / arrayBuf | buffer rss / arrayBuf
 ------+----------------------+----------------------++----------------------+----------------------
 16    | 73.1 /  7.5          | 105.4 /  32.1        ||  79.0 / 12.9         | 115.9 /  35.9
 64    | 78.6 /  9.4          | 258.3 / 128.2        ||  86.1 / 18.4         | 266.3 / 136.0
 256   | 71.7 /  5.9          | 846.7 / 512.3        ||  76.6 /  9.9         | 867.9 / 534.7
```

- **Streaming holds ~6–18 MB of git bytes at every size, push and clone alike.**
  A 16× larger pack does not move the number — the budget is fixed.
- **Buffering tracks the pack (~2× it in `arrayBuffers`).** The 2× is the chunk
  array plus the `Buffer.concat` result coexisting; RSS follows with overhead. At
  256 MB the buffering proxy resident set is **~11× the streaming proxy's**.
- The flat vs. linear split is identical on the **response** (clone) leg as on the
  **request** (push) leg — the read-path gap the roadmap left unstated is closed.

**CONTROL (auth) — decided from headers, zero body bytes.** An unauthenticated push
is refused at `info/refs`; the authenticated one streams:

```
>> GET  …/info/refs?service=git-receive-pack
   AUTH-DENY: no/invalid credentials -> 401 (0 body bytes read)
>> POST …/git-receive-pack
   POLICY ALLOW: [refs/heads/main] -- policed 179 command bytes, pack now streams through
```

The client's proxy token is **stripped** on the re-encrypt leg (`delete
headers.authorization`) — it never reaches the upstream, per the roadmap's auth-swap
model.

**CONTROL (policy) — decided from the command section, pack drained not buffered.**
A push of the locked ref carrying a 64 MB pack is rejected from a ~16 KB front
window; the same 64 MB pack to an allowed ref succeeds:

```
   POLICY DENY (ref refs/heads/locked is locked (front-of-stream policy))
   decided from 16378 head bytes; the packfile will be DRAINED, never buffered
   drained + discarded 66060156 pack bytes after the DENY (peak memory unaffected)
   POLICY ALLOW: [refs/heads/main] -- policed 179 command bytes, pack now streams through
PEAK rss=69.0MB arrayBuffers=5.5MB …
```

The proxy decided from **16 KB** (one socket read holding the whole command
section), then discarded **66 MB** of pack — and the process peak stayed at **5.5
MB** of git bytes. Policy holds without ever buffering the pack, *even on the reject
path*.

## Conclusions

1. **Yes — the budget is fixed in both directions.** Peak proxy memory is flat as
   the pack grows on a push (pack in request) *and* on a clone (pack in response):
   ~6–18 MB held regardless of a 16→256 MB pack. Forwarding each chunk and keeping
   only a bounded window makes proxy memory independent of pack size. This is the
   roadmap's "thin streaming proxy, no packfile parsing on the hot path" — extended
   to the read path it left unstated.

2. **Buffering is the linear baseline, and it's what the prior experiments did.**
   The control proxy (concatenate the whole body, as `git-remote-domain-swap` and
   `tls-terminate-reencrypt` both did) holds ~2× the pack and its RSS reaches ~11×
   the streaming proxy's at 256 MB. The flat streaming result is meaningful *because*
   the same packs make this proxy climb — the inputs were genuinely large.

3. **Header auth needs zero body bytes.** Auth lives in the request headers, which
   precede the body, so an unauthenticated request is refused having read no pack at
   all. Being memory-flat and being auth-enforcing are not in tension.

4. **Front-of-stream ref policy needs only a bounded prefix.** The ref-update
   commands precede the pack and end at a flush pkt; the proxy polices them from a
   ~16 KB window (one socket read), independent of pack size, then streams the pack
   opaquely. A rejected push is *drained*, not buffered, so refusing a 64 MB push is
   as flat as accepting one. Inspection and streaming coexist — the seam is at the
   front of the stream, not the whole of it.

5. **What streaming gives up vs. the buffering seat.** A streaming proxy that only
   relays the pack cannot, by construction, hold a copy for durable replay or read
   the pack's *contents* — the very custody the `tls-terminate-reencrypt` experiment
   demonstrated. That is the right trade for the hot path (durability in the roadmap
   comes from streaming *into Artifacts*, not from holding the pack in the Worker),
   but it means "inspect the pack" and "stay O(1) in the pack" are mutually
   exclusive on a single pass. Front-of-stream policy is exactly the class of
   inspection that survives the trade: it reads what comes *before* the pack.

## Files

```
stream-both-directions/
├── README.md            # this file
├── RESEARCH_LOG.md      # chronological notebook: design, measurement method, findings
└── code/
    ├── gen-certs.sh          # two-CA throwaway PKI (copied from tls-terminate-reencrypt)
    ├── upstream-server.js    # streaming HTTPS git server (real git-http-backend) = "github.com"
    ├── streaming-proxy.js    # THE SUBJECT: stream both directions, header auth, front-of-stream policy
    ├── buffering-proxy.js    # memory CONTROL: buffers both directions (what the predecessors did)
    ├── memsample.js          # the instrument: process-lifetime peak of rss + arrayBuffers
    ├── wire.js               # pkt-line decoder + scanReceivePackCommands (front-of-stream scanner)
    ├── run.sh                # one-command reproduction: sweep + auth + policy controls
    └── package.json          # metadata; no dependencies
```

## Follow-ups worth running next

- **Stream all the way into durable storage.** Here the streamed request just goes
  to a live upstream. The roadmap's durability point is Artifacts: stream the
  request body straight into an Artifacts write (client → proxy → Artifacts) and
  confirm the proxy stays flat *and* the ack waits only on the storage write, not on
  a container or the pack being held.
- **Concurrency, not just size.** Peak was measured one transfer at a time. Run N
  concurrent 256 MB pushes/clones and confirm the budget is `O(N × window)`, not
  `O(N × pack)` — the real edge is a shared box serving many repos at once.
- **Measure inside workerd, not Node.** The roadmap's Phase 4.5 note is that
  workerd's stream/memory behavior differs from Node's. Re-run the sweep against a
  `wrangler dev`/deployed Worker to validate the 128 MB heap ceiling never binds
  when nothing is buffered — the whole reason streaming matters there.
- **Tighten the policy window.** The DENY window here is one socket read (~16 KB),
  not the ~179-byte command section, because a chunk carried commands + pack start.
  Cap the head strictly at the flush and forward the residual pack bytes separately,
  to report the true minimum inspection prefix.
- **Backpressure under a slow reader.** Confirm memory stays flat when the *client*
  reads a clone slowly (or the upstream ingests a push slowly): a stalled consumer
  is the classic way a "streaming" proxy silently starts buffering.
