const ZERO_OID = /^0+$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const decoder = new TextDecoder();

export class PolicyInputError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'PolicyInputError';
    this.statusCode = statusCode;
  }
}

export function concatChunks(chunks, byteLength) {
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export function inspectReceivePackPrefix(buffer) {
  const commands = [];
  let offset = 0;

  while (true) {
    if (offset + 4 > buffer.byteLength) return { complete: false, commands };

    const lengthText = decoder.decode(buffer.subarray(offset, offset + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) {
      throw new PolicyInputError(`invalid pkt-line length at byte ${offset}`);
    }

    const length = Number.parseInt(lengthText, 16);
    if (length === 0) {
      return { complete: true, commands, prefixBytes: offset + 4 };
    }
    if (length < 4) {
      throw new PolicyInputError(`unsupported pkt-line control ${lengthText}`);
    }
    if (offset + length > buffer.byteLength) return { complete: false, commands };

    const payload = decoder.decode(buffer.subarray(offset + 4, offset + length));
    const commandText = payload.replace(/\n$/, '').split('\0', 1)[0];
    const fields = commandText.split(' ');
    if (fields.length !== 3 || !OID.test(fields[0]) || !OID.test(fields[1]) ||
        !fields[2].startsWith('refs/')) {
      throw new PolicyInputError(`malformed receive-pack command at byte ${offset}`);
    }

    commands.push({
      oldOid: fields[0],
      newOid: fields[1],
      ref: fields[2],
      deletion: ZERO_OID.test(fields[1]),
    });
    offset += length;
  }
}

export function rejectedRef(commands) {
  return commands.find(({ ref }) =>
    ref === 'refs/heads/protected' || ref.startsWith('refs/heads/protected/'));
}
