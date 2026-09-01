import {
  boundedFanout,
  failedReceivePackBody,
  parseAdvertisement,
  readBoundedBody,
  receivePackReport,
  refsEqual,
  requestedStateMatches,
  successfulReceivePackBody,
} from 'replication-core.js';
import {
  PolicyInputError,
  concatChunks,
  inspectReceivePackPrefix,
} from 'policy.js';

const readAssignments = new Map();
let nextReadReplica = 0;

function log(event) {
  console.log(`REPLICATION ${JSON.stringify(event)}`);
}

function experimentCase(request) {
  return request.headers.get('x-experiment-case') || 'unlabeled';
}

function isReceivePack(pathname) {
  return pathname.endsWith('/git-receive-pack');
}

function isReceiveDiscovery(url) {
  return url.pathname.endsWith('/info/refs') &&
    url.searchParams.get('service') === 'git-receive-pack';
}

function isUploadPack(pathname) {
  return pathname.endsWith('/git-upload-pack');
}

function isUploadDiscovery(url) {
  return url.pathname.endsWith('/info/refs') &&
    url.searchParams.get('service') === 'git-upload-pack';
}

function upstreamHeaders(requestHeaders, upstreamAuth) {
  const headers = new Headers(requestHeaders);
  headers.set('authorization', upstreamAuth);
  for (const name of [
    'host', 'connection', 'proxy-connection', 'expect', 'content-length',
    'transfer-encoding', 'te', 'trailer', 'upgrade',
  ]) headers.delete(name);
  return headers;
}

function upstreamRequest(request, body, upstreamAuth) {
  const url = new URL(request.url);
  url.protocol = 'http:';
  url.host = 'replica.invalid';
  return new Request(url, {
    method: request.method,
    headers: upstreamHeaders(request.headers, upstreamAuth),
    body: request.method === 'GET' || request.method === 'HEAD' ? null : body,
    redirect: 'manual',
  });
}

function responseFromBuffered(outcome, extraHeaders = {}) {
  const headers = new Headers(outcome.headers);
  headers.delete('content-length');
  headers.delete('connection');
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(outcome.body, {
    status: outcome.status,
    statusText: outcome.statusText,
    headers,
  });
}

async function bufferedFetch(binding, request, body, upstreamAuth, maximumBytes) {
  try {
    const response = await binding.fetch(upstreamRequest(request, body, upstreamAuth));
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      contentType: response.headers.get('content-type'),
      body: await readBoundedBody(response, maximumBytes),
    };
  } catch (error) {
    return { error: error.message, body: new Uint8Array() };
  }
}

async function recordReconciliation(env, record) {
  try {
    const response = await env.RECONCILIATION.fetch(new Request('http://recorder.invalid/records', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    }));
    if (response.status !== 201) throw new Error(`recorder returned HTTP ${response.status}`);
    return true;
  } catch (error) {
    log({ event: 'reconciliation-record-failed', id: record.id, error: error.message });
    return false;
  }
}

function compactOutcome(outcome) {
  return {
    status: outcome.status ?? null,
    contentType: outcome.contentType ?? null,
    responseBytes: outcome.body?.byteLength ?? 0,
    report: outcome.report ?? null,
    error: outcome.error ?? null,
  };
}

async function readReceivePackPrelude(body, maximumBytes) {
  if (!body) throw new PolicyInputError('receive-pack request has no body');
  const reader = body.getReader();
  const held = [];
  let heldBytes = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new PolicyInputError('receive-pack body ended before command flush');
    held.push(value);
    heldBytes += value.byteLength;
    const inspected = inspectReceivePackPrefix(concatChunks(held, heldBytes));
    if (inspected.complete) {
      let heldIndex = 0;
      const replay = new ReadableStream({
        async pull(controller) {
          if (heldIndex < held.length) {
            controller.enqueue(held[heldIndex]);
            heldIndex += 1;
            return;
          }
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      }, { highWaterMark: 0 });
      return { commands: inspected.commands, heldBytes, body: replay };
    }
    if (heldBytes > maximumBytes) {
      await reader.cancel('receive-pack command prelude is too large').catch(() => {});
      throw new PolicyInputError(`receive-pack command prelude exceeds ${maximumBytes} bytes`, 413);
    }
  }
}

function selectedWriteReplica(request) {
  return request.headers.get('x-write-advertisement')?.toUpperCase() === 'B' ? 'B' : 'A';
}

async function handleReceiveDiscovery(request, env) {
  const [a, b] = await Promise.all([
    bufferedFetch(env.REPLICA_A, request, null, env.UPSTREAM_AUTH, 1024 * 1024),
    bufferedFetch(env.REPLICA_B, request, null, env.UPSTREAM_AUTH, 1024 * 1024),
  ]);
  const selected = selectedWriteReplica(request);
  const selectedOutcome = selected === 'A' ? a : b;
  if (selectedOutcome.error) throw new Error(`selected replica ${selected}: ${selectedOutcome.error}`);

  const refsA = a.status === 200 ? parseAdvertisement(a.body) : null;
  const refsB = b.status === 200 ? parseAdvertisement(b.body) : null;
  const equal = refsA !== null && refsB !== null && refsEqual(refsA, refsB);
  log({
    event: 'advertisement-compared',
    experimentCase: experimentCase(request),
    selected,
    equal,
    statusA: a.status ?? null,
    statusB: b.status ?? null,
    refsA,
    refsB,
  });
  if (!equal) {
    const id = crypto.randomUUID();
    await recordReconciliation(env, {
      version: 1,
      id,
      recordedAt: new Date().toISOString(),
      stage: 'advertisement',
      reason: 'advertised-refs-diverge',
      experimentCase: experimentCase(request),
      path: new URL(request.url).pathname,
      selectedReplica: selected,
      requestedUpdates: [],
      finalStatesMatch: false,
      replicas: {
        A: { status: a.status ?? null, refs: refsA, error: a.error ?? null },
        B: { status: b.status ?? null, refs: refsB, error: b.error ?? null },
      },
      reconciliation: 'required',
    });
  }
  return responseFromBuffered(selectedOutcome, {
    'x-write-advertisement-replica': selected,
    'x-advertisements-equal': String(equal),
  });
}

async function verifyRefs(binding, request, upstreamAuth) {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/\/git-receive-pack$/, '/info/refs');
  url.search = '?service=git-receive-pack';
  const verificationRequest = new Request(url, {
    method: 'GET',
    headers: upstreamHeaders(request.headers, upstreamAuth),
    redirect: 'manual',
  });
  const outcome = await bufferedFetch(binding, verificationRequest, null, upstreamAuth, 1024 * 1024);
  if (outcome.error || outcome.status !== 200) {
    return { refs: null, status: outcome.status ?? null, error: outcome.error ?? null };
  }
  return { refs: parseAdvertisement(outcome.body), status: outcome.status, error: null };
}

async function actionOutcome(binding, request, body, upstreamAuth, commands) {
  const outcome = await bufferedFetch(binding, request, body, upstreamAuth, 1024 * 1024);
  if (!outcome.error && outcome.status === 200) {
    outcome.report = receivePackReport(outcome.body, commands);
  }
  return outcome;
}

async function handleReceivePack(request, env) {
  const prelude = await readReceivePackPrelude(request.body, Number(env.MAX_COMMAND_PREFIX));
  // Git sends an empty `0000` receive-pack probe before large chunked RPCs so
  // it can discover HTTP/auth failures before producing the pack. It is not a
  // ref transaction and gives a coupled fan-out no commands to verify. Answer
  // it through A; the following command-bearing RPC is the replicated push.
  if (prelude.commands.length === 0) {
    const probe = await bufferedFetch(
      env.REPLICA_A,
      request,
      prelude.body,
      env.UPSTREAM_AUTH,
      1024 * 1024,
    );
    if (probe.error) throw new Error(`receive-pack probe failed: ${probe.error}`);
    log({
      event: 'receive-pack-probe',
      experimentCase: experimentCase(request),
      heldBytes: prelude.heldBytes,
      replica: 'A',
      status: probe.status,
    });
    return responseFromBuffered(probe, { 'x-replication-probe-replica': 'A' });
  }
  const fanout = boundedFanout(prelude.body, 2);
  const [a, b] = await Promise.all([
    actionOutcome(env.REPLICA_A, request, fanout.streams[0], env.UPSTREAM_AUTH, prelude.commands),
    actionOutcome(env.REPLICA_B, request, fanout.streams[1], env.UPSTREAM_AUTH, prelude.commands),
  ]);
  const [verifyA, verifyB] = await Promise.all([
    verifyRefs(env.VERIFY_A, request, env.UPSTREAM_AUTH),
    verifyRefs(env.VERIFY_B, request, env.UPSTREAM_AUTH),
  ]);
  const finalStatesMatch = verifyA.refs !== null && verifyB.refs !== null &&
    requestedStateMatches(prelude.commands, [verifyA.refs, verifyB.refs]);
  const event = {
    event: 'receive-pack-finalized',
    experimentCase: experimentCase(request),
    commands: prelude.commands,
    heldBytes: prelude.heldBytes,
    fanout: fanout.stats,
    outcomes: { A: compactOutcome(a), B: compactOutcome(b) },
    verification: { A: verifyA, B: verifyB },
    finalStatesMatch,
  };
  log(event);

  if (finalStatesMatch) {
    const accepted = [a, b].find((outcome) => outcome.report?.success);
    if (accepted) {
      return responseFromBuffered(accepted, { 'x-replication-state': 'converged' });
    }
    return new Response(successfulReceivePackBody(prelude.commands), {
      status: 200,
      headers: {
        'content-type': 'application/x-git-receive-pack-result',
        'x-replication-state': 'converged',
        'x-replication-result': 'synthesized-from-final-state',
      },
    });
  }

  const id = crypto.randomUUID();
  const recorded = await recordReconciliation(env, {
    version: 1,
    id,
    recordedAt: new Date().toISOString(),
    stage: 'final',
    reason: 'requested-final-state-mismatch',
    experimentCase: experimentCase(request),
    path: new URL(request.url).pathname,
    requestedUpdates: prelude.commands,
    upstreamOutcomes: { A: compactOutcome(a), B: compactOutcome(b) },
    finalStatesMatch: false,
    replicas: { A: verifyA, B: verifyB },
    reconciliation: 'required',
  });
  return new Response(failedReceivePackBody(prelude.commands, id), {
    status: 200,
    headers: {
      'content-type': 'application/x-git-receive-pack-result',
      'x-replication-state': 'divergent',
      'x-reconciliation-id': id,
      'x-reconciliation-recorded': String(recorded),
    },
  });
}

function readReplica(request) {
  const key = experimentCase(request);
  if (!readAssignments.has(key)) {
    readAssignments.set(key, nextReadReplica === 0 ? 'A' : 'B');
    nextReadReplica = (nextReadReplica + 1) % 2;
  }
  return readAssignments.get(key);
}

async function passThrough(request, binding, env, replica) {
  const response = await binding.fetch(upstreamRequest(request, request.body, env.UPSTREAM_AUTH));
  const headers = new Headers(response.headers);
  headers.set('x-read-replica', replica);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handle(request, env) {
  if (request.headers.get('authorization') !== env.CLIENT_AUTH) {
    return new Response('proxy authentication required\n', { status: 401 });
  }
  const url = new URL(request.url);
  if (isReceiveDiscovery(url)) return handleReceiveDiscovery(request, env);
  if (isReceivePack(url.pathname)) return handleReceivePack(request, env);
  if (isUploadDiscovery(url) || isUploadPack(url.pathname)) {
    const replica = readReplica(request);
    return passThrough(request, replica === 'A' ? env.REPLICA_A : env.REPLICA_B, env, replica);
  }
  return passThrough(request, env.REPLICA_A, env, 'A');
}

export default {
  fetch(request, env) {
    return handle(request, env).catch((error) => {
      const status = error instanceof PolicyInputError ? error.statusCode : 500;
      log({ event: 'uncaught', experimentCase: experimentCase(request), error: error.message });
      return new Response(`replication proxy error: ${error.message}\n`, { status });
    });
  },
};
