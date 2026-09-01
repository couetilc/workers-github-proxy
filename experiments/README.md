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

## Planned POC staging sequence

The next four experiments prepare an outage-buffering proof of concept. They
must use the following contract consistently:

- The authoritative primary is a complete Git repository in Cloudflare
  Artifacts. Gitea may stand in while developing a harness, but cannot establish
  the Artifacts conclusion.
- A client push succeeds when the authoritative primary accepts it. GitHub
  synchronization is asynchronous and may remain pending during an outage.
- Client pack bodies stream directly to the primary. Later primary-to-GitHub
  fetch/push traffic also stays outside Durable Object storage.
- One Durable Object per canonical repository coordinates background sync
  metadata and leases. For the single-tenant POC, the repository identity is a
  sufficient shard key; a future multi-tenant deployment must include its
  deployment/customer boundary.
- Reads come from the primary. Round-robin reads are not a POC requirement.
- Repositories are proxy-exclusive during the POC: direct GitHub pushes, PR
  merges, bots, and administrative ref changes are unsupported except when a
  test deliberately injects one as a conflict.
- A temporary ref mismatch is normal while synchronization is pending. Use
  `synced`, `pending_sync`, `needs_review`, and `verification_required` rather
  than treating every mismatch as an incident. `sync_paused` is an action flag,
  not an observed repository state.
- **Sync** is expected primary-to-GitHub propagation; **retry** repeats a known
  operation; **reconciliation** inspects real refs after processing becomes
  ambiguous, is missed, or encounters an unexpected OID.

### 1. `authoritative-primary-outage-replay`

**Question.** Can an Artifacts-backed primary durably accept and serve Git
pushes while GitHub is unavailable, then replay the buffered state to GitHub
without client retry?

**First gate.** Confirm Artifacts beta/API access with an authenticated
Cloudflare account, create a repository through the binding/API, and prove
smart-HTTP push and clone. The 2026-09-01 agent container had no Cloudflare
token, account ID, Wrangler installation, or Wrangler login, so access was not
confirmed in that session.

Exercise initial and incremental commits, annotated tags, branch creation and
deletion, and multiple same-ref updates while GitHub is unavailable. Every
primary-accepted push must succeed for the client and be cloneable from the
primary. On recovery, coalesce where safe, synchronize GitHub, and compare refs
and reachable objects. Inject an unrelated GitHub OID and require
`needs_review`; never force it automatically.

Record client acknowledgement latency, buffered ref count, convergence delay,
primary/GitHub outcomes, refs and object graphs, and Worker memory.

**Exit criteria.** Primary acceptance survives origin outage; no accepted Git
state is lost; recovery reaches equivalent refs/objects; an unexpected origin
OID is detected without overwrite; status distinguishes `pending_sync`,
`synced`, and `needs_review`.

### 2. `durable-object-repo-coordination`

**Question.** Can one repository-scoped Durable Object serialize, coalesce, and
recover background sync work without carrying pack bodies or delaying primary
acknowledgement?

The DO grants one TTL-bounded sync lease per canonical repository and stores
only cursors, desired ref state, lease/operation IDs, and incident pointers.
The primary Git server's old-OID compare-and-swap continues to resolve inbound
push races; the DO is not on the inbound data path.

Exercise rapid same-ref updates, multiple refs, concurrent repositories,
duplicate and out-of-order events, a killed lease holder, lease expiry, and a
crash after GitHub commits but before the cursor advances. A retried job must
classify GitHub already at the desired OID as success. Measure primary
acknowledgement latency separately from synchronization latency and prove that
no request body enters DO storage.

**Exit criteria.** At most one active sync lease exists per repository;
different repositories remain concurrent; bursts safely coalesce to the latest
desired state; expired work resumes; duplicate execution is idempotent; primary
push availability and streaming are independent of the DO and GitHub.

### 3. `reconciliation-policy-and-protection`

**Question.** Which observed ref mismatches can be repaired automatically, and
how do protected branches, immutable tags, deletion rules, and expected-old-OID
checks constrain recovery?

Evaluate this minimum matrix for branch creation, update, and deletion plus
annotated/lightweight tags:

| Primary | GitHub | Classification/action |
| --- | --- | --- |
| desired | desired | Already `synced` |
| desired | recorded before | Safe expected-old-to-desired catch-up |
| recorded before | recorded before | Update landed nowhere; no repair |
| desired | unrelated OID | `needs_review`; do not overwrite |
| unavailable | anything | `verification_required`; observe later |

Test fast-forward-only protected `main`, forbidden deletion, immutable tags,
rewritable feature branches, mismatched protection rules, and credentials with
different bypass privileges. Protection reduces unsafe cases but does not
replace repo-scoped serialization: two updates can both be fast-forwards from
the same old OID and still produce sibling tips if allowed to cross replicas.

Automatic recovery is limited to the exact recorded-before/desired pattern,
guarded by the currently observed old OID. Never automatically merge unrelated
history or force a protected ref. Define a minimal operator interface for
status, safe retry, explicitly adopting one side, verification, and state
clearing; clearing without successful verification is forbidden.

**Exit criteria.** Every matrix case has a deterministic classification; safe
catch-up converges refs/objects; no unexpected OID is overwritten; protection
and credential asymmetry are visible; all unsafe cases produce enough
information for documented human reconciliation.

### 4. `crash-window-observability`

**Question.** Do crashes, ambiguous upstream outcomes, lost events, failed
verification, and incident-recording failure become idempotent retries or
actionable repository states without requiring exactly-once transactions?

Inject failure before primary commit, after primary commit but before client
response, after client response but before event processing, during GitHub pack
transfer, after GitHub commit but before cursor update, during final
verification, and during incident persistence. Drop an event completely and
expire a lease. A low-frequency primary-ref-versus-cursor scrub and next-request
check are the backstops.

Use stable operation/incident IDs and expected-old/desired ref comparison:
GitHub at desired is a no-op success, at recorded before is retryable, at an
unrelated OID needs review, and unavailable requires later verification.
Incident persistence failure must emit a critical structured event that does
not contain credentials, pack data, or repository contents.

Keep current coordination state in the repo DO. Store append-oriented operation
and incident history in a small SQL database (SQLite locally): operation ID,
repository/ref, before/desired OIDs, authenticated proxy principal, timestamps,
safe upstream HTTP/Git outcomes, observed refs, retry count, classification,
and human resolution. Full event-sourced state reconstruction is not required.

**Exit criteria.** Missing events are rediscovered; ambiguous commits resolve by
observing refs; duplicates are harmless; recorder failure raises a critical
operation ID; no case disappears silently; every injected failure ends as
`synced`, `pending_sync`, `needs_review`, or `verification_required`.

### POC boundary after these experiments

The deployed acceptance run is Worker → Artifacts primary → event/queue →
repo DO lease → GitHub test repository. It repeats outage/recovery with a real
Git client and measures acknowledgement latency, convergence latency, deployed
limits, and status/incident visibility.

Defer atomic dual writes, automatic merge or arbitrary force reconciliation,
exactly-once incident delivery, full journal replay, out-of-band multi-writer or
bidirectional synchronization, clone-level round-robin/cache design, continuous
reconciliation beyond next-request checks and a scheduled scrub, polished
reconciliation UI, and multi-tenant attribution. `gitea-user-attribution`
remains a separate prerequisite if the POC expands beyond one trusted tenant.

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
| [authoritative-primary-outage-replay](./authoritative-primary-outage-replay) | Can an Artifacts-backed authoritative primary durably accept and serve Git pushes while the origin is unavailable, then replay them to convergence? | 🧪 In progress — Artifacts gate passed and replay harness is ready; live run awaits an empty GitHub test repo because the current token cannot create one |
| `durable-object-repo-coordination` | Can one repo-scoped Durable Object serialize, coalesce, and recover background sync leases without carrying pack bodies or delaying primary acknowledgement? | 🔜 Planned — test same-repo ordering, cross-repo concurrency, duplicate events, lease expiry, and idempotent retry |
| `reconciliation-policy-and-protection` | Which observed ref mismatches are safe to repair automatically, and how do protected branches, immutable tags, and expected-old-OID checks constrain recovery? | 🔜 Planned — automate only unambiguous catch-up; classify unrelated history and unsafe rewrites for human review |
| `crash-window-observability` | Do worker crashes, ambiguous upstream outcomes, lost events, failed verification, and incident-recording failure become safe retries or actionable states? | 🔜 Planned — validate backstop scrubs, critical alerts, and `synced` / `pending_sync` / `needs_review` / `verification_required` outcomes |
| `gitea-user-attribution` | If clients map to a shared upstream service account, how can original user identity remain trustworthy in proxy audit and repository attribution? | 🔜 Planned — compare per-user credentials, trusted identity propagation, and proxy-owned audit before authentication design is fixed |
