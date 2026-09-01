const { appendFileSync, readFileSync } = require("node:fs");

const rootPid = Number.parseInt(process.argv[2] ?? "0", 10);
const label = process.argv[3];
const output = process.argv[4];
if (!rootPid || !label || !output) {
  throw new Error("usage: process-tree-rss.cjs <root-pid> <label> <output>");
}

let baselineKiB = null;
let peakKiB = 0;
let maxProcessCount = 0;
let samples = 0;
let stopping = false;

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function descendants(pid, result = new Set()) {
  if (result.has(pid)) return result;
  result.add(pid);
  const children = readText(`/proc/${pid}/task/${pid}/children`)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  for (const child of children) descendants(child, result);
  return result;
}

function rssKiB(pid) {
  const match = readText(`/proc/${pid}/status`).match(/^VmRSS:\s+(\d+)\s+kB$/m);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function sample() {
  const pids = descendants(rootPid);
  const total = [...pids].reduce((sum, pid) => sum + rssKiB(pid), 0);
  if (baselineKiB === null) baselineKiB = total;
  peakKiB = Math.max(peakKiB, total);
  maxProcessCount = Math.max(maxProcessCount, pids.size);
  samples += 1;
}

function finish() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  sample();
  appendFileSync(
    output,
    `${JSON.stringify({
      label,
      rootPid,
      samples,
      baselineKiB,
      peakKiB,
      deltaKiB: peakKiB - baselineKiB,
      maxProcessCount,
      scope: "wrangler process tree during local Worker proxy traffic",
    })}\n`,
  );
  process.exit(0);
}

sample();
const timer = setInterval(sample, 20);
process.on("SIGINT", finish);
process.on("SIGTERM", finish);
