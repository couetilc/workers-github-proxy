'use strict';
// Minimal decoder for git's "smart" transport framing.
// (Copied verbatim from ../../git-remote-domain-swap/code/wire.js so this
// experiment reproduces standalone. See that experiment for the origin.)
//
// Git frames its control messages as pkt-lines: a 4-char hex length prefix
// (the length INCLUDES the 4 prefix bytes) followed by that many bytes of
// payload. Special short packets: 0000 = flush, 0001 = delimiter (protocol v2),
// 0002 = response-end. After the control pkt-lines, a push/fetch body carries a
// raw packfile which begins with the ASCII bytes "PACK".

function hex(buf) {
  return buf.toString('hex');
}

// Walk a buffer, yielding a human-readable transcript of the pkt-lines it
// contains, and return where the pkt-line stream stopped (start of any trailing
// packfile).
function decodePktLines(buf) {
  const lines = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.slice(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) {
      lines.push(`  (offset ${off}: not a pkt-line length -> "${lenHex}", stopping)`);
      break;
    }
    const len = parseInt(lenHex, 16);
    if (len === 0) { lines.push('  0000  FLUSH'); off += 4; continue; }
    if (len === 1) { lines.push('  0001  DELIM'); off += 4; continue; }
    if (len === 2) { lines.push('  0002  RESPONSE-END'); off += 4; continue; }
    const payload = buf.slice(off + 4, off + len);
    // If a packfile follows immediately, the next 4 bytes will be "PACK",
    // which is not a valid hex length, so the guard above catches it.
    const text = payload.toString('utf8').replace(/\n$/, '');
    const printable = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(payload.toString('latin1'));
    lines.push(`  ${lenHex}  ${printable ? JSON.stringify(text) : '<' + payload.length + ' binary bytes> ' + hex(payload.slice(0, 24)) + '...'}`);
    off += len;
  }
  return { transcript: lines.join('\n'), rest: off };
}

// Decode the leading header of a git packfile: "PACK", 4-byte version,
// 4-byte object count (both big-endian).
function decodePackHeader(buf) {
  if (buf.length < 12 || buf.slice(0, 4).toString('ascii') !== 'PACK') return null;
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  return { version, count, trailerSha: buf.length >= 20 ? hex(buf.slice(-20)) : '(incomplete)' };
}

// Full body decode: pkt-lines up to where framing stops, then a packfile if any.
function describeBody(buf) {
  if (!buf || buf.length === 0) return '  (empty body)';
  const out = [];
  const { transcript, rest } = decodePktLines(buf);
  if (transcript) out.push(transcript);
  const tail = buf.slice(rest);
  const pack = decodePackHeader(tail);
  if (pack) {
    out.push(`  --- PACKFILE at offset ${rest}: version ${pack.version}, ${pack.count} object(s), ${tail.length} bytes, trailer-sha ${pack.trailerSha} ---`);
  } else if (tail.length > 0) {
    out.push(`  --- ${tail.length} trailing bytes (not a packfile): ${hex(tail.slice(0, 24))}... ---`);
  }
  return out.join('\n');
}

module.exports = { decodePktLines, decodePackHeader, describeBody, hex };
