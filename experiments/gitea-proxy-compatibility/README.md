# Experiment: Gitea proxy compatibility

**Question.** Is the proxy semantically transparent to Git when Gitea is the
upstream, while keeping client and upstream authentication credentials strictly
separated?

**Hypothesis.** A stock Git client should observe the same refs, objects, and
success or failure through the native-pass-through workerd Worker as it does
against Gitea directly. Gitea should see only a replacement upstream credential,
protocol negotiation and Git content types should survive, and local client-auth
or protected-ref failures should stop before Gitea.

**Short answer.** Yes for the tested local, static-credential workflow. Git
2.39.5 produced matching refs and objects against direct and proxied private
repositories on Gitea 1.27.3. All 36 normal proxy-to-Gitea requests carried one
replacement credential and never the client credential. Requested protocol v2,
Git content types, a Git-layer rejection inside HTTP 200, Gitea's HTTP 401/404,
and its Basic challenge survived workerd 2026-08-31.

## Experimental design

The harness creates one local Gitea 1.27.3 process with two private repositories:

- `direct.git` is the control and receives a Gitea Basic credential directly.
- `proxied.git` receives the same Git object history through workerd, authenticated
  to the Worker with an unrelated Bearer value.

The existing native-pass-through Worker and bounded receive-pack prefix policy
from [`workerd-duplex-streaming`](../workerd-duplex-streaming) are reused without
modification. A transparent audit gateway between workerd and Gitea classifies
credentials and records safe request/response metadata and streaming hashes. It
does not accept credentials itself; Gitea remains the authentication authority.

```text
direct control:  Git + Gitea credential --------------------------> Gitea/direct.git

subject:         Git + client credential -> workerd -> audit hop -> Gitea/proxied.git
                                             |
                                             `- replaces Authorization
```

The paired workflow exercises:

1. initial branch and annotated-tag push;
2. fresh clones with protocol v0 and requested protocol v2;
3. incremental push and fetch;
4. branch creation and deletion;
5. an application-layer non-fast-forward rejection from Gitea;
6. a missing repository;
7. a protected ref rejected inside the Worker before receive-pack;
8. missing and invalid client credentials rejected before the audit hop; and
9. a deliberately invalid upstream replacement rejected by Gitea.

The harness compares ref OIDs and checked-out object contents throughout, runs
`git fsck --strict` on both Gitea repositories, and asserts routes, content types,
`Git-Protocol: version=2`, status behavior, credential classes, and absence of
credential values from service logs.

## Results

One complete run on 2026-09-01 audited 38 proxy-to-Gitea requests: 36 normal
requests and two probes using a deliberately invalid upstream replacement.

| Control | Direct Gitea | Through workerd | Result |
|---|---|---|---|
| Initial branch + annotated tag | accepted | accepted | ref OIDs matched |
| Protocol-v0 clone | valid objects | valid objects | same remote `main` and file |
| Requested-v2 clone | valid objects | valid objects | same remote `main` and file |
| Incremental push + fetch | accepted | accepted | updated OIDs matched |
| Branch create + delete | accepted | accepted | presence and absence matched |
| Forced non-fast-forward | Git rejection | same Git rejection | accepted tip remained unchanged |
| Missing private repository | failed | failed | proxied Gitea status remained 404 |
| Invalid upstream replacement | not applicable | failed | Gitea 401 and Basic challenge survived |
| Missing/invalid client auth | not applicable | failed locally | zero audit-hop requests |
| Locally protected ref | not applicable | failed locally | discovery reached Gitea; receive-pack did not |

Both Gitea repositories passed `git fsck --strict` and contained the same ten
reachable loose objects at the end of the workflow. Canonical `.git` URLs
produced no redirects.

### Protocol evidence

The protocol-v0 clone sent no `Git-Protocol` header. The requested-v2 clone sent
`Git-Protocol: version=2` on discovery and both `git-upload-pack` RPCs. Gitea
returned the expected advertisement and result content types in both modes.
Every audited upload-pack and receive-pack POST had a nonempty request and
response body.

The forced non-fast-forward control is important: Gitea returned HTTP 200 with
`application/x-git-receive-pack-result`, while the pkt-line result rejected the
ref. Direct and proxied Git printed the same remote rejection. HTTP status alone
therefore cannot classify Git operation success; production observability needs
to understand receive-pack results or record the eventual client-visible
outcome.

### Authentication evidence

For every normal request, the audit hop saw exactly one `Authorization` header,
classified as the replacement Gitea credential. It never saw the client Bearer
value. Missing and invalid client credentials returned HTTP 401 inside the
Worker and did not reach the audit hop. A deliberately invalid replacement did
reach Gitea, which returned HTTP 401 with a Basic challenge. A client-side HTTP
capture proved both headers crossed workerd, and Git then followed the
authentication failure path. Credential values were absent from the workerd,
audit-gateway, and Gitea service logs.

This proves separation for credentials supplied explicitly with
`http.extraHeader`; it does not establish the production login experience. The
Worker's own 401 currently has no `WWW-Authenticate` header, so the proxy still
needs an explicit client authentication and credential-helper contract.

It also does not preserve the original client identity inside Gitea. Gitea sees
the replacement service account. The experiment index records user attribution
as a separate planned experiment.

## Conclusions

1. **The existing Worker is semantically compatible with this real Gitea
   workflow.** Direct and proxied operations converged on the same refs and
   object graph across writes, reads, deletion, and rejection.
2. **Protocol metadata survived without special Gitea code.** URL suffixes,
   service queries, v0/v2 negotiation, content types, statuses, Git bodies, and
   the upstream Basic challenge crossed the Worker correctly.
3. **Static credential replacement held at the intended boundary.** Client
   failures stopped locally, valid traffic used only the upstream credential,
   and an invalid upstream credential remained a genuine Gitea failure.
4. **Git errors are not synonymous with HTTP errors.** A receive-pack result can
   reject a ref inside HTTP 200, which matters for future replication response
   aggregation and observability.
5. **The next product uncertainty is replication, not single-upstream
   compatibility.** This fixture can now be extended to two Gitea instances;
   identity attribution and client-auth UX remain deliberately separate.

## Limits and follow-up work

- This is one Git, Gitea, and workerd version over local HTTP. TLS, deployed
  scheduling, GitHub/Artifacts quirks, and credential issuance are absent.
- The workflow uses a small object graph. Large-pack and concurrency behavior
  remain established by the preceding experiments rather than re-measured here.
- Redirects did not occur on canonical URLs; cross-origin and canonicalization
  redirect policy still needs a negative control before production.
- LFS, submodules, shallow/partial clones, push options, and unusual content
  encodings are outside this compatibility slice.
- The transparent audit hop streams bytes and lets Gitea authenticate them, but
  it is still one extra local HTTP implementation in the topology.
- Extend the fixture to two Gitea instances: duplicate push bodies, define how
  Git-layer and HTTP-layer failures combine, and round-robin stateless reads.

## How to run

Requires Linux, Node, npm, Git, curl, and `sha256sum`:

```bash
./code/run.sh
KEEP=1 ./code/run.sh
```

The script installs the pinned workerd npm dependency and downloads the official
Gitea 1.27.3 binary for Linux amd64 or arm64 into ignored `code/.cache/` when
absent. `GITEA_BIN` may select an existing binary. `KEEP=1` retains the SQLite
database, bare repositories, audit JSONL, command failures, and service logs in
the printed temporary directory. All ports can be overridden with `GITEA_PORT`,
`AUDIT_PORT`, and `WORKERD_PORT`.

## Files

```text
gitea-proxy-compatibility/
|-- README.md                       design, results, and conclusions
|-- RESEARCH_LOG.md                 chronological notebook
`-- code/
    |-- run.sh                      complete direct/proxied workflow
    |-- audit-gateway.cjs           streaming, credential-safe upstream audit
    |-- assert-results.cjs          auth and smart-HTTP regression gates
    |-- gitea.app.ini.template      isolated SQLite Gitea configuration
    |-- workerd.capnp.template      proxy service and Gitea audit-hop binding
    |-- package.json                pinned workerd dependency
    |-- package-lock.json           exact npm dependency graph
    `-- .gitignore                  generated runtime files and downloaded binary
```
