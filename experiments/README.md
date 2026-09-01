# Listen now.

It's time to wipe all the noise away. Concentrate on the scent of discovery,
as we follow the path of experiments. Our goal is understanding, then wisdom.

## Tools

- javascript, npm packages, I'm sure there's more tools you can use.

## We must establish

- what's next? what are the main features? We've established concurrency can be
handled efficiently and predictably.
  - ✅ local integration test with Gitea as a remote.
  - ✅ local integration tests proxying to Gitea.
  - ✅ local dual-Gitea replication, asymmetric-failure, and recovery tests.
  - **Next:** prove an Artifacts-backed authoritative primary can accept pushes
    during an origin outage and replay them later.
  - Then validate repo-scoped coordination, safe reconciliation policy, and
    crash-window observability before the deployed proof of concept.

- once we've establish that syncing mechanism somewhat works, we can start
thinking about auth. once auth is answered, we can do a v0 deploy and use it
actually. And then we start use observability to answer questions about the
sytem, and iterating on it in production and staging. Key thing here is
recognized unexpected responses and logging them for later analysis, as well as
run of the mill errors. Because we are a proxy, we may receive requests we
don't recognize, let's save them so the system can become self-improving.

## Workspace

Your laboratory is a directory under `./experiments/<experiment-name>/`. Use it
as a scratchpad. It must contain a README.md discussing the experimental design
and the conclusions. It must also contain a RESEARCH_LOG.md, a notebook keeping
track of ideas and attempts during the experiment(s). Any code you write for
the experiment can live in appropriately named sub-directories. Those
directories should be described in the README, along with the command to
reproduce the experiment and any suggestions for follow-up work.

## Experiments

Keep this index of experiments up to date.

| Experiment | Question | Status |
|---|---|---|
| [git-remote-domain-swap](./git-remote-domain-swap) | Can swapping a remote's domain let you receive and inspect git pushes/fetches? | ✅ Yes — depth depends on protocol compliance; **TLS/host-key identity is what protects a real push** |
| [tls-terminate-reencrypt](./tls-terminate-reencrypt) | Can a git remote proxy terminate the client's TLS, work on the plaintext, and re-encrypt to the upstream? | ✅ Yes — push/fetch complete; **plaintext custody comes from terminating, and both TLS legs verify independently** |
| [duplex-streaming-memory](./duplex-streaming-memory) | Can push requests and clone/fetch responses stream through a fixed, small proxy memory budget while auth and ref policy still hold? | ✅ Yes locally — 96 MiB real-Git bodies stayed under 24 MiB RSS delta; **both byte paths plateau with bounded queues** |
| [workerd-duplex-streaming](./workerd-duplex-streaming) | Does bounded duplex Git streaming survive inside workerd using Worker Fetch and Web Streams? | ✅ Yes with native pass-through — 96 MiB bodies added <1 MiB RSS; **reconstructing the request in JavaScript grows with the pack** |
| [workerd-concurrency-envelope](./workerd-concurrency-envelope) | How does one warmed workerd Worker behave under concurrent, slow, repeated, and canceled Git streams? | ✅ Bounded in this runtime — RSS tracks active streams, not pack size; **16-way and 20-wave runs showed no body-sized or monotonic per-wave retention** |
| [gitea-proxy-compatibility](./gitea-proxy-compatibility) | Is the proxy semantically transparent to Git with Gitea upstream while client and upstream credentials remain separated? | ✅ Yes locally — refs/objects and v0/v2 behavior matched; **Git-layer rejection, HTTP 401/404, auth replacement, and Basic challenge survived** |
| [dual-gitea-replication-semantics](./dual-gitea-replication-semantics) | Can one workerd proxy stream every push to two Giteas, round-robin reads, and report partial writes honestly? | ✅ Converges with verification/recovery, not atomically — **every asymmetric failure split refs; final-state checks, Git-visible failure, and durable reconciliation are mandatory** |
| `authoritative-primary-outage-replay` | Can an Artifacts-backed authoritative primary durably accept and serve Git pushes while the origin is unavailable, then replay them to convergence? | 🔜 Next — validate Artifacts access, primary-only acknowledgement, buffered ref updates, origin conflict detection, and recovery |
| `durable-object-repo-coordination` | Can one repo-scoped Durable Object serialize, coalesce, and recover background sync leases without carrying pack bodies or delaying primary acknowledgement? | 🔜 Planned — test same-repo ordering, cross-repo concurrency, duplicate events, lease expiry, and idempotent retry |
| `reconciliation-policy-and-protection` | Which observed ref mismatches are safe to repair automatically, and how do protected branches, immutable tags, and expected-old-OID checks constrain recovery? | 🔜 Planned — automate only unambiguous catch-up; classify unrelated history and unsafe rewrites for human review |
| `crash-window-observability` | Do worker crashes, ambiguous upstream outcomes, lost events, failed verification, and incident-recording failure become safe retries or actionable states? | 🔜 Planned — validate backstop scrubs, critical alerts, and `synced` / `pending_sync` / `needs_review` / `verification_required` outcomes |
| `gitea-user-attribution` | If clients map to a shared upstream service account, how can original user identity remain trustworthy in proxy audit and repository attribution? | 🔜 Planned — compare per-user credentials, trusted identity propagation, and proxy-owned audit before authentication design is fixed |
