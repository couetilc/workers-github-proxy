'use strict';

const { Transform } = require('stream');

class RateThrottle extends Transform {
  constructor(bytesPerSecond) {
    super();
    this.bytesPerSecond = bytesPerSecond;
    this.releaseAt = 0;
  }

  _transform(chunk, encoding, callback) {
    if (!this.bytesPerSecond) {
      callback(null, chunk);
      return;
    }

    const now = Date.now();
    this.releaseAt = Math.max(now, this.releaseAt) +
      (chunk.length / this.bytesPerSecond) * 1000;
    const delay = Math.max(0, Math.ceil(this.releaseAt - now));
    setTimeout(() => callback(null, chunk), delay);
  }
}

module.exports = { RateThrottle };
