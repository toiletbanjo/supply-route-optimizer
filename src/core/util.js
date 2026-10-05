// Small shared helpers. Runs on the main thread, in the solver worker and in Node tests.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const util = SRO.util = SRO.util || {};

  // Seeded RNG (mulberry32). Returns a function producing floats in [0, 1).
  util.rng = function (seed) {
    let a = (seed >>> 0) || 1;
    const next = function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.int = function (n) { return Math.floor(next() * n); };          // 0..n-1
    next.pick = function (arr) { return arr[Math.floor(next() * arr.length)]; };
    next.shuffle = function (arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    };
    return next;
  };

  util.clamp = function (x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; };
  util.round = function (x, digits) { const f = Math.pow(10, digits || 0); return Math.round(x * f) / f; };
  util.deepClone = function (x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x, util.jsonReplacer), util.jsonReviver); };
  util.pad = function (n, width) { let s = String(n); while (s.length < width) s = '0' + s; return s; };

  // JSON cannot hold Infinity; matrices use it for unreachable pairs.
  util.jsonReplacer = function (k, v) { return v === Infinity ? '__INF__' : v === -Infinity ? '__-INF__' : v; };
  util.jsonReviver = function (k, v) { return v === '__INF__' ? Infinity : v === '__-INF__' ? -Infinity : v; };

  let idCounter = 0;
  util.uid = function (prefix) { idCounter += 1; return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + idCounter.toString(36); };
  // Sequential human-readable id, e.g. nextId('R', existing) -> 'R-0007'
  util.nextId = function (prefix, existingIds, width) {
    let max = 0;
    const re = new RegExp('^' + prefix + '-(\\d+)$');
    (existingIds || []).forEach(function (id) { const m = re.exec(id); if (m) max = Math.max(max, parseInt(m[1], 10)); });
    return prefix + '-' + util.pad(max + 1, width || 4);
  };
})(typeof self !== 'undefined' ? self : globalThis);
