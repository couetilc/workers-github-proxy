'use strict';

const assert = require('assert');
const fs = require('fs');

const [auditPath, reconciliationPath, statePath, memoryPath, workerdLogPath] =
  process.argv.slice(2);
if (!auditPath || !reconciliationPath || !statePath || !memoryPath || !workerdLogPath) {
  throw new Error('usage: node assert-results.cjs AUDIT RECONCILIATION STATES MEMORY WORKERD_LOG');
}

const MiB = 1024 * 1024;
const memoryBudget = Number(process.env.MEMORY_BUDGET_MIB || 24) * MiB;
const expectedSlowSizes = (process.env.SLOW_SIZES_MIB || '8 32').trim().split(/\s+/).map(Number)
  .sort((left, right) => left - right);

function records(path) {
  const contents = fs.readFileSync(path, 'utf8').trim();
  return contents ? contents.split('\n').filter(Boolean).map(JSON.parse) : [];
}

const audits = records(auditPath);
const reconciliations = records(reconciliationPath);
const states = records(statePath);
const memory = records(memoryPath);
const workerdLog = fs.readFileSync(workerdLogPath, 'utf8');
const events = workerdLog.split('\n')
  .filter((line) => line.startsWith('REPLICATION '))
  .map((line) => JSON.parse(line.slice('REPLICATION '.length)));

assert(audits.length > 0, 'fault gateways recorded no traffic');
assert(events.length > 0, 'workerd emitted no replication events');
assert(audits.every((record) => record.authorizationValid),
  'a gateway received missing or incorrect upstream authorization');

const receiveAudits = (caseName) => audits.filter((record) =>
  record.experimentCase === caseName && record.method === 'POST' &&
  record.path.endsWith('/git-receive-pack') && record.requestBytes !== 4);
const finalizeEvent = (caseName) => events.find((event) =>
  event.event === 'receive-pack-finalized' && event.experimentCase === caseName);
const state = (label) => states.find((record) => record.label === label);

for (const caseName of [
  'happy-initial',
  'happy-incremental',
  'happy-branch-create',
  'happy-branch-delete',
  'happy-fetch-update',
]) {
  const recordsForCase = receiveAudits(caseName);
  assert.strictEqual(recordsForCase.length, 2, `${caseName}: expected one write per replica`);
  const [a, b] = ['A', 'B'].map((replica) =>
    recordsForCase.find((record) => record.replica === replica));
  assert(a && b, `${caseName}: missing a replica audit`);
  assert.strictEqual(a.appliedFault, 'none');
  assert.strictEqual(b.appliedFault, 'none');
  assert.strictEqual(a.responseStatus, 200);
  assert.strictEqual(b.responseStatus, 200);
  assert(a.requestBytes > 0 && a.requestBytes === b.requestBytes,
    `${caseName}: replicas did not consume the same nonempty request`);
  assert.strictEqual(a.requestSha256, b.requestSha256,
    `${caseName}: replica request hashes differ`);
  assert.strictEqual(finalizeEvent(caseName)?.finalStatesMatch, true,
    `${caseName}: Worker did not verify convergence`);
}

const roundRobinCases = [
  'round-robin-clone-1',
  'round-robin-clone-2',
  'round-robin-fetch-1',
  'round-robin-fetch-2',
];
assert.deepStrictEqual(roundRobinCases.map((caseName) => {
  const replicas = new Set(audits.filter((record) =>
    record.experimentCase === caseName &&
    (record.path.endsWith('/git-upload-pack') ||
      record.path.includes('/info/refs?service=git-upload-pack')))
    .map((record) => record.replica));
  assert.strictEqual(replicas.size, 1, `${caseName}: one read session crossed replicas`);
  return [...replicas][0];
}), ['A', 'B', 'A', 'B'], 'clone/fetch sessions did not alternate replicas');

const partialCases = [
  'partial-http-401',
  'partial-http-404',
  'partial-git-rejection',
  'partial-disconnect',
  'divergent-advertisements',
];
for (const caseName of partialCases) {
  assert.strictEqual(finalizeEvent(caseName)?.finalStatesMatch, false,
    `${caseName}: partial write was not classified as divergence`);
  const measured = state(caseName);
  assert(measured, `${caseName}: repository state was not measured`);
  assert.notDeepStrictEqual(measured.replicas.A.refs, measured.replicas.B.refs,
    `${caseName}: expected deliberately different refs`);
  assert.strictEqual(measured.clientResult, 'failure');
  const journaled = reconciliations.find((record) =>
    record.stage === 'final' && record.experimentCase === caseName);
  assert(journaled, `${caseName}: missing durable final-state reconciliation record`);
  assert.strictEqual(journaled.finalStatesMatch, false);
  assert.strictEqual(journaled.reconciliation, 'required');
}

const expectedFaults = {
  'partial-http-401': { fault: 'http-401', status: 401 },
  'partial-http-404': { fault: 'http-404', status: 404 },
  'partial-git-rejection': { fault: 'reject', status: 200 },
};
for (const [caseName, expected] of Object.entries(expectedFaults)) {
  const b = receiveAudits(caseName).find((record) => record.replica === 'B');
  assert(b, `${caseName}: replica B audit missing`);
  assert.strictEqual(b.appliedFault, expected.fault);
  assert.strictEqual(b.responseStatus, expected.status);
  const a = receiveAudits(caseName).find((record) => record.replica === 'A');
  assert.strictEqual(a?.responseStatus, 200,
    `${caseName}: surviving replica A did not finish successfully`);
}
assert.strictEqual(
  finalizeEvent('partial-git-rejection').outcomes.B.report.rejected,
  true,
  'the HTTP-200 Git-layer rejection was not parsed',
);

const disconnectAudits = receiveAudits('partial-disconnect');
const disconnectedB = disconnectAudits.find((record) => record.replica === 'B');
const survivingA = disconnectAudits.find((record) => record.replica === 'A');
assert(disconnectedB?.disconnectedMidPack, 'replica B did not disconnect mid-pack');
assert(disconnectedB.requestBytes >= 1024 * 1024, 'disconnect happened before a substantial prefix');
assert.strictEqual(survivingA?.responseStatus, 200,
  'replica B cancellation harmed the surviving replica A request');
assert(survivingA.requestBytes > disconnectedB.requestBytes * 1.5,
  'the surviving replica did not consume substantially more than the disconnected replica');

const recoveryCases = [
  'recovery-http-401',
  'recovery-http-404',
  'recovery-git-rejection',
  'recovery-disconnect',
  'recovery-already-desired',
];
for (const caseName of recoveryCases) {
  const event = finalizeEvent(caseName);
  assert.strictEqual(event?.finalStatesMatch, true, `${caseName}: retry did not converge`);
  assert.strictEqual(event.outcomes.A.report?.success, false,
    `${caseName}: already-updated A should reject the lagging old OID`);
  assert.strictEqual(event.outcomes.B.report?.success, true,
    `${caseName}: lagging B should accept the compensating update`);
}
for (const label of ['recovery-http-401', 'recovery-already-desired']) {
  const measured = state(label);
  assert(measured, `${label}: recovered repository state was not measured`);
  assert.deepStrictEqual(measured.replicas.A.refs, measured.replicas.B.refs,
    `${label}: refs did not converge`);
  assert.strictEqual(measured.replicas.A.reachableObjectCount,
    measured.replicas.B.reachableObjectCount, `${label}: reachable object counts differ`);
}

const advertisementDivergence = events.find((event) =>
  event.event === 'advertisement-compared' &&
  event.experimentCase === 'divergent-advertisements');
assert.strictEqual(advertisementDivergence?.equal, false,
  'pre-existing divergent advertisements were not recognized');
assert(reconciliations.some((record) =>
  record.stage === 'advertisement' &&
  record.experimentCase === 'divergent-advertisements'),
'pre-existing advertised divergence was not journaled');

assert.strictEqual(new Set(reconciliations.map((record) => record.id)).size,
  reconciliations.length, 'reconciliation IDs are not unique');

assert.strictEqual(memory.length, expectedSlowSizes.length,
  'unexpected number of slow-consumer memory measurements');
const sortedMemory = [...memory].sort((left, right) => left.sizeMiB - right.sizeMiB);
assert.deepStrictEqual(sortedMemory.map((record) => record.sizeMiB), expectedSlowSizes);
for (const record of sortedMemory) {
  assert(record.rssDeltaBytes <= memoryBudget,
    `${record.runLabel}: RSS delta exceeded ${memoryBudget / MiB} MiB`);
  assert(record.samples >= 5, `${record.runLabel}: too few RSS samples`);
  const caseName = record.runLabel;
  const [a, b] = ['A', 'B'].map((replica) =>
    receiveAudits(caseName).find((audit) => audit.replica === replica));
  assert(a && b, `${caseName}: missing slow-consumer audits`);
  assert(a.requestBytes >= record.sizeMiB * MiB * 0.9,
    `${caseName}: request did not contain the expected pack-sized body`);
  assert.strictEqual(a.requestBytes, b.requestBytes);
  assert.strictEqual(a.requestSha256, b.requestSha256);
  assert(b.durationMs >= 100, `${caseName}: replica B was not substantially slow`);
  assert(a.durationMs >= 100, `${caseName}: replica A saw no request-path backpressure`);
  assert(b.durationMs >= a.durationMs * 1.5,
    `${caseName}: injected replica B was not substantially slower than A`);
  assert(record.elapsedMs >= b.durationMs * 0.8,
    `${caseName}: client completed without waiting for the slow replica`);
  const event = finalizeEvent(caseName);
  assert.strictEqual(event?.finalStatesMatch, true);
  assert(event.fanout.maxChunkBytes <= MiB,
    `${caseName}: distributor retained an unexpectedly large source chunk`);
  assert(event.fanout.sourceBytes >= record.sizeMiB * MiB * 0.9,
    `${caseName}: distributor byte count was not pack-sized`);
}
if (sortedMemory.length > 1) {
  assert(sortedMemory.at(-1).rssDeltaBytes <= sortedMemory[0].rssDeltaBytes + 8 * MiB,
    'largest slow push grew RSS by more than the plateau tolerance');
}

console.log(`PASS: ${audits.length} gateway audits prove happy pushes reached both replicas byte-for-byte.`);
console.log('PASS: clone/fetch sessions alternated A/B and the shell harness verified equivalent results.');
console.log(`PASS: ${partialCases.length} partial-write cases failed visibly and were durably journaled.`);
console.log('PASS: compensating retries converged even when already-updated A rejected the retry old OID.');
console.log(`PASS: ${memory.length} slow dual writes stayed within a ${memoryBudget / MiB} MiB RSS-delta budget.`);
