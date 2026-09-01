'use strict';

const assert = require('assert');
const fs = require('fs');

const [auditPath, workerdLog, gatewayLog, giteaLog] = process.argv.slice(2);
if (!auditPath || !workerdLog || !gatewayLog || !giteaLog) {
  throw new Error('usage: node assert-results.cjs <audit.jsonl> <workerd.log> <gateway.log> <gitea.log>');
}

const records = fs.readFileSync(auditPath, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
assert(records.length > 0, 'the audit gateway recorded no requests');

const byCase = (name) => records.filter((record) => record.experimentCase === name);
const hasPath = (caseName, method, suffix) => byCase(caseName).some((record) =>
  record.method === method && record.path.endsWith(suffix));
const invalidUpstreamCases = new Set(['upstream-auth-challenge', 'upstream-auth-failure']);

for (const record of records) {
  assert.strictEqual(record.clientCredentialLeaked, false,
    `client credential leaked in audit record ${record.sequence}`);
  assert.strictEqual(record.authorizationHeaderCount, 1,
    `expected one Authorization header in audit record ${record.sequence}`);
  if (!invalidUpstreamCases.has(record.experimentCase)) {
    assert.strictEqual(record.authorizationClass, 'upstream',
      `wrong credential class in audit record ${record.sequence}`);
  }
}

for (const caseName of ['missing-client-auth', 'invalid-client-auth']) {
  assert.strictEqual(byCase(caseName).length, 0,
    `${caseName} unexpectedly reached the audit gateway`);
}

for (const caseName of ['initial-push', 'incremental-push', 'feature-create', 'feature-delete']) {
  assert(hasPath(caseName, 'GET', 'info/refs?service=git-receive-pack'),
    `${caseName} did not perform receive-pack discovery`);
  assert(hasPath(caseName, 'POST', '/git-receive-pack'),
    `${caseName} did not perform receive-pack RPC`);
}

for (const version of [0, 2]) {
  const caseName = `clone-v${version}`;
  assert(hasPath(caseName, 'GET', 'info/refs?service=git-upload-pack'),
    `${caseName} did not perform upload-pack discovery`);
  assert(hasPath(caseName, 'POST', '/git-upload-pack'),
    `${caseName} did not perform upload-pack RPC`);
}

assert(byCase('clone-v2').some((record) => record.gitProtocol === 'version=2'),
  'the protocol-v2 request lost its Git-Protocol header');
assert(byCase('clone-v0').every((record) => record.gitProtocol !== 'version=2'),
  'the protocol-v0 control unexpectedly negotiated version 2');

const uploadPosts = records.filter((record) => record.method === 'POST' &&
  record.path.endsWith('/git-upload-pack'));
const receivePosts = records.filter((record) => record.method === 'POST' &&
  record.path.endsWith('/git-receive-pack'));
assert(uploadPosts.length > 0, 'no upload-pack RPC was audited');
assert(receivePosts.length > 0, 'no receive-pack RPC was audited');
for (const record of uploadPosts) {
  assert.strictEqual(record.requestContentType, 'application/x-git-upload-pack-request');
  assert.strictEqual(record.responseContentType, 'application/x-git-upload-pack-result');
  assert.strictEqual(record.responseStatus, 200);
  assert(record.requestBytes > 0 && record.responseBytes > 0,
    `empty upload-pack RPC in audit record ${record.sequence}`);
}
for (const record of receivePosts) {
  assert.strictEqual(record.requestContentType, 'application/x-git-receive-pack-request');
  assert.strictEqual(record.responseContentType, 'application/x-git-receive-pack-result');
  assert.strictEqual(record.responseStatus, 200);
  assert(record.requestBytes > 0 && record.responseBytes > 0,
    `empty receive-pack RPC in audit record ${record.sequence}`);
}

assert.strictEqual(byCase('protected-policy').filter((record) =>
  record.method === 'POST' && record.path.endsWith('/git-receive-pack')).length, 0,
'the locally protected ref reached Gitea receive-pack');

const rejected = byCase('gitea-rejected').filter((record) =>
  record.method === 'POST' && record.path.endsWith('/git-receive-pack'));
assert(rejected.length > 0, 'the Gitea rejection did not reach receive-pack');
assert(rejected.every((record) => record.responseStatus === 200 &&
  record.responseContentType === 'application/x-git-receive-pack-result'),
'the Gitea application-layer rejection was not preserved as a Git result');

const missing = byCase('missing-repository');
assert(missing.length > 0, 'the missing repository control did not reach Gitea');
assert(missing.some((record) => record.responseStatus >= 400),
  'Gitea unexpectedly returned success for a missing repository');

const upstreamFailure = records.filter((record) => invalidUpstreamCases.has(record.experimentCase));
assert(upstreamFailure.length > 0, 'the invalid upstream credential control was not audited');
assert(upstreamFailure.every((record) => record.authorizationClass === 'other'),
  'the upstream auth failure did not use the deliberately invalid replacement');
assert(upstreamFailure.some((record) => record.responseStatus >= 400),
  'Gitea unexpectedly accepted the invalid upstream credential');
assert(upstreamFailure.some((record) => record.responseAuthenticateScheme === 'Basic'),
  'Gitea Basic challenge was not preserved through the proxy');

assert(records.every((record) => record.responseLocation === null),
  'a canonical Git URL unexpectedly produced a redirect');

const forbiddenValues = [
  process.env.CLIENT_AUTH,
  process.env.UPSTREAM_AUTH,
  process.env.UPSTREAM_PASSWORD,
].filter(Boolean);
for (const path of [workerdLog, gatewayLog, giteaLog]) {
  const contents = fs.readFileSync(path, 'utf8');
  for (const value of forbiddenValues) {
    assert(!contents.includes(value), `${path} contains a credential value`);
  }
}

const statuses = [...new Set(records.map((record) => record.responseStatus))].sort();
console.log(`PASS: ${records.length} audited proxy-to-Gitea requests used separated credentials.`);
console.log('PASS: clone/fetch and push preserved smart-HTTP routes, content types, bodies, and v2 negotiation.');
console.log('PASS: local auth/ref denials stopped before Gitea; upstream Git and HTTP failures reached the client.');
console.log(`Observed upstream HTTP statuses: ${statuses.join(', ')}.`);
