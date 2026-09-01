'use strict';
// Decoder for git's "smart" transport framing, plus a streaming-friendly scanner
// for the receive-pack command section.
//
// The pkt-line/packfile decoders are copied verbatim from
// ../../tls-terminate-reencrypt/code/wire.js so this experiment reproduces
// standalone. NEW here is `scanReceivePackCommands`, which is what makes
// "front-of-stream ref policy without buffering the pack" possible: it reads the
// ref-update commands at the FRONT of a git-receive-pack body and tells you
// exactly where they end (the flush pkt) -- i.e. where the unbounded packfile
// begins -- so a proxy can decide policy from a bounded prefix and then stream
// the rest through untouched.
//
// A git-receive-pack request body looks like:
//
//   <pkt> <old-sha> <new-sha> <refname>\0<capabilities>\n   (first command)
//   <pkt> <old-sha> <new-sha> <refname>\n                   (further commands)
//   0000                                                    (flush = end of commands)
//   PACK........                                            (the packfile; UNBOUNDED)
//
// The commands are tiny and come first; the pack is huge and comes last. That
// ordering is the entire reason a proxy can police refs in O(1) memory.

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

// Parse one receive-pack command pkt-line payload: "<old> <new> <ref>[\0caps]".
function parseCommand(payload) {
  const nul = payload.indexOf(0);
  const cmdPart = (nul === -1 ? payload : payload.slice(0, nul)).toString('utf8').replace(/\n$/, '');
  const caps = nul === -1 ? '' : payload.slice(nul + 1).toString('utf8').replace(/\n$/, '');
  const parts = cmdPart.split(' ');
  const oldSha = parts[0];
  const newSha = parts[1];
  const ref = parts.slice(2).join(' ');
  const isDelete = /^0{40,64}$/.test(newSha || '');
  const isCreate = /^0{40,64}$/.test(oldSha || '');
  return { oldSha, newSha, ref, caps, isDelete, isCreate };
}

// Streaming scanner for the receive-pack command section.
//
// Feed it whatever bytes have arrived so far. It returns either:
//   { done: false }                        -- need more bytes; keep buffering
//   { done: true, commands, commandBytes,  -- full command section in hand;
//     sawFlush }                              `commandBytes` = where the pack starts
//
// Because it stops at the first flush pkt, `commandBytes` is bounded by the size
// of the command list (a few hundred bytes per ref), NOT by the packfile. A proxy
// can therefore run policy on `commands` and then forward everything from
// `commandBytes` onward as an opaque stream.
function scanReceivePackCommands(buf) {
  let off = 0;
  const commands = [];
  for (;;) {
    if (off + 4 > buf.length) return { done: false };
    const lenHex = buf.slice(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) {
      // Not a pkt-line length. Shouldn't occur before the flush in a well-formed
      // receive-pack; treat as the end of what we can police.
      return { done: true, commands, commandBytes: off, sawFlush: false };
    }
    const len = parseInt(lenHex, 16);
    if (len === 0) return { done: true, commands, commandBytes: off + 4, sawFlush: true }; // flush
    if (len < 4) { off += 4; continue; } // 0001 delim / 0002 (not expected here)
    if (off + len > buf.length) return { done: false };
    commands.push(parseCommand(buf.slice(off + 4, off + len)));
    off += len;
  }
}

module.exports = {
  decodePktLines, decodePackHeader, describeBody, hex,
  parseCommand, scanReceivePackCommands,
};
