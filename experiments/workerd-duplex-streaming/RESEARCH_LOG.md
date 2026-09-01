# Research log: workerd duplex Git streaming

A chronological notebook of the experiment's hypotheses, attempts, failures, and
evidence. Dates are absolute.

---

## 2026-09-01 - Framing

The Node duplex experiment established that both Git pack directions can be
backpressured without holding whole bodies. Its process RSS plateaued around 15
MiB for push and 22 MiB for clone, but that number was a Node/V8/libuv/glibc result.
The next question is whether the architecture and plateau survive the runtime that
actually powers Workers.

**Hypothesis.** A Worker using Fetch and Web Streams should remain O(1)-in-body if
it retains only the receive-pack command prelude and forwards each body with
runtime backpressure. The numeric high-water mark should differ from Node.

**Required controls.** Keep real Git, incompressible packs, auth replacement, and
protected-ref rejection. Measure workerd itself rather than a Wrangler or
Miniflare Node supervisor.

## 2026-09-01 - Direct workerd topology

Pinned npm `workerd@1.20260831.1` and launched `workerd serve` with a Cap'n Proto
configuration. The proxy Worker has an explicit service binding to an external
loopback Node server. This avoids global-fetch SSRF allowances and removes
Wrangler's development proxy from the measured path.

The first config render placed its generated Cap'n Proto file under `/tmp` and
used absolute `embed` paths. The prebuilt workerd parser refused those embeds.
Generating the ignored config beside `worker.js` and using relative embeds fixed
startup. A curl smoke test then traversed Worker -> external service successfully.

## 2026-09-01 - Measurement design

Standalone workerd exposes no per-request JS memory API. Added an external Node
sampler that reads `/proc/<workerd-pid>/status` every 5 ms. It records warmed
baseline RSS, peak RSS, sample count, and elapsed time. This is process RSS, not
hosted isolate accounting.

Each operation gets a fresh workerd process. Before sampling, authenticated
`ls-remote` loads the Worker module and exercises the service binding so startup
allocation does not masquerade as streaming memory.

The upstream adapter streams request bytes into real `git-http-backend`, streams
CGI output back, and records byte counts plus auth classification. It never retains
a pack.

## 2026-09-01 - First request implementation: reconstruction

The initial receive-pack gate read chunks until the command flush, then returned a
new JavaScript `ReadableStream`. Its `pull()` first re-enqueued held chunks and then
read/enqueued one original chunk at a time. It was logically backpressured and
matched the successful Node control flow.

Reduced 1/4/8 MiB results:

| Direction | 1 MiB | 4 MiB | 8 MiB |
|---|---:|---:|---:|
| Push RSS delta | 7.91 MiB | 14.72 MiB | 23.05 MiB |
| Clone RSS delta | 0.14 MiB | 0.14 MiB | 0.20 MiB |

The response was flat, but request memory clearly grew with the pack.

**First suspicion:** workerd might deliver the entire request as one giant chunk,
which the policy `held` array would retain. Policy logs disproved this. The
pack-carrying pushes held 4,122, 3,762, and 3,762 bytes respectively; command
prefixes were 179 bytes. The growing memory was downstream of policy retention.

The evidence points to the JS-backed reconstructed stream or its handoff through
the external service binding. Black-box RSS cannot separate JS stream queues,
native bridge allocations, and GC timing, so do not overstate the internal cause.

## 2026-09-01 - Preserve the runtime-owned stream with `tee()`

Changed the gate to:

1. `const [policyBody, forwardBody] = request.body.tee()`;
2. read policy only from `policyBody`;
3. reject by cancelling both branches, or approve by cancelling policy and passing
   `forwardBody` untouched to `env.UPSTREAM.fetch()`.

Only the few kilobytes consumed for policy can queue on the not-yet-read forward
branch. Once approved, there is no competing reader and workerd owns the stream
all the way into its service binding.

The same reduced matrix changed to:

| Direction | 1 MiB | 4 MiB | 8 MiB |
|---|---:|---:|---:|
| Push RSS delta | 0.82 MiB | 0.81 MiB | 0.90 MiB |
| Clone RSS delta | 0.16 MiB | 0.16 MiB | 0.15 MiB |

This is a mechanism change of roughly an order of magnitude at 8 MiB, not sampler
noise.

## 2026-09-01 - Full 8/32/96 MiB run

The direct workerd run completed all pushes, clones, object/ref integrity checks,
auth controls, and ref policy controls:

| Direction | 8 MiB | 32 MiB | 96 MiB |
|---|---:|---:|---:|
| Push RSS delta | 0.81 MiB | 0.83 MiB | 0.85 MiB |
| Clone RSS delta | 0.15 MiB | 0.19 MiB | 0.16 MiB |

Wire bodies were 8.00/32.01/96.03 MiB on push and
8.01/32.03/96.08 MiB on clone. Warm baselines stayed between 43.94 and 43.97 MiB.
The largest transfers ran for 4.6 seconds push and 2.8 seconds clone, yielding
hundreds of RSS samples.

All upstream requests used the replacement credential and none saw the client
credential. The protected ref produced a Worker `policy-rejected` event, no new
upstream receive-pack POST, and no bare-repo ref.

## 2026-09-01 - Make the failed path reproducible

Retained both constructions behind `REQUEST_STREAM_MODE=tee|reconstruct`. The
default remains `tee`; `reconstruct` is an explicit negative control.

A fresh reconstruction run reproduced the earlier behavior:

| Push body | RSS delta |
|---:|---:|
| 1.00 MiB | 7.71 MiB |
| 4.00 MiB | 15.39 MiB |
| 8.00 MiB | 22.71 MiB |

Clone remained 0.16–0.21 MiB. The control makes it possible to detect future
workerd changes rather than preserving the result only as prose.

## 2026-09-01 - Tightened default and repeat

Reduced the default per-transfer RSS-delta gate from the exploratory 64 MiB to 8
MiB and the 32-to-96 plateau tolerance from 16 MiB to 2 MiB. These remain generous
relative to the observed sub-1 MiB deltas but reject the reconstruction control.

A second full default run passed:

| Direction | 8 MiB | 32 MiB | 96 MiB |
|---|---:|---:|---:|
| Push RSS delta | 0.88 MiB | 0.89 MiB | 0.85 MiB |
| Clone RSS delta | 0.19 MiB | 0.19 MiB | 0.19 MiB |

The repeat confirms the plateau is stable in this pinned container/runtime, not a
single favorable GC cycle.

## 2026-09-01 - Interpretation

The result answers the architectural question: workerd can stream both Git pack
directions with flat process memory while a Worker performs header auth and a
bounded front-of-stream policy decision.

It also raises the implementation bar. Web Streams code must preserve the native
body branch. “One chunk at a time” in user-created JavaScript was not equivalent
to native pass-through in measured workerd RSS.

The next memory uncertainty is hosted concurrency, not pack size. Standalone
workerd process RSS cannot say how Cloudflare attributes native queues to a V8
isolate or how multiple simultaneous requests share the 128 MiB ceiling. Deployed
tests should sweep concurrency, slow peers, cancellation, request-plan limits, and
the real Artifacts destination.
