# Research log: workerd concurrency envelope

A chronological notebook of the experiment's hypotheses, implementation choices,
failures, and evidence. Dates are absolute.

---

## 2026-09-01 - Framing

The preceding direct-workerd experiment established O(1)-in-body behavior for one
push or clone when the Worker forwards a native `tee()` branch. It did not answer
how memory scales when one isolate carries concurrent streams, what a slow peer
does to queues, whether a warmed process retains memory across waves, or how a
disconnect affects sibling requests.

Rejected a 128 MiB cgroup as the primary next test. Killing or constraining an
entire standalone workerd process does not reproduce hosted per-isolate memory
accounting and would mix runtime baseline/native allocations with Worker memory.

**Hypothesis.** Native pass-through remains O(1) in each body. Incremental memory
should instead grow with active stream count, and repeated waves should settle or
show GC/allocator releases rather than pack-sized accumulation.

## 2026-09-01 - Production-shaped topology

Kept the measured path as direct workerd, without Wrangler or Miniflare. Added two
unmeasured Node fixtures:

- a client-side response shaper to model a slow clone consumer and inject one
  deterministic downstream reset;
- a `git-http-backend` adapter that slowly consumes push bodies and paces clone
  response bodies.

Each request receives a case header. After a request or response crosses 1 MiB,
the upstream writes `active-start` and `active-end` events with a global active
count. This distinguishes simultaneous Git commands from simultaneous pack bytes.

The Worker imports the exact implementation and policy from
`workerd-duplex-streaming`. A thin wrapper logs a module-scope isolate ID for each
case. Initializing that ID with `crypto.randomUUID()` in module global scope failed
because workerd disallows random generation there. Lazy initialization during the
first fetch fixed startup without changing request behavior.

## 2026-09-01 - Reduced matrix and telemetry correction

The first reduced 1/2-stream run completed all Git operations and cancellation,
but mixed cases reported only one active stream. Inspection showed that clone
packs were paced only after workerd. The upstream could finish writing into socket
buffers before a push pack became active, so its telemetry did not prove overlap
across the Worker-to-upstream leg.

Added clone response pacing before workerd as well as slow consumption after it.
For mixed cases, push clients now start first; once every push pack has crossed the
1 MiB threshold, clone clients start. This intentionally creates worst-case
co-residency and makes the maximum-active assertion deterministic.

The corrected ten-case reduced matrix passed. At two mixed 4 MiB streams the
upstream observed both active, workerd added 0.90 MiB RSS, two longevity waves used
one PID/isolate, and the injected clone reset failed only that operation.

## 2026-09-01 - Full concurrency and size matrix

Ran the default 26 cases with per-stream shaping at 4 MiB/s. Every requested pack
overlapped, every successful clone blob and pushed ref verified, and all upstream
requests used the replacement credential.

Fresh-process 8 MiB concurrency results:

| Concurrency | Push RSS delta | Clone RSS delta | Mixed RSS delta |
|---:|---:|---:|---:|
| 1 | 0.79 MiB | 0.24 MiB | - |
| 2 | 1.05 MiB | 0.37 MiB | 0.86 MiB |
| 4 | 1.36 MiB | 0.68 MiB | 1.21 MiB |
| 8 | 2.12 MiB | 1.25 MiB | 1.89 MiB |
| 16 | 3.62 MiB | 2.33 MiB | 3.18 MiB |

Linear fits produced slopes of 0.187 MiB/push, 0.140 MiB/clone, and 0.165 MiB per
mixed stream. This is empirical process RSS, not a guaranteed allocation per
request.

At concurrency 8, mixed 8/32/96 MiB packs produced RSS deltas of 1.89, 1.88, and
1.91 MiB. Aggregate pack traffic grew from about 64 to 768 MiB with no meaningful
movement in the workerd high-water mark.

## 2026-09-01 - Cancellation

Opened four pushes and four clones using 32 MiB packs, then reset one clone after
2 MiB reached the client shaper. The canceled Git command reported early EOF.
Four pushes and three sibling clones completed, workerd served a health
`ls-remote`, all eight pack streams had overlapped, and incremental RSS peaked at
2.13 MiB.

This establishes survival and sibling isolation for a downstream clone cancel. It
does not cover every cancellation timing or an upstream reset during a push.

## 2026-09-01 - Eight-wave run was ambiguous

The default longevity phase reused one PID and isolate for eight waves of four
pushes plus four clones. Settled RSS was:

```text
46.13, 46.87, 47.73, 48.50, 52.98, 53.04, 53.33, 53.57 MiB
```

That passed the loose drift gate but had not actually demonstrated a plateau. A
large allocation step occurred in wave 5, and the final three points were still
moving upward slightly. Stopping there would overstate the evidence.

Added selectable `PHASES` so longevity can be repeated without rerunning the
expensive 96 MiB size curve.

## 2026-09-01 - Twenty-wave longevity extension

Ran `PHASES=longevity WAVES=20 KEEP=1 ./code/run.sh`. All 160 Git operations used
the same PID and isolate ID. The floor first rose to 53.11 MiB, then fell sharply:

```text
wave 1-7:   46.18 -> 53.11 MiB
wave 8:     42.93 MiB
wave 13:    30.74 MiB
wave 18:    30.43 MiB
wave 20:    39.71 MiB
```

There were later upward steps too, including a 7.88 MiB peak delta in wave 19,
but no monotonic retained-memory trend. The process demonstrably returned resident
pages during the run. Black-box RSS cannot assign those releases to V8 GC,
workerd native allocation, the system allocator, or a combination.

## 2026-09-01 - Interpretation

The experiment supports an O(active streams), O(1)-in-body model for native Git
pass-through in this workerd build. It rejects two simpler models:

1. memory proportional to each pack, because 8 and 96 MiB packs were flat at the
   same concurrency;
2. a permanently retained allocation per request wave, because RSS fell by more
   than 10 MiB twice while the same process stayed alive.

It also explains why the earlier Node proxy's roughly 15 MiB plateau should not be
treated as a Git-client constant. The sampled proxy runtime, stream queues,
concurrency, and allocator cycle control the numeric plateau. Git packing settings
mostly affect how long streams overlap and run outside the sampled PID here.

The next increase in fidelity should be a deployed canary using the real upstream
service and platform memory telemetry. It should retain the same synchronized
concurrency, slow-peer, wave, and cancellation controls so local and hosted shapes
can be compared without pretending their absolute RSS numbers are equivalent.
