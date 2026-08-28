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
| Git implementation | isomorphic-git over in-memory FS (the Artifacts-documented pattern) |
| Inbound push endpoint | Thin streaming proxy for smart-HTTP (`info/refs` + `git-receive-pack`) → Artifacts. No packfile parsing on the hot path. |
| URL scheme | GitHub path conventions: `https://<your-domain>/<owner>/<repo>.git` — a pure host substitution from an existing GitHub remote |
| Durable buffer | Artifacts itself (queue messages carry pointers, never pack data) |
| Sync orchestration | Cloudflare Queues (trigger + retry/DLQ) and/or Workflows (durable multi-step sync) |
| Concurrency | One Durable Object per repo as control plane: linearizes sync state + admission via leases; data-plane writes to Artifacts/GitHub run concurrently under git's CAS ref semantics |
| Sync state modeling | XState state machines for the sync lifecycle |
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
- The queue consumer holding the lease does the heavy isomorphic-git fetch/push. Keeping the 128MB memory load out of the DO means an OOM on a big sync can never take down the state holder.
- Consumer crash mid-push is safe: lease expires → next job runs → idempotency check (compare GitHub's current ref first) finds the push either landed (no-op) or redoes it

**Granularity:** per-repo lanes, not per-ref, for v1 — pack fetches overlap heavily across refs and per-ref cursors complicate the model for marginal gain on agent-sized repos. Cross-repo needs no coordination; repos are independent, matching both DO sharding and Artifacts' repo-per-agent model.

---

## Phase 0 — Spike & validation (~1 week)

Goal: kill the unknowns before building anything permanent.

- [ ] Confirm Artifacts beta access; create/fork repos via the Workers binding
- [ ] Prove the pass-through proxy: real `git push` from CLI → Worker → Artifacts, verified with `git clone` from Artifacts
- [ ] Prove the sync leg: isomorphic-git in a Worker fetches from Artifacts and pushes to a GitHub repo (fast-forward case)
- [ ] Prove non-thin pack behavior: confirm fetched packs from Artifacts push cleanly to GitHub receive-pack
- [ ] First rough memory ceiling: at what repo size does the sync leg fall over in workerd?

**Exit criteria:** end-to-end demo (push → Artifacts → GitHub) on a toy repo; a written list of anything that didn't work as expected.

## Phase 1 — MVP (~2–3 weeks)

Goal: a usable single-tenant proxy for agent-sized repos.

- [ ] **Routing:** GitHub-convention URL parsing (`/:owner/:repo.git/info/refs`, `/:owner/:repo.git/git-receive-pack`, and the read paths `git-upload-pack` so clones/fetches through the proxy also work)
- [ ] **Repo mapping:** `owner/repo` → Artifacts repo (auto-create/fork on first push) + GitHub upstream config
- [ ] **Auth:** proxy-minted tokens presented as git basic auth; server-side mapping to Artifacts tokens + GitHub PAT/App installation token. Secrets in Worker secrets/bindings.
- [ ] **Sync pipeline v1:** on successful push, DO records ref update → enqueue `{repo, ref, oldSha, newSha}` → consumer (via the repo's DO) runs isomorphic-git fetch/push
- [ ] **Idempotent replay:** consumer compares GitHub's current ref before pushing; no-op if already synced
- [ ] **Status endpoint:** per-repo JSON — buffered refs, last sync time, divergence flag
- [ ] Deploy under a real domain; write the "change one string in your remote URL" quickstart

**Exit criteria:** an agent workflow (e.g., Claude Code or a scripted agent) uses the proxy as its only remote for a full session, with GitHub reflecting every push.

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
- [ ] **Measurement:** local workerd runs with memory profiling for precise numbers; deployed binary-search (push increasing sizes until failure) to validate the real 128MB ceiling
- [ ] **CI integration:** benchmarks run on every merge to main and nightly; results committed to a `LIMITS.md` with trend history — a regression fails the build
- [ ] **Published limits table:** e.g., "initial mirror: repos up to X MB packed; incremental sync: pushes up to Y MB" — with the failure mode described for oversize cases (clear error, repo stays safe in Artifacts)
- [ ] **Optimization backlog (post-limits):** single-branch + shallow fetch in the sync leg; incremental pack windows for large histories; Container fallback offer for oversized initial mirrors

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
- [ ] Observability: per-repo sync lag metric, buffered-commit count, GitHub health status page; Workers Analytics Engine or logs → dashboard
- [ ] **Upstream status page:** not a probe — a status page summarizing observed data from the system's real interactions with GitHub (rolling availability estimate of the git endpoints, incident timeline, current health signal). Built entirely from the Phase 2 passive dataset; still serves as the landing-page proof point ("here's what our traffic saw"), with methodology noted so the passive-measurement basis is transparent
- [ ] Multi-tenancy decision: self-host template (wrangler deploy, bring your own domain + GitHub App) first; hosted service later if demand appears
- [ ] GitHub App instead of PATs (installation tokens, fine-grained repo perms, better rate limits)
- [ ] Beta with 3–5 real agent workflows; collect divergence and limits telemetry before widening
- [ ] **Milestone — domain acquisition:** secure buy-in/budget for `git.cloud` (~$5,000, verify current listing) and deploy the proxy behind it. Resolves open question #4 — `git.cloud/<owner>/<repo>.git` is about as cute as the URL gets.

---

## Open questions

1. **Read path scope:** proxy `git-upload-pack` too (clones/fetches through the cute URL, served from Artifacts) — MVP or later? Serving reads from Artifacts during a GitHub outage is a strong part of the story.
2. **Artifacts webhooks:** if push-event subscriptions ship during development, they replace the "enqueue after proxied push" trigger — track the changelog.
3. **Force-push semantics inbound:** does the proxy accept client force-pushes and mirror them, or restrict them? (Interacts with the divergence policy.)
4. **Name & domain:** worth picking early since the URL *is* the product surface.

## Risks

| Risk | Mitigation |
|---|---|
| Artifacts beta changes/limits | Keep the Artifacts interface behind an adapter; it's just a git remote + management binding |
| 128MB ceiling excludes desirable repos | Published limits + shallow/single-branch sync + Container fallback path |
| Divergence in shared repos erodes trust | Pause-and-notify default; never silent force-push; loud status surface |
| Git protocol edge cases mocks miss | Real-git conformance layer in CI (Phase 4.4) |
