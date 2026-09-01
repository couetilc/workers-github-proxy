import fs from 'node:fs';

const [statsPath, auditPath, workerdLogPath] = process.argv.slice(2);
if (!statsPath || !auditPath || !workerdLogPath) {
  console.error('usage: node assert-results.js STATS_JSONL AUDIT_JSONL WORKERD_LOG');
  process.exit(2);
}

const MiB = 1024 * 1024;
const memoryBudget = Number(process.env.MEMORY_BUDGET_MIB || 8) * MiB;
const plateauTolerance = Number(process.env.MEMORY_PLATEAU_TOLERANCE_MIB || 2) * MiB;
const requestStreamMode = process.env.REQUEST_STREAM_MODE || 'tee';
const expectedSizes = (process.env.SIZES_MIB || '8 32 96').trim().split(/\s+/).map(Number)
  .sort((left, right) => left - right);

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
const log = fs.readFileSync(workerdLogPath, 'utf8');
const policyEvents = log.split('\n')
  .filter((line) => line.startsWith('EXPERIMENT '))
  .map((line) => JSON.parse(line.slice('EXPERIMENT '.length)))
  .filter(({ event }) => event === 'policy-allowed' || event === 'policy-rejected');

console.log('direction  input MiB  wire MiB  baseline MiB  RSS delta MiB  samples');
for (const record of stats) {
  const pathSuffix = record.direction === 'push' ? '/git-receive-pack' : '/git-upload-pack';
  const repoPrefix = `/repo-${record.sizeMiB}.git/`;
  const candidates = audits.filter((audit) =>
    audit.accepted && audit.path.startsWith(repoPrefix) && audit.path.endsWith(pathSuffix));
  const wireField = record.direction === 'push' ? 'requestBytes' : 'responseBytes';
  const matching = candidates.sort((left, right) => right[wireField] - left[wireField])
    .find((audit) => audit[wireField] >= record.sizeMiB * MiB * 0.9);
  record.wireBytes = matching?.[wireField] || 0;
  console.log([
    record.direction.padEnd(9),
    String(record.sizeMiB).padStart(9),
    (record.wireBytes / MiB).toFixed(2).padStart(8),
    (record.baselineRssBytes / MiB).toFixed(2).padStart(12),
    (record.rssDeltaBytes / MiB).toFixed(2).padStart(13),
    String(record.samples).padStart(7),
  ].join('  '));
}

for (const direction of ['push', 'clone']) {
  const group = stats.filter((record) => record.direction === direction)
    .sort((left, right) => left.sizeMiB - right.sizeMiB);
  if (group.length !== expectedSizes.length) {
    fail(`${direction}: expected ${expectedSizes.length} measurements, got ${group.length}`);
    continue;
  }
  if (group.some((record, index) => record.sizeMiB !== expectedSizes[index])) {
    fail(`${direction}: sizes do not match ${expectedSizes.join(', ')}`);
  }
  if (group.some((record) => record.wireBytes < record.sizeMiB * MiB * 0.9)) {
    fail(`${direction}: an operation did not carry its expected pack-sized wire body`);
  }
  if (group.at(-1).wireBytes < group[0].wireBytes * 7.5) {
    fail(`${direction}: wire body grew less than 7.5x`);
  }
  for (const record of group) {
    if (record.rssDeltaBytes > memoryBudget) {
      fail(`${direction} ${record.sizeMiB} MiB: RSS delta exceeded ${memoryBudget / MiB} MiB`);
    }
  }
  if (group.at(-1).rssDeltaBytes > group.at(-2).rssDeltaBytes + plateauTolerance) {
    fail(`${direction}: largest body added more than ${plateauTolerance / MiB} MiB over prior RSS delta`);
  }
}

if (audits.length === 0 || audits.some(({ accepted }) => !accepted)) {
  fail('upstream saw a request without the replacement credential');
}
if (audits.some(({ clientCredentialLeaked }) => clientCredentialLeaked)) {
  fail('client credential leaked to upstream');
}
if (policyEvents.some(({ streamMode }) => streamMode !== requestStreamMode)) {
  fail(`Worker policy did not consistently use ${requestStreamMode} request streaming`);
}
if (policyEvents.some(({ heldBytes }) => heldBytes > 128 * 1024)) {
  fail('Worker policy retained more than its prefix plus one expected transport chunk');
}
if (!log.includes('"event":"policy-rejected"') ||
    !log.includes('"rejectedRef":"refs/heads/protected"')) {
  fail('protected-ref control was not logged by Worker policy');
}

if (!process.exitCode) {
  console.log(`PASS: ${stats.length} workerd transfers stayed within a ${memoryBudget / MiB} MiB RSS-delta budget.`);
  console.log(`PASS: auth replacement and protected-ref policy held inside the Worker.`);
}
