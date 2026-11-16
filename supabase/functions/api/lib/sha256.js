// SHA-256 and HMAC-SHA256, synchronous and in plain JavaScript.
//
// The backend signs sessions, hashes passwords and checks the Mini App's
// initData with Utilities.computeHmacSha256Signature, which Apps Script runs
// synchronously. Deno's WebCrypto is asynchronous only, and the backend code
// cannot wait for a promise, so the Edge runtime brings its own. Checked
// against Node's crypto in tests/edge-runtime.test.js.
//
// Loaded as a CommonJS module by the tests and as a plain module by Deno;
// either way it also registers itself as globalThis.MBMSha256.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MBMSha256 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  /** UTF-8 bytes of a string. */
  function utf8(text) {
    var s = String(text);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        } else c = 0xfffd;
      } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  /** Bytes from a string (UTF-8) or a byte array (signed or unsigned). */
  function toBytes(input) {
    if (typeof input === 'string') return utf8(input);
    if (input && typeof input.length === 'number' && typeof input !== 'function') {
      var out = new Array(input.length);
      for (var i = 0; i < input.length; i++) out[i] = Number(input[i]) & 0xff;
      return out;
    }
    return utf8(String(input));
  }

  /** SHA-256 of a byte array; returns 32 unsigned bytes. */
  function sha256(bytes) {
    var length = bytes.length;
    var bitLength = length * 8;
    var padded = ((length + 9 + 63) >> 6) << 6;
    var data = new Uint8Array(padded);
    for (var i = 0; i < length; i++) data[i] = bytes[i];
    data[length] = 0x80;
    var high = Math.floor(bitLength / 0x100000000);
    var low = bitLength >>> 0;
    data[padded - 8] = (high >>> 24) & 0xff;
    data[padded - 7] = (high >>> 16) & 0xff;
    data[padded - 6] = (high >>> 8) & 0xff;
    data[padded - 5] = high & 0xff;
    data[padded - 4] = (low >>> 24) & 0xff;
    data[padded - 3] = (low >>> 16) & 0xff;
    data[padded - 2] = (low >>> 8) & 0xff;
    data[padded - 1] = low & 0xff;

    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var w = new Uint32Array(64);

    for (var offset = 0; offset < padded; offset += 64) {
      for (var t = 0; t < 16; t++) {
        var j = offset + t * 4;
        w[t] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
      }
      for (t = 16; t < 64; t++) {
        var x = w[t - 15];
        var y = w[t - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + S1 + ch + K[t] + w[t]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }

    var words = [h0, h1, h2, h3, h4, h5, h6, h7];
    var out = new Array(32);
    for (var k = 0; k < 8; k++) {
      out[k * 4] = (words[k] >>> 24) & 0xff;
      out[k * 4 + 1] = (words[k] >>> 16) & 0xff;
      out[k * 4 + 2] = (words[k] >>> 8) & 0xff;
      out[k * 4 + 3] = words[k] & 0xff;
    }
    return out;
  }

  /** HMAC-SHA256; value and key are strings (UTF-8) or byte arrays. Unsigned bytes out. */
  function hmacSha256(value, key) {
    var keyBytes = toBytes(key);
    if (keyBytes.length > 64) keyBytes = sha256(keyBytes);
    var inner = new Array(64);
    var outer = new Array(64);
    for (var i = 0; i < 64; i++) {
      var k = i < keyBytes.length ? keyBytes[i] : 0;
      inner[i] = k ^ 0x36;
      outer[i] = k ^ 0x5c;
    }
    var innerHash = sha256(inner.concat(toBytes(value)));
    return sha256(outer.concat(innerHash));
  }

  /** Apps Script's byte convention: Java's signed bytes (-128..127). */
  function toSigned(bytes) {
    var out = new Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] > 127 ? bytes[i] - 256 : bytes[i];
    return out;
  }

  return { utf8: utf8, toBytes: toBytes, sha256: sha256, hmacSha256: hmacSha256, toSigned: toSigned };
});
