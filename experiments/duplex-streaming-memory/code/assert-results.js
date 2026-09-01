'use strict';

const fs = require('fs');

const [statsPath, auditPath] = process.argv.slice(2);
if (!statsPath || !auditPath) {
  console.error('usage: node assert-results.js STATS_JSONL AUDIT_JSONL');
  process.exit(2);
}

const MiB = 1024 * 1024;
const memoryBudget = Number(process.env.MEMORY_BUDGET_MIB || 32) * MiB;
const plateauTolerance = Number(process.env.MEMORY_PLATEAU_TOLERANCE_MIB || 8) * MiB;
const queueBudget = Number(process.env.QUEUE_BUDGET_MIB || 2) * MiB;
const expectedSizes = (process.env.SIZES_MIB || '8 32 96').trim().split(/\s+/).map(Number)
  .sort((left, right) => left - right);

function records(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function fail(message) {
  console.error(`ASSERTION FAILED: ${message}`);
  process.exitCode = 1;
}

const stats = records(statsPath);
const audits = records(auditPath);
const allowed = [];
for (const direction of ['push', 'clone']) {
  for (const sizeMiB of expectedSizes) {
    const candidates = stats.filter((record) =>
      record.decision === 'allowed' &&
      record.direction === direction &&
      record.runLabel === `${direction}-${sizeMiB}`);
    const bodyBytes = (record) => direction === 'push' ? record.requestBytes : record.responseBytes;
    candidates.sort((left, right) => bodyBytes(right) - bodyBytes(left));
    if (candidates[0]) allowed.push(candidates[0]);
  }
}

console.log('direction  input MiB  body MiB  RSS MiB  external MiB  arrays MiB  reqQ KiB  respQ KiB');
for (const record of allowed) {
  const bodyBytes = record.direction === 'push' ? record.requestBytes : record.responseBytes;
  console.log([
    record.direction.padEnd(9),
    String(record.sizeMiB).padStart(9),
    (bodyBytes / MiB).toFixed(2).padStart(9),
    (record.rssDeltaBytes / MiB).toFixed(2).padStart(7),
    (record.externalDeltaBytes / MiB).toFixed(2).padStart(12),
    (record.arrayBuffersDeltaBytes / MiB).toFixed(2).padStart(10),
    (record.maxRequestQueueBytes / 1024).toFixed(1).padStart(8),
    (record.maxResponseQueueBytes / 1024).toFixed(1).padStart(9),
  ].join('  '));
}

for (const direction of ['push', 'clone']) {
  const group = allowed.filter((record) => record.direction === direction)
    .sort((left, right) => left.sizeMiB - right.sizeMiB);
  if (group.length !== expectedSizes.length) {
    fail(`${direction}: expected ${expectedSizes.length} measurements, got ${group.length}`);
    continue;
  }
  if (group.some((record, index) => record.sizeMiB !== expectedSizes[index])) {
    fail(`${direction}: measurement sizes do not match ${expectedSizes.join(', ')}`);
  }

  const firstBody = direction === 'push' ? group[0].requestBytes : group[0].responseBytes;
  const lastBody = direction === 'push' ? group.at(-1).requestBytes : group.at(-1).responseBytes;
  if (lastBody < firstBody * 8) fail(`${direction}: body grew less than 8x`);

  for (const record of group) {
    if (record.rssDeltaBytes > memoryBudget) {
      fail(`${direction} ${record.sizeMiB} MiB: RSS delta exceeded ${memoryBudget / MiB} MiB`);
    }
    if (record.maxRequestQueueBytes > queueBudget || record.maxResponseQueueBytes > queueBudget) {
      fail(`${direction} ${record.sizeMiB} MiB: a stream queue exceeded ${queueBudget / MiB} MiB`);
    }
    if (direction === 'push' &&
        record.maxPolicyBufferedBytes > record.policyPrefixLimitBytes + 128 * 1024) {
      fail(`${direction} ${record.sizeMiB} MiB: policy buffer exceeded prefix + transport chunk allowance`);
    }
  }

  const previousDelta = group.at(-2).rssDeltaBytes;
  const lastDelta = group.at(-1).rssDeltaBytes;
  if (lastDelta > previousDelta + plateauTolerance) {
    fail(`${direction}: largest body added more than ${plateauTolerance / MiB} MiB over the prior RSS delta`);
  }
}

const rejected = stats.find(({ decision }) => decision === 'policy-rejected');
if (!rejected || rejected.rejectedRef !== 'refs/heads/protected') {
  fail('protected-ref control was not rejected at the proxy');
}
if (audits.length === 0 || audits.some(({ accepted }) => !accepted)) {
  fail('upstream saw a request without the replacement credential');
}
if (audits.some(({ clientCredentialLeaked }) => clientCredentialLeaked)) {
  fail('client credential leaked across the proxy/upstream boundary');
}

if (!process.exitCode) {
  console.log(`PASS: ${allowed.length} transfers stayed within a fixed ${memoryBudget / MiB} MiB RSS delta budget.`);
  console.log(`PASS: ${audits.length} upstream requests used only the replacement credential; protected ref stopped locally.`);
}
