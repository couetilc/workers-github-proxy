# Research log: authoritative primary outage replay

## 2026-09-01 — Start and access check

The repository plan identifies Artifacts access as the first gate. This
container has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; Wrangler
4.128.0 authenticated successfully, and both Wrangler and the Artifacts REST
API listed namespaces successfully. The list was empty, so no prior namespace
or repository can be reused.

The experiment will create its first repository through a Worker running with
an experiment-specific Wrangler config and `remote: true`. This verifies the
same binding surface intended for the POC, rather than treating a generic API
token check as sufficient. The first repository implicitly creates the
unrestricted `workers-github-proxy-experiments` namespace.

The first-gate harness keeps the returned repo token out of command output,
remote URLs, and committed files. It uses Git's `http.extraHeader` Bearer form
for push and clone.

## 2026-09-01 — First binding create and token-format drift

The first remote-binding invocation succeeded: it implicitly created the
unrestricted namespace and created `outage-replay-gate-20260901` with default
branch `main`. The Worker returned HTTP 201 in about 1.8 seconds.

The harness then rejected the returned credential before running Git because
it expected the documented `art_v1_<40 hex>?expires=<unix>` shape. The binding
returned an `art_v2_...?...` credential instead. This is exactly the kind of
beta/API drift the experiment needs to surface. Tokens are now treated as
opaque: the harness checks only an `art_v<version>_` prefix, a non-empty secret,
and numeric expiry, while never logging the value. A reuse mode mints a new
short-lived token for this already-created repository so the gate can continue
without creating another repository.

## 2026-09-01 — First gate passed and GitHub creation blocked

Using a newly minted one-hour token, Git smart HTTP pushed the initial commit
to Artifacts in 530 ms. A fresh clone completed in 528 ms, resolved the same
OID (`e6c9a3881e361e201369319451d00c46c6bdfd8e`), matched file content, and
passed `git fsck --strict`.

The next harness revision proxies Git through the local Worker. A live
`ls-remote` through that path completed both `info/refs` and `git-upload-pack`
against the real Artifacts repository, confirming that binding-minted tokens
and the streaming pass-through route interoperate.

The full harness now covers seven outage-buffered updates, 503 sync failures,
fresh primary clones, coalesced GitHub replay, exact ref/reachable-object
comparison, and an unrelated sibling GitHub OID classified as `needs_review`.
It refuses to run against a non-empty GitHub repository.

Creating the required disposable private GitHub repository failed before any
repository was created: GitHub returned `Resource not accessible by personal
access token (createRepository)`. The current fine-grained `GH_TOKEN` can read
the project repository but cannot create repositories. Reusing this project's
`main` or adding experiment refs would broaden the experiment's impact and
violate the dedicated-target safety guard, so the live replay run is paused
until an empty test repository is supplied or the token gains repository
creation authority.
