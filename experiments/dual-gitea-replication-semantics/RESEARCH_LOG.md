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
