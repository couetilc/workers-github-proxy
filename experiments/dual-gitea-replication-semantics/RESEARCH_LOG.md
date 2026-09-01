# Research log: dual-Gitea replication semantics

## 2026-09-01 — Question and design

The preceding experiment established transparent smart-HTTP behavior against a
single real Gitea. This experiment moves the uncertainty to replication: a push
request has one client body and two independently transactional receive-pack
destinations.

The design deliberately separates four facts that a naive proxy could conflate:

- transport completion and HTTP status;
- receive-pack success or rejection inside an HTTP 200 result;
- whether a replica accepted this particular old-OID/new-OID command; and
- whether the replica's final ref already equals the requested new OID.

Final state is the success authority. This permits an important recovery case:
after A commits and B fails, a retry advertised from B can make B commit while A
rejects the stale old OID. The operation is nevertheless converged if direct
post-write verification finds the requested OID at both replicas.

The request distributor will not use `ReadableStream.tee()` for the two
upstream writes. Standard tee semantics allow the faster consumer to pull ahead
while buffering for the slower branch. Instead, a custom distributor reads one
source chunk only when both active consumers have pulled, keeping at most one
shared chunk in the Worker and allowing a canceled branch to detach without
canceling the survivor.

Faults are injected between workerd and replica B. Verification bypasses those
gateways so that a failed write transport cannot hide the actual final state.
The reconciliation sink is a separate local service that appends and fsyncs one
JSON record at a time; workerd itself has no filesystem durability contract.

## 2026-09-01 — First integration run: large-push probe deadlock

The happy path and the HTTP 401, HTTP 404, Git-layer rejection, and their
recovery pushes completed. The first pack-sized disconnect case stalled before
either replica received the pack. Its only upstream audit was a four-byte
`0000` receive-pack POST to A.

Git emits this empty receive-pack probe before a large chunked request so it can
surface HTTP/auth errors before spending the work to stream the pack. The
Worker had treated the command-free probe as a two-replica transaction, but
there is no requested final state to verify and the coupled distributor waited
for an unnecessary second consumer. The fix routes command-free probes through
A only and reserves dual-write aggregation for the following command-bearing
RPC. A probe cannot mutate refs, so this does not weaken the replication claim.

The next run completed all repository operations and stopped in the result
assertions because the fault gateway did not finalize audit rows for its early
401/404 responses. The Worker and both repository states were correct; this was
an observer lifecycle bug. For deterministic auditing, those synthetic status
responses now drain the small experimental request before replying.

The 8 MiB slow-consumer measurement also showed that backpressure is not
lockstep at the two gateway sockets. A received its body in about 5.5 seconds
while delayed B took about 15.5 seconds, and the client completed only after B.
The coupled JavaScript distributor retained a maximum 4 KiB source chunk, but
workerd's HTTP client and the kernel can absorb a bounded amount per outbound
connection. Assertions therefore require bounded Worker RSS and client latency
coupled to B, not equal A/B completion times.

A reduced-size diagnostic run then exposed a second fault-injector bug: after
the disconnect row finalized its SHA-256 digest, an already-buffered request
chunk could still fire and try to update that digest, crashing gateway B before
the recovery advertisement. Post-finalization data is now ignored. This does
not change the injected disconnect; it keeps the observation process alive for
the subsequent recovery.

The first default-size assertion pass reached the end with correct repositories
but rejected the 32 MiB timing because B was less than 1.5 times slower than A.
That ratio is the wrong invariant: at the larger size, coupled backpressure also
slows A, so replica completion times approach one another. The gate now checks
that B's injected delay is substantial, that complete request bytes and hashes
match, that the client waits for B, and that memory remains bounded.

Inspection of the retained failure logs found a correctness issue in the
client-facing aggregate response. The proxy returned pkt-line `unpack`/`ng`
records directly, but Gitea's advertised `side-band-64k` capability requires
the report to be wrapped in sideband channel 1. Git failed the push but printed
`bad band #117` (ASCII `u`) rather than the reconciliation reason. Synthesized
success and failure reports now use the same outer channel-1 packet and flush as
Gitea. The harness additionally requires every intended partial-write failure
to display `replication incomplete; reconciliation <id>` in Git's stderr.
