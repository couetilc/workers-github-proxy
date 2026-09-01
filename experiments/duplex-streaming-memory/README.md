# Experiment: stream Git packs both ways through bounded proxy memory

**Question.** Can a smart-HTTP Git proxy stream an unbounded push body to its
upstream and an unbounded clone/fetch response back to its client while keeping a
small, fixed memory budget? Can it still replace credentials at the header
boundary and enforce a ref policy from only the bounded command prelude?

**Short answer.** Yes in this local Node experiment. Real `git push` and `git
clone` operations moved incompressible 8, 32, and 96 MiB payloads through the
proxy. The largest body was 12x the smallest, but proxy RSS stopped growing:

| Direction | 8 MiB body | 32 MiB body | 96 MiB body | Largest stream queue |
|---|---:|---:|---:|---:|
| Push request | 9.17 MiB RSS delta | 13.11 MiB | 13.79 MiB | 128.0 KiB request |
| Clone response | 11.12 MiB RSS delta | 23.01 MiB | 22.18 MiB | 76.4 KiB response |

Every transfer stayed below the experiment's 32 MiB RSS-delta ceiling. The 96
MiB bodies were three times that ceiling, so whole-body buffering could not have
passed. The 32-to-96 MiB plateau and bounded queues are the stronger evidence:
tripling the body added 0.68 MiB on push and reduced the measured clone peak by
0.83 MiB.

The same runs proved the two non-body concerns:

- The proxy accepted a client credential, removed it, and sent a distinct
  upstream credential. All 21 audited upstream requests had the replacement;
  none contained the client credential.
- A push to `refs/heads/protected` was rejected from the receive-pack pkt-line
  prelude. The proxy never opened an upstream request and the ref did not appear
  in the bare repository.

This establishes the transport mechanism, not a Cloudflare production limit.
Workerd, Workers request limits, TLS, and the Artifacts service still need deployed
measurement.

## Why both directions matter

The roadmap explicitly requires inbound pushes to stream client -> Worker ->
Artifacts, but the same URL swap also puts clones and fetches on the proxy path.
Their large pack is in the opposite half of the HTTP exchange:

```
push:   git --[small ref prelude | unbounded PACK]--> proxy --> upstream
clone:  git <--[negotiation | unbounded sideband PACK]-- proxy <-- upstream
```

Buffering only the request would solve the write path and leave the read path
with a repo-sized memory hazard. This experiment applies backpressure to both
halves and measures them independently.

TLS is intentionally absent here. The preceding
[`tls-terminate-reencrypt`](../tls-terminate-reencrypt) experiment already proved
that two verified TLS legs expose the same plaintext streams at the proxy. Adding
that PKI again would test the established TLS fact, not whether a body is retained.

## Experimental design

The harness runs on loopback in a disposable temp directory and uses only Node
built-ins plus the installed `git` and `git-http-backend`.

For each size (8, 32, and 96 MiB), [`code/run.sh`](./code/run.sh):

1. Creates a repository containing one `/dev/urandom` blob. Random input prevents
   pack compression from turning a large file into a tiny wire body.
2. Starts a fresh proxy process, pushes to an empty bare repo through it, verifies
   the upstream ref, and stops the proxy.
3. Starts another fresh proxy process, clones that repo through it, verifies the
   fetched blob size, and stops the proxy.
4. Selects the pack-carrying RPC from Git's negotiation requests and checks its
   RSS delta, external/ArrayBuffer allocation, body bytes, policy retention, and
   writable queue peaks.

Restarting the proxy for each measured operation prevents a previous transfer's
allocator high-water mark from hiding the next one's cost. RSS is sampled every 5
ms and at every chunk/queue observation.

The automated gates require:

- all transfers under a 32 MiB per-request RSS delta;
- at least 8x body growth across the size sweep;
- the 96 MiB RSS delta no more than 8 MiB above the 32 MiB delta;
- request and response writable queues under 2 MiB;
- policy retention no larger than the 64 KiB command cap plus one bounded
  transport chunk;
- successful auth replacement, no client credential at upstream, and local
  rejection of the protected ref.

The generous queue and plateau tolerances make the reproduction portable across
Node/kernel versions while still making whole-body buffering fail decisively.

## The bounded policy gate

Receive-pack places every proposed ref update before the raw packfile:

```
<old-oid> <new-oid> refs/heads/main\0<capabilities>\n
...
0000
PACK...
```

[`code/policy.js`](./code/policy.js) incrementally parses only those pkt-lines.
[`code/streaming-proxy.js`](./code/streaming-proxy.js) holds chunks until the
`0000` flush, applies the ref rule, then either:

- returns 403 and drains the client body without opening upstream; or
- opens upstream, writes the held prelude, and forwards every remaining chunk
  with writable-drain backpressure.

The measured allowed pushes retained at most 65,202 bytes for policy. The
protected-ref control retained 216 bytes and was rejected before its pack could
matter. A 64 KiB incomplete command prelude fails closed with 413.

Clone/fetch responses need no ref gate. Each upstream chunk is written directly to
the client response; a full client socket queue pauses upstream until `drain`.

## Auth boundary

The harness sends `Authorization: Bearer client-only` to the proxy. The proxy
validates it at header level, deletes hop-by-hop/body-framing headers, and sends
`Authorization: Bearer upstream-only` on a separately constructed upstream
request. The upstream accepts only the latter and writes a JSONL audit record that
classifies, but never records, the credential value.

An unauthenticated `ls-remote` fails locally. An authenticated one succeeds. This
models the roadmap's proxy-token -> scoped Artifacts-token mapping at the relevant
HTTP boundary; it does not test token issuance, scope, expiry, or Basic-vs-Bearer
credential UX.

## How to run

From this directory:

```bash
./code/run.sh
KEEP=1 ./code/run.sh
SIZES_MIB="8 32 128" ./code/run.sh
```

`KEEP=1` preserves the generated repositories, JSONL measurements, auth audit,
and process logs and prints their temp path. `PROXY_PORT` and `UPSTREAM_PORT`
override the loopback ports. The memory gates can be adjusted with
`MEMORY_BUDGET_MIB`, `MEMORY_PLATEAU_TOLERANCE_MIB`, and `QUEUE_BUDGET_MIB`.

The default run takes roughly 15 seconds in the agent container and uses about
500 MiB of temporary disk before cleanup.

## Results

One full run on 2026-09-01 produced:

```text
direction  input MiB  body MiB  RSS MiB  external MiB  arrays MiB  reqQ KiB  respQ KiB
push               8       8.00     9.17          1.85        1.84      64.0        0.3
push              32      32.01    13.11          2.50        2.33     127.9        0.3
push              96      96.03    13.79          2.81        2.80     128.0        0.3
clone              8       8.01    11.12          8.90        8.90       0.5       64.0
clone             32      32.03    23.01         13.50       13.50       0.5       64.0
clone             96      96.08    22.18         13.43       13.43       0.5       76.4
PASS: 6 transfers stayed within a fixed 32 MiB RSS delta budget.
PASS: 21 upstream requests used only the replacement credential; protected ref stopped locally.
```

The external/ArrayBuffer columns explain why the 8-to-32 MiB RSS values are not
perfectly horizontal. Node allocates fresh network chunks; unreachable chunks
remain counted until V8 runs garbage collection under allocation pressure. This
is allocator churn, not a growing stream queue. By 32 MiB, automatic collection
has established a high-water mark and the 96 MiB run stays there. No explicit GC
or `--expose-gc` was used.

## Conclusions

1. **A Git smart-HTTP proxy can stay on both byte paths without holding either
   pack.** Backpressured request and response forwarding completed real 96 MiB
   pushes and clones inside a 32 MiB RSS-delta budget.

2. **The bounded exception is the front-of-stream control plane.** Receive-pack's
   command prelude can be retained, parsed, and authorized before opening the
   upstream request. The following pack remains opaque and streaming.

3. **Auth belongs at the header boundary, independent of body strategy.** Client
   credential validation and upstream credential replacement completed before
   any unbounded body handling. Streaming does not require forwarding the
   client's secret.

4. **The roadmap should state the read-path constraint explicitly.** Phase 1.5's
   `git-upload-pack` proxy has the same O(1)-in-body requirement as inbound
   receive-pack. Phase 3 should measure deployed response streaming as well as the
   documented inbound request-body ceiling.

## Limits and follow-up work

- Repeat inside deployed workerd/Workers and against Artifacts. Node loopback RSS
  cannot establish the 128 MiB Worker ceiling, edge body limits, or service-side
  buffering behavior.
- Sweep file count and history depth, not only one incompressible blob. They
  should not affect proxy memory, but will expose protocol and timeout behavior.
- Add slow-client, slow-upstream, and mid-pack disconnect controls to validate
  cancellation and queue bounds under adverse flow control.
- Exercise multi-ref pushes near the 64 KiB command-prefix cap and document the
  product behavior for an intentionally oversized ref set.
- Reintroduce TLS in the production conformance harness, where the value is
  catching integration regressions rather than re-proving TLS termination.

## Files

```text
duplex-streaming-memory/
|-- README.md                   design, measured results, and conclusions
|-- RESEARCH_LOG.md             chronological notebook
`-- code/
    |-- run.sh                  one-command real-Git reproduction
    |-- streaming-proxy.js      bounded policy gate, duplex streaming, telemetry
    |-- streaming-upstream.js   streaming git-http-backend HTTP adapter
    |-- policy.js               incremental receive-pack command parser
    |-- policy.test.js          chunk-boundary and malformed-input unit controls
    |-- assert-results.js       memory/auth/policy result gates and report
    `-- package.json            scripts; no third-party dependencies
```
