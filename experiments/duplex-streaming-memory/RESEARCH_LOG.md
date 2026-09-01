# Research log: duplex Git streaming through bounded proxy memory

A chronological notebook of the experiment's hypotheses, implementation choices,
failed attempts, and evidence. Dates are absolute.

---

## 2026-09-01 - Framing

The experiment queue asks whether the proxy can keep a fixed, small memory budget
for both directions of Git smart-HTTP:

- push: the pack is the large HTTP request body;
- clone/fetch: the pack is the large HTTP response body.

The preceding domain-swap and TLS experiments buffered bodies to inspect them.
That was useful evidence about visibility but would make proxy memory linear in
pack size. The roadmap calls inbound receive-pack a thin streaming proxy, while
the Phase 1.5 upload-pack read path and Phase 3 measurements do not say the
corresponding response-side requirement out loud.

**Hypothesis.** If both legs honor backpressure, proxy memory should reach a
runtime/socket high-water mark and stop growing even as pack size grows. The only
intentional body retention should be the receive-pack pkt-line command prelude,
bounded by an explicit cap.

**Success criteria.** Use actual Git, not a synthetic body generator. Grow an
incompressible pack by at least an order of magnitude, complete push and clone,
and keep every transfer under a fixed budget smaller than the largest body. Also
show that credential replacement and protected-ref rejection still work.

## 2026-09-01 - Design choices

**HTTP without TLS.** TLS termination and re-encryption were proved in the prior
experiment. The decrypted stream exposed to application code has the same flow
control semantics. Omitting certificates makes this experiment isolate memory.

**Real `git-http-backend`.** The upstream adapter streams the incoming request
directly to CGI stdin. It buffers only CGI response headers, then streams stdout
to the proxy with backpressure. This prevents a buffering test fixture from
distorting timing or hiding an end-to-end flow-control bug.

**Random single blobs.** `/dev/urandom` makes the requested 8/32/96 MiB sizes
survive Git's zlib/pack encoding. A zero-filled fixture would barely grow on wire
and could produce a false result.

**Fresh proxy per operation.** RSS is a process high-water-mark measurement. A
single long-lived proxy would make later cases inherit earlier allocator growth,
so every push and clone starts a new process and reports baseline-to-peak delta.

**Policy before upstream.** The proxy incrementally parses receive-pack command
pkt-lines through the terminating `0000`. It does not create the upstream request
until all proposed refs pass. This is stronger than opening upstream and aborting
after a rejection.

**Auth replacement.** The proxy requires one Authorization value and constructs
the upstream request with another. The upstream rejects anything else and records
only a credential classification, avoiding credential values in logs.

## 2026-09-01 - Parser and streaming implementation

The policy parser accepts SHA-1 and SHA-256-length object IDs, strips capabilities
from the first NUL-delimited command, validates framing, and exposes proposed
refs. Tests split a valid prelude at every byte boundary, reject malformed lengths,
and confirm pack bytes are outside the policy decision.

The request path uses an async iterator and awaits upstream `drain` whenever a
write crosses the writable high-water mark. The response path pauses upstream
when the client response queue fills and resumes on `drain`. Measurements include
RSS, heap, external memory, ArrayBuffers, request/response bytes, policy-held bytes,
and both writable queue peaks.

The 64 KiB prefix cap applies when the parser still has no complete flush. The
chunk containing the flush can also contain initial pack bytes, so the assertion
allows one transport chunk beyond the semantic prefix cap. In observed pushes,
the whole held chunk stayed just under 64 KiB.

## 2026-09-01 - Reduced 1/4/8 MiB shakeout

The first reduced run found a harness-only failure: the newly initialized bare
repo had no symbolic `HEAD`, so a `--no-checkout` clone fetched `origin/main` but
`HEAD:payload.bin` could not resolve. The integrity check now reads
`refs/remotes/origin/main:payload.bin`.

The next run completed all six transfers and both controls, but the result reducer
counted more than one POST per operation. Git protocol v2 uses small negotiation
RPCs in addition to the pack-carrying RPC. The reducer now groups by explicit run
label and selects the request with the largest relevant body.

Early RSS increased with 1/4/8 MiB bodies even though writable queues were fixed at
64 KiB. Added external and ArrayBuffer peaks to distinguish retained JS/network
buffers from resident allocator pages. They showed that Node had accumulated
uncollected short-lived chunks at small sizes; a larger run was required to see
whether automatic GC produced a stable high-water mark.

## 2026-09-01 - First full run and telemetry race

The first 8/32/96 MiB run completed all Git operations. Clone showed the expected
plateau (about 23 MiB RSS delta at both 32 and 96 MiB), but the 96 MiB push's pack
record was absent even though the upstream accepted the POST and its branch was
correct.

Cause: the harness sent SIGTERM as soon as Git exited, while the proxy waited for
the client response's `finish` event before resolving its telemetry promise. On
the large push, the client had its result while that final local event had not yet
run. The proxy was killed in that narrow window.

Fix: finalize the upstream completion promise when the upstream response emits
`end`, immediately after calling `clientResponse.end()`. That is the proxy-side
completion point and necessarily precedes the client observing a complete
response. This changed telemetry ordering only, not body forwarding.

## 2026-09-01 - Successful full run

The corrected default run produced:

| Direction | Body at 8 MiB input | RSS delta | Body at 32 MiB | RSS delta | Body at 96 MiB | RSS delta |
|---|---:|---:|---:|---:|---:|---:|
| Push | 8.00 MiB | 9.17 MiB | 32.01 MiB | 13.11 MiB | 96.03 MiB | 13.79 MiB |
| Clone | 8.01 MiB | 11.12 MiB | 32.03 MiB | 23.01 MiB | 96.08 MiB | 22.18 MiB |

Maximum queues were 128.0 KiB on an upstream request and 76.4 KiB on a client
response. Push policy retention was at most 65,202 bytes. The pack body grew 12x;
the 32-to-96 MiB RSS delta was flat in both directions. All cases stayed beneath
the predeclared 32 MiB budget without explicit GC.

There were 21 accepted upstream HTTP requests across discovery, negotiation, and
data transfer. Every audit record classified the replacement upstream credential,
and none saw the client credential. The missing-auth control failed locally.

The protected-ref push returned 403 after retaining 216 command bytes. No
upstream request was made for that push and the bare repo had no protected ref.

## 2026-09-01 - Interpretation

The experiment supports O(1)-in-body proxy memory, not literally constant RSS at
every small size. Node allocates network chunks and V8 collects unreachable
ArrayBuffers under pressure; RSS therefore rises to an allocator high-water mark.
The meaningful evidence is that the high-water mark and writable queues stop
growing while the body triples from 32 to 96 MiB, and that a 96 MiB body completes
under a 32 MiB delta ceiling.

The result does not establish deployed Worker memory behavior. Workerd stream
implementations, TLS records, edge request ceilings, Artifacts, slow peers, and
cancellation can all change the operational limit. Those belong in the Phase 0
deployed proxy and Phase 3 benchmark harness. This experiment removes the more
basic architectural uncertainty: neither direction intrinsically requires the
proxy to hold a Git pack.
