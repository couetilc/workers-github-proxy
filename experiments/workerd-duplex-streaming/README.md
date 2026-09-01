# Experiment: duplex Git streaming inside workerd

**Question.** Does the bounded-memory result from
[`duplex-streaming-memory`](../duplex-streaming-memory) survive when the proxy runs
as a Worker inside the actual open-source workerd runtime? Can Worker Web Streams
still enforce the receive-pack ref prelude and replace auth without retaining the
push request or clone response body?

**Short answer.** Yes, but only when the Worker preserves workerd's native body
stream. A direct workerd process moved real 8, 32, and 96 MiB Git packs in both
directions with flat incremental RSS:

| Direction | 8 MiB wire body | 32 MiB | 96 MiB |
|---|---:|---:|---:|
| Push request | 0.81 MiB RSS delta | 0.83 MiB | 0.85 MiB |
| Clone response | 0.15 MiB RSS delta | 0.19 MiB | 0.16 MiB |

The warmed workerd process baseline was about 44 MiB. Tripling the pack from 32
to 96 MiB did not move either high-water mark. Auth replacement and protected-ref
rejection also held inside the Worker.

The implementation detail is load-bearing. Two request-body constructions were
measured:

- **`tee` (default, correct):** split the original request body, read only the
  command prelude from one branch, cancel it, and pass the untouched other branch
  to the upstream service binding. Push RSS stayed below 1 MiB.
- **`reconstruct` (negative control):** read the command prelude, then create a new
  JavaScript `ReadableStream` that re-enqueues the held bytes and every subsequent
  chunk. Push RSS grew from 7.71 MiB for a 1 MiB pack to 22.71 MiB for an 8 MiB
  pack. Clone remained flat because that response already used native pass-through.

So “uses streams” is not a sufficient production rule. Preserve the runtime-owned
stream across `fetch()` whenever possible. A JavaScript stream wrapper that appears
incremental can still put body-proportional pressure on workerd.

## Relation to production

This is closer to Workers than the Node experiment in the ways that matter for
stream behavior:

- the proxy is an ES-module Worker running inside pinned workerd `2026-08-31`;
- incoming and outgoing bodies use Worker Fetch and WHATWG Streams APIs;
- the upstream is reached through a workerd external service binding;
- the response is returned directly as `new Response(upstreamResponse.body, ...)`.

It is still not a deployed Workers capacity result. The measurement is Linux
process RSS for a standalone, single-isolate workerd process. Hosted Workers uses
isolate-level accounting, shares an isolate across concurrent requests, terminates
TLS at the edge, and imposes account-plan request limits. This experiment also uses
a loopback HTTP upstream rather than the Artifacts binding/service.

The result therefore establishes the correct Worker stream construction and its
O(1)-in-body behavior. It does not establish how many concurrent Git streams fit
inside the hosted 128 MiB isolate limit.

## Topology

No Wrangler, Miniflare, or Node development proxy sits on the measured path:

```text
git CLI
   |
   | HTTP smart protocol
   v
workerd process
   `-- proxy Worker
         |-- auth replacement
         |-- receive-pack prefix policy (one tee branch)
         `-- env.UPSTREAM.fetch(untouched body branch)
                         |
                         v
instrumented Node HTTP adapter -> real git-http-backend -> bare repository
```

Node remains only the controlled upstream fixture. Its memory is outside the
sampled PID.

## Experimental design

[`code/run.sh`](./code/run.sh) pins and launches the npm-distributed workerd binary
directly with [`code/workerd.capnp.template`](./code/workerd.capnp.template). For
each of 8, 32, and 96 MiB it:

1. Creates a repository containing one incompressible `/dev/urandom` blob.
2. Starts a fresh workerd process and performs an authenticated `ls-remote` to load
   the Worker and warm its runtime allocations.
3. Starts a separate 5 ms `/proc/<pid>/status` RSS sampler.
4. Pushes through the Worker to an empty bare repo, stops the sampler, and verifies
   the upstream ref.
5. Repeats with a fresh warmed workerd process for a clone and verifies the fetched
   blob size.

The instrumented upstream counts request and response bytes while piping them. It
does not retain either body. The result gate matches the pack-carrying RPC for each
repo, rather than Git protocol v2's smaller negotiation RPCs.

The default assertions require:

- all six workerd process RSS deltas below 8 MiB;
- at least 7.5x wire-body growth across the configured sweep;
- the largest-body delta no more than 2 MiB above the preceding size;
- no client credential in any upstream audit record;
- every upstream request authenticated with the replacement credential;
- no upstream receive-pack POST for the protected-ref control;
- policy-held chunks below 128 KiB.

The actual receive-pack command prefix was 179 bytes and the workerd chunks held
for inspection were about 3.7–4.1 KiB. The protected control held 216 bytes.

## Why `tee` works here

Receive-pack puts ref commands before `PACK`, terminated by `0000`. The Worker can
make its decision after only that bounded prelude:

```js
const [policyBody, forwardBody] = request.body.tee();
const prelude = await readPolicyPrelude(policyBody, 64 * 1024);

if (rejectedRef(prelude.commands)) {
  await Promise.allSettled([prelude.reader.cancel(), forwardBody.cancel()]);
  return new Response('ref rejected', { status: 403 });
}

prelude.reader.cancel('policy inspection complete');
return env.UPSTREAM.fetch(new Request(upstreamUrl, { body: forwardBody, ...init }));
```

While policy reads the first branch, the second branch queues the same small
prelude. After approval, policy cancels and the runtime-owned forward branch is
consumed by the service binding. There is never a long-lived slow inspection
branch. That cancellation matters: a general-purpose `tee()` with one branch
falling behind could accumulate data for that branch.

The rejected request never opens upstream. The allowed request forwards the
original branch rather than copying chunks through JavaScript.

## Negative control: reconstructed request stream

The first implementation used the pattern that worked acceptably in Node:

```js
return new ReadableStream({
  async pull(controller) {
    const { value, done } = await originalReader.read();
    if (done) controller.close();
    else controller.enqueue(value);
  },
});
```

This remained logically backpressured, and policy telemetry disproved the initial
suspicion that a giant first chunk was retained: only about 4 KiB was held. Yet
workerd process RSS grew with the push:

| Reconstructed push body | RSS delta |
|---:|---:|
| 1.00 MiB | 7.71 MiB |
| 4.00 MiB | 15.39 MiB |
| 8.00 MiB | 22.71 MiB |

This black-box experiment cannot identify whether the growth comes from the
JS-backed stream implementation, the JS/native handoff in external `fetch()`, GC
timing, or a combination. It is enough to reject reconstruction for this hot path.
The selectable control keeps that failure reproducible.

## Auth and policy controls

The Git client presents `Bearer client-only`. The Worker validates it, constructs
new upstream headers containing `Bearer upstream-only`, and sends only those via
the service binding. An unauthenticated `ls-remote` fails without incrementing the
upstream audit.

For `refs/heads/protected`, the Worker logs `policy-rejected`, cancels both tee
branches, and returns 403. The harness proves the upstream receive-pack POST count
does not change and the ref is absent from the bare repo.

## How to run

Requires Linux `/proc`, Node, npm, Git with `git-http-backend`, and `dd`. From this
directory:

```bash
npm ci
./code/run.sh
KEEP=1 ./code/run.sh
SIZES_MIB="8 32 128" ./code/run.sh
```

`run.sh` performs `npm ci` automatically if the pinned workerd binary is absent.
`KEEP=1` retains RSS JSONL, upstream audits, workerd policy logs, and repositories
in the printed temp directory.

Reproduce the rejected stream construction with the smaller sweep and relaxed
observational budget:

```bash
REQUEST_STREAM_MODE=reconstruct \
SIZES_MIB="1 4 8" \
MEMORY_BUDGET_MIB=64 \
MEMORY_PLATEAU_TOLERANCE_MIB=16 \
./code/run.sh
```

The default mode is `REQUEST_STREAM_MODE=tee`. Ports can be overridden with
`PROXY_PORT` and `UPSTREAM_PORT`.

## Results

The default full run on 2026-09-01 produced:

```text
direction  input MiB  wire MiB  baseline MiB  RSS delta MiB  samples
push               8      8.00         43.97           0.81       72
clone              8      8.01         43.95           0.15       46
push              32     32.01         43.96           0.83      260
clone              32     32.03         43.94           0.19      179
push              96     96.03         43.96           0.85      748
clone              96     96.08         43.97           0.16      476
PASS: 6 workerd transfers stayed within a 64 MiB RSS-delta budget.
PASS: auth replacement and protected-ref policy held inside the Worker.
```

The gate was subsequently tightened from 64 to 8 MiB. A second full run passed
with push deltas of 0.88, 0.89, and 0.85 MiB and clone deltas of 0.19 MiB at every
size.

## Conclusions

1. **The duplex streaming result survives inside workerd.** Real 96 MiB request
   and response bodies remain O(1)-in-body with sub-1 MiB incremental process RSS
   when runtime-owned streams are passed through.

2. **Native stream identity is part of the architecture.** Reconstructing a
   request in a JavaScript `ReadableStream` caused strongly body-related RSS even
   though its pull loop was backpressured. The production proxy should inspect a
   short-lived tee branch and forward the untouched branch.

3. **Response forwarding is the simplest and flattest path.** Returning the
   upstream response body directly added about 0.2 MiB across all sizes.

4. **Header auth and front-of-stream policy do not require pack buffering.** Both
   operate before the unbounded body, and rejected traffic stays local.

5. **Hosted concurrency is now the remaining memory question.** The next deployed
   benchmark should measure isolate memory for 1/2/4/8 simultaneous pushes and
   clones, slow peers, disconnects, TLS/edge behavior, and the real Artifacts
   destination.

## Limitations and follow-ups

- Standalone workerd process RSS is not hosted Worker isolate memory. The roughly
  44 MiB baseline includes runtime/native process costs and should not be compared
  directly with the 128 MiB per-isolate limit.
- A 5 ms external sampler can miss very short transients, though the largest
  transfers lasted several seconds and repeated results were stable.
- Transfers are sequential on loopback. Slow peers and concurrency may increase
  runtime queues even when body-size complexity remains O(1).
- The external HTTP service binding is not Artifacts. Repeat against the beta
  service in deployed workerd/Workers as soon as access is available.
- Local workerd does not reproduce Cloudflare account-plan request-body limits.
- TLS is omitted because the previous experiment already proved termination and
  re-encryption; deployed conformance should combine both.

## Files

```text
workerd-duplex-streaming/
|-- README.md                    design, results, and conclusions
|-- RESEARCH_LOG.md              chronological notebook
`-- code/
    |-- run.sh                   one-command real-Git matrix and controls
    |-- worker.js                Worker auth, tee policy, and stream forwarding
    |-- policy.js                Worker-compatible receive-pack parser
    |-- policy.test.js           parser framing tests
    |-- workerd.capnp.template   direct runtime + external service configuration
    |-- rss-sampler.js           5 ms Linux workerd PID RSS sampler
    |-- git-upstream.cjs         streaming git-http-backend + wire-byte audit
    |-- assert-results.js        memory/auth/policy result gates
    |-- package.json             pinned workerd dependency and scripts
    `-- package-lock.json        exact npm dependency graph
```
