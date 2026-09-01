import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundedFanout,
  concatBytes,
  failedReceivePackBody,
  parseAdvertisement,
  pktLine,
  receivePackReport,
  refsEqual,
  requestedStateMatches,
  successfulReceivePackBody,
} from './replication-core.js';

const oidA = 'a'.repeat(40);
const oidB = 'b'.repeat(40);
const zero = '0'.repeat(40);

test('advertisements parse refs and ignore service and peeled lines', () => {
  const bytes = concatBytes([
    pktLine('# service=git-receive-pack\n'),
    new TextEncoder().encode('0000'),
    pktLine(`${oidA} refs/heads/main\0report-status\n`),
    pktLine(`${oidB} refs/tags/v1^{}\n`),
    new TextEncoder().encode('0000'),
  ]);
  assert.deepEqual(parseAdvertisement(bytes), { 'refs/heads/main': oidA });
});

test('requested state treats matching updates and absent deletions as converged', () => {
  const commands = [
    { oldOid: oidA, newOid: oidB, ref: 'refs/heads/main', deletion: false },
    { oldOid: oidA, newOid: zero, ref: 'refs/heads/gone', deletion: true },
  ];
  assert.equal(requestedStateMatches(commands, [
    { 'refs/heads/main': oidB },
    { 'refs/heads/main': oidB },
  ]), true);
  assert.equal(requestedStateMatches(commands, [
    { 'refs/heads/main': oidB },
    { 'refs/heads/main': oidA },
  ]), false);
  assert.equal(refsEqual({ b: oidB, a: oidA }, { a: oidA, b: oidB }), true);
});

test('synthesized receive-pack reports classify success and failure', () => {
  const commands = [{ ref: 'refs/heads/main' }];
  const successBody = successfulReceivePackBody(commands);
  assert.equal(successBody[4], 1, 'the report must use sideband channel one');
  assert.equal(receivePackReport(successBody, commands).success, true);
  const failureBody = failedReceivePackBody(commands, 'record-1');
  assert.equal(failureBody[4], 1, 'the failure must use sideband channel one');
  const failure = receivePackReport(failureBody, commands);
  assert.equal(failure.success, false);
  assert.equal(failure.unpackOk, true);
  assert.equal(failure.rejected, true);
});

test('bounded fan-out waits for both consumers and detaches cancellation', async () => {
  let pulls = 0;
  const source = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls <= 3) controller.enqueue(Uint8Array.of(pulls));
      else controller.close();
    },
  }, { highWaterMark: 0 });
  const fanout = boundedFanout(source);
  const fast = fanout.streams[0].getReader();
  const slow = fanout.streams[1].getReader();

  const fastFirst = fast.read();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pulls, 0, 'the source must wait until both consumers pull');
  const slowFirst = slow.read();
  assert.deepEqual(await fastFirst, { value: Uint8Array.of(1), done: false });
  assert.deepEqual(await slowFirst, { value: Uint8Array.of(1), done: false });

  await slow.cancel('test cancellation');
  const remaining = [];
  while (true) {
    const { value, done } = await fast.read();
    if (done) break;
    remaining.push(value[0]);
  }
  assert.deepEqual(remaining, [2, 3]);
  assert.equal((await fanout.completion).canceledBranches, 1);
});
