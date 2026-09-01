import { classifyReplay } from "./replay-policy.js";

const [before, desired, observed, availability = "available"] = process.argv.slice(2);
if (!before || !desired) {
  console.error("usage: classify-replay.mjs <before> <desired> <observed> [available|unavailable]");
  process.exit(2);
}

process.stdout.write(
  `${classifyReplay({
    before,
    desired,
    observed: observed || null,
    available: availability === "available",
  })}\n`,
);
