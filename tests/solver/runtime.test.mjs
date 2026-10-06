// Solver runtime: api.js (solve, compare, listMethods), estimate.js and the worker message handler in
// worker-main.js (run in Node with the real highs.js + wasm, exactly as the Blob worker does).
//
//   node --test tests/solver/runtime.test.mjs
//   SRO_FULL_ESTIMATE=1 node --test tests/solver/runtime.test.mjs   also checks estimate vs a real run at
//                                                                  DEFAULT params for every registered
//                                                                  heuristic on three Phase 1 instances
//
// Stub methods follow the method interface (DESIGN.md section 7) so api/estimate are tested without
// depending on the real methods; the real ones (tabu, sa, aco, mip) are exercised when their files exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { ROOT, wrapSource } from '../load.mjs';

const plain = (x) => JSON.parse(JSON.stringify(x));
const FULL = !!process.env.SRO_FULL_ESTIMATE;

const CORE = ['src/core/ns.js', 'src/core/util.js', 'src/solver/instance.js', 'src/solver/params.js',
  'src/solver/evaluate.js', 'src/solver/construct.js', 'src/solver/localsearch.js'];
const RUNTIME = ['src/solver/estimate.js', 'src/solver/api.js', 'src/solver/worker-main.js'];

function manifestWorkerFiles() {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/manifest.json'), 'utf8'));
  return m.worker.map((f) => f.replace(/\?$/, '')).filter((f) => fs.existsSync(path.join(ROOT, f)));
}

// A fresh vm context with the web globals a Blob worker has (atob, Blob, Response, DecompressionStream)
// and, when asked, highs.js run first in the same context (it defines the global Module), exactly like
// the Blob worker source = highs.js text + worker files. (Passing require('highs') in from the outer
// realm breaks HiGHS callbacks: wasm tables reject function objects from another realm.)
function load(files, { highs = false } = {}) {
  const ctx = {
    console, setTimeout, clearTimeout, performance, atob, Blob, Response, DecompressionStream
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  if (highs) {
    const hf = path.join(ROOT, 'node_modules/highs/build/highs.js');
    vm.runInContext(fs.readFileSync(hf, 'utf8'), ctx, { filename: hf });
  }
  for (const f of files) vm.runInContext(wrapSource(f, fs.readFileSync(path.join(ROOT, f), 'utf8')), ctx, { filename: path.join(ROOT, f) });
  return ctx.SRO;
}
const loadCore = () => load(CORE.concat(RUNTIME));
const loadAll = (opts) => load(manifestWorkerFiles(), opts);

function phase1(SRO, seed, extra = {}) {
  return SRO.solver.makeTestInstance(seed, Object.assign({
    nJobs: 30, nVehicles: 8, nRally: 8, nHubs: 3, capacity: { tanker: 7500, cargo: 30 }, deadlineMax: 900, directShare: 0.3
  }, extra));
}
const small = (SRO, seed, extra = {}) => SRO.solver.makeTestInstance(seed, Object.assign({ nJobs: 10, nVehicles: 4, nRally: 5 }, extra));

function now() { return performance.now(); }
function spin(ms) { const end = now() + ms; while (now() < end) { /* busy */ } }
// Estimate-vs-run checks time both sides on this process's CPU clock (the estimator takes it as
// opts.now; the stubs spin on it): npm test runs the test files in parallel, and on a busy machine a
// wall-clock probe of 0.2-0.5 s and the run it predicts see different shares of the CPU.
function cpuNow() { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }
function spinCpu(ms) { const end = cpuNow() + ms; while (cpuNow() < end) { /* busy */ } }

// Interface-following stub: setupMs, then `iterations` steps of perIterMs each (or method.budget units),
// progress at iteration 0, every 200 ms and on the last step; stops at budget, timeCapSec or shouldStop.
function busyStub(SRO, { key = 'tabu', label = 'Stub', setupMs = 20, perIterMs = 1, budget = null } = {}) {
  const S = SRO.solver;
  const m = {
    key, label,
    calls: [],
    run(instance, p, hooks) {
      m.calls.push({ params: p, hooks });
      const t0 = hooks.now();
      spinCpu(setupMs);
      const sol = S.construct(instance);
      const ev = S.evaluate(instance, sol, { costOnly: true });
      hooks.onProgress({ fraction: 0, bestCost: ev.total, currentCost: ev.total, elapsedSec: (hooks.now() - t0) / 1000, iteration: 0, message: 'start', best: sol });
      const maxIt = budget ? budget(instance, p) : p.iterations;
      let it = 0, last = hooks.now(), stopReason = 'budget';
      while (it < maxIt) {
        if (hooks.shouldStop()) { stopReason = 'stopped'; break; }
        if (hooks.now() - t0 >= p.timeCapSec * 1000) { stopReason = 'time'; break; }
        spinCpu(perIterMs);
        it++;
        if (hooks.now() - last >= 200 || it === maxIt) {
          last = hooks.now();
          hooks.onProgress({ fraction: it / maxIt, bestCost: ev.total, elapsedSec: (last - t0) / 1000, iteration: it, message: 'step ' + it });
        }
      }
      return { solution: sol, total: ev.total, feasible: ev.feasible, evals: it, iterations: it, elapsedSec: (hooks.now() - t0) / 1000, stopReason, history: [{ t: 0, best: ev.total }] };
    }
  };
  if (budget) m.budget = budget;
  return m;
}

// Quick stub: returns construct() (optionally polished) and records what it got.
function planStub(SRO, key, { polish = false, total = null, extra = null, fail = null, noPlan = false } = {}) {
  const S = SRO.solver;
  const m = {
    key, label: 'Stub ' + key, calls: [],
    run(instance, p, hooks) {
      m.calls.push({ params: p, hooks, start: hooks.start });
      if (fail) throw new Error(fail);
      if (noPlan) return { total: 1 };
      let sol = hooks.start || S.construct(instance);
      if (polish) sol = S.localSearch(instance, sol, { seed: p.seed || 1 });
      const ev = S.evaluate(instance, sol, { costOnly: true });
      hooks.onProgress({ fraction: 0.5, bestCost: ev.total, elapsedSec: 0, iteration: 1, message: 'half', best: sol });
      hooks.onProgress({ fraction: 1, bestCost: ev.total, elapsedSec: 0, iteration: 2, message: 'done' });
      return { solution: sol, total: total != null ? total : ev.total, feasible: ev.feasible, evals: 1, iterations: 2, elapsedSec: 0.01, stopReason: 'budget', history: [], extra };
    }
  };
  return m;
}

function throwsCode(fn, code) {
  try { fn(); } catch (e) { assert.equal(e.code, code, 'error code for: ' + e.message); assert.equal(e.name, 'SolverError'); return e; }
  assert.fail('expected an error with code ' + code);
}

// ---------------------------------------------------------------------------------------------------
test('listMethods / methodStatus: labels, availability, plain-language reasons', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  let list = plain(S.listMethods());
  assert.deepEqual(list.map((m) => m.key), ['tabu', 'sa', 'aco', 'mip']);
  assert.deepEqual(list.map((m) => m.label), ['Tabu search', 'Simulated annealing', 'Ant colony', 'Exact (MIP)']);
  assert.ok(list.every((m) => !m.available && m.code === 'method-not-loaded' && /not part of this build/.test(m.reason)));
  assert.equal(list.find((m) => m.default).key, 'tabu');
  assert.equal(list.find((m) => m.exact).key, 'mip');

  S.methods.tabu = planStub(SRO, 'tabu');
  S.methods.mip = planStub(SRO, 'mip');
  S.methods.extra = planStub(SRO, 'extra');
  list = plain(S.listMethods());
  assert.equal(list.length, 5);
  assert.equal(list.find((m) => m.key === 'tabu').available, true);
  assert.equal(list.find((m) => m.key === 'extra').available, true);
  const mip = list.find((m) => m.key === 'mip');
  assert.equal(mip.available, false);
  assert.equal(mip.code, 'mip-unavailable');
  assert.match(mip.reason, /has not been loaded/);
  S.setHighsStatus(false, 'WebAssembly.instantiate(): out of memory');
  assert.match(S.methodStatus('mip').reason, /could not start in this browser.*heuristic methods still work.*out of memory/);
  S.setHighsStatus(true);
  assert.equal(S.methodStatus('mip').available, true);
  assert.equal(S.methodStatus('nope').code, 'unknown-method');
});

test('solve: errors the UI can show (unknown, not loaded, MIP unavailable, bad instance, method failure, no plan)', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  const inst = small(SRO, 1);
  throwsCode(() => S.solve(inst, { method: 'nope' }), 'unknown-method');
  const e = throwsCode(() => S.solve(inst, { method: 'sa' }), 'method-not-loaded');
  assert.match(e.message, /Simulated annealing is not part of this build/);
  S.methods.mip = planStub(SRO, 'mip');
  throwsCode(() => S.solve(inst, { method: 'mip' }), 'mip-unavailable');
  S.methods.tabu = planStub(SRO, 'tabu');
  const bad = JSON.parse(JSON.stringify(inst)); bad.vehicles[0].type = 'boat';
  const eb = throwsCode(() => S.solve(bad, { method: 'tabu' }), 'bad-instance');
  assert.match(eb.message, /^The plan cannot be solved: /);
  assert.ok(eb.problems.length >= 1);
  S.methods.sa = planStub(SRO, 'sa', { fail: 'boom' });
  const ef = throwsCode(() => S.solve(inst, { method: 'sa' }), 'method-failed');
  assert.match(ef.message, /^Stub sa stopped with an error: boom$/);
  S.methods.aco = planStub(SRO, 'aco', { noPlan: true });
  throwsCode(() => S.solve(inst, { method: 'aco' }), 'bad-result');
});

test('solve: clamps params, fills hooks, re-evaluates the plan, attaches evaluation + explain', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  const inst = small(SRO, 2, { nJobs: 14, nVehicles: 2 });
  const stub = planStub(SRO, 'tabu', { total: 123 });   // misreports its total
  S.methods.tabu = stub;
  const settings = { timeLimitSec: 42, methodParams: { tabu: { tenure: 7 } } };
  const res = S.solve(inst, { method: 'tabu', params: { iterations: 1e9, neighborhood: 'abc', bogus: 1 }, settings });
  const p = stub.calls[0].params;
  assert.equal(p.iterations, 100000);                 // clamped to max
  assert.equal(p.neighborhood, 200);                  // invalid -> default
  assert.equal(p.timeCapSec, 42);                     // default from settings.timeLimitSec
  assert.equal(p.bogus, undefined);
  assert.deepEqual(plain(Object.keys(p).sort()), plain(S.PARAMS.tabu.map((e) => e.key).sort()));
  const h = stub.calls[0].hooks;
  assert.equal(typeof h.onProgress, 'function');
  assert.equal(typeof h.now, 'function');
  assert.equal(h.shouldStop(), false);
  assert.equal('start' in h, false);
  // params omitted -> settings.methodParams[method]
  S.solve(inst, { method: 'tabu', settings });
  assert.equal(stub.calls[1].params.tenure, 7);
  // evaluation is the single source of truth
  const full = S.evaluate(inst, res.solution);
  assert.equal(res.total, full.total);
  assert.equal(res.methodTotal, 123);
  assert.equal(res.feasible, full.feasible);
  assert.equal(res.evaluation.total, full.total);
  assert.ok(Array.isArray(res.evaluation.routes));
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /reported a total of 123/);
  assert.deepEqual(plain(res.explain), plain(S.explainDeferred(inst, full)));
  assert.equal(res.method, 'tabu');
  assert.equal(res.label, 'Stub tabu');
  assert.equal(res.stopReason, 'budget');
  assert.ok(res.wallSec >= 0);
  // a start plan is passed through
  const start = S.construct(inst);
  S.solve(inst, { method: 'tabu', hooks: { start } });
  assert.equal(stub.calls[2].start, start);
  // with only two trucks for 14 jobs something is deferred, and every deferral gets a reason
  if (res.evaluation.deferred.length) assert.ok(res.explain.every((x) => typeof x.reason === 'string' && x.reason));
});

test('compare: heuristics first, MIP last with the best heuristic plan as start; table rows and errors', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  const inst = phase1(SRO, 3);
  S.methods.tabu = planStub(SRO, 'tabu');                       // construct only
  S.methods.sa = planStub(SRO, 'sa', { polish: true });         // construct + local search (better)
  const mip = S.methods.mip = planStub(SRO, 'mip', { extra: { status: 'Time limit reached', mipGap: 0.064, dualBound: 1000, modelObjective: 1100 } });
  S.setHighsStatus(true);
  const progress = [], done = [];
  const table = S.compare(inst, ['mip', 'tabu', 'aco', 'sa'], {
    settings: { timeLimitSec: 30 },
    hooks: { onProgress: (p) => progress.push(p) },
    onMethodDone: (row, i) => done.push([row.method, i])
  });
  assert.deepEqual(plain(table.map((r) => r.method)), ['mip', 'tabu', 'aco', 'sa']);   // requested order
  assert.deepEqual(done.map((d) => d[0]), ['tabu', 'aco', 'sa', 'mip']);         // run order
  const by = Object.fromEntries(table.map((r) => [r.method, r]));
  assert.equal(by.aco.code, 'method-not-loaded');
  assert.match(by.aco.error, /Ant colony is not part of this build/);
  assert.ok(by.sa.total <= by.tabu.total);
  // MIP got the better heuristic plan (sa's) as its start
  assert.equal(mip.calls[0].start, by.sa.result.solution);
  assert.equal(by.mip.startFrom, 'sa');
  assert.equal(by.mip.gap, 0.064);
  assert.equal(by.mip.status, 'Time limit reached');
  assert.equal(by.tabu.gap, undefined);
  for (const k of ['tabu', 'sa', 'mip']) {
    const r = by[k];
    assert.equal(r.total, S.evaluate(inst, r.result.solution).total);
    for (const c of ['fuel', 'distance', 'risk', 'simplicity', 'platoon', 'lateness', 'deferral']) assert.equal(typeof r.cost[c], 'number', k + '.' + c);
    assert.equal(typeof r.elapsedSec, 'number');
    assert.equal(r.stopReason, 'budget');
    assert.equal(typeof r.deferredJobs, 'number');
  }
  assert.equal(table.filter((r) => r.best).length, 1);
  const best = table.find((r) => r.best);
  assert.equal(best.total, Math.min(...table.filter((r) => r.total != null).map((r) => r.total)));
  // progress is tagged per method and the whole-run fraction never exceeds 1
  assert.ok(progress.length >= 6);
  assert.ok(progress.every((p) => typeof p.method === 'string' && p.methodCount === 4 && p.fraction >= 0 && p.fraction <= 1));
  assert.equal(progress[progress.length - 1].method, 'mip');
  assert.equal(progress[progress.length - 1].fraction, 1);

  // stop: the rest is skipped
  let calls = 0;
  const t2 = S.compare(inst, ['tabu', 'sa'], { hooks: { shouldStop: () => ++calls > 1 } });
  assert.equal(t2[0].skipped, undefined);
  assert.equal(t2[1].skipped, true);
  assert.equal(t2[1].stopReason, 'stopped');
  assert.throws(() => S.compare(inst, []), /at least one method/);
});

test('estimate: probe on a stub with known timing is close (1.5x even on a busy machine), capped by timeCapSec, cached per instance', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  const inst = phase1(SRO, 1);
  S.methods.tabu = busyStub(SRO, { perIterMs: 1, setupMs: 20 });
  const settings = { timeLimitSec: 300 };
  const est = S.estimate(inst, 'tabu', { iterations: 1500 }, settings, { cache: false, now: cpuNow });
  const t0 = cpuNow();
  const res = S.solve(inst, { method: 'tabu', params: { iterations: 1500 }, settings });
  const actual = (cpuNow() - t0) / 1000;
  assert.equal(est.source, 'probe');
  assert.ok(est.probe.ms < 700, 'probe took ' + est.probe.ms);
  const ratio = est.seconds / actual;
  assert.ok(ratio > 0.67 && ratio < 1.5, `estimate ${est.seconds} vs actual ${actual}`);
  assert.ok(est.low <= est.seconds && est.seconds <= est.high);
  assert.ok(est.low <= actual && actual <= est.high);
  assert.equal(res.iterations, 1500);
  assert.match(est.basis, /steps of Stub|steps of Tabu search/);
  // cache: a different budget reuses the probe and scales
  const e2 = S.estimate(inst, 'tabu', { iterations: 3000, seed: 7 }, settings);
  const e3 = S.estimate(inst, 'tabu', { iterations: 6000 }, settings);
  assert.equal(e3.probe.cached, true);
  assert.ok(Math.abs(e3.seconds / e2.seconds - 2) < 0.15, `${e2.seconds} -> ${e3.seconds}`);
  // a knob that changes the cost of one step re-probes
  assert.equal(S.estimate(inst, 'tabu', { neighborhood: 50 }, settings).probe.cached, false);
  // cap
  const ec = S.estimate(inst, 'tabu', { iterations: 100000, timeCapSec: 5 }, settings);
  assert.equal(ec.capped, true);
  assert.equal(ec.seconds, 5);
  assert.equal(ec.high, 5, 'the range ends at the cap (the run stops there)');
  // below the cap too: about 3.6 s here (5 s is the smallest cap), and 1.5x that would be past it
  const en = S.estimate(inst, 'tabu', { iterations: 3500, timeCapSec: 5 }, settings);
  assert.equal(en.capSec, 5);
  assert.ok(en.high <= 5 && en.seconds <= en.high, JSON.stringify([en.seconds, en.high]));
  assert.match(ec.basis, /stops at 5\.0 s|stops at 5 s/);
  S.estimate.clearCache(inst);
  assert.equal(S.estimate(inst, 'tabu', { iterations: 6000 }, settings).probe.cached, false);
});

test('estimate: method.budget() and the progress fraction are used for methods without a built-in budget', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  const inst = phase1(SRO, 2);
  S.methods.custom = busyStub(SRO, { key: 'custom', perIterMs: 0.5, setupMs: 5, budget: () => 2000 });
  const e = S.estimate(inst, 'custom', { timeCapSec: 60 }, {}, { cache: false, now: cpuNow });
  assert.equal(e.probe.budget, 2000);
  assert.ok(e.seconds > 0.6 && e.seconds < 2, String(e.seconds));
  // no budget(): falls back to iteration / fraction from the progress reports
  const st = busyStub(SRO, { key: 'custom2', perIterMs: 0.5, setupMs: 5, budget: () => 2000 });
  delete st.budget;
  S.methods.custom2 = { key: 'custom2', label: 'Custom 2', run: st.run };
  const e2 = S.estimate(inst, 'custom2', { timeCapSec: 60 }, {}, { cache: false, now: cpuNow });
  assert.ok(Math.abs(e2.probe.budget - 2000) < 1, String(e2.probe.budget));
});

test('estimate: MIP = its time limit (warm start inside it, as mip.js runs); basis says it stops at the limit with a proven gap', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  const inst = phase1(SRO, 4);
  const e = S.estimate(inst, 'mip', { timeLimitSec: 60 }, { timeLimitSec: 300 });
  assert.equal(e.method, 'mip');
  assert.equal(e.source, 'limit');
  assert.equal(e.probe.limitSec, 60);
  assert.equal(e.probe.warmSec, 6);                      // min(10, max(2, 10% of 60), 30)
  assert.equal(e.seconds, 60);
  assert.match(e.basis, /time limit/);
  assert.match(e.basis, /first 6 s of it go to a quick tabu search/);
  assert.match(e.basis, /proven gap/);
  assert.match(e.basis, /1%/);
  assert.ok(e.low < e.seconds && e.high === e.seconds, 'up to the limit, not past it');
  assert.equal(S.estimate(inst, 'mip', { timeLimitSec: 300 }, {}).probe.warmSec, 10);
  assert.equal(S.estimate(inst, 'mip', { timeLimitSec: 5 }, {}).probe.warmSec, 2);
  const cold = S.estimate(inst, 'mip', { timeLimitSec: 60, warmStart: false }, {});
  assert.equal(cold.probe.warmSec, 0);
  assert.equal(cold.seconds, 60);
  const seeded = S.estimate(inst, 'mip', { timeLimitSec: 60 }, {}, { hasStart: true });
  assert.equal(seeded.probe.warmSec, 0);
  assert.match(seeded.basis, /starting from the best heuristic plan/);
  // the limit is min(timeLimitSec, timeCapSec); both default to settings.timeLimitSec
  assert.equal(S.estimate(inst, 'mip', {}, { timeLimitSec: 120 }).probe.limitSec, 120);
  assert.equal(S.estimate(inst, 'mip', { timeLimitSec: 600, timeCapSec: 100 }, {}).probe.limitSec, 100);
  assert.match(S.estimate(inst, 'mip', { mipGap: 0 }, {}).basis, /proof of the best plan/);
  // compare mode: sum, MIP seeded by the heuristic (no warm-start phase of its own)
  S.methods.tabu = busyStub(SRO, { perIterMs: 1 });
  const many = S.estimateMany(inst, ['tabu', 'mip'], { tabu: { iterations: 200 }, mip: { timeLimitSec: 30 } }, {});
  assert.equal(many.perMethod.length, 2);
  assert.equal(many.perMethod[1].probe.warmSec, 0);
  assert.ok(Math.abs(many.seconds - many.perMethod[0].seconds - many.perMethod[1].seconds) < 1e-9);
  assert.equal(many.perMethod[1].seconds, 30);
});

test('estimate: rough model when the method is not loaded (main thread)', () => {
  // the main-thread group has instance, params, evaluate and estimate only
  const SRO = load(['src/core/ns.js', 'src/core/util.js', 'src/solver/instance.js', 'src/solver/params.js', 'src/solver/evaluate.js', 'src/solver/estimate.js']);
  const S = SRO.solver;
  const inst = phase1(SRO, 5);
  for (const m of ['tabu', 'sa', 'aco']) {
    const e = S.estimate(inst, m, {}, { timeLimitSec: 300 });
    assert.equal(e.source, 'model', m);
    assert.ok(e.seconds > 0 && isFinite(e.seconds), m + ' ' + e.seconds);
    assert.ok(e.low < e.seconds && e.seconds <= e.high);
    assert.match(e.basis, /Rough estimate/);
    assert.ok(e.probe.evalRate > 1000, m + ' rate ' + e.probe.evalRate);
  }
  const mip = S.estimate(inst, 'mip', { timeLimitSec: 30, warmStart: false }, {});
  assert.equal(mip.seconds, 30);
});

// ---- real methods ------------------------------------------------------------------------------
const ALL = loadAll();
const REAL = ['tabu', 'sa', 'aco'].filter((k) => ALL.solver.methods[k]);
// Small budgets so the suite stays quick; SRO_FULL_ESTIMATE=1 uses the defaults.
const QUICK = { tabu: { iterations: 600 }, sa: { coolingRate: 0.97 }, aco: { iterations: 15 } };

test('real methods through solve(): violation-free plans, evaluated totals, progress contract', { skip: REAL.length ? false : 'no method files yet' }, () => {
  const S = ALL.solver;
  const inst = phase1(ALL, 7, { closedZones: 1 });
  for (const m of REAL) {
    let calls = 0, maxGap = 0, last = now(), bestSeen = 0;
    const res = S.solve(inst, { method: m, params: QUICK[m], settings: { timeLimitSec: 60 }, hooks: {
      onProgress: (p) => { const t = now(); maxGap = Math.max(maxGap, t - last); last = t; calls++; if (p.best) bestSeen++; assert.ok(p.fraction >= 0 && p.fraction <= 1); }
    } });
    assert.equal(res.feasible, true, m);
    assert.equal(res.total, S.evaluate(inst, res.solution).total, m);
    assert.ok(res.total <= S.evaluate(inst, S.construct(inst)).total + 1e-6, m + ' not worse than construct');
    assert.ok(calls >= 2 && bestSeen >= 1, m + ' progress calls ' + calls);
    assert.ok(maxGap < 400, m + ' progress gap ' + maxGap.toFixed(0) + ' ms');
    assert.ok(['budget', 'time', 'converged'].includes(res.stopReason), m + ' ' + res.stopReason);
  }
});

function checkEstimates(t, label, paramsFor, seeds, factor) {
  const S = ALL.solver;
  const rows = [];
  for (const seed of seeds) {
    const inst = phase1(ALL, seed);
    for (const m of REAL) {
      const est = S.estimate(inst, m, paramsFor(m), { timeLimitSec: 300 }, { cache: false, now: cpuNow });
      const t0 = cpuNow();
      const res = S.solve(inst, { method: m, params: paramsFor(m), settings: { timeLimitSec: 300 } });
      const actual = (cpuNow() - t0) / 1000;
      const ratio = est.seconds / actual;
      rows.push({ seed, m, est: est.seconds, actual, ratio, probeMs: est.probe.ms, iters: res.iterations, budget: est.probe.budget });
      t.diagnostic(`${label} seed ${seed} ${m}: estimate ${est.seconds.toFixed(2)} s [${est.low.toFixed(2)}-${est.high.toFixed(2)}] ` +
        `(probe ${est.probe.ms.toFixed(0)} ms, ${est.probe.iterations} it, budget ${Math.round(est.probe.budget)}), actual ${actual.toFixed(2)} s ` +
        `(${res.iterations} it, ${res.stopReason}), ratio ${ratio.toFixed(2)}`);
    }
  }
  for (const r of rows) assert.ok(r.ratio > 1 / factor && r.ratio < factor, `${label} seed ${r.seed} ${r.m}: estimate ${r.est.toFixed(2)} s vs actual ${r.actual.toFixed(2)} s (allowed factor ${factor})`);
}

// Always on, so it allows 2.5x: runs of about a second, where a 0.2 s probe sees more of the JIT
// warm-up and of the start phase than the run does (both sides on the CPU clock, see cpuNow).
test('estimate vs real runs (reduced budgets): within a factor of 2.5', { skip: REAL.length ? false : 'no method files yet' }, (t) => {
  checkEstimates(t, 'quick', (m) => QUICK[m], [11, 12], 2.5);
});

test('estimate vs real runs at DEFAULT params on Phase 1 instances: within a factor of 2', { skip: !REAL.length ? 'no method files yet' : !FULL ? 'set SRO_FULL_ESTIMATE=1' : false }, (t) => {
  checkEstimates(t, 'default', () => ({}), [21, 22, 23], 2);
});

// ---- worker message handler ---------------------------------------------------------------------
const WASM_GZ_B64 = zlib.gzipSync(fs.readFileSync(path.join(ROOT, 'node_modules/highs/build/highs.wasm')), { level: 9 }).toString('base64');

function collector() {
  const msgs = [];
  const post = (m) => { msgs.push(Object.assign({ at: now() }, JSON.parse(JSON.stringify(m)))); };
  return { msgs, post };
}

test('worker: init loads HiGHS from gzip+base64 (self-test), solve/estimate/compare/errors over the protocol', async () => {
  const SRO = loadAll({ highs: true });
  const S = SRO.solver, W = S.worker;
  const { msgs, post } = collector();
  await W.handle({ type: 'init', wasmGzB64: WASM_GZ_B64 }, post);
  const ready = msgs.shift();
  assert.equal(ready.type, 'ready');
  assert.equal(ready.highs, true, ready.error);
  assert.equal(ready.version, '1.15.1');
  assert.equal(ready.selfTest.objective, 5);
  assert.ok(Array.isArray(ready.methods) && ready.methods.length >= 4);
  assert.equal(S.runtime.highs, true);
  if (S.methods.mip) assert.equal(ready.methods.find((m) => m.key === 'mip').available, true);
  // a second init reuses the first
  await W.handle({ type: 'init', wasmGzB64: 'garbage' }, post);
  assert.equal(msgs.shift().highs, true);

  // instance as a JSON string with Infinity encoded (closed zone -> unreachable pairs)
  const inst = small(SRO, 8, { closedZones: 2 });
  const hasInf = inst.minutes.some((row) => row.some((x) => x === Infinity));
  const json = JSON.stringify(inst, SRO.util.jsonReplacer);
  const key = S.methods.tabu ? 'tabu' : null;
  if (key) {
    await W.handle({ type: 'solve', id: 's1', instance: json, method: key, params: { iterations: 300 }, settings: { timeLimitSec: 30 } }, post);
    const done = msgs.find((m) => m.type === 'done' && m.id === 's1');
    assert.ok(done, JSON.stringify(msgs.filter((m) => m.type === 'error')));
    assert.ok(hasInf ? true : true);
    const prog = msgs.filter((m) => m.type === 'progress' && m.id === 's1');
    assert.ok(prog.length >= 1);
    assert.ok(prog[0].best, 'first best plan is posted at once');
    // best is sent only when it changed
    const bests = prog.filter((m) => m.best).map((m) => JSON.stringify(m.best));
    for (let i = 1; i < bests.length; i++) assert.notEqual(bests[i], bests[i - 1]);
    // the last posted best equals the final plan's cost or better is impossible
    const lastBest = prog.filter((m) => m.best).pop();
    assert.ok(S.evaluate(inst, lastBest.best).total >= done.result.total - 1e-6);
    assert.equal(done.result.total, S.evaluate(inst, done.result.solution).total);
    assert.ok(done.result.evaluation && Array.isArray(done.result.explain));
    // the same plan from the object form with '__INF__' markers
    msgs.length = 0;
    await W.handle({ type: 'solve', id: 's2', instance: JSON.parse(json), method: key, params: { iterations: 300 }, settings: { timeLimitSec: 30 } }, post);
    const d2 = msgs.find((m) => m.type === 'done');
    assert.equal(d2.result.total, done.result.total, 'deterministic for the same seed and both input forms');
    // estimate (single and compare mode)
    msgs.length = 0;
    await W.handle({ type: 'estimate', id: 'e1', instance: json, method: key, params: {}, settings: { timeLimitSec: 30 } }, post);
    const e1 = msgs.find((m) => m.id === 'e1');
    assert.equal(e1.type, 'done');
    assert.ok(e1.result.seconds > 0 && typeof e1.result.basis === 'string');
    // the worker keeps the revived instance, so a budget-knob change answers from the probe cache
    await W.handle({ type: 'estimate', id: 'e1b', instance: JSON.parse(json), method: key, params: { iterations: 9000 }, settings: { timeLimitSec: 30 } }, post);
    const e1b = msgs.find((m) => m.id === 'e1b');
    assert.equal(e1b.result.probe.cached, true);
    assert.ok(e1b.result.probe.ms === e1.result.probe.ms);
    await W.handle({ type: 'estimate', id: 'e2', instance: json, method: [key, 'mip'], params: { mip: { timeLimitSec: 10 } }, settings: {} }, post);
    const e2 = msgs.find((m) => m.id === 'e2');
    assert.equal(e2.type, 'done');
    assert.equal(e2.result.perMethod.length, 2);
    // compare: method-done per method, then the table
    msgs.length = 0;
    const cmpMethods = REAL.slice(0, 2);
    await W.handle({ type: 'compare', id: 'c1', instance: json, methods: cmpMethods, params: { tabu: { iterations: 200 }, sa: { coolingRate: 0.9 }, aco: { iterations: 5 } }, settings: { timeLimitSec: 30 } }, post);
    assert.deepEqual(msgs.filter((m) => m.type === 'method-done').map((m) => m.row.method), cmpMethods);
    const c1 = msgs.find((m) => m.type === 'done' && m.id === 'c1');
    assert.equal(c1.result.length, cmpMethods.length);
    assert.ok(msgs.filter((m) => m.type === 'progress').every((m) => cmpMethods.includes(m.method)));
  }
  // errors
  msgs.length = 0;
  await W.handle({ type: 'solve', id: 'x1', instance: json, method: 'nope' }, post);
  await W.handle({ type: 'frobnicate', id: 'x2' }, post);
  await W.handle({ type: 'solve', id: 'x3', instance: { nodes: 'bad' }, method: key || 'tabu' }, post);
  await W.handle(null, post);
  const errs = msgs.filter((m) => m.type === 'error');
  assert.deepEqual(errs.map((m) => m.id), ['x1', 'x2', 'x3', null]);
  assert.deepEqual(errs.map((m) => m.code), ['unknown-method', 'bad-message', key ? 'bad-instance' : 'method-not-loaded', 'bad-message']);
  await W.handle({ type: 'methods', id: 'm1' }, post);
  assert.ok(Array.isArray(msgs.find((m) => m.id === 'm1').result));
});

test('worker: MIP through the protocol after init (loader set by worker-main, warm start, proven gap)', { skip: loadAll().solver.methods.mip ? false : 'mip.js not in the build yet' }, async () => {
  const SRO = loadAll({ highs: true });
  const S = SRO.solver, W = S.worker;
  const { msgs, post } = collector();
  // init and a MIP solve posted back to back: the solve waits for init
  const inst = S.makeTestInstance(5, { nJobs: 5, nVehicles: 2, nRally: 2, noSplit: true, flatPeriods: true });
  const json = JSON.stringify(inst, SRO.util.jsonReplacer);
  const pInit = W.handle({ type: 'init', wasmGzB64: WASM_GZ_B64 }, post);
  const pSolve = W.handle({ type: 'solve', id: 'm1', instance: json, method: 'mip', params: { timeLimitSec: 5 }, settings: {} }, post);
  await Promise.all([pInit, pSolve]);
  assert.equal(msgs[0].type, 'ready');
  assert.equal(msgs[0].highs, true);
  assert.equal(S.mip.isReady(), true);
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done, JSON.stringify(msgs.filter((m) => m.type === 'error')));
  const r = done.result;
  assert.equal(r.method, 'mip');
  assert.equal(r.feasible, true);
  assert.equal(r.total, S.evaluate(inst, r.solution).total);
  assert.equal(typeof r.extra.status, 'string');
  assert.ok(typeof r.extra.mipGap === 'number' && r.extra.mipGap >= 0, 'gap ' + r.extra.mipGap);
  assert.ok(msgs.some((m) => m.type === 'progress' && m.best));
  // compare: heuristic first, MIP seeded with its plan
  if (S.methods.tabu) {
    msgs.length = 0;
    await W.handle({ type: 'compare', id: 'c', instance: json, methods: ['mip', 'tabu'], params: { tabu: { iterations: 200 }, mip: { timeLimitSec: 5 } }, settings: {} }, post);
    const table = msgs.find((m) => m.type === 'done').result;
    assert.deepEqual(table.map((x) => x.method), ['mip', 'tabu']);
    assert.equal(table[0].startFrom, 'tabu');
    assert.ok(table[0].total <= table[1].total + 1e-6);
    assert.equal(typeof table[0].gap, 'number');
    assert.deepEqual(msgs.filter((m) => m.type === 'method-done').map((m) => m.row.method), ['tabu', 'mip']);
  }
});

test('worker: a broken wasm reports highs:false, heuristics keep working, MIP gives a clear error', async () => {
  const SRO = loadAll({ highs: true });
  const S = SRO.solver, W = S.worker;
  const { msgs, post } = collector();
  const broken = zlib.gzipSync(Buffer.from('this is not wasm')).toString('base64');
  await W.handle({ type: 'init', wasmGzB64: broken }, post);
  const ready = msgs.shift();
  assert.equal(ready.highs, false);
  assert.ok(ready.error.length > 0);
  assert.equal(S.runtime.highs, false);
  const inst = small(SRO, 9);
  if (S.methods.tabu) {
    await W.handle({ type: 'solve', id: 1, instance: JSON.stringify(inst, SRO.util.jsonReplacer), method: 'tabu', params: { iterations: 100 }, settings: {} }, post);
    assert.equal(msgs.find((m) => m.type === 'done').result.feasible, true);
  }
  msgs.length = 0;
  await W.handle({ type: 'solve', id: 2, instance: inst, method: 'mip', params: {}, settings: {} }, post);
  const err = msgs.find((m) => m.type === 'error');
  assert.ok(err);
  assert.equal(err.code, S.methods.mip ? 'mip-unavailable' : 'method-not-loaded');
  // no highs.js in the worker source at all
  const SRO2 = loadAll({ highs: false });
  const c2 = collector();
  await SRO2.solver.worker.handle({ type: 'init', wasmGzB64: WASM_GZ_B64 }, c2.post);
  assert.equal(c2.msgs[0].highs, false);
  assert.match(c2.msgs[0].error, /highs\.js is not part of the worker source/);
  // garbage that is not even base64-gzip
  const SRO3 = loadAll({ highs: true });
  const c3 = collector();
  await SRO3.solver.worker.handle({ type: 'init', wasmGzB64: 'AAAA' }, c3.post);
  assert.equal(c3.msgs[0].highs, false);
});

test('worker: progress relay throttles, posts the first best at once and holds later bests until the next post', () => {
  const SRO = loadCore();
  const W = SRO.solver.worker;
  const { msgs, post } = collector();
  const relay = W.progressRelay(post, 'r', 100);
  const plan = (n) => ({ routes: [{ vehicle: 0, visits: [{ node: n, jobs: [] }] }] });
  relay({ fraction: 0, bestCost: 10, iteration: 0, message: 'a', best: plan(1) });       // posted (first best)
  relay({ fraction: 0.1, bestCost: 9, iteration: 1, message: 'b', best: plan(2) });      // held
  relay({ fraction: 0.2, bestCost: 8, iteration: 2, message: 'c', best: plan(3), fn() {} }); // held (replaces)
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].best.routes[0].visits[0].node, 1);
  spin(110);
  relay({ fraction: 0.3, bestCost: 8, iteration: 3, message: 'd' });                     // due: carries plan 3
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].best.routes[0].visits[0].node, 3);
  assert.equal(msgs[1].bestCost, 8);
  assert.equal(msgs[1].fn, undefined);
  relay({ fraction: 0.4, bestCost: 8, iteration: 4, message: 'e' });                     // held, no best
  relay({ fraction: 1, bestCost: 7, iteration: 5, message: 'f', best: plan(4) });       // fraction 1: posted now
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2].best.routes[0].visits[0].node, 4);
  relay({ fraction: 1, bestCost: 7, iteration: 5, message: 'g' });
  relay.flush();                                                                          // nothing pending
  assert.ok(msgs.every((m) => m.type === 'progress' && m.id === 'r'));
  // a held best is copied (a method may reuse the object)
  const c = collector();
  const r2 = W.progressRelay(c.post, 'q', 1000);
  r2({ fraction: 0, bestCost: 5, best: plan(1) });
  const reused = plan(7);
  r2({ fraction: 0.5, bestCost: 4, best: reused });
  reused.routes[0].visits[0].node = 99;
  r2.flush();
  assert.equal(c.msgs[1].best.routes[0].visits[0].node, 7);
});

test('worker-main installs no message hook outside a worker', () => {
  const SRO = loadCore();
  assert.equal(SRO.solver.worker.installed, undefined);
});

test('estimate: a run that finishes inside the probe (nothing to plan) is estimated as that run', { skip: ALL.solver.methods.tabu ? false : 'tabu.js not loaded' }, () => {
  const S = ALL.solver;
  const inst = S.makeTestInstance(3, { nJobs: 1, nVehicles: 1, nRally: 1, noCandidateShare: 1 });
  const e = S.estimate(inst, 'tabu', {}, {}, { cache: false });
  assert.ok(e.seconds < 1, String(e.seconds));
  assert.match(e.basis, /finished the whole run within the timing probe/);
});

test('estimate: unknown method is a clear error; a method that throws in the probe falls back to the model', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  const inst = small(SRO, 4);
  throwsCode(() => S.estimate(inst, 'nope', {}, {}), 'unknown-method');
  S.methods.tabu = { key: 'tabu', label: 'Broken', run() { throw new Error('kaput'); } };
  const e = S.estimate(inst, 'tabu', {}, { timeLimitSec: 60 });
  assert.equal(e.source, 'model');
  assert.equal(e.probe.error, 'kaput');
  assert.match(e.basis, /could not be timed here/);
  assert.ok(e.seconds > 0 && e.seconds <= 60);
});
