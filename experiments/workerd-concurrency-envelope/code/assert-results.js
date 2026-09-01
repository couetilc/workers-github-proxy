import fs from 'node:fs';

const [statsPath, auditPath, shaperAuditPath, workerdLogPath] = process.argv.slice(2);
if (!workerdLogPath) {
  console.error('usage: node assert-results.js STATS AUDIT SHAPER_AUDIT WORKERD_LOG');
  process.exit(2);
}

const MiB = 1024 * 1024;
const expectedConcurrencies = (process.env.CONCURRENCIES || '1 2 4 8 16')
  .trim().split(/\s+/).map(Number);
const expectedMixedConcurrencies = expectedConcurrencies.filter((value) => value >= 2);
const expectedSizes = (process.env.SIZES_MIB || '8 32 96').trim().split(/\s+/).map(Number);
const expectedWaves = Number(process.env.WAVES || 8);
const sizeConcurrency = Number(process.env.SIZE_CONCURRENCY || 8);
const maxPerStreamMiB = Number(process.env.MAX_RSS_PER_STREAM_MIB || 4);
const fixedAllowanceMiB = Number(process.env.FIXED_RSS_ALLOWANCE_MIB || 12);
const sizeToleranceMiB = Number(process.env.SIZE_PLATEAU_TOLERANCE_MIB || 12);
const floorToleranceMiB = Number(process.env.FLOOR_DRIFT_TOLERANCE_MIB || 12);
const phases = new Set((process.env.PHASES || 'concurrency size longevity cancel')
  .trim().split(/\s+/));

function records(file) {
  const contents = fs.readFileSync(file, 'utf8').trim();
  return contents ? contents.split('\n').filter(Boolean).map(JSON.parse) : [];
}

function fail(message) {
  console.error(`ASSERTION FAILED: ${message}`);
  process.exitCode = 1;
}

const stats = records(statsPath);
const audits = records(auditPath);
const shaperAudits = records(shaperAuditPath);
const log = fs.readFileSync(workerdLogPath, 'utf8');
const requestAudits = audits.filter(({ recordType }) => recordType === 'request');
const activeStarts = audits.filter(({ recordType }) => recordType === 'active-start');
const workerEvents = log.split('\n')
  .filter((line) => line.startsWith('EXPERIMENT_ENVELOPE '))
  .map((line) => JSON.parse(line.slice('EXPERIMENT_ENVELOPE '.length)));
const policyEvents = log.split('\n')
  .filter((line) => line.startsWith('EXPERIMENT '))
  .map((line) => JSON.parse(line.slice('EXPERIMENT '.length)))
  .filter(({ event }) => event === 'policy-allowed');

function expectedOperations(record) {
  return record.phase === 'cancel' ? record.concurrency : record.concurrency;
}

function maxActive(caseName) {
  return Math.max(0, ...activeStarts.filter((event) => event.case === caseName)
    .map(({ active }) => active));
}

function largeCompletedTransfers(record) {
  return requestAudits.filter((audit) => audit.case === record.case && audit.completed &&
    ((audit.kind === 'push' && audit.requestBytes >= record.sizeMiB * MiB * 0.85) ||
     (audit.kind === 'clone' && audit.responseBytes >= record.sizeMiB * MiB * 0.85)));
}

console.log('phase       workload  conc  size  wave  peak delta  final RSS  max active');
for (const record of stats) {
  record.maxActive = maxActive(record.case);
  console.log([
    record.phase.padEnd(11),
    record.workload.padEnd(8),
    String(record.concurrency).padStart(4),
    String(record.sizeMiB).padStart(4),
    String(record.wave || '-').padStart(4),
    `${(record.rssDeltaBytes / MiB).toFixed(2)} MiB`.padStart(10),
    `${(record.finalRssBytes / MiB).toFixed(2)} MiB`.padStart(10),
    String(record.maxActive).padStart(10),
  ].join('  '));

  const requiredActive = record.phase === 'cancel' ? record.concurrency - 1 : record.concurrency;
  if (record.maxActive < requiredActive) {
    fail(`${record.case}: only ${record.maxActive}/${requiredActive} pack streams overlapped`);
  }
  const expectedCompleted = record.phase === 'cancel' ? record.concurrency - 1 :
    expectedOperations(record);
  if (largeCompletedTransfers(record).length < expectedCompleted) {
    fail(`${record.case}: fewer than ${expectedCompleted} completed pack-sized transfers`);
  }
  const memoryBudgetMiB = fixedAllowanceMiB + record.concurrency * maxPerStreamMiB;
  if (record.rssDeltaBytes > memoryBudgetMiB * MiB) {
    fail(`${record.case}: RSS delta exceeded ${memoryBudgetMiB} MiB concurrency budget`);
  }
}

if (phases.has('concurrency')) {
  for (const workload of ['push', 'clone', 'mixed']) {
    const actual = stats.filter((record) => record.phase === 'concurrency' &&
      record.workload === workload).map(({ concurrency }) => concurrency);
    const expected = workload === 'mixed' ? expectedMixedConcurrencies : expectedConcurrencies;
    if (actual.join(',') !== expected.join(',')) {
      fail(`${workload} concurrency points were ${actual.join(',')}; expected ${expected.join(',')}`);
    }
  }
}

const sizeStats = stats.filter(({ phase }) => phase === 'size');
if (phases.has('size') && (sizeStats.length !== expectedSizes.length ||
    sizeStats.map(({ sizeMiB }) => sizeMiB).join(',') !== expectedSizes.join(','))) {
  fail(`size points did not match ${expectedSizes.join(',')}`);
} else if (phases.has('size')) {
  const deltas = sizeStats.map(({ rssDeltaBytes }) => rssDeltaBytes);
  if (Math.max(...deltas) - Math.min(...deltas) > sizeToleranceMiB * MiB) {
    fail(`fixed-concurrency pack sizes varied by more than ${sizeToleranceMiB} MiB RSS`);
  }
  if (sizeStats.some(({ concurrency }) => concurrency !== sizeConcurrency)) {
    fail(`size phase did not use concurrency ${sizeConcurrency}`);
  }
}

const waveStats = stats.filter(({ phase }) => phase === 'longevity');
if (phases.has('longevity') && waveStats.length !== expectedWaves) {
  fail(`expected ${expectedWaves} longevity waves, got ${waveStats.length}`);
} else if (phases.has('longevity')) {
  const window = Math.min(3, Math.floor(waveStats.length / 2));
  const earlyFloor = Math.max(...waveStats.slice(0, window).map(({ finalRssBytes }) => finalRssBytes));
  const lateFloor = Math.max(...waveStats.slice(-window).map(({ finalRssBytes }) => finalRssBytes));
  if (lateFloor > earlyFloor + floorToleranceMiB * MiB) {
    fail(`late-wave RSS floor grew more than ${floorToleranceMiB} MiB over early waves`);
  }
  const longevityCases = new Set(waveStats.map(({ case: caseName }) => caseName));
  const isolateIds = new Set(workerEvents
    .filter((event) => longevityCases.has(event.case)).map(({ isolateId }) => isolateId));
  if (isolateIds.size !== 1) {
    fail(`longevity waves used ${isolateIds.size} isolate IDs instead of one`);
  }
}

const cancelStats = stats.filter(({ phase }) => phase === 'cancel');
if (phases.has('cancel') && cancelStats.length !== 1) {
  fail(`expected one cancellation case, got ${cancelStats.length}`);
}
const injectedAborts = shaperAudits.filter(({ injectedAbort }) => injectedAbort);
if (phases.has('cancel') && injectedAborts.length !== 1) {
  fail(`expected one injected downstream abort, got ${injectedAborts.length}`);
}

if (requestAudits.length === 0 || requestAudits.some(({ accepted }) => !accepted)) {
  fail('upstream saw a request without the replacement credential');
}
if (requestAudits.some(({ clientCredentialLeaked }) => clientCredentialLeaked)) {
  fail('client credential leaked to upstream');
}
if (policyEvents.some(({ heldBytes }) => heldBytes > 128 * 1024)) {
  fail('Worker policy retained more than its prefix plus one expected transport chunk');
}

if (!process.exitCode) {
  console.log(`PASS: ${stats.length} cases completed with real overlapping Git packs.`);
  if (phases.has('concurrency') || phases.has('size') || phases.has('longevity')) {
    console.log('PASS: measured memory stayed within the configured envelope.');
  }
  if (phases.has('longevity')) console.log('PASS: the warmed-process RSS floor stayed bounded.');
  if (phases.has('cancel')) {
    console.log('PASS: cancellation propagated while sibling streams and the Worker remained healthy.');
  }
}
