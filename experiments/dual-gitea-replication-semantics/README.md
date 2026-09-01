# Experiment: dual-Gitea replication semantics

**Question.** Can one workerd proxy keep two independent Gitea repositories
converged by streaming every push to both while round-robin serving clones—and
what happens when only one push succeeds?

**Hypothesis.** Happy-path pushes can stream to both Gitea instances with
bounded memory, producing identical refs and objects, and either instance can
serve equivalent clones. Simple stream duplication cannot make two
receive-pack transactions atomic: rejection, disconnection, or timeout at one
upstream can leave a partial write that must be reported and reconciled.

**Status.** In progress. The harness and conclusions will be recorded here as
the experiment runs.

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

## Results and conclusions

Pending the first complete run.
