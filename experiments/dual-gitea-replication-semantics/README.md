# Experiment: dual-Gitea replication semantics

**Question.** Can one workerd proxy keep two independent Gitea repositories
converged by streaming every push to both while round-robin serving clones—and
what happens when only one push succeeds?

**Hypothesis.** Happy-path pushes can stream to both Gitea instances with
bounded memory, producing identical refs and objects, and either instance can
serve equivalent clones. Simple stream duplication cannot make two
receive-pack transactions atomic: rejection, disconnection, or timeout at one
upstream can leave a partial write that must be reported and reconciled.

**Short answer.** Yes on the happy path, and emphatically not atomically. Git
2.39.5 through workerd 2026-08-31 streamed the same pushes to two independent
Gitea 1.27.3 instances, kept reachable refs/objects identical, and alternated
equivalent clone/fetch sessions. A delayed 32 MiB push added 2.14 MiB peak RSS
over its sampled baseline. Every one-sided 401, 404, Git-layer rejection,
mid-pack disconnect, and stale advertised-ref rejection left A and B different.
The Worker reported those pushes as rejected with a reconciliation ID, durably
journaled the partial state, and accepted a retry only after direct final-state
verification proved both replicas held the requested OID.

## Experimental design

The harness starts two independent Gitea processes, one fault-injection gateway
per process, a workerd Worker, and an append-and-fsync reconciliation recorder.
Real Git clients use one proxy URL. Receive-pack discovery compares both
advertisements and selects a controlled write advertisement; receive-pack POSTs
use a backpressure-coupled fan-out to both gateways. Upload-pack sessions are
assigned alternately to replica A and B.

The Worker does not equate HTTP 200 with success. It extracts the requested ref
updates from the bounded receive-pack prelude, waits for both upstream results,
and queries both Giteas directly for final ref state. It reports success only
when both repositories contain every requested new OID (or both omit a deleted
ref). Any mismatch produces a Git-visible failure and a durable reconciliation
record containing the requested update, upstream outcomes, and observed refs.

The three phases cover:

1. initial, incremental, tag, branch, and deletion pushes; exact ref/object
   comparisons; and alternating clone/fetch sessions;
2. one-sided HTTP 401 and 404, receive-pack rejection inside HTTP 200,
   mid-pack disconnect, a slow consumer, and pre-existing divergent refs; and
3. retries from the lagging advertisement, including the case where the
   already-updated replica rejects the old OID while final verification proves
   that both replicas converged.

Memory sampling surrounds two progressively larger slow-consumer pushes.
Gateway audits measure bytes, hashes, timing, and whether the surviving request
completed after its peer failed.

## How to run

Requires Linux, Node, npm, Git, curl, `dd`, and `sha256sum`:

```bash
./code/run.sh
KEEP=1 ./code/run.sh
```

The script installs the pinned workerd dependency and downloads the official
Gitea binary when absent. Generated repositories, logs, JSONL audits,
measurements, and reconciliation records are retained only with `KEEP=1`.

## Files

```text
dual-gitea-replication-semantics/
|-- README.md                         design, results, and conclusions
|-- RESEARCH_LOG.md                   chronological notebook
`-- code/
    |-- run.sh                        complete three-phase workflow
    |-- replication-worker.js         dual-write and round-robin read Worker
    |-- replication-core.js           pkt-line, fan-out, and verification logic
    |-- replication-core.test.js      Worker-compatible unit tests
    |-- fault-gateway.cjs              streaming audit and injected failures
    |-- reconciliation-recorder.cjs   append-and-fsync divergence journal
    |-- assert-results.cjs             semantic and measurement regression gates
    |-- rss-sampler.js                 workerd RSS sampler
    |-- gitea.app.ini.template         isolated Gitea configuration
    |-- workerd.capnp.template         bindings for both replicas and recorder
    |-- package.json                   pinned workerd dependency
    |-- package-lock.json              exact npm dependency graph
    `-- .gitignore                     generated runtime files and binary cache
```

## Results

One complete run on 2026-09-01 audited 85 gateway requests. The final
repositories had identical `main` and annotated `v1` refs, the same 31
reachable objects, and passed `git fsck --strict`.

| Case | Replica A | Replica B | Client/result |
| --- | --- | --- | --- |
| Initial, incremental, tag, branch, deletion | accepted | accepted | success; exact refs and reachable graph |
| Alternating clones/fetches | A sessions | B sessions | same remote OIDs and contents |
| B HTTP 401 | committed | unchanged, HTTP 401 | rejected with reconciliation ID |
| B HTTP 404 | committed | unchanged, HTTP 404 | rejected with reconciliation ID |
| B Git rejection | committed | `ng` inside HTTP 200 | rejected with reconciliation ID |
| B disconnect near 1 MiB | consumed 8,391,645 bytes and committed | disconnected after 1,049,415 bytes | rejected; A was not canceled |
| Slow B, 8 MiB | 8,391,670 bytes in 8.14 s | same hash/bytes in 17.03 s | success after 17.26 s |
| Slow B, 32 MiB | 33,565,125 bytes in 54.51 s | same hash/bytes in 64.12 s | success after 64.85 s |
| Pre-existing divergent `main` | accepted desired update | rejected stale old OID | rejected; advertisement and final mismatch journaled |

### Memory and backpressure

The delayed-body measurements grew the wire body 4x without body-sized Worker
growth:

| Input | Wire bytes to each Gitea | Baseline RSS | Peak RSS | RSS delta | Max distributor chunk |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 8 MiB | 8,391,670 | 88.61 MiB | 93.53 MiB | 4.92 MiB | 4 KiB |
| 32 MiB | 33,565,125 | 89.78 MiB | 91.92 MiB | 2.14 MiB | 4 KiB |

Backpressure was visible but not lockstep at the gateway sockets. For 8 MiB,
workerd's outbound HTTP transport let A finish about nine seconds before B. At
32 MiB, A was itself slowed to within ten seconds of B. The custom distributor
held one source chunk, while the HTTP client and kernel retained bounded
per-connection buffering. Most importantly, the proxy did not answer the
client until slow B completed. When B disconnected, its branch cancellation
detached from the distributor and A continued through the complete body.

Git sends a command-free four-byte `0000` probe before large chunked
receive-pack RPCs. The Worker routes that non-mutating probe through A only;
the subsequent command-bearing request is what streams to both replicas.

### Failure reporting and recovery

HTTP status alone was insufficient. The Git-rejection fixture returned HTTP
200 with `unpack ok` and `ng refs/heads/main`, while the opposite recovery
result had A reject and B accept. The Worker therefore used the requested
new-OID state, not the pair of immediate receive-pack results, as its success
authority.

Each partial write returned a valid sidebanded receive-pack report such as:

```text
! [remote rejected] main -> main (replication incomplete; reconciliation <id>)
```

The matching append-and-fsync record contains both upstream outcomes, the
requested old/new OIDs, directly observed replica refs, and
`reconciliation: "required"`. The run created five final-mismatch records and
six advertisement-divergence records.

All five compensating retries selected B's lagging advertisement. B accepted
the old-B/new-desired command; A rejected its old OID because A already held
the desired ref. Direct verification then found the desired OID at both
replicas, so the proxy correctly returned B's successful Git result. This is
the precise case where “one rejected” means convergence rather than failure.

## Conclusions

1. **One Worker can replicate happy-path Git pushes with bounded memory.** The
   tested initial/incremental ref changes, tag, branch, deletion, and 32 MiB
   slow write produced identical reachable repositories.
2. **Two receive-pack calls are not a transaction.** Every asymmetric failure
   can commit one repository and leave the other unchanged. Stream fan-out
   supplies bytes, not atomicity or rollback.
3. **Final requested ref state is the only useful aggregate success test.** It
   catches HTTP-success/Git-failure splits and recognizes recovery when the
   already-correct replica rejects a stale old OID.
4. **Cancellation must be branch-local.** B's mid-pack disconnect detached one
   fan-out consumer; canceling the source or A would have turned a partial
   write into an ambiguous double failure without undoing any commit.
5. **Partial writes need a durable product state.** A standard Git rejection
   with a record ID makes the client outcome honest; the journal makes the
   split actionable after the request ends.
6. **Replication should precede user attribution.** The service first needs a
   durable reconciliation owner and policy. Only then is it useful to decide
   how the initiating user's identity crosses both upstream boundaries.

## Limits and follow-up work

- This is a local single-process workerd experiment with two local Giteas. The
  fault gateways synthesize HTTP/Git failures and the network disconnect; no
  deployed Cloudflare, GitHub, or Artifacts behavior is claimed.
- Verification is an immediate smart-HTTP ref read. A concurrent third-party
  writer can race the verification response; production needs per-repository
  serialization/CAS and a durable reconciliation state machine.
- The local recorder fsyncs every row, but recorder outage, crash recovery,
  duplicate delivery, and journal replay were not faulted. Production must not
  allow a journal failure to turn a partial write into an untracked state.
- Recovery deliberately selects the lagging advertisement and uses a forced
  update for truly divergent history. A production policy must never guess
  which side wins or force without an explicit configured reconciliation rule.
- Reachable object graphs were compared. Failed receive-pack attempts may leave
  unreachable quarantine or loose objects; those are not semantic convergence
  and were not required to match.
- Round-robin session stickiness uses an experiment-case header. A real proxy
  needs a stable routing key or must prove every request within an upload-pack
  exchange can safely land on different converged replicas.
- The largest body was 32 MiB. Concurrent dual writes, timeouts, recorder
  failure, process crashes between commit and verification, multi-ref partial
  acceptance, LFS, atomic push, and push options remain follow-ups.
