import fs from 'node:fs';

const [pidText, label, sizeText, direction, outputPath, readyPath] = process.argv.slice(2);
if (!pidText || !label || !sizeText || !direction || !outputPath || !readyPath) {
  console.error('usage: node rss-sampler.js PID LABEL SIZE_MIB DIRECTION OUTPUT_JSONL READY_FILE');
  process.exit(2);
}

const targetPid = Number(pidText);
const sizeMiB = Number(sizeText);
const statusPath = `/proc/${targetPid}/status`;

function readRssBytes() {
  const status = fs.readFileSync(statusPath, 'utf8');
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if (!match) throw new Error(`VmRSS missing from ${statusPath}`);
  return Number(match[1]) * 1024;
}

const baselineRssBytes = readRssBytes();
fs.writeFileSync(readyPath, `${baselineRssBytes}\n`);
let peakRssBytes = baselineRssBytes;
let samples = 1;
let finished = false;
const startedAt = process.hrtime.bigint();

function sample() {
  try {
    peakRssBytes = Math.max(peakRssBytes, readRssBytes());
    samples += 1;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function finish() {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  sample();
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  fs.appendFileSync(outputPath, `${JSON.stringify({
    runLabel: label,
    sizeMiB,
    direction,
    targetPid,
    baselineRssBytes,
    peakRssBytes,
    rssDeltaBytes: peakRssBytes - baselineRssBytes,
    samples,
    elapsedMs: Math.round(elapsedMs),
  })}\n`);
  process.exit(0);
}

const timer = setInterval(sample, 5);
process.on('SIGTERM', finish);
process.on('SIGINT', finish);
