# Listen now.

It's time to wipe all the noise away. Concentrate on the scent of discovery,
as we follow the path of experiments. Our goal is understanding, then wisdom.

## Tools

- javascript, npm packages, I'm sure there's more tools you can use.

## We must establish

- whether the fixed-memory duplex result survives inside **workerd**, using the
same Fetch and Web Streams APIs as a production Worker. Establish not only that
real push-request and clone-response packs plateau, but which request-stream
construction preserves workerd's native backpressure while still allowing a
bounded receive-pack ref policy and header-level auth replacement.

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
