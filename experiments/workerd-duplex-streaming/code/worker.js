import {
  PolicyInputError,
  concatChunks,
  inspectReceivePackPrefix,
  rejectedRef,
} from 'policy.js';

function log(event) {
  console.log(`EXPERIMENT ${JSON.stringify(event)}`);
}

function isReceivePack(pathname) {
  return pathname.endsWith('/git-receive-pack');
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

async function readPolicyPrelude(body, maximumBytes) {
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
    if (inspected.complete) return { reader, held, heldBytes, inspected };
    if (heldBytes > maximumBytes) {
      throw new PolicyInputError(
        `receive-pack command prelude exceeds ${maximumBytes} bytes`,
        413,
      );
    }
  }
}

function replayThenContinue(held, reader) {
  let heldIndex = 0;
  return new ReadableStream({
    async pull(controller) {
      if (heldIndex < held.length) {
        controller.enqueue(held[heldIndex]);
        heldIndex += 1;
        return;
      }
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function applyReceivePackPolicy(body, url, env) {
  if (!body) {
    return { response: new Response('receive-pack request has no body\n', { status: 400 }) };
  }
  const streamMode = env.REQUEST_STREAM_MODE;
  if (streamMode !== 'tee' && streamMode !== 'reconstruct') {
    throw new Error(`unsupported REQUEST_STREAM_MODE: ${streamMode}`);
  }

  let policyBody = body;
  let forwardBody;
  if (streamMode === 'tee') [policyBody, forwardBody] = body.tee();

  try {
    const prelude = await readPolicyPrelude(policyBody, Number(env.MAX_POLICY_PREFIX));
    const denied = rejectedRef(prelude.inspected.commands);
    log({
      event: denied ? 'policy-rejected' : 'policy-allowed',
      path: url.pathname,
      streamMode,
      heldBytes: prelude.heldBytes,
      prefixBytes: prelude.inspected.prefixBytes,
      commandCount: prelude.inspected.commands.length,
      rejectedRef: denied?.ref,
    });

    if (denied) {
      const cancellations = [prelude.reader.cancel('ref policy rejected request')];
      if (forwardBody) cancellations.push(forwardBody.cancel('ref policy rejected request'));
      await Promise.allSettled(cancellations);
      return {
        response: new Response(`ref policy rejects ${denied.ref}\n`, { status: 403 }),
      };
    }

    if (streamMode === 'reconstruct') {
      return { body: replayThenContinue(prelude.held, prelude.reader) };
    }
    prelude.reader.cancel('policy inspection complete').catch((error) => {
      log({ event: 'policy-cancel-error', error: error.message });
    });
    return { body: forwardBody };
  } catch (error) {
    if (forwardBody) {
      forwardBody.cancel('policy input rejected').catch(() => {});
    }
    const status = error instanceof PolicyInputError ? error.statusCode : 500;
    log({ event: 'policy-input-rejected', path: url.pathname, streamMode, error: error.message });
    return { response: new Response(`${error.message}\n`, { status }) };
  }
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.headers.get('authorization') !== env.CLIENT_AUTH) {
    return new Response('proxy authentication required\n', { status: 401 });
  }

  let body = request.body;
  if (isReceivePack(url.pathname)) {
    const policyResult = await applyReceivePackPolicy(body, url, env);
    if (policyResult.response) return policyResult.response;
    body = policyResult.body;
  }

  const upstreamUrl = new URL(request.url);
  upstreamUrl.protocol = 'http:';
  upstreamUrl.host = 'upstream.invalid';
  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders(request.headers, env.UPSTREAM_AUTH),
    body: request.method === 'GET' || request.method === 'HEAD' ? null : body,
    redirect: 'manual',
  });
  const upstreamResponse = await env.UPSTREAM.fetch(upstreamRequest);
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: upstreamResponse.headers,
  });
}

export default {
  fetch(request, env) {
    return handle(request, env).catch((error) => {
      log({ event: 'uncaught', error: error.message, stack: error.stack });
      return new Response('proxy internal error\n', { status: 500 });
    });
  },
};
