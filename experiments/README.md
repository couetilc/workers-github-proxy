# Listen now.

It's time to wipe all the noise away. Concentrate on the scent of discovery,
as we follow the path of experiments. Our goal is understanding, then wisdom.

## Tools

- javascript, npm packages, I'm sure there's more tools you can use.

## We must establish

- whether a git remote proxy can successfully terminate TLS, then re-encrypt
and pass the request along to the proxied service.

## Workspace

Your laboratory is a directory under `./experiments/<experiment-name>/`. Use it
as a scratchpad. It must contain a README.md discussing the experimental design
and the conclusions. It must also contain a RESEARCH_LOG.md, a notebook keeping
track of ideas and attempts during the experiment(s). Any code you write for
the experiment can live in appropriately named sub-directories. Those
directories should be described in the README, along with the command to
reproduce the experiment and any suggestions for follow-up work.

## Safety

Experiments stay local and self-contained: bind servers to `127.0.0.1`, use only
placeholder secrets, and never commit real credentials.

## Experiments

Keep this index of experiments up to date.

| Experiment | Question | Status |
|---|---|---|
| [git-remote-domain-swap](./git-remote-domain-swap) | Can swapping a remote's domain let you receive and inspect git pushes/fetches? | ✅ Yes — depth depends on protocol compliance; **TLS/host-key identity is what protects a real push** |
