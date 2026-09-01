# Experiment: workerd concurrency envelope

**Question.** How does the native-stream Worker from
[`workerd-duplex-streaming`](../workerd-duplex-streaming) behave under concurrent,
backpressured Git traffic? Does memory scale with pack size, concurrent streams,
or repeated traffic in one warmed process, and does cancellation release the
stream without harming sibling requests?

**Short answer.** In standalone workerd, incremental process RSS scaled with the
number of active streams, not their body size. Fresh warmed processes moving
8 MiB packs showed these RSS deltas:

| Concurrent streams | Push | Clone | Mixed push/clone |
|---:|---:|---:|---:|
| 1 | 0.79 MiB | 0.24 MiB | - |
| 2 | 1.05 MiB | 0.37 MiB | 0.86 MiB |
| 4 | 1.36 MiB | 0.68 MiB | 1.21 MiB |
| 8 | 2.12 MiB | 1.25 MiB | 1.89 MiB |
| 16 | 3.62 MiB | 2.33 MiB | 3.18 MiB |

A least-squares line over those points is about 0.19 MiB per push, 0.14 MiB per
clone, and 0.17 MiB per mixed stream. These are observations from this pinned
runtime and host, not production capacity constants.

At fixed concurrency 8, increasing every pack from 8 to 96 MiB did not move the
high-water mark:

| Pack per stream | Aggregate pack traffic | workerd RSS delta | Max active |
|---:|---:|---:|---:|
| 8 MiB | about 64 MiB | 1.89 MiB | 8 |
| 32 MiB | about 256 MiB | 1.88 MiB | 8 |
| 96 MiB | about 768 MiB | 1.91 MiB | 8 |

The runtime therefore retained bounded per-stream state under this workload. It
did not retain a pack-sized body per request.

## What the longevity run found

The first default run kept one workerd PID and one module-scope isolate ID across
eight waves. Each wave contained four pushes and four clones of 8 MiB packs. Its
post-settle RSS rose from 46.13 MiB after wave 1 to 53.57 MiB after wave 8, with
most of the increase arriving in one step at wave 5. Eight waves were not enough
to call that a stable plateau.

An isolated 20-wave repeat showed the missing behavior:

| Wave | Settled RSS | Observation |
|---:|---:|---|
| 1 | 46.18 MiB | first concurrent wave allocation |
| 5 | 53.01 MiB | high floor after a 4.48 MiB step |
| 7 | 53.11 MiB | highest settled floor |
| 8 | 42.93 MiB | runtime returned about 10 MiB |
| 13 | 30.74 MiB | another large release |
| 18 | 30.43 MiB | late low floor |
| 20 | 39.71 MiB | final floor after a later allocation step |

All 160 Git operations completed on the same PID and isolate ID. The series is
sawtoothed rather than a fixed plateau, but it is not a monotonic per-wave leak.
Standalone process RSS reflects runtime heap growth, garbage collection, native
allocators, and pages returned to Linux. A short run can stop at the top of that
cycle and make the retained floor look permanent.

This also answers why a prior Node experiment plateaued near 15 MiB: that number
was not a Git client configuration limit. The Git clients run outside the sampled
process here, and changing the runtime and concurrency changed the memory shape.
Git packing settings affect CPU time and overlap, but the proxy high-water mark is
primarily a property of its runtime, stream implementation, active-request count,
and allocator state.

## Cancellation result

The cancellation case opens eight overlapping 32 MiB transfers: four pushes,
three normal clones, and one clone whose downstream connection is reset after
2 MiB. The canceled Git process failed with an incomplete pack, all seven sibling
operations completed and passed object/ref checks, and an authenticated
`ls-remote` proved workerd was still serving requests. Peak incremental RSS was
2.13 MiB and the upstream observed all eight large streams active together.

## Production interpretation

This experiment usefully simulates the parts of a production Worker that matter
for stream-memory pressure:

- one Worker service and one warmed isolate handle many simultaneous requests;
- real Git smart-HTTP clients generate receive-pack and upload-pack traffic;
- request and response bodies cross Worker Fetch and Web Streams APIs;
- pushes encounter a slow upstream consumer;
- clones encounter both a paced upstream producer and a slow downstream client;
- mixed traffic is synchronized after push packs become active, creating
  deliberate worst-case co-residency;
- repeated waves reuse the process and isolate instead of resetting allocator
  state;
- a downstream disconnect tests cancellation propagation while siblings remain
  active.

The useful production conclusion is qualitative: budget memory by concurrent
active streams plus a warmed runtime floor, not by repository or pack size. Do
not project the observed 0.14-0.19 MiB/process-RSS slope directly into a hosted
128 MiB isolate calculation.

Standalone workerd RSS includes native process/runtime costs that hosted isolate
accounting may exclude or attribute differently. Hosted Workers also schedules
isolates, applies CPU and request limits, terminates TLS, multiplexes real network
connections, and may evict an isolate. The Artifacts service is not represented.
Production can have a different per-stream constant and a different allocator
cycle even if the O(concurrency), O(1)-in-body shape survives.

## Topology

The measured PID contains only workerd and the Worker. Both traffic shapers and
Git are outside it:

```text
concurrent git CLI processes
          |
          v
Node client shaper (slow clone consumer + deterministic abort)
          |
          v
single workerd process / single Worker service
          |  auth replacement, receive-pack tee policy, native pass-through
          v
Node upstream shaper (slow push consumer + paced clone producer)
          |
          v
real git-http-backend and bare repositories
```

The Worker wrapper imports the exact proxy and policy modules from the preceding
experiment. It adds only a case label and an isolate ID initialized on the first
request. Node fixtures count bytes and active large transfers without retaining
a whole body.

## Experimental design

The default run has four phases:

1. **Concurrency:** fresh warmed workerd processes for 1, 2, 4, 8, and 16 push
   streams; the same clone curve; and mixed curves from 2 through 16.
2. **Pack size:** fresh processes at concurrency 8 for 8, 32, and 96 MiB
   incompressible packs.
3. **Longevity:** eight mixed waves on one warmed process and isolate.
4. **Cancellation:** eight 32 MiB mixed streams with one injected clone abort.

Each client carries an experiment-case header. The upstream marks a pack transfer
active after its request or response crosses 1 MiB and logs the global active
count. Mixed cases start clone clients only after all push packs are active. This
proves byte-transfer overlap rather than assuming concurrent shell PIDs imply it.

Before each fresh-process measurement, an authenticated `ls-remote` loads the
Worker and service binding. A separate process samples `/proc/<pid>/status` every
5 ms and records baseline, peak, and post-settle RSS. Every successful push ref
and clone blob size is verified.

Default regression gates require:

- the requested number of pack-sized streams to overlap;
- every non-canceled operation to carry at least 85% of its generated blob size;
- incremental RSS below a loose `12 MiB + 4 MiB * concurrency` guardrail;
- no more than 12 MiB RSS variation across the fixed-concurrency size curve;
- no more than 12 MiB late-window floor growth over the early longevity window;
- one isolate ID for every longevity wave;
- exactly one deterministic downstream abort;
- replacement upstream auth on every request and no client credential leak;
- receive-pack policy retention below 128 KiB.

Those thresholds are regression tripwires, not claimed hosted limits. The measured
values were substantially lower.

## How to run

Requires Linux `/proc`, Node, npm, Git with `git-http-backend`, and `dd`:

```bash
./code/run.sh
KEEP=1 ./code/run.sh
PHASES=longevity WAVES=20 KEEP=1 ./code/run.sh
```

`run.sh` installs the pinned workerd binary when absent. `KEEP=1` retains JSONL
RSS measurements, request/active-stream audits, Worker logs, shaper logs, and Git
fixtures in the printed temporary directory.

Useful controls include:

```bash
CONCURRENCIES="1 2 4 8" CURVE_SIZE_MIB=16 ./code/run.sh
RATE_MIB_PER_SECOND=1 ./code/run.sh
PHASES="size cancel" SIZES_MIB="8 64 128" ./code/run.sh
```

Available phases are `concurrency`, `size`, `longevity`, and `cancel`. Ports,
sizes, concurrency levels, wave counts, throttle rate, settle time, cancellation
point, and assertion tolerances are environment-configurable in `code/run.sh` and
`code/assert-results.js`.

## Conclusions

1. **Memory is O(concurrency), not O(pack size), in this workerd topology.** Sixteen
   simultaneous 8 MiB streams added 2.33-3.62 MiB, while eight 96 MiB streams
   added 1.91 MiB.

2. **The per-stream constant is runtime-specific.** It is much smaller here than
   the earlier Node proxy's plateau, confirming that one local RSS number is not a
   Git configuration or portable production constant.

3. **The warmed floor is dynamic.** Repeated waves triggered both allocation
   steps and large RSS releases. Capacity tests need enough waves to observe a
   full allocator/GC cycle.

4. **Native pass-through remains robust under slow peers and disconnects.** The
   Worker survived deliberate maximum overlap and cancellation without retaining
   bodies, corrupting sibling operations, or leaking credentials.

5. **A deployed canary is the next fidelity step.** It should measure platform
   isolate memory under the same concurrency/wave matrix against the real
   upstream service, with production TLS, CPU limits, and scheduler behavior.

## Files

```text
workerd-concurrency-envelope/
|-- README.md                    design, results, and production interpretation
|-- RESEARCH_LOG.md              chronological notebook
`-- code/
    |-- run.sh                   phased real-Git orchestration
    |-- worker.js                isolate/case telemetry wrapper
    |-- workerd.capnp.template   direct workerd service configuration
    |-- client-shaper.cjs        slow client and deterministic abort fixture
    |-- git-upstream.cjs         throttled git-http-backend and overlap audit
    |-- throttle.cjs             bounded per-request byte-rate transform
    |-- throttle.test.cjs        shaper correctness tests
    |-- rss-sampler.js           5 ms workerd PID RSS sampler
    |-- assert-results.js        overlap, memory, auth, and lifecycle gates
    |-- package.json             pinned workerd dependency
    `-- package-lock.json        exact npm dependency graph
```
