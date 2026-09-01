// .agent/config.js — this project's agent-container configuration.
// USER-OWNED: `agent init` writes this once and never overwrites it. Pure data
// (no functions in v1); loaded as ESM and validated by @couetilc/agentic-coding.
export default {
  schemaVersion: 1,

  project: 'workers-github-proxy',           // names image, containers, volumes, labels
  repo: 'couetilc/workers-github-proxy',                 // clone target (HTTPS + GH_TOKEN)
  defaultBranch: 'main', // auto-push hook skips this branch

  // Named container ports → host mapping. Each gets a fresh random localhost
  // port per launch, injected as $DEV_HOST_<NAME> (e.g. { astro: 4321 } →
  // $DEV_HOST_ASTRO). Bind the dev server to 0.0.0.0 inside for it to be reachable.
  ports: {},

  agents: {
    claude: { model: 'claude-fable-5', effort: 'xhigh' },
    codex:  { model: 'gpt-5.6-sol',        effort: 'xhigh' },
  },

  // .env keys the preflight requires beyond GH_TOKEN + agent credentials.
  requiredEnv: [],

  // Extra named docker volumes mounted for cross-container caching. The npm
  // cache is always mounted; add e.g. 'uv' for Python projects.
  caches: [],

  // Days before this project's stopped containers and superseded image tags
  // are auto-removed at launch (throttled to once per 24h). 0 disables.
  retentionDays: 30,
};
