  ### Minimum sensible PoC

implement:

  - One repo-scoped DO lease. (to serialize writes to a repo through the proxy).
  - Proxy-exclusive writes. (to avoid change detection and reconciliation when writes bypass the proxy to an origin).
  - Direct streaming outside the DO. (to avoid slowing down the hot path).
  - Final ref verification against both replicas. (to ensure correctness?).
  - healthy, divergent, and unknown repository states. (a categorization used for human flagging and behavioral policy choices)
  - Durable incident record when available. (for human review, data used to feed future software improvements).
  - Critical logging when recording fails. (for human review, and to surface use cases we do not account for so we can address them).
  - Block additional writes while divergent. (fail-safe switch to indicate to users that repo's state cannot be converged with current information).
  - Primary-only reads. (to avoid pre-mature performance optimization, read performance should be optimized with real-world data and curated approaches).
  - Manual reconciliation followed by verification and state clearing. (a human-facing feature for addressing issues, the UI/UX here has not been discussed.).

defer:

  - Atomic dual writes—they are impossible without upstream transaction support. (I need more info here.)
  - Automatic merge/force reconciliation. (this is likely useful, but only on un-protected branches right? protected branches don't have this issue?)
  - Exactly-once incident processing. (not sure why this is important?)
  - Full journal replay machinery. (yes, but what is keeping the journal, and what does the journal record? would want to re-use something like sqlite)
  - Out-of-band multi-writer support. (so here we need a reconciliation algorithm, and either a pull/push based solution for detecting changes at git origins)
  - Clone-level round-robin affinity. (round robin is just a dead-simple experiment, really, the ask here is "how can we improve read performance" broadly? edge-caching, load balancing, not sure yet).
  - Continuous reconciliation beyond a basic scheduled scrub. (yes, but what causes a need for reconciliation is not clear to me at the moment.)

  
### Then build the PoC

The first deployed PoC can deliberately be narrow:

- One tenant and a small number of repositories.
- HTTPS only.
- One authoritative durable primary.
- Primary-only clone/fetch reads.
- Asynchronous GitHub synchronization.
- One DO per repository for sync leases and status.
- Proxy-exclusive writes for the test repositories.
- Protected, fast-forward-only main.
- Final ref verification.
- Status endpoint and high-priority incident logging.
- Automatic repair only for the exact recorded-before/desired-after case.
- Human reconciliation for everything else.

# PoC

Goal: keep pushing when GitHub is down, reconcile when back up.

There was a couple models bouncing around, the goal is to create an outage-buffer primarily, a synchronous mirror secondarily.

                            Synchronous mirror         Recommended outage-buffer
  ━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Client success           Both replicas verified     Durable primary accepted
  ───────────────────────  ─────────────────────────  ─────────────────────────────────────────
   DO serializes            Inbound pushes             Background sync jobs
  ───────────────────────  ─────────────────────────  ─────────────────────────────────────────
   Replica mismatch         Push failure/divergence    Usually normal pending_sync
  ───────────────────────  ─────────────────────────  ─────────────────────────────────────────
   Secondary unavailable    Client push fails          Client push succeeds and buffers
  ───────────────────────  ─────────────────────────  ─────────────────────────────────────────
   Block new pushes         Often necessary            Usually continue accepting into primary

  ## Revised implementation list

  - One repo-scoped DO lease. Yes, but serialize background synchronization and reconciliation, not ordinary inbound writes. The authoritative Git repository already uses Git’s
    old-OID CAS to serialize ref updates.

  - Proxy-exclusive writes. Correct for the PoC. Note that GitHub PR merges, Dependabot, release automation, and direct administrator pushes all violate this condition. Use
    dedicated test repositories where those are disabled.

  - Direct streaming outside the DO. Correct. On the client hot path, stream only to the durable primary. Later synchronization fetches from the primary and pushes to GitHub, also
    outside the DO.

  - Final ref verification against both replicas. Correct before declaring a sync job completed, but it does not need to block the original client push. The primary receive-pack
    result establishes durable acceptance; secondary verification advances the sync cursor asynchronously.

  - Repository states. I would use more precise names:
      - synced: secondary matches the intended primary cursor.
      - pending_sync: primary is ahead; this is normal.
      - needs_review: an observed ref is neither the expected old OID nor desired OID.
      - verification_required: an upstream could not be inspected or the result was ambiguous.
      - sync_paused: behavioral flag preventing more secondary mutations.

    “Divergent” is too broad because every normal asynchronous push temporarily makes the repositories different.

  - Durable incident record. Correct, but distinguish ordinary operation records from incidents. A retryable GitHub outage is operational state; an unrelated GitHub OID is an
    incident.

  - Critical logging when recording fails. Correct. It is a secondary observability channel, not a substitute for recovery.
  - Block additional writes while divergent. In the recommended architecture, pause writes to the conflicting secondary, not inbound writes to the primary. Continuing to durably
    accept agent work is the product’s purpose. A deliberately fail-closed PoC is possible, but it weakens the outage-buffering demonstration.

  - Primary-only reads. Correct.
  - Manual reconciliation followed by verification. Correct. The initial UX can be a status endpoint plus CLI, not a full UI:

    status
    retry-safe
    adopt-primary --expect-secondary=<oid>
    adopt-origin --expect-primary=<oid>
    verify-and-clear

    “Clear” must only work after verification.

    ## PoC goals

  The PoC should prove:

  1. A Git push succeeds while GitHub is unavailable.
  2. The complete repository state is durable in the primary.
  3. GitHub eventually converges after recovery.
  4. Conflicting GitHub changes are never silently overwritten.
  5. Crashes and lost events become either safe retries or visible incidents.
  6. Pack bodies remain outside the coordination layer.
  7. Operators can understand and manually resolve exceptional states.

   For a single-tenant PoC, defer:

  - User-attribution propagation beyond recording one authenticated proxy principal.
  - Multi-writer or bidirectional GitHub synchronization.
  - Automatic merge/force conflict resolution.
  - Round-robin or cached reads.
  - Exactly-once incident handling.
  - Event-sourced journal replay.
  - Polished reconciliation UI.
  - Continuous reconciliation beyond event processing, next-request checks, and a scheduled scrub.
