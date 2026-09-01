import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PolicyInputError,
  concatChunks,
  inspectReceivePackPrefix,
  rejectedRef,
} from './policy.js';

const encoder = new TextEncoder();
const oldOid = '0'.repeat(40);
const newOid = '1'.repeat(40);

function pkt(payload) {
  const body = encoder.encode(payload);
  const prefix = encoder.encode((body.byteLength + 4).toString(16).padStart(4, '0'));
  return concatChunks([prefix, body], prefix.byteLength + body.byteLength);
}

test('parses a prelude without consuming pack bytes', () => {
  const command = pkt(`${oldOid} ${newOid} refs/heads/main\0report-status\n`);
  const body = concatChunks(
    [command, encoder.encode('0000PACKpayload')],
    command.byteLength + 15,
  );
  const result = inspectReceivePackPrefix(body);

  assert.equal(result.complete, true);
  assert.equal(result.prefixBytes, body.findIndex((_, index) =>
    new TextDecoder().decode(body.subarray(index, index + 4)) === 'PACK'));
  assert.deepEqual(result.commands.map(({ ref }) => ref), ['refs/heads/main']);
});

test('identifies protected refs and malformed framing', () => {
  const command = pkt(`${oldOid} ${newOid} refs/heads/protected\0report-status\n`);
  const body = concatChunks([command, encoder.encode('0000')], command.byteLength + 4);

  assert.equal(rejectedRef(inspectReceivePackPrefix(body).commands).ref, 'refs/heads/protected');
  assert.throws(() => inspectReceivePackPrefix(encoder.encode('zzzzbad')), PolicyInputError);
});
