'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PolicyInputError,
  inspectReceivePackPrefix,
  rejectedRef,
} = require('./policy');

const oldOid = '0'.repeat(40);
const newOid = '1'.repeat(40);

function pkt(payload) {
  const body = Buffer.from(payload);
  return Buffer.concat([
    Buffer.from((body.length + 4).toString(16).padStart(4, '0')),
    body,
  ]);
}

test('waits for a complete command prelude across arbitrary chunk boundaries', () => {
  const body = Buffer.concat([
    pkt(`${oldOid} ${newOid} refs/heads/main\0report-status\n`),
    Buffer.from('0000PACKpayload'),
  ]);

  for (let length = 0; length < body.indexOf('0000') + 4; length += 1) {
    assert.equal(inspectReceivePackPrefix(body.subarray(0, length)).complete, false);
  }

  const result = inspectReceivePackPrefix(body);
  assert.equal(result.complete, true);
  assert.equal(result.prefixBytes, body.indexOf('PACK'));
  assert.deepEqual(result.commands.map(({ ref }) => ref), ['refs/heads/main']);
});

test('identifies a protected ref without inspecting pack bytes', () => {
  const body = Buffer.concat([
    pkt(`${oldOid} ${newOid} refs/heads/protected/release\0report-status\n`),
    Buffer.from('0000PACKthis-must-not-be-parsed'),
  ]);
  const result = inspectReceivePackPrefix(body);

  assert.equal(rejectedRef(result.commands).ref, 'refs/heads/protected/release');
  assert.equal(result.prefixBytes, body.indexOf('PACK'));
});

test('fails closed on malformed framing', () => {
  assert.throws(
    () => inspectReceivePackPrefix(Buffer.from('zzzznot-a-pkt-line')),
    PolicyInputError,
  );
});
