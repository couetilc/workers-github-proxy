# workers-github-proxy — Product Roadmap

**One-liner:** This software makes your agents keep pushing even when GitHub is down.

**Why it matters:** GitHub recently had ~4 days of downtime across a 90-day period. Agents can't hold local git state the way humans do — when GitHub is down, agent work stops or is lost. This proxy accepts pushes at GitHub-shaped URLs, durably stores them in Cloudflare Artifacts, and syncs upstream when GitHub recovers.

**North-star UX — enabling the proxy is exactly one command:**

```bash
git remote set-url origin "$(git remote get-url origin | sed 's/github\.com/git.cloud/')"
```

Every design decision (GitHub-convention URL paths, auth that fits git basic auth, auto-creating Artifacts repos on first push) exists to keep this true. If a feature would require a second setup step, it needs a very good reason.

**Primary audience:** AI agents and automation that can't hold local git state. Secondary: human developers who want a resilient push path.

---

## Architecture snapshot (decisions locked in)

| Concern | Decision |
|---|---|
| Sync engine | Phase 0 bake-off: real `git` in a pooled Sandbox container (multi-GB memory, thin packs, delta compression) vs. isomorphic-git over in-memory FS in the Worker (the Artifacts-documented pattern). Container pool is the leading candidate — it removes the 128MB heap and non-delta-pack ceilings. |
| Inbound push endpoint | Thin streaming proxy for smart-HTTP (`info/refs` + `git-receive-pack`) → Artifacts. No packfile parsing on the hot path. Containers are never on this path — durability = client → Worker stream → Artifacts, with no scheduling dependency in front of the ack. |
| Sync trigger | Native Artifacts event subscription: `cf.artifacts.repo.pushed` carries `ref`/`before`/`after` into a Queue — the proxy never parses push results. Repo-level subscription created at repo auto-create. Backstopped by DO alarm reconciliation (correctness never depends on event delivery). |
| Initial mirror | Native Artifacts `import()` for public GitHub repos (branch + depth options; Artifacts does the heavy fetch, not our compute). Private repos go through the sync engine unless authenticated import proves out (Phase 0 experiment). |
| URL scheme | GitHub path conventions: `https://<your-domain>/<owner>/<repo>.git` — a pure host substitution from an existing GitHub remote |
| Durable buffer | Artifacts itself (queue messages carry pointers, never pack data) |
| Sync orchestration | Cloudflare Queues (native `pushed`-event delivery + retry/DLQ) and/or Workflows (durable multi-step sync) |
| Artifacts platform limits (documented) | 10 GB/repo, 1 TB/account (raisable on request), 2,000 git requests per 10s per repo; ops $0.15/1k + storage $0.50/GB-mo past included amounts |
| Concurrency | One Durable Object per repo as control plane: linearizes sync state + admission via leases; data-plane writes to Artifacts/GitHub run concurrently under git's CAS ref semantics |
| Sync state modeling | XState state machines for the sync lifecycle |
| Read-path freshness | Background poll (default on, per-repo interval) reconciles out-of-band GitHub pushes into Artifacts; optional GitHub webhook supplements/replaces polling for lower latency; opt-in "proxy-exclusive mode" skips reconciliation entirely for repos that guarantee the proxy is the sole write path |
| Test target | 100% coverage on core sync logic, enforced in CI, backed by mutation testing so the number is meaningful |

### Core syncing logic — Durable Object per repo

**Principle:** DOs linearize per-repo sync *state and admission*; all actual writes to Artifacts and GitHub happen concurrently in the data plane, protected by git's own compare-and-swap ref semantics.

**Control plane (one DO per `owner/repo`):**
- Owns the sync cursor (last GitHub-confirmed SHA per ref) and divergence state (paused/needs-attention — a conflicted repo stops syncing loudly instead of thrashing)
- Grants at most one **sync lease** per repo (TTL-bounded); receives ref-update notifications and sync outcomes; advances the cursor on success
- **Coalescing for free:** ref updates arriving mid-sync don't queue as separate jobs — when the current lease resolves, the next lease targets the newest SHA. Ten rapid agent pushes become one GitHub round-trip; a long outage buffer drains in one sync per ref, not one per commit.
- Uses **DO alarms** for parked-retry scheduling in outage mode — a repo with buffered commits wakes itself on the slow cadence, no external ticks

**Data plane (outside the DO):**
- Inbound pushes stream client → Worker → Artifacts fully concurrently; the DO is *not* in the hot path. Races on the same ref are resolved by Artifacts' own receive-pack CAS (`old-sha new-sha`) — the losing client gets a standard non-fast-forward, exactly what git clients expect. Push is acked the moment Artifacts confirms; the DO notification is async. **Durability point = Artifacts, never sync progress.**
- The queue consumer holding the lease dispatches the heavy fetch/push to the sync engine. Keeping the memory load out of the DO means an OOM on a big sync can never take down the state holder.
- Consumer crash mid-push is safe: lease expires → next job runs → idempotency check (compare GitHub's current ref first) finds the push either landed (no-op) or redoes it

### Sync execution — pooled Sandbox containers (leading candidate)

The Worker never does the memory-heavy git work itself; the queue consumer dispatches to a small pool of Sandbox containers running real `git`. Division of labor: **Queues deliver the work (retry/DLQ), the per-repo DO admits it (one lease), containers execute it.**

- **Pool, not per-repo:** a fixed set of container (sandbox) IDs shared across all repos. The repo DO's lease already serializes per-repo sync, so the pool holds no per-repo state — it is pure execution capacity.
- **Repo→container affinity:** consistent-hash `owner/repo` onto the pool so a repo's syncs land on the same warm container, which keeps the repo cloned on disk — repeat syncs become incremental `git fetch`/`git push`, not full re-clones.
- **Containers hold no authoritative state:** a killed container loses only a disk cache; the DO cursor and Artifacts remain the truth.
- **Real git wins:** thin packs, delta compression, no 128MB JS heap — and it's the same engine the Artifacts CI guide (`@cloudflare/ci` + Sandbox SDK) already documents against Artifacts repos.
- **Costs to measure in Phase 0:** cold start (seconds) when the pool scales from zero, per-second runtime billing, idle-timeout tuning. During a GitHub outage nothing syncs — jobs park in the DO and the pool sleeps, so outage buffering costs ~nothing in compute.

Fallback/alternative: isomorphic-git in the Worker stays viable for small incremental syncs if the bake-off shows container latency or cost is prohibitive at low volume.

**Granularity:** per-repo lanes, not per-ref, for v1 — pack fetches overlap heavily across refs and per-ref cursors complicate the model for marginal gain on agent-sized repos. Cross-repo needs no coordination; repos are independent, matching both DO sharding and Artifacts' repo-per-agent model.

### Auth & transport notes

- **HTTPS-only.** The proxy terminates TLS at the edge and works on the plaintext smart-HTTP exchange — the only architecture that supports buffering and replay. SSH remotes cannot be proxied (end-to-end encrypted; Workers can't terminate inbound SSH). Docs must state that the one-command swap requires an HTTPS remote.
- **Agents: smooth.** Agents overwhelmingly authenticate with HTTPS tokens already; a proxy-minted token in the credential helper (or embedded in the swapped URL) fits their existing flow.
- **Artifacts side is documented, not experimental:** git Basic auth as `x:<token-secret>`; tokens are `art_v1_<40 hex>?expires=<unix>` (strip the `?expires=` suffix for the password), per-repo with `read`/`write` scopes, TTL 1 minute–1 year (default 24h). The proxy's server-side mapping mints short-lived scoped tokens rather than holding long-lived ones.
- **Humans: known friction point.** SSH-remote users need a remote migration, and everyone needs a token issued and installed — which strains the one-command north star. **Open research item (pre-Phase 5):** investigate UX improvements, e.g. a tiny setup CLI — strawman: `npx git-cloud setup`, which authenticates, mints the token, and rewrites the remote in one step (preserving the one-command story for humans, just a different command than the raw sed swap agents use) — git credential-helper integration, OAuth device flow for token issuance, or GitHub App–based identity so users authorize once in a browser. Goal: human onboarding no worse than `gh auth login`.
- **Trust posture:** proxy sees plaintext contents and credentials by necessity → self-host deployment ("your Worker, your account, your secrets") is the primary trust answer; client tokens verified per-request and never persisted; Cloudflare at-rest encryption covers Artifacts/R2. Client-side encryption (`git-remote-gcrypt`-style) passes through unmodified for users who want the proxy blind to contents.

---

## Phase 0 — Spike & validation (~1 week)

Goal: kill the unknowns before building anything permanent.

- [ ] Confirm Artifacts beta access; create/fork repos via the Workers binding (gating item — request first, it has lead time we don't control)
- [ ] Prove the pass-through proxy: real `git push` from CLI → Worker → Artifacts, verified with `git clone` from Artifacts. Probe the inbound request-body ceiling with progressively larger packs — Cloudflare edge body limits, not workerd memory, likely bind first.
- [ ] **Sync-engine bake-off** — fetch from Artifacts, push to GitHub (fast-forward case), both engines:
  - (a) real `git` in a Sandbox container: cold start, warm-affinity incremental sync time, cost per sync, practical repo-size ceiling per instance type
  - (b) isomorphic-git in the Worker: memory + CPU ceiling (measured deployed, not just `wrangler dev` — local dev doesn't enforce the 128MB limit), and non-thin/non-delta pack acceptance by GitHub receive-pack
- [ ] **`pushed` event subscription:** create the repo-level subscription at repo creation; measure delivery latency and behavior under bursts; confirm account-level events cover auto-created repos' lifecycle
- [ ] **Native import:** initial mirror of a public GitHub repo via `import()`; test whether a credential-embedded HTTPS URL imports a private repo (undocumented — if it works, initial mirror is native for private repos too)

**Exit criteria:** end-to-end demo (push → Artifacts → GitHub) on a toy repo; a recorded sync-engine decision backed by bake-off numbers; a written list of anything that didn't work as expected.

## Phase 1 — MVP (~2–3 weeks)

Goal: a usable single-tenant proxy for agent-sized repos.

- [ ] **Routing:** GitHub-convention URL parsing (`/:owner/:repo.git/info/refs`, `/:owner/:repo.git/git-receive-pack`, and the read paths `git-upload-pack` so clones/fetches through the proxy also work)
- [ ] **Repo mapping:** `owner/repo` → Artifacts repo (auto-create/fork on first push, creating the repo-level `pushed` event subscription in the same step) + GitHub upstream config
- [ ] **Auth:** proxy-minted tokens presented as git basic auth; server-side mapping to Artifacts tokens + GitHub PAT/App installation token. Secrets in Worker secrets/bindings.
- [ ] **Sync pipeline v1:** native `pushed` event (`ref`, `before`, `after`) → Queue → consumer acquires the repo DO's lease → sync engine (per the Phase 0 decision) runs fetch/push. Backstop: DO alarm periodically compares Artifacts ref state against the cursor, so a lost event can delay a sync but never strand one.
- [ ] **Idempotent replay:** consumer compares GitHub's current ref before pushing; no-op if already synced
- [ ] **Status endpoint:** per-repo JSON — buffered refs, last sync time, divergence flag
- [ ] Deploy under a real domain; write the "change one string in your remote URL" quickstart

**Exit criteria:** an agent workflow (e.g., Claude Code or a scripted agent) uses the proxy as its only remote for a full session, with GitHub reflecting every push.

## Phase 1.5 — Edge-accelerated reads (~1–2 weeks)

Goal: serve `git clone`/`git fetch` from Artifacts at the edge (latency win, and a read path that keeps working during a GitHub outage) without ever silently serving a stale repo.

Resolves Open Question #1 below.

- [ ] **Read-path proxy:** `git-upload-pack` (`info/refs?service=git-upload-pack` + the fetch negotiation) served from Artifacts, completing the read side of the URL swap alongside the existing write path
- [ ] **Background poll (default on):** per-repo DO polls GitHub's ref state on an interval, independent of push-triggered sync, to catch commits that landed on GitHub *outside* the proxy (direct push, merged PR, another tool) and pull them into Artifacts
- [ ] **Optional GitHub webhook:** push-event webhook as a lower-latency alternative/supplement to polling — configured per repo (webhook URL + secret at setup time); falls back to the poll cadence if not configured or if delivery fails, so correctness never depends on webhook delivery succeeding
- [ ] **Per-repo freshness toggle:** default = poll (+ webhook if configured); opt-in "proxy-exclusive mode" for repos that guarantee the proxy is the sole write path, skipping reconciliation entirely for the fastest possible reads
- [ ] **Visible staleness, never silent staleness:** reads carry the reconciliation cursor's age; status endpoint (Phase 1) exposes reconciliation lag per repo
- [ ] **Correctness test:** push directly to GitHub (bypassing the proxy), confirm the next clone through the proxy reflects it within the configured poll/webhook window — and never before

**Exit criteria:** clone-through-proxy is measurably faster than clone-from-GitHub in edge-favorable geographies, and no clone/fetch ever omits a commit that landed on GitHub more than one reconciliation interval ago.

## Phase 2 — GitHub interaction mapping & failure semantics (~2 weeks)

Goal: enumerate every way GitHub can respond, and give each a defined behavior.

Important nuance: the sync leg speaks **git smart-HTTP**, not the REST API — so most of the mapping is protocol-level, with REST only for auxiliary checks (repo existence, token validity, rate-limit headers).

- [ ] **Response matrix** (living doc, tested against):
  - Transport: 401/403 (auth, rate limit, SSO), 404 (repo gone/renamed), 5xx, timeouts, connection resets mid-pack
  - Protocol: `unpack ok` / `unpack failed`, `ng <ref> non-fast-forward`, pre-receive hook rejections (>100MB blobs, secret scanning push protection, protected branches)
  - Classify each as: **retryable** (backoff, stay buffered), **divergence** (pause repo, surface to owner), or **config error** (fail fast, don't retry)
- [ ] **Retry policy:** exponential backoff with jitter via Queues retry semantics; DLQ for exhausted/diverged jobs
- [ ] **Divergence policy (explicit product decision):** default = pause + notify; opt-in per repo: `fetch-merge`, `force` (mirror mode). Never silently force-push.
- [ ] **GitHub health signal (passive, not a probe):** no synthetic traffic. Every real sync job already talks to GitHub; classify each outcome (success, 5xx, timeout, rate-limit, protocol error) and record it durably (Analytics Engine or D1). Aggregated over a sliding window, this yields an upstream availability estimate that drives outage mode below and the status surface. With even a few active users, natural sync traffic provides continuous coverage; sparse periods simply widen the estimate's confidence interval rather than triggering false signals.
- [ ] **Outage mode:** driven by the health signal; during outage, syncs park cheaply instead of burning retries; on recovery, DOs drain in per-repo order. Recovery detection is also passive — parked jobs retry on a slow schedule, and the first success flips the signal back to healthy.
- [ ] Evaluate Workflows for the sync job (durable steps: fetch → push → verify → update cursor) vs. plain queue consumer; adopt whichever is simpler to reason about after prototyping both

**Exit criteria:** chaos test passes — kill GitHub (mock) mid-session, keep pushing for an hour, restore it, and watch the buffer drain to an identical ref state with zero manual intervention.

## Phase 3 — Memory benchmarking & documented limits (ongoing, starts ~week 4)

Goal: replace "it depends" with a published, continuously re-verified limits table.

- [ ] **Benchmark harness:** synthetic repo generator sweeping three axes independently — file count, largest blob size, history depth — plus realistic composites (typical agent repo, typical web app)
- [ ] **Measurement:** per engine — container pool: repo-size ceiling per instance type, cold vs. warm sync time, cost per sync; in-Worker isomorphic-git (if kept for small syncs): local workerd runs with memory profiling, deployed binary-search to validate the real 128MB ceiling. Inbound path: the edge request-body ceiling from Phase 0, re-verified.
- [ ] **CI integration:** benchmarks run on every merge to main and nightly; results committed to a `LIMITS.md` with trend history — a regression fails the build
- [ ] **Published limits table:** e.g., "initial mirror: repos up to X MB packed; incremental sync: pushes up to Y MB" — with the failure mode described for oversize cases (clear error, repo stays safe in Artifacts)
- [ ] **Optimization backlog (post-limits):** single-branch + shallow fetch in the sync leg; incremental pack windows for large histories; native `import()` already covers oversized initial mirrors of public repos — extend to private if authenticated import proved out in Phase 0, otherwise route oversized private mirrors to a dedicated large-instance container

**Exit criteria (initial):** LIMITS.md exists, is generated by CI not by hand, and the quickstart links to it.

## Phase 4 — Testing to 100% (parallel to Phases 1–3, hardened ~week 6+)

Goal: 100% coverage on core sync code, and confidence that the number isn't vacuous.

**Layered strategy:**

1. **Unit (pure logic):** URL parsing, token mapping, response classification, cursor math. Trivially 100%.
2. **State machines (XState):** model the sync lifecycle (`idle → fetching → pushing → verifying → synced | retrying | diverged | parked`) as machines. Use model-based testing (`@xstate/test` / graph traversal) to generate paths covering every state × event — this is the cleanest route to genuine 100% on the part that matters most.
3. **Integration with mocked GitHub:** 
   - REST responses: MSW (Mock Service Worker) or recorded fixtures; prior art exists in `@octokit/fixtures`
   - Git protocol responses: thinner prior art here — the practical options are (a) recorded smart-HTTP exchanges replayed as fixtures (isomorphic-git's own test suite does this with a git-http mock server — worth mining), and (b) a scriptable fake receive-pack that can emit `ng non-fast-forward`, hook rejections, and mid-stream disconnects on demand. Build (b) once; it's the backbone of the Phase 2 response matrix tests.
4. **Real-git conformance:** CI job running an actual git server (e.g., Gitea or `git http-backend` in a container) as the "GitHub" upstream — catches protocol assumptions mocks would hide. Also test with real `git` CLI as the *client*, across a couple of git versions.
5. **In-runtime e2e:** `@cloudflare/vitest-pool-workers` so tests execute inside workerd, not Node — the runtimes differ enough to matter for streams and memory.
6. **Mutation testing (Stryker)** on the core sync package, so 100% line coverage is backed by killed mutants rather than incidental execution.

**Coverage policy:** 100% enforced on the sync core and state machines; the streaming proxy and glue measured but gated at a high threshold with documented, reviewed exclusions (some stream-teardown branches are effectively unreachable in tests — excluding them explicitly is more honest than writing tests that fake-touch them).

## Phase 5 — DX, observability & launch (~week 8+)

- [ ] Docs site: quickstart (URL substitution), agent integration guide (Claude Code / generic), limits page, failure-semantics page
- [ ] Observability: per-repo sync lag metric, buffered-commit count, GitHub health status page; Workers Analytics Engine or logs → dashboard. Lean on Artifacts' native GraphQL metrics (operations/errors/pushes by repo) and `cloned`/`fetched` events for the Artifacts side instead of instrumenting it ourselves.
- [ ] **Upstream status page:** not a probe — a status page summarizing observed data from the system's real interactions with GitHub (rolling availability estimate of the git endpoints, incident timeline, current health signal). Built entirely from the Phase 2 passive dataset; still serves as the landing-page proof point ("here's what our traffic saw"), with methodology noted so the passive-measurement basis is transparent
- [ ] Multi-tenancy decision: self-host template (wrangler deploy, bring your own domain + GitHub App) first; hosted service later if demand appears
- [ ] GitHub App instead of PATs (installation tokens, fine-grained repo perms, better rate limits)
- [ ] Beta with 3–5 real agent workflows; collect divergence and limits telemetry before widening
- [ ] **Milestone — domain acquisition:** secure buy-in/budget for `git.cloud` (~$5,000, verify current listing) and deploy the proxy behind it. Resolves open question #4 — `git.cloud/<owner>/<repo>.git` is about as cute as the URL gets.

---

## Open questions

1. ~~**Read path scope**~~ — resolved: see **Phase 1.5**. Reads are served from Artifacts with default-on poll + optional webhook reconciliation, not deferred to later.
2. ~~**Artifacts webhooks**~~ — resolved: event subscriptions shipped (Artifacts docs, May 2026). `cf.artifacts.repo.pushed` carries `ref`/`before`/`after` and replaces the "enqueue after proxied push" trigger; repo-level subscriptions are created at repo auto-create. (Still distinct from the Phase 1.5 GitHub→proxy webhook, which detects out-of-band pushes.)
3. **Force-push semantics inbound:** does the proxy accept client force-pushes and mirror them, or restrict them? (Interacts with the divergence policy.)
4. **Name & domain:** worth picking early since the URL *is* the product surface.
5. **Human auth UX (research follow-up):** token issuance + SSH-remote migration is the friction point for human users. Evaluate setup-CLI, credential-helper, OAuth device flow, and GitHub App approaches (see Auth & transport notes) before Phase 5 docs are written.
6. **Container pool economics:** pool size, idle timeout, cold-start amortization, and per-sync cost at low volume — the Phase 0 bake-off produces the numbers; the answer may be volume-dependent (isomorphic-git for tiny syncs, containers above a threshold).
7. **Private-repo import auth:** `import()` documents public HTTPS remotes only. If credential-embedded URLs work, initial mirror is fully native; if not, private initial mirrors go through the sync engine.

## Risks

| Risk | Mitigation |
|---|---|
| Artifacts beta changes/limits | Keep the Artifacts interface behind an adapter; it's just a git remote + management binding |
| Sync memory ceiling excludes desirable repos | Pooled real-git containers as leading engine (multi-GB instances); native `import()` for initial mirrors of public repos; published limits + shallow/single-branch for the in-Worker engine |
| Missed `pushed` events strand buffered commits | DO alarm reconciliation compares Artifacts ref state to the sync cursor on a slow cadence — event delivery is a latency optimization, never a correctness dependency |
| Container cold starts / cost undermine sync latency or unit economics | Repo→container affinity keeps warm clones; pool sleeps during outages; isomorphic-git in-Worker path retained for small syncs if numbers demand it (Phase 0 bake-off decides) |
| Divergence in shared repos erodes trust | Pause-and-notify default; never silent force-push; loud status surface |
| Git protocol edge cases mocks miss | Real-git conformance layer in CI (Phase 4.4) |
| Stale reads served from Artifacts (commit landed on GitHub out-of-band) | Default-on background poll + optional webhook (Phase 1.5); reconciliation lag surfaced on the status endpoint, never hidden; proxy-exclusive mode only for repos that guarantee no bypass writes |
