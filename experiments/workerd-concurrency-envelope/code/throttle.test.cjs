'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { RateThrottle } = require('./throttle.cjs');

test('passes bytes unchanged', async () => {
  const chunks = [];
  const throttle = new RateThrottle(1024 * 1024);
  throttle.on('data', (chunk) => chunks.push(chunk));
  await pipeline(Readable.from([Buffer.from('one'), Buffer.from('two')]), throttle);
  assert.equal(Buffer.concat(chunks).toString(), 'onetwo');
});

test('applies an approximate byte rate', async () => {
  const started = Date.now();
  await pipeline(
    Readable.from([Buffer.alloc(20 * 1024)]),
    new RateThrottle(100 * 1024),
    async function consume(source) {
      for await (const _chunk of source) { /* drain */ }
    },
  );
  assert.ok(Date.now() - started >= 170);
});
