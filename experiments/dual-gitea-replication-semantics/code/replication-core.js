const decoder = new TextDecoder();
const encoder = new TextEncoder();
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function pktLine(payload) {
  const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const length = bytes.byteLength + 4;
  if (length > 0xffff) throw new Error('pkt-line payload is too large');
  const prefix = encoder.encode(length.toString(16).padStart(4, '0'));
  const packet = new Uint8Array(length);
  packet.set(prefix);
  packet.set(bytes, 4);
  return packet;
}

export function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function parsePktLines(bytes) {
  const payloads = [];
  let offset = 0;
  while (offset + 4 <= bytes.byteLength) {
    const prefix = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(prefix)) break;
    const length = Number.parseInt(prefix, 16);
    offset += 4;
    if (length === 0 || length === 1 || length === 2) continue;
    if (length < 4 || offset + length - 4 > bytes.byteLength) break;
    payloads.push(bytes.subarray(offset, offset + length - 4));
    offset += length - 4;
  }
  return payloads;
}

export function parseAdvertisement(bytes) {
  const refs = {};
  for (const payload of parsePktLines(bytes)) {
    const line = decoder.decode(payload).replace(/\n$/, '').split('\0', 1)[0];
    const separator = line.indexOf(' ');
    if (separator === -1) continue;
    const oid = line.slice(0, separator);
    const ref = line.slice(separator + 1);
    if (OID.test(oid) && ref.startsWith('refs/') && !ref.endsWith('^{}')) refs[ref] = oid;
  }
  return refs;
}

export function refsEqual(left, right) {
  const leftEntries = Object.entries(left).sort();
  const rightEntries = Object.entries(right).sort();
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

export function requestedStateMatches(commands, refsByReplica) {
  return commands.every((command) => refsByReplica.every((refs) => {
    const actual = refs[command.ref];
    return command.deletion ? actual === undefined : actual === command.newOid;
  }));
}

export function receivePackReport(bytes, commands) {
  const text = decoder.decode(bytes);
  const unpackOk = text.includes('unpack ok\n');
  const rejected = text.includes('\nng ') || text.includes('ng refs/');
  const acceptedRefs = commands.filter((command) =>
    text.includes(`ok ${command.ref}\n`)).map((command) => command.ref);
  return {
    success: unpackOk && !rejected && acceptedRefs.length === commands.length,
    unpackOk,
    rejected,
    acceptedRefs,
  };
}

export function successfulReceivePackBody(commands) {
  const report = [pktLine('unpack ok\n')];
  for (const command of commands) report.push(pktLine(`ok ${command.ref}\n`));
  report.push(encoder.encode('0000'));
  return sidebandReport(report);
}

export function failedReceivePackBody(commands, reconciliationId) {
  const report = [pktLine('unpack ok\n')];
  for (const command of commands) {
    report.push(pktLine(
      `ng ${command.ref} replication incomplete; reconciliation ${reconciliationId}\n`,
    ));
  }
  report.push(encoder.encode('0000'));
  return sidebandReport(report);
}

function sidebandReport(reportChunks) {
  const report = concatBytes(reportChunks);
  const channelOne = new Uint8Array(report.byteLength + 1);
  channelOne[0] = 1;
  channelOne.set(report, 1);
  return concatBytes([pktLine(channelOne), encoder.encode('0000')]);
}

// Unlike ReadableStream.tee(), the source advances only after every active
// branch has pulled. A canceled branch detaches and cannot cancel its survivor.
export function boundedFanout(source, branchCount = 2) {
  if (!source || branchCount < 1) throw new Error('a source and at least one branch are required');
  const reader = source.getReader();
  const branches = Array.from({ length: branchCount }, () => ({
    controller: null,
    ready: false,
    canceled: false,
  }));
  const stats = {
    sourceBytes: 0,
    sourceChunks: 0,
    maxChunkBytes: 0,
    canceledBranches: 0,
  };
  let reading = false;
  let finished = false;
  let resolveFinished;
  const completion = new Promise((resolve) => { resolveFinished = resolve; });

  async function pump() {
    if (reading || finished) return;
    const active = branches.filter((branch) => !branch.canceled);
    if (active.length === 0) {
      finished = true;
      await reader.cancel('all fan-out branches canceled').catch(() => {});
      resolveFinished(stats);
      return;
    }
    if (!active.every((branch) => branch.ready)) return;
    for (const branch of active) branch.ready = false;
    reading = true;
    try {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        for (const branch of active) branch.controller.close();
        resolveFinished(stats);
        return;
      }
      stats.sourceBytes += value.byteLength;
      stats.sourceChunks += 1;
      stats.maxChunkBytes = Math.max(stats.maxChunkBytes, value.byteLength);
      for (const branch of active) branch.controller.enqueue(value);
    } catch (error) {
      finished = true;
      for (const branch of active) branch.controller.error(error);
      resolveFinished({ ...stats, sourceError: error.message });
    } finally {
      reading = false;
    }
    queueMicrotask(pump);
  }

  const streams = branches.map((branch) => new ReadableStream({
    start(controller) {
      branch.controller = controller;
    },
    pull() {
      branch.ready = true;
      return pump();
    },
    cancel() {
      if (!branch.canceled) {
        branch.canceled = true;
        stats.canceledBranches += 1;
      }
      return pump();
    },
  }, { highWaterMark: 0 }));

  return { streams, stats, completion };
}

export async function readBoundedBody(response, maximumBytes = 1024 * 1024) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return concatBytes(chunks);
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel('response exceeds experiment result limit').catch(() => {});
      throw new Error(`upstream result exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
}
