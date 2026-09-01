import proxy from 'base-worker.js';

let isolateId;

export default {
  fetch(request, env, context) {
    isolateId ||= crypto.randomUUID();
    console.log(`EXPERIMENT_ENVELOPE ${JSON.stringify({
      event: 'request',
      case: request.headers.get('x-experiment-case') || 'unlabeled',
      isolateId,
    })}`);
    return proxy.fetch(request, env, context);
  },
};
