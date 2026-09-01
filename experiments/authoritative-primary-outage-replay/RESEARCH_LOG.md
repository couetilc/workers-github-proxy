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
