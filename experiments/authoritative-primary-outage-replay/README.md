# Experiment: authoritative primary outage replay

**Question.** Can an Artifacts-backed primary durably accept and serve Git
pushes while GitHub is unavailable, then replay the accepted state to GitHub
without a client retry?

**Hypothesis.** A client push can be acknowledged as soon as Cloudflare
Artifacts accepts it, independently of GitHub availability. A later sync can
coalesce repeated updates safely when GitHub still holds the recorded old OID,
while an unrelated GitHub OID must stop automatic replay as `needs_review`.

**Status.** In progress. The first gate is to create a real Artifacts repository
through the Workers binding and prove smart-HTTP push and clone.

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
    |-- package.json          pinned Wrangler dependency and commands
    |-- package-lock.json     exact npm dependency graph
    |-- wrangler.jsonc        experiment-specific remote Artifacts binding
    |-- worker-configuration.d.ts generated binding types checked for drift
    |-- src/index.js          narrow repository/token management Worker
    `-- .gitignore            generated local Wrangler state
```

## Results

Pending.

## Conclusions

Pending.

## Limits and follow-up work

- The first gate validates the Artifacts binding and Git protocol, not outage
  replay or deployed Worker limits.
- The complete run still needs a disposable GitHub upstream and a faultable
  synchronization path.
- Local Wrangler execution does not establish deployed Worker memory or edge
  request-body limits; those must be measured in a deployed acceptance run.
