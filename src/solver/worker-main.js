// Solver Web Worker entry (DESIGN.md section 7, "Method interface" and "MIP"). Last file of the 'worker'
// group in tools/manifest.json.
//
// HOW THE PAGE STARTS THE WORKER (file:// pages cannot load a worker file, so it is a Blob URL):
//   const src = $('highs-js').textContent + '\n;\n' + $('worker-src').textContent;  // highs.js defines Module
//   const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
//   worker.postMessage({ type: 'init', wasmGzB64: $('highs-wasm-gz').textContent });
// The worker source works without the highs.js part too (heuristics only; init then reports highs: false).
// The three text/plain script blocks are written by tools/build.py (#highs-js, #highs-wasm-gz,
// #worker-src). (No HTML tag text in this file: it is inlined into such a block.)
//
// PROTOCOL. Every request except init carries an `id` chosen by the page; replies echo it.
// Instances (and start plans) cross as JSON with Infinity encoded by SRO.util.jsonReplacer: send either
// the JSON string itself (JSON.stringify(instance, SRO.util.jsonReplacer)) or the parsed object that
// still holds the '__INF__' markers; the worker revives both with SRO.util.jsonReviver. Replies are
// plain objects (structured clone keeps Infinity as is).
//
// Page -> worker
//   { type: 'init', wasmGzB64 }        highs.wasm, gzip -9 + base64 (plain base64 of the raw wasm also works).
//                                      Once per worker: a second init gets the first one's ready reply.
//   { type: 'solve', id, instance, method, params, settings, start? }
//                                      SRO.solver.solve(); `start` (optional) = starting plan, e.g. the
//                                      adjusted old plan in a contingency re-plan
//   { type: 'estimate', id, instance, method, params, settings, hasStart?, start? }
//                                      SRO.solver.estimate(); `method` may be an array (compare mode), then
//                                      `params` is { [method]: params } and the reply is estimateMany().
//                                      The first estimate for an instance takes about 0.2-0.6 s (a timing
//                                      probe); the worker keeps the last instance it revived (same JSON ->
//                                      same object), so later estimates for budget knobs (iterations,
//                                      timeCapSec, seed, ...) on the same instance answer from the cache.
//   { type: 'compare', id, instance, methods, params: { [method]: params }, settings, start? }
//                                      SRO.solver.compare(): heuristics in order, then MIP seeded with the
//                                      best heuristic plan (extension of the DESIGN protocol)
//   { type: 'methods', id }            replies done with listMethods() (extension)
// Worker -> page
//   { type: 'ready', highs: bool, error?, version?, initMs, selfTest?, methods }
//                                      reply to init; highs false = Exact (MIP) unavailable, heuristics fine.
//                                      `methods` = SRO.solver.listMethods() (key, label, available, reason)
//   { type: 'progress', id, fraction, bestCost, currentCost?, elapsedSec, iteration, message, best?, ... }
//                                      throttled to one message per PROGRESS_MIN_MS (50 ms; the methods
//                                      report every 100 ms, so their cadence passes through) unless the
//                                      method's progress hits fraction 1; `best` (the plan) only when it
//                                      changed since the last posted message, so keep the latest one for
//                                      Cancel. The first best plan of a run is posted at once. In compare
//                                      mode progress also has { method, methodIndex, methodCount,
//                                      methodFraction } and `fraction` covers the whole comparison.
//   { type: 'method-done', id, row }   compare mode: one method finished (row as in SRO.solver.compare,
//                                      with row.result); keep it in case the comparison is cancelled later.
//                                      On Cancel keep the cheapest of the finished rows and the latest
//                                      progress `best` (a later method may still be above an earlier one).
//   { type: 'done', id, result }       solve: SRO.solver.solve() result (solution, total, evaluation,
//                                      explain, ...); estimate: the estimate; compare: the table
//   { type: 'error', id, message, code? }
//                                      code: 'unknown-method' | 'method-not-loaded' | 'mip-unavailable' |
//                                      'bad-instance' (also: instance missing or not readable JSON) |
//                                      'method-failed' | 'bad-result' | 'bad-message' (also: a start plan
//                                      that is not readable JSON)
//
// CANCEL. A run is synchronous and blocks the worker; nothing the page posts reaches it. Cancel =
// worker.terminate(), keep the last `best` posted, and start a fresh worker (and init) for the next run
// (init takes about 0.1-0.3 s). One worker runs one request at a time; messages queue behind a run, so
// use a separate worker for estimates while a solve runs.
//
// MIP loading. On init: base64 -> bytes -> DecompressionStream('gzip') -> Module({ instantiateWasm })
// (highs-js 1.15.3 ignores wasmBinary / wasmModule), a tiny self-test solve, then
// SRO.solver.mip.setLoader(() => Promise.resolve(highs)) and SRO.solver.ensureMip() (awaits
// mip.ready()). A MIP solve or compare that arrives while init is still running waits for it.
//
// Node / tests: SRO.solver.worker.handle(msg, post) is the message handler (post(reply) receives every
// reply); the self.onmessage hook is only installed inside a real worker.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};
  const W = S.worker = S.worker || {};

  // At most one progress message per this many ms (plus forced ones). Below the methods' own 100 ms
  // cadence on purpose: at 100 a report arriving a little early (95 ms) was held until the next one, so
  // every other report was dropped and the page saw ~200 ms gaps.
  W.PROGRESS_MIN_MS = 50;
  W.INIT_TIMEOUT_MS = 30000;      // give up on HiGHS when instantiation hangs this long

  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  // ---- Infinity-safe input ------------------------------------------------------------------------
  function reviveDeep(x) {
    if (x === '__INF__') return Infinity;
    if (x === '__-INF__') return -Infinity;
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        const v = x[i];
        if (v === '__INF__') x[i] = Infinity;
        else if (v === '__-INF__') x[i] = -Infinity;
        else if (v && typeof v === 'object') reviveDeep(v);
      }
      return x;
    }
    if (x && typeof x === 'object') {
      for (const k in x) {
        if (!Object.prototype.hasOwnProperty.call(x, k)) continue;
        const v = x[k];
        if (v === '__INF__') x[k] = Infinity;
        else if (v === '__-INF__') x[k] = -Infinity;
        else if (v && typeof v === 'object') reviveDeep(v);
      }
    }
    return x;
  }
  // Input the page sent that cannot be read: a coded error the planner can be shown, not a raw
  // JSON.parse message.
  function unreadable(what, code, e) {
    return S.solverError(code, 'The plan cannot be solved: the ' + what + ' sent to the solver ' +
      (e ? 'could not be read (' + ((e && e.message) || e) + ').' : 'is missing.'));
  }
  // The last instance revived, keyed by its JSON text: repeated requests on the same instance reuse
  // one object, so the prepare() and estimate() caches (WeakMaps keyed by the object) keep working.
  let lastKey = null, lastInstance = null;
  W.instanceFor = function (raw) {
    if (raw == null || raw === '') throw unreadable('plan data', 'bad-instance');
    let key, inst;
    try {
      key = typeof raw === 'string' ? raw : JSON.stringify(raw, SRO.util && SRO.util.jsonReplacer);
      if (key === lastKey && lastInstance) return lastInstance;
      inst = W.revive(typeof raw === 'string' ? raw : JSON.parse(key));
    } catch (e) { throw unreadable('plan data', 'bad-instance', e); }
    lastKey = key; lastInstance = inst;
    return inst;
  };
  // A start plan from the page (string or object), revived; null when none was sent.
  function startFor(raw) {
    if (raw == null) return null;
    try { return W.revive(raw); } catch (e) { throw unreadable('start plan', 'bad-message', e); }
  }

  W.revive = function (x) {
    if (typeof x === 'string') {
      const reviver = SRO.util && SRO.util.jsonReviver;
      return JSON.parse(x, reviver);
    }
    return reviveDeep(x);
  };

  // ---- HiGHS ----------------------------------------------------------------------------------------
  function bytesFromB64(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // gzip+base64 (or plain base64 of the wasm) -> wasm bytes
  W.decodeWasm = function (b64) {
    const raw = bytesFromB64(b64);
    if (raw.length >= 4 && raw[0] === 0x00 && raw[1] === 0x61 && raw[2] === 0x73 && raw[3] === 0x6d) return Promise.resolve(raw);
    if (!(raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b)) return Promise.reject(new Error('The exact solver data is damaged (not gzip or wasm).'));
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error('This browser cannot unpack the exact solver (no DecompressionStream).'));
    }
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  };

  W.instantiateHighs = function (bytes) {
    const factory = root.Module;
    if (typeof factory !== 'function') return Promise.reject(new Error('highs.js is not part of the worker source.'));
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () { fail(new Error('HiGHS did not start within ' + (W.INIT_TIMEOUT_MS / 1000) + ' s.')); }, W.INIT_TIMEOUT_MS);
      function fail(e) { if (settled) return; settled = true; clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); }
      function ok(h) { if (settled) return; settled = true; clearTimeout(timer); resolve(h); }
      let p;
      try {
        p = factory({
          // highs-js 1.15.3 ignores { wasmBinary } / { wasmModule }; this hook is honored
          instantiateWasm: function (imports, receive) {
            WebAssembly.instantiate(bytes, imports).then(function (r) { receive(r.instance); }, fail);
            return {};
          },
          print: function () {}, printErr: function () {}
        });
      } catch (e) { fail(e); return; }
      Promise.resolve(p).then(ok, fail);
    });
  };

  // A 2-variable MIP (optimum 5 at x = 3, y = 1) proves the module can parse, solve and report.
  const SELF_TEST_LP = 'Maximize\n obj: x + 2 y\nSubject To\n c1: x + y <= 4\n c2: x + 3 y <= 6\nBounds\n 0 <= x <= 3\nGeneral\n y\nEnd\n';
  W.selfTest = function (highs) {
    const t0 = now();
    let status, objective;
    if (typeof highs.createModel === 'function') {
      const model = highs.createModel({ format: 'lp', data: SELF_TEST_LP });
      try {
        model.options.set({ output_flag: false });
        model.run();
        status = model.getModelStatus();
        objective = model.getObjectiveValue();
      } finally { model.dispose(); }
      if (status !== 7) throw new Error('HiGHS self-test ended with status ' + status + ' instead of Optimal.');
    } else {
      const r = highs.solve(SELF_TEST_LP, {});
      status = r.Status; objective = r.ObjectiveValue;
      if (status !== 'Optimal') throw new Error('HiGHS self-test ended with status ' + status + '.');
    }
    if (!(Math.abs(objective - 5) < 1e-6)) throw new Error('HiGHS self-test gave ' + objective + ' instead of 5.');
    return { status: status, objective: objective, ms: now() - t0 };
  };

  let initPromise = null;
  W.highs = null;

  function initHighs(msg) {
    const t0 = now();
    return Promise.resolve().then(function () {
      if (typeof root.Module !== 'function') throw new Error('highs.js is not part of the worker source.');
      if (!msg || !msg.wasmGzB64) throw new Error('No HiGHS WebAssembly was sent to the worker.');
      return W.decodeWasm(msg.wasmGzB64);
    }).then(function (bytes) {
      const tDecode = now();
      return W.instantiateHighs(bytes).then(function (highs) { return { highs: highs, decodeMs: tDecode - t0, instantiateMs: now() - tDecode }; });
    }).then(function (r) {
      const st = W.selfTest(r.highs);
      W.highs = r.highs;
      S.setHighsStatus(true);
      if (S.mip && typeof S.mip.setLoader === 'function') S.mip.setLoader(function () { return Promise.resolve(r.highs); });
      return S.ensureMip().then(function (ok) {
        if (!ok) throw new Error((S.runtime && S.runtime.highsError) || 'The MIP module did not accept HiGHS.');
        const v = r.highs.version;
        return { type: 'ready', highs: true, version: v && v.string ? v.string : (typeof v === 'function' ? v() : v),
          initMs: now() - t0, decodeMs: r.decodeMs, instantiateMs: r.instantiateMs, selfTest: st, methods: S.listMethods() };
      });
    }).catch(function (e) {
      W.highs = null;
      S.setHighsStatus(false, (e && e.message) || e);
      return { type: 'ready', highs: false, error: String((e && e.message) || e), initMs: now() - t0, methods: S.listMethods() };
    });
  }

  // ---- progress relay -----------------------------------------------------------------------------
  // Wraps post() into the hooks.onProgress the methods call. Posts at most every PROGRESS_MIN_MS
  // (always the first best plan, and fraction >= 1); a best plan that arrives in between is held (as a
  // copy) and sent with the next posted message, so `best` goes out only when it changed.
  W.progressRelay = function (post, id, minMs) {
    const gap = minMs != null ? minMs : W.PROGRESS_MIN_MS;
    let last = -Infinity, pendingBest = null, sentBest = false, held = null, posted = 0;
    function send(p, t) {
      const out = { type: 'progress', id: id };
      for (const k in p) {
        if (k === 'best' || k === 'type' || k === 'id' || !Object.prototype.hasOwnProperty.call(p, k)) continue;
        const v = p[k];
        if (typeof v !== 'function') out[k] = v;
      }
      if (pendingBest) { out.best = pendingBest; pendingBest = null; sentBest = true; }
      last = t; held = null; posted++;
      post(out);
    }
    function relay(p) {
      if (!p || typeof p !== 'object') return;
      const t = now();
      const due = t - last >= gap || (p.best && !sentBest) || p.fraction >= 1;
      if (p.best) {
        // posted now: structured clone copies it; held: copy, since a method may reuse the object
        pendingBest = due ? p.best : (S.cloneSolution ? S.cloneSolution(p.best) : JSON.parse(JSON.stringify(p.best)));
      }
      if (due) send(p, t); else held = p;
    }
    // sends what is still held (a newer best plan or the latest numbers)
    relay.flush = function () { if (held || pendingBest) send(held || {}, now()); };
    relay.count = function () { return posted; };
    return relay;
  };

  // ---- message handler ------------------------------------------------------------------------------
  function errorReply(id, e) {
    return { type: 'error', id: id, message: String((e && e.message) || e || 'Unknown error'), code: (e && e.code) || null };
  }

  function needsMip(msg) {
    if (msg.type === 'solve') return msg.method === 'mip';
    if (msg.type === 'compare') return Array.isArray(msg.methods) && msg.methods.indexOf('mip') >= 0;
    return false;
  }

  // Handles one message; post(reply) receives every reply. Returns a promise that settles when done.
  W.handle = function (msg, post) {
    if (!msg || typeof msg !== 'object') return Promise.resolve(post(errorReply(null, S.solverError('bad-message', 'The worker got a message it does not understand.'))));
    const id = msg.id;
    if (msg.type === 'init') {
      if (!initPromise) initPromise = initHighs(msg);
      return initPromise.then(function (ready) { post(ready); });
    }
    const wait = needsMip(msg) && initPromise ? initPromise : Promise.resolve();
    return wait.then(function () {
      switch (msg.type) {
        case 'solve': return doSolve(msg, post);
        case 'compare': return doCompare(msg, post);
        case 'estimate': return doEstimate(msg, post);
        case 'methods': post({ type: 'done', id: id, result: S.listMethods() }); return null;
        default: throw S.solverError('bad-message', 'Unknown request type "' + msg.type + '".');
      }
    }).catch(function (e) { post(errorReply(id, e)); });
  };

  function doSolve(msg, post) {
    const instance = W.instanceFor(msg.instance);
    const relay = W.progressRelay(post, msg.id);
    const hooks = { onProgress: relay, now: now };
    const start = startFor(msg.start);
    if (start) hooks.start = start;
    const result = S.solve(instance, { method: msg.method, params: msg.params, settings: msg.settings, hooks: hooks });
    relay.flush();
    post({ type: 'done', id: msg.id, result: result });
  }

  function doCompare(msg, post) {
    const instance = W.instanceFor(msg.instance);
    // one relay per method, so each method's first best plan goes out at once
    const relays = {};
    let current = null;
    const relayFor = function (k) {
      if (!relays[k]) relays[k] = W.progressRelay(post, msg.id);
      if (current && current !== relays[k]) current.flush();
      current = relays[k];
      return current;
    };
    const hooks = { onProgress: function (p) { relayFor(p && p.method || '?')(p); }, now: now };
    const start = startFor(msg.start);
    if (start) hooks.start = start;
    const table = S.compare(instance, msg.methods, {
      params: msg.params, settings: msg.settings, hooks: hooks,
      onMethodDone: function (row) {
        if (current) current.flush();
        post({ type: 'method-done', id: msg.id, row: row });
      }
    });
    if (current) current.flush();
    post({ type: 'done', id: msg.id, result: table });
  }

  function doEstimate(msg, post) {
    const instance = W.instanceFor(msg.instance);
    const opts = { hasStart: !!msg.hasStart };
    const start = startFor(msg.start);
    if (start) opts.start = start;
    const result = Array.isArray(msg.method)
      ? S.estimateMany(instance, msg.method, msg.params, msg.settings, opts)
      : S.estimate(instance, msg.method, msg.params, msg.settings, opts);
    post({ type: 'done', id: msg.id, result: result });
  }

  // ---- install inside a real worker only ------------------------------------------------------------
  const inWorker = typeof root.importScripts === 'function' && typeof root.postMessage === 'function' &&
    typeof root.document === 'undefined';
  if (inWorker && !W.installed) {
    W.installed = true;
    root.addEventListener('message', function (e) {
      W.handle(e.data, function (reply) {
        try { root.postMessage(reply); } catch (err) {
          // a value the structured clone cannot copy: send a JSON copy instead of losing the reply
          try { root.postMessage(JSON.parse(JSON.stringify(reply, SRO.util && SRO.util.jsonReplacer))); } catch (e2) {
            root.postMessage(errorReply(reply && reply.id, err));
          }
        }
      });
    });
  }
})(typeof self !== 'undefined' ? self : globalThis);
