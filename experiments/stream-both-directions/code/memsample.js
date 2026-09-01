'use strict';
// The experiment's measuring instrument.
//
// The whole claim -- "proxy memory stays flat as the pack grows" -- is a number
// this module produces. It polls process.memoryUsage() on a fast interval and
// keeps the process-lifetime PEAK of the quantities that matter:
//
//   rss          resident set size: total memory the OS says the process holds.
//   arrayBuffers bytes backing Node Buffers/ArrayBuffers -- i.e. exactly the git
//                bytes a proxy would hold if it buffered the pack. This is the
//                cleanest signal: a buffering proxy's Buffer.concat lives here and
//                grows with the pack; a streaming proxy never accumulates, so it
//                stays near zero.
//   external     all off-heap memory (a superset of arrayBuffers).
//   heapUsed     V8 heap (JS objects); should be tiny/flat either way.
//
// Each proxy runs one git operation per process lifetime (run.sh starts a fresh
// proxy per measurement), so the lifetime peak IS that operation's peak, measured
// against a clean baseline -- no residual-RSS confounds from a previous transfer.
//
// On SIGTERM (how run.sh stops it) the proxy prints `mem.line()`, which run.sh
// greps for the PEAK numbers.

function startMemSampler(intervalMs) {
  const iv = intervalMs || 10;
  const peak = { rss: 0, arrayBuffers: 0, external: 0, heapUsed: 0 };
  const sample = () => {
    const m = process.memoryUsage();
    if (m.rss > peak.rss) peak.rss = m.rss;
    if (m.arrayBuffers > peak.arrayBuffers) peak.arrayBuffers = m.arrayBuffers;
    if (m.external > peak.external) peak.external = m.external;
    if (m.heapUsed > peak.heapUsed) peak.heapUsed = m.heapUsed;
  };
  sample();
  const t = setInterval(sample, iv);
  if (t.unref) t.unref(); // don't keep the process alive just for sampling

  const mb = (b) => (b / (1024 * 1024)).toFixed(1);
  const api = {
    sample,
    peak,
    line() {
      return `PEAK rss=${mb(peak.rss)}MB arrayBuffers=${mb(peak.arrayBuffers)}MB ` +
             `external=${mb(peak.external)}MB heapUsed=${mb(peak.heapUsed)}MB`;
    },
  };

  // Print the peak on the way out so the harness can read it deterministically.
  const dump = () => { try { console.log(api.line()); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGTERM', dump);
  process.on('SIGINT', dump);
  return api;
}

module.exports = { startMemSampler };
