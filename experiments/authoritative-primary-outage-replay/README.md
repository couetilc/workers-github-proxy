# Experiment: authoritative primary outage replay

**Question.** Can an Artifacts-backed primary durably accept and serve Git
pushes while GitHub is unavailable, then replay the accepted state to GitHub
without a client retry?

**Hypothesis.** A client push can be acknowledged as soon as Cloudflare
Artifacts accepts it, independently of GitHub availability. A later sync can
coalesce repeated updates safely when GitHub still holds the recorded old OID,
while an unrelated GitHub OID must stop automatic replay as `needs_review`.

**Status.** In progress. The real-service first gate passed; outage/replay and
conflict cases are implemented but await a dedicated empty GitHub repository.

**Short answer so far.** Yes for the primary-acceptance gate. A repository
created through the remote Workers binding accepted a real Git push, served the
same commit to a fresh clone, and passed strict object verification. This does
not yet establish GitHub replay or conflict behavior.

## Experimental design

The experiment has two stages:

1. Run an experiment-scoped Worker locally through Wrangler with a remote
   Artifacts binding. Create a repository through `env.ARTIFACTS`, push an
   initial commit with Git smart HTTP, clone it, and compare the resulting OID
   and object integrity.
2. Treat that Artifacts repository as authoritative. Accept initial and
   incremental commits, an annotated tag, branch creation/deletion, and several
   updates to one ref while GitHub synchronization is deliberately unavailable.
   After restoring GitHub, replay the desired ref state, compare refs and
   reachable objects, then inject an unrelated GitHub OID and require
   `needs_review` without force-pushing it.

Repository tokens returned by Artifacts are ephemeral secrets. The harness
captures them only in a mode-`0700` temporary directory, supplies them to Git
through `http.extraHeader`, and never writes them to a remote URL or committed
result file.

## How to run

Requires `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, Node, npm, Wrangler,
Git, curl, and jq:

```bash
cd code
npm ci
./run-first-gate.sh

# Requires a new, empty, disposable private repository.
GITHUB_TEST_REPO=owner/repository KEEP=1 ./run-outage-replay.sh
```

The first-gate run creates a uniquely named repository in the
`workers-github-proxy-experiments` Artifacts namespace. It intentionally keeps
the repository after the run so its server-side state remains available for
inspection and the outage/replay stage.

## Files

```text
authoritative-primary-outage-replay/
|-- README.md                 design, results, and conclusions
|-- RESEARCH_LOG.md           chronological notebook
`-- code/
    |-- run-first-gate.sh     binding create plus smart-HTTP push/clone gate
    |-- run-outage-replay.sh  complete outage, recovery, and conflict workflow
    |-- origin-outage.cjs     deterministic GitHub-side HTTP 503 injector
    |-- replay-policy.js      OID-based replay classification
    |-- replay-policy.test.js classification unit tests
    |-- classify-replay.mjs   shell-facing policy command
    |-- process-tree-rss.cjs  local Wrangler/Worker process-tree sampler
    |-- package.json          pinned Wrangler dependency and commands
    |-- package-lock.json     exact npm dependency graph
    |-- wrangler.jsonc        experiment-specific remote Artifacts binding
    |-- worker-configuration.d.ts generated binding types checked for drift
    |-- src/index.js          management and streaming Git proxy Worker
    |-- src/index.test.js     proxy routing and host-validation tests
    `-- .gitignore            generated local Wrangler state
```

## Results

### Artifacts first gate

One run on 2026-09-01 created
`workers-github-proxy-experiments/outage-replay-gate-20260901` through the
remote Workers binding. A follow-up run minted a short-lived token for that
repository and completed the Git gate:

| Check | Result |
| --- | --- |
| Binding create | HTTP 201; repository ready with default branch `main` |
| Initial smart-HTTP push | Accepted; acknowledgement in 530 ms |
| Fresh smart-HTTP clone | Completed in 528 ms |
| Expected/clone OID | `e6c9a3881e361e201369319451d00c46c6bdfd8e` on both |
| Object integrity/content | `git fsck --strict` and file comparison passed |

The live binding returned an `art_v2_...` repository credential although the
current Git-protocol documentation describes `art_v1_<40 hex>`. The harness no
longer couples authentication to an exact beta token representation.

## Conclusions

The Artifacts beta/API access gate is cleared. The binding supplies a complete
Git smart-HTTP primary for the tested initial push and clone. The experiment's
main outage/recovery hypothesis remains open.

## Limits and follow-up work

- The first gate validates the Artifacts binding and Git protocol, not outage
  replay or deployed Worker limits.
- The complete run still needs a disposable GitHub upstream and a faultable
  synchronization path. The fault path is implemented, but the current
  fine-grained `GH_TOKEN` cannot create the required private repository.
- Local Wrangler execution does not establish deployed Worker memory or edge
  request-body limits; those must be measured in a deployed acceptance run.
