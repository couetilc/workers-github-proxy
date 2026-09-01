import fs from 'node:fs';

const [pidText, outputPath, phase, caseName, workload, concurrencyText, sizeText,
  waveText, readyPath] = process.argv.slice(2);
if (!readyPath) {
  console.error('usage: node rss-sampler.js PID OUTPUT PHASE CASE WORKLOAD CONCURRENCY SIZE_MIB WAVE READY');
  process.exit(2);
}

const targetPid = Number(pidText);
const concurrency = Number(concurrencyText);
const sizeMiB = Number(sizeText);
const wave = Number(waveText);
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
let finalRssBytes = baselineRssBytes;
let samples = 1;
let finished = false;
const startedAt = process.hrtime.bigint();

function sample() {
  try {
    finalRssBytes = readRssBytes();
    peakRssBytes = Math.max(peakRssBytes, finalRssBytes);
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
    phase,
    case: caseName,
    workload,
    concurrency,
    sizeMiB,
    wave,
    targetPid,
    baselineRssBytes,
    peakRssBytes,
    finalRssBytes,
    rssDeltaBytes: peakRssBytes - baselineRssBytes,
    finalDeltaBytes: finalRssBytes - baselineRssBytes,
    samples,
    elapsedMs: Math.round(elapsedMs),
  })}\n`);
  process.exit(0);
}

const timer = setInterval(sample, 5);
process.on('SIGTERM', finish);
process.on('SIGINT', finish);
