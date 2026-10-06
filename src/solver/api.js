// Solver runtime entry points (DESIGN.md section 7, "Method interface"). Pure JS: runs in the solver
// Web Worker and in Node tests (no DOM).
//
//   SRO.solver.solve(instance, { method, params, settings, hooks }) -> result
//       Clamps params (SRO.solver.clampParams), runs SRO.solver.methods[method].run(instance, params,
//       hooks), re-evaluates the final plan with evaluate() (the single source of truth for cost) and
//       returns the method's result plus:
//         { method, label, params, total, feasible  (from the re-evaluation),
//           methodTotal (what the method reported), evaluation (full evaluate() result),
//           explain (explainDeferred: a reason per deferred job), wallSec, warnings: [text] }
//       params default to settings.methodParams[method]. hooks: { onProgress, now, shouldStop, start }
//       (all optional; see the method interface).
//   SRO.solver.compare(instance, methods, { params: { [method]: params }, settings, hooks, onMethodDone })
//       -> table: [{ method, label, total, feasible, cost: { fuel, distance, risk, simplicity, platoon,
//          lateness, deferral, pinned }, elapsedSec, stopReason, iterations, evals, gap (MIP only, proven
//          gap 0..1), status (MIP only), startFrom (MIP only: the method whose plan seeded it),
//          deferredJobs, lateJobs, hardLate, trucksUsed, stops, miles, violations, best (lowest total),
//          error?, code?, result (the full solve() result) }]
//       Runs the methods one after another on the same instance, heuristics first (in the order given)
//       and MIP last, seeded with the best heuristic plan found so far (hooks.start). Rows come back in
//       the order requested. A method that fails or is unavailable gets a row with `error` and `code`
//       instead of stopping the comparison. hooks.onProgress receives each method's progress with
//       { method, methodIndex, methodCount, methodFraction } added and `fraction` for the whole run;
//       onMethodDone(row, runIndex) fires as each method finishes (the worker posts it so Cancel keeps
//       finished rows). When hooks.shouldStop() turns true the running method stops and the rest are
//       skipped (row.skipped, stopReason 'stopped').
//   SRO.solver.listMethods() -> [{ key, label, available, reason, code, default, exact }]
//       For the method picker: every key in METHOD_KEYS plus any other registered method. `reason` is a
//       plain-language note when the method cannot run here.
//   SRO.solver.methodStatus(key) -> { available, code, reason }
//   SRO.solver.setHighsStatus(ok, error)  records whether HiGHS loaded (the worker calls it after init).
//   SRO.solver.ensureMip() -> Promise<bool>  awaits SRO.solver.mip.ready() and records the outcome.
//   SRO.solver.solverError(code, message, extra) -> Error with { name: 'SolverError', code }.
//
// Error codes thrown by solve() (compare() puts them in row.code): 'unknown-method' (no such method),
// 'method-not-loaded' (a known method whose file is not in this build), 'mip-unavailable' (HiGHS did
// not load), 'bad-instance' (validateInstance problems), 'method-failed' (the method threw),
// 'bad-result' (the method returned no plan). Messages are written for the planner.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};
  S.methods = S.methods || {};
  const mmax = Math.max, mabs = Math.abs;

  const METHOD_FILES = { tabu: 'tabu.js', sa: 'sa.js', aco: 'aco.js', mip: 'mip.js' };
  // HiGHS status as known to this runtime: null = not tried yet, true = loaded, false = failed.
  const runtime = S.runtime = S.runtime || { highs: null, highsError: null };

  function defaultNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function noop() {}
  function never() { return false; }

  S.solverError = function (code, message, extra) {
    const e = new Error(message);
    e.name = 'SolverError';
    e.code = code;
    if (extra) for (const k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
  };
  const err = S.solverError;

  function labelOf(key) {
    const m = S.methods[key];
    return (m && m.label) || (S.METHOD_LABELS && S.METHOD_LABELS[key]) || String(key);
  }
  function knownKey(key) { return (S.METHOD_KEYS || []).indexOf(key) >= 0; }

  // ---- HiGHS / MIP availability ---------------------------------------------------------------
  S.setHighsStatus = function (ok, error) {
    runtime.highs = !!ok;
    runtime.highsError = ok ? null : String(error || 'HiGHS did not load.');
  };

  // Awaits SRO.solver.mip.ready() (the loader set with mip.setLoader) and records the outcome.
  S.ensureMip = function () {
    const mip = S.mip;
    if (!mip || typeof mip.ready !== 'function') {
      return Promise.resolve(runtime.highs === true);
    }
    let p;
    try { p = Promise.resolve(mip.ready()); } catch (e) { p = Promise.reject(e); }
    return p.then(function (v) {
      if (v === false) { S.setHighsStatus(false, 'HiGHS did not load.'); return false; }
      S.setHighsStatus(true);
      return true;
    }, function (e) {
      S.setHighsStatus(false, (e && e.message) || e);
      return false;
    });
  };

  // true / false when mip.js can say whether its HiGHS module is loaded, else null
  function mipLoadedSync() {
    const mip = S.mip;
    if (!mip) return null;
    try {
      if (typeof mip.isReady === 'function') return !!mip.isReady();
      if (typeof mip.available === 'function') return !!mip.available();
    } catch (e) { return false; }
    return null;
  }

  S.methodStatus = function (key) {
    const m = S.methods[key];
    if (!m || typeof m.run !== 'function') {
      if (knownKey(key)) {
        return { available: false, code: 'method-not-loaded',
          reason: labelOf(key) + ' is not part of this build (' + (METHOD_FILES[key] || key + '.js') + ' is not loaded).' };
      }
      return { available: false, code: 'unknown-method', reason: 'There is no solver method called "' + key + '".' };
    }
    if (key === 'mip') {
      if (runtime.highs === false) {
        return { available: false, code: 'mip-unavailable',
          reason: 'The exact solver (HiGHS) could not start in this browser, so Exact (MIP) is not available. The heuristic methods still work.' +
            (runtime.highsError ? ' Detail: ' + runtime.highsError : '') };
      }
      const loaded = mipLoadedSync();
      if (loaded === false || (loaded === null && runtime.highs !== true)) {
        return { available: false, code: 'mip-unavailable',
          reason: 'The exact solver (HiGHS) has not been loaded yet, so Exact (MIP) cannot run.' };
      }
    }
    return { available: true, code: null, reason: null };
  };

  S.listMethods = function () {
    const keys = (S.METHOD_KEYS || []).slice();
    Object.keys(S.methods).forEach(function (k) { if (keys.indexOf(k) < 0 && S.methods[k] && typeof S.methods[k].run === 'function') keys.push(k); });
    return keys.map(function (k) {
      const st = S.methodStatus(k);
      return { key: k, label: labelOf(k), available: st.available, reason: st.reason, code: st.code, default: k === 'tabu', exact: k === 'mip' };
    });
  };

  // ---- params and hooks -------------------------------------------------------------------------
  // Clamped params for `method`. A registered method without a PARAMS table (tests, experiments) gets
  // a shallow copy of what was passed.
  S.methodParams = function (method, params, settings) {
    if (params == null && settings && settings.methodParams && settings.methodParams[method]) params = settings.methodParams[method];
    if (S.PARAMS && S.PARAMS[method]) return S.clampParams(method, params, settings);
    const out = {};
    if (params && typeof params === 'object') for (const k in params) if (Object.prototype.hasOwnProperty.call(params, k)) out[k] = params[k];
    return out;
  };

  function normHooks(h) {
    h = h || {};
    const out = {
      onProgress: typeof h.onProgress === 'function' ? h.onProgress : noop,
      now: typeof h.now === 'function' ? h.now : defaultNow,
      shouldStop: typeof h.shouldStop === 'function' ? h.shouldStop : never
    };
    if (h.start && typeof h.start === 'object') out.start = h.start;
    return out;
  }

  function checkInstance(instance) {
    const problems = S.validateInstance ? S.validateInstance(instance) : (!instance ? ['The instance is missing.'] : []);
    if (problems.length) {
      throw err('bad-instance', 'The plan cannot be solved: ' + problems[0] + (problems.length > 1 ? ' (and ' + (problems.length - 1) + ' more problem' + (problems.length > 2 ? 's' : '') + ')' : ''),
        { problems: problems });
    }
  }

  // ---- solve ------------------------------------------------------------------------------------
  S.solve = function (instance, opts) {
    opts = opts || {};
    const method = opts.method || (opts.settings && opts.settings.method) || 'tabu';
    const st = S.methodStatus(method);
    if (!st.available) throw err(st.code, st.reason, { method: method });
    checkInstance(instance);
    const m = S.methods[method];
    const params = S.methodParams(method, opts.params, opts.settings);
    const hooks = normHooks(opts.hooks);
    const t0 = hooks.now();
    let res;
    try {
      res = m.run(instance, params, hooks);
    } catch (e) {
      if (e && e.name === 'SolverError') throw e;
      throw err('method-failed', labelOf(method) + ' stopped with an error: ' + ((e && e.message) || e), { method: method, stack: e && e.stack });
    }
    const wallSec = (hooks.now() - t0) / 1000;
    if (!res || !res.solution || !Array.isArray(res.solution.routes)) {
      throw err('bad-result', labelOf(method) + ' finished without returning a plan.', { method: method });
    }
    const evaluation = S.evaluate(instance, res.solution);
    const explain = S.explainDeferred ? S.explainDeferred(instance, evaluation) : [];
    const warnings = [];
    if (typeof res.total === 'number' && mabs(res.total - evaluation.total) > 1e-6 * mmax(1, mabs(evaluation.total))) {
      warnings.push(labelOf(method) + ' reported a total of ' + res.total.toFixed(1) + ' but the plan evaluates to ' + evaluation.total.toFixed(1) + '; the evaluated total is used.');
    }
    const out = {};
    for (const k in res) if (Object.prototype.hasOwnProperty.call(res, k)) out[k] = res[k];
    out.method = method;
    out.label = labelOf(method);
    out.params = params;
    out.methodTotal = res.total;
    out.total = evaluation.total;
    out.feasible = evaluation.feasible;
    if (typeof out.elapsedSec !== 'number') out.elapsedSec = wallSec;
    if (!out.stopReason) out.stopReason = 'budget';
    if (!Array.isArray(out.history)) out.history = [];
    out.wallSec = wallSec;
    out.evaluation = evaluation;
    out.explain = explain;
    out.warnings = warnings.concat(Array.isArray(res.warnings) ? res.warnings : []);
    return out;
  };

  // ---- compare ----------------------------------------------------------------------------------
  function rowFrom(method, res) {
    const ev = res.evaluation;
    const ex = res.extra || {};
    const row = {
      method: method, label: res.label, total: res.total, feasible: res.feasible,
      cost: Object.assign({}, ev.cost),
      elapsedSec: res.elapsedSec, stopReason: res.stopReason, iterations: res.iterations, evals: res.evals,
      deferredJobs: (ev.deferred || []).length, lateJobs: (ev.late || []).length, hardLate: (ev.hardLate || []).length,
      trucksUsed: ev.stats ? ev.stats.trucksUsed : (ev.routes || []).length,
      stops: ev.stats ? ev.stats.stops : null, miles: ev.stats ? ev.stats.miles : null,
      violations: (ev.violations || []).length, best: false, result: res
    };
    if (method === 'mip' || typeof ex.mipGap === 'number') {
      row.gap = typeof ex.mipGap === 'number' ? ex.mipGap : null;
      row.status = ex.status != null ? ex.status : null;
      row.dualBound = typeof ex.dualBound === 'number' ? ex.dualBound : null;
    }
    return row;
  }

  function errorRow(method, e) {
    return {
      method: method, label: labelOf(method), total: null, feasible: false, cost: null,
      elapsedSec: 0, stopReason: null, best: false,
      error: (e && e.message) || String(e), code: (e && e.code) || 'method-failed'
    };
  }

  S.compare = function (instance, methods, opts) {
    opts = opts || {};
    const list = [];
    (Array.isArray(methods) ? methods : [methods]).forEach(function (k) { if (k && list.indexOf(k) < 0) list.push(k); });
    if (!list.length) throw err('unknown-method', 'Pick at least one method to compare.');
    checkInstance(instance);
    const order = list.filter(function (k) { return k !== 'mip'; }).concat(list.indexOf('mip') >= 0 ? ['mip'] : []);
    const base = normHooks(opts.hooks);
    const paramsBy = opts.params || {};
    const rows = {};
    let bestPlan = null, bestTotal = Infinity, bestFeas = false, bestFrom = null, stopped = false;
    const n = order.length;

    for (let i = 0; i < n; i++) {
      const key = order[i];
      if (stopped || base.shouldStop()) {
        stopped = true;
        const r = { method: key, label: labelOf(key), total: null, feasible: false, cost: null, elapsedSec: 0,
          stopReason: 'stopped', skipped: true, best: false };
        rows[key] = r;
        if (typeof opts.onMethodDone === 'function') opts.onMethodDone(r, i);
        continue;
      }
      const hooks = {
        now: base.now, shouldStop: base.shouldStop,
        onProgress: (function (idx, k) {
          return function (p) {
            const q = {};
            for (const f in p) if (Object.prototype.hasOwnProperty.call(p, f)) q[f] = p[f];
            const fr = typeof p.fraction === 'number' ? p.fraction : 0;
            q.method = k; q.methodIndex = idx; q.methodCount = n; q.methodFraction = fr;
            q.fraction = (idx + mmax(0, Math.min(1, fr))) / n;
            base.onProgress(q);
          };
        })(i, key)
      };
      const start = key === 'mip' ? (bestPlan || base.start) : base.start;
      if (start) hooks.start = start;
      let row;
      try {
        const res = S.solve(instance, { method: key, params: paramsBy[key], settings: opts.settings, hooks: hooks });
        row = rowFrom(key, res);
        if (key === 'mip') row.startFrom = bestPlan ? bestFrom : (base.start ? 'start' : null);
        if (key !== 'mip' && (bestPlan === null || (res.feasible && !bestFeas) || (res.feasible === bestFeas && res.total < bestTotal))) {
          bestPlan = res.solution; bestTotal = res.total; bestFeas = res.feasible; bestFrom = key;
        }
        if (res.stopReason === 'stopped' && base.shouldStop()) stopped = true;
      } catch (e) {
        row = errorRow(key, e);
      }
      rows[key] = row;
      if (typeof opts.onMethodDone === 'function') opts.onMethodDone(row, i);
    }

    const table = list.map(function (k) { return rows[k]; });
    let bi = -1;
    table.forEach(function (r, i) {
      if (r.total == null) return;
      const b = bi >= 0 ? table[bi] : null;
      if (!b || (r.feasible && !b.feasible) || (r.feasible === b.feasible && r.total < b.total)) bi = i;
    });
    if (bi >= 0) table[bi].best = true;
    return table;
  };
})(typeof self !== 'undefined' ? self : globalThis);
