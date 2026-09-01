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
