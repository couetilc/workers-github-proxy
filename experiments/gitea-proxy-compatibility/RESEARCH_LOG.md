# Research log: Gitea proxy compatibility

## 2026-09-01 — Question and design

The preceding work established bounded Web Streams behavior under concurrency.
The next uncertainty is compatibility with an application Git server rather than
the deliberately narrow `git-http-backend` fixture.

Question:

> Is the proxy semantically transparent to Git when Gitea is the upstream,
> while keeping client and upstream authentication credentials strictly
> separated?

The direct control and proxy subject use separate private Gitea repositories
initialized from the same source commits. The paired workflow covers initial and
incremental pushes, protocol-v0 and requested-v2 clones, fetch, tag and branch
updates, deletion, a Gitea receive-pack rejection, a missing repository, local
ref policy, and both client- and upstream-auth failures.

A transparent Node gateway sits between workerd and Gitea only to classify the
credential, route, protocol header, content types, statuses, byte counts, and
streaming SHA-256 digests. It never records an authorization value. Gitea still
authenticates the replacement Basic credential itself, so the gateway cannot
manufacture a successful auth result.

Hypothesis: direct and proxied workflows will produce matching refs and object
graphs; the proxy will preserve smart-HTTP negotiation and success/failure
semantics; and no credential will cross the wrong trust boundary. Redirect,
challenge, header, and URL behavior are likelier failure points than streaming.

## 2026-09-01 — First run: Gitea startup control failure

The initial harness exported `GIT_CONFIG_GLOBAL=/dev/null` to isolate Git client
configuration. Gitea inherits the environment and initializes its own Git
settings at startup; it failed when Git tried to lock `/dev/null` as a global
config file. No experimental Git workflow ran.

The fix was to scope `GIT_CONFIG_GLOBAL=/dev/null` and
`GIT_CONFIG_NOSYSTEM=1` to client invocations only. Gitea then initialized its
Git environment normally. This was a harness isolation bug, not a proxy or
Gitea compatibility result.

## 2026-09-01 — Complete run

The paired workflow completed in about seven seconds after dependencies were
cached. Versions were Git 2.39.5, Gitea 1.27.3, and workerd 2026-08-31.

- Initial and incremental pushes, tag creation, branch creation/deletion,
  protocol-v0 and requested-v2 clones, and incremental fetch all converged on
  matching direct/proxied refs and content.
- Both bare Gitea repositories passed `git fsck --strict` and ended with ten
  reachable loose objects.
- The audit hop recorded 38 requests. All 36 normal requests carried exactly one
  replacement authorization value; none carried the client credential. The
  final two probes deliberately carried an invalid replacement for HTTP-header
  capture and the Git negative control.
- Protocol v0 had no `Git-Protocol` header. Requested v2 preserved
  `Git-Protocol: version=2` on discovery and two upload-pack RPCs.
- Gitea's forced non-fast-forward response was HTTP 200 with a valid
  receive-pack result containing the rejection. Direct and proxied Git printed
  the same remote rejection and retained the previously accepted ref.
- The locally protected push performed receive-pack discovery but no
  receive-pack POST. Missing/invalid client-auth probes made no audit-hop
  request.
- A missing repository remained Gitea HTTP 404. An invalid upstream replacement
  remained HTTP 401, and the `WWW-Authenticate: Basic` scheme crossed both hops.
- No canonical Git operation redirected. Service logs contained none of the
  credential values used by the harness.

The Worker-generated client 401 has no `WWW-Authenticate` response header. The
explicit Bearer `http.extraHeader` contract works, but standard credential-helper
UX is not established here.

## 2026-09-01 — Interpretation and follow-up

The hypothesis held for this compatibility slice. Single-upstream Gitea is no
longer the highest-risk unknown; the fixture should next exercise two upstreams
and define how to aggregate a mix of HTTP failures and Git-layer failures hidden
inside successful HTTP responses.

A shared upstream credential necessarily makes Gitea observe the service
account rather than the original proxy user. The experiment index now reserves
a separate `gitea-user-attribution` experiment for proxy audit identity,
repository attribution, and credential design.
