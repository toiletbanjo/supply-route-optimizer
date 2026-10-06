// Adversarial review tests for the solver runtime (api.js, estimate.js, worker-main.js).
//
//   node --test tests/solver/runtime-review.test.mjs
//
// Each test targets a way the runtime could mislead the planner or break the worker protocol:
// estimates reused for the wrong budget, probes fooled by lumpy work, unreadable input, progress
// cadence lost in the relay, Infinity across the boundary, compare-table bookkeeping, error codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { ROOT, wrapSource } from '../load.mjs';

const CORE = ['src/core/ns.js', 'src/core/util.js', 'src/solver/instance.js', 'src/solver/params.js',
  'src/solver/evaluate.js', 'src/solver/construct.js', 'src/solver/localsearch.js'];
const RUNTIME = ['src/solver/estimate.js', 'src/solver/api.js', 'src/solver/worker-main.js'];
const MAIN_THREAD = ['src/core/ns.js', 'src/core/util.js', 'src/solver/instance.js', 'src/solver/params.js',
  'src/solver/evaluate.js', 'src/solver/estimate.js'];

function manifestWorkerFiles() {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/manifest.json'), 'utf8'));
  return m.worker.map((f) => f.replace(/\?$/, '')).filter((f) => fs.existsSync(path.join(ROOT, f)));
}
// Fresh vm context with the Blob-worker globals; highs.js first in the same context when asked
// (the Blob worker source is highs.js text + the worker files).
function load(files, { highs = false, perf = performance } = {}) {
  const ctx = { console, setTimeout, clearTimeout, performance: perf, atob, Blob, Response, DecompressionStream };
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
const WASM_GZ_B64 = zlib.gzipSync(fs.readFileSync(path.join(ROOT, 'node_modules/highs/build/highs.wasm')), { level: 9 }).toString('base64');

const PHASE1 = { nJobs: 30, nVehicles: 8, nRally: 8, nHubs: 3, capacity: { tanker: 7500, cargo: 30 }, deadlineMax: 900, directShare: 0.3 };
const now = () => performance.now();
// The estimate-vs-run tests time both sides on this process's CPU clock (the estimator takes it as
// opts.now; the stubs spin on it), so other processes on a busy machine (npm test runs the test files
// in parallel) cannot stretch one side and not the other.
const cpuNow = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const CPU = { now: cpuNow };
function spin(ms) { const end = cpuNow() + ms; while (cpuNow() < end) { /* busy */ } }
function collector(clock = now) {
  const msgs = [];
  return { msgs, post: (m) => msgs.push(Object.assign({ at: clock() }, m)) };
}
function timed(fn) { const t0 = cpuNow(); const r = fn(); return { r, sec: (cpuNow() - t0) / 1000 }; }
// A timing comparison measured up to `tries` times: passes as soon as one measurement is within the
// bound (the bound itself is not relaxed). For checks whose short sample (the model's 80 ms evaluate
// sample, a 0.2 s probe) one burst of other work on the machine can spoil; returns the last message.
function withinTries(tries, measure) {
  let last = '';
  for (let k = 0; k < tries; k++) {
    const r = measure(k);
    if (r.ok) return { ok: true, msg: r.msg, tries: k + 1 };
    last = r.msg;
  }
  return { ok: false, msg: last + ' (' + tries + ' measurements)', tries };
}

// Interface-following stub with a controllable cost profile:
//   startMs     work after the first progress call (iteration 0) before the first iteration; shouldStop
//               is asked every 100 ms of it (like tabu's start localSearch chunks)
//   stepMs      cost of one walk step (one shouldStop call per step)
//   restartEvery / restartMs / restartCharge
//               every restartEvery steps a "restart" of restartMs that is charged restartCharge
//               iterations at once and asks shouldStop only once (like tabu's restarts)
function profileStub(SRO, { key = 'tabu', startMs = 0, stepMs = 1, restartEvery = 0, restartMs = 0, restartCharge = 0 } = {}) {
  const S = SRO.solver;
  return {
    key, label: 'Profile stub',
    run(instance, p, hooks) {
      const t0 = hooks.now();
      const sol = S.construct(instance);
      const ev = S.evaluate(instance, sol, { costOnly: true });
      hooks.onProgress({ fraction: 0, bestCost: ev.total, elapsedSec: 0, iteration: 0, message: 'start', best: sol });
      const maxIt = p.iterations;
      let it = 0, steps = 0, last = hooks.now(), stopReason = 'budget';
      const done = (reason) => ({ solution: sol, total: ev.total, feasible: ev.feasible, evals: it, iterations: it,
        elapsedSec: (hooks.now() - t0) / 1000, stopReason: reason, history: [] });
      for (let left = startMs; left > 0; left -= 100) {
        spin(Math.min(100, left));
        if (hooks.shouldStop()) return done('stopped');
      }
      while (it < maxIt) {
        if (hooks.shouldStop()) { stopReason = 'stopped'; break; }
        if (restartEvery && steps > 0 && steps % restartEvery === 0) {
          spin(restartMs);
          it = Math.min(maxIt, it + restartCharge);
          steps++;
        } else {
          spin(stepMs);
          it++; steps++;
        }
        if (hooks.now() - last >= 100 || it >= maxIt) {
          last = hooks.now();
          hooks.onProgress({ fraction: Math.min(1, it / maxIt), bestCost: ev.total, elapsedSec: (last - t0) / 1000, iteration: it, message: 'step ' + it });
        }
      }
      return done(stopReason);
    }
  };
}

// ---- estimate.js ---------------------------------------------------------------------------------
test('estimate: a run that finished inside the probe is not reused for a longer budget (cache key leaves the budget out)', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  const inst = S.makeTestInstance(1, PHASE1);
  S.methods.tabu = profileStub(SRO, { stepMs: 1 });
  const settings = { timeLimitSec: 300 };
  const short = S.estimate(inst, 'tabu', { iterations: 100 }, settings, CPU);
  assert.ok(short.seconds < 1, 'iterations 100 at 1 ms: ' + short.seconds);
  const long = S.estimate(inst, 'tabu', { iterations: 3000 }, settings, CPU);
  const { sec } = timed(() => S.solve(inst, { method: 'tabu', params: { iterations: 3000 }, settings }));
  const ratio = long.seconds / sec;
  assert.ok(ratio > 0.5 && ratio < 2, `iterations 3000 estimated ${long.seconds.toFixed(2)} s after a cached 100-iteration probe, actual ${sec.toFixed(2)} s`);
  assert.doesNotMatch(long.basis, /finished the whole run within the timing probe/);
  // back to the small budget: answered from the cached longer probe (its iteration curve), no new probe
  const again = S.estimate(inst, 'tabu', { iterations: 100, seed: 9 }, settings, CPU);
  assert.equal(again.probe.cached, true);
  assert.ok(again.seconds < 1 && Math.abs(again.seconds - short.seconds) < 0.5, again.seconds + ' vs ' + short.seconds + ': ' + again.basis);
});

test('estimate: real SA, a fast schedule that ends inside the probe does not answer for a slow one', { skip: loadAll().solver.methods.sa ? false : 'sa.js not loaded' }, () => {
  const SRO = loadAll();
  const S = SRO.solver;
  const inst = S.makeTestInstance(2, PHASE1);
  const settings = { timeLimitSec: 300 };
  const fast = S.estimate(inst, 'sa', { coolingRate: 0.8, reheats: 0 }, settings, CPU);
  const slow = S.estimate(inst, 'sa', { coolingRate: 0.99 }, settings, CPU);
  // 0.99 needs ~60x the proposals of 0.8 with no reheats
  assert.ok(slow.seconds > 10 * fast.seconds, `coolingRate 0.99: ${slow.seconds.toFixed(2)} s vs 0.8: ${fast.seconds.toFixed(2)} s (${slow.basis})`);
  const { sec } = timed(() => S.solve(inst, { method: 'sa', params: { coolingRate: 0.99 }, settings }));
  const ratio = slow.seconds / sec;
  assert.ok(ratio > 0.4 && ratio < 2.5, `estimate ${slow.seconds.toFixed(2)} s vs actual ${sec.toFixed(2)} s`);
});

test('estimate: lumpy work (iterations charged in bulk with few shouldStop calls, like tabu restarts) is not underestimated', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  const inst = S.makeTestInstance(3, PHASE1);
  // walk steps 0.2 ms; every 40 steps a 160 ms restart charged 160 iterations: about 0.8 ms per iteration
  S.methods.tabu = profileStub(SRO, { stepMs: 0.2, restartEvery: 40, restartMs: 160, restartCharge: 160 });
  const settings = { timeLimitSec: 300 };
  const est = S.estimate(inst, 'tabu', { iterations: 2000 }, settings, { cache: false, now: cpuNow });
  const { sec } = timed(() => S.solve(inst, { method: 'tabu', params: { iterations: 2000 }, settings }));
  const ratio = est.seconds / sec;
  assert.ok(ratio > 0.5 && ratio < 2, `estimate ${est.seconds.toFixed(2)} s vs actual ${sec.toFixed(2)} s (ratio ${ratio.toFixed(2)}): ${est.basis}`);
});

test('estimate: real tabu with frequent restarts (restartAfter 50) within 2x', { skip: loadAll().solver.methods.tabu ? false : 'tabu.js not loaded' }, () => {
  const SRO = loadAll();
  const S = SRO.solver;
  const settings = { timeLimitSec: 300 };
  for (const seed of [43, 44]) {
    const inst = S.makeTestInstance(seed, PHASE1);
    const params = { restartAfter: 50, iterations: 2000 };
    const r = withinTries(2, () => {
      const est = S.estimate(inst, 'tabu', params, settings, { cache: false, now: cpuNow });
      const { sec } = timed(() => S.solve(inst, { method: 'tabu', params, settings }));
      const ratio = est.seconds / sec;
      return { ok: ratio > 0.5 && ratio < 2, msg: `seed ${seed}: estimate ${est.seconds.toFixed(2)} s vs actual ${sec.toFixed(2)} s (ratio ${ratio.toFixed(2)})` };
    });
    assert.ok(r.ok, r.msg);
  }
});

test('estimate: a probe that ends before the first iteration (long start phase) gives a sane number, not budget x probe time', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  const inst = S.makeTestInstance(4, PHASE1);
  S.methods.tabu = profileStub(SRO, { startMs: 1500, stepMs: 1 });
  const settings = { timeLimitSec: 300 };
  const est = S.estimate(inst, 'tabu', { iterations: 1000 }, settings, { cache: false, now: cpuNow });
  const { sec } = timed(() => S.solve(inst, { method: 'tabu', params: { iterations: 1000 }, settings }));
  assert.ok(est.seconds < 4 * sec, `estimate ${est.seconds.toFixed(2)} s vs actual ${sec.toFixed(2)} s: ${est.basis}`);
  assert.ok(est.seconds >= 0.5 * sec, `estimate ${est.seconds.toFixed(2)} s vs actual ${sec.toFixed(2)} s`);
  assert.equal(est.capped, false);
});

// The model is rough by design (it states a 2.5x range); 3x leaves room for the JIT state and cache
// effects that differ between the model's short throughput sample and the run. Before the SA constant was re-measured SA came out at 0.21-0.5x.
test('estimate: main-thread model (methods not loaded) within 3x of real tabu and SA runs', { skip: loadAll().solver.methods.sa && loadAll().solver.methods.tabu ? false : 'methods not loaded' }, (t) => {
  const MAIN = load(MAIN_THREAD);
  const ALL = loadAll();
  const settings = { timeLimitSec: 300 };
  const params = { tabu: { iterations: 1000 }, sa: { coolingRate: 0.98 } };
  for (const [seed, shape] of [[5, PHASE1], [6, { nJobs: 12, nVehicles: 4, nRally: 5 }]]) {
    for (const m of ['tabu', 'sa']) {
      const inst = ALL.solver.makeTestInstance(seed, shape);
      ALL.solver.solve(inst, { method: m, params: { iterations: 100, coolingRate: 0.8, reheats: 0 }, settings });   // JIT warm
      const r = withinTries(3, () => {
        const e = MAIN.solver.estimate(MAIN.solver.makeTestInstance(seed, shape), m, params[m], settings, { cache: false, now: cpuNow });
        assert.equal(e.source, 'model');
        const { sec } = timed(() => ALL.solver.solve(inst, { method: m, params: params[m], settings }));
        const ratio = e.seconds / sec;
        return { ok: ratio > 1 / 3 && ratio < 3, msg: `seed ${seed} ${m}: model ${e.seconds.toFixed(2)} s vs actual ${sec.toFixed(2)} s (ratio ${ratio.toFixed(2)})` };
      });
      t.diagnostic(r.msg + (r.tries > 1 ? ' after ' + r.tries + ' measurements' : ''));
      assert.ok(r.ok, r.msg);
    }
  }
});

test('estimate: missing or invalid instance is a bad-instance error the UI can show', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  for (const bad of [null, undefined, 'x', { nodes: 'bad' }]) {
    let err = null;
    try { S.estimate(bad, 'tabu', {}, {}); } catch (e) { err = e; }
    assert.ok(err, 'no error for ' + JSON.stringify(bad));
    assert.equal(err.code, 'bad-instance', String(err && err.message));
    assert.match(err.message, /^The plan cannot be solved: /);
  }
});

// ---- worker-main.js ------------------------------------------------------------------------------
test('worker: missing, malformed or invalid instance data gives a coded error, not a raw JSON message', async () => {
  const SRO = loadCore();
  const W = SRO.solver.worker;
  SRO.solver.methods.tabu = profileStub(SRO, {});
  const { msgs, post } = collector();
  await W.handle({ type: 'solve', id: 'a', method: 'tabu', params: { iterations: 100 } }, post);
  await W.handle({ type: 'solve', id: 'b', method: 'tabu', instance: '{"nodes":' }, post);
  await W.handle({ type: 'estimate', id: 'c', method: 'tabu', params: {} }, post);
  await W.handle({ type: 'compare', id: 'd', methods: ['tabu'], instance: 'not json' }, post);
  const inst = SRO.solver.makeTestInstance(1, { nJobs: 4, nVehicles: 2, nRally: 2 });
  await W.handle({ type: 'solve', id: 'e', method: 'tabu', instance: inst, start: '{"routes":[' }, post);
  const errs = msgs.filter((m) => m.type === 'error');
  assert.deepEqual(errs.map((m) => m.id), ['a', 'b', 'c', 'd', 'e']);
  for (const e of errs) {
    assert.ok(['bad-instance', 'bad-message'].includes(e.code), e.id + ': ' + e.code + ' ' + e.message);
    // a plain-language lead (any technical detail only in parentheses after it)
    assert.match(e.message, /^The plan cannot be solved: /, e.id + ': ' + e.message);
    assert.doesNotMatch(e.message.split('(')[0], /JSON|undefined|Unexpected/, e.id + ': ' + e.message);
  }
  assert.deepEqual(errs.map((m) => m.code), ['bad-instance', 'bad-instance', 'bad-instance', 'bad-instance', 'bad-message']);
});

test('worker: Infinity survives every input form (structured clone object, JSON string, __INF__ object) with the same result', async () => {
  const SRO = loadAll();
  const S = SRO.solver, W = S.worker;
  if (!S.methods.tabu) return;
  const inst = S.makeTestInstance(7, { nJobs: 10, nVehicles: 4, nRally: 4 });
  // cut off every candidate of job 0: only an Infinity-aware evaluation calls it 'closed-road'
  const cut = inst.jobs[0].candidates.map((c) => c.node);
  for (const n of cut) for (let i = 0; i < inst.nodes.length; i++) if (i !== n) { inst.minutes[i][n] = Infinity; inst.minutes[n][i] = Infinity; }
  const json = JSON.stringify(inst, SRO.util.jsonReplacer);
  const forms = { clone: structuredClone(inst), string: json, markers: JSON.parse(json) };
  const totals = {};
  for (const [k, raw] of Object.entries(forms)) {
    const { msgs, post } = collector();
    await W.handle({ type: 'solve', id: k, instance: raw, method: 'tabu', params: { iterations: 200 }, settings: {} }, post);
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, k + ': ' + JSON.stringify(msgs.find((m) => m.type === 'error')));
    const ex0 = done.result.explain.find((x) => x.job === 0);
    assert.equal(ex0 && ex0.reason, 'closed-road', k);
    assert.equal(done.result.feasible, true, k);
    totals[k] = done.result.total;
  }
  assert.equal(totals.clone, totals.string);
  assert.equal(totals.markers, totals.string);
  // the page's own object is not changed by the worker (main-thread fallback shares objects)
  assert.equal(forms.clone.minutes[0][cut[0]], Infinity);
});

test('worker: the progress relay keeps a ~100 ms method cadence (no aliasing to every other message)', () => {
  // virtual clock (the relay reads performance.now()), so a busy machine cannot stretch the gaps
  const clock = { t: 1000 };
  const SRO = load(CORE.concat(RUNTIME), { perf: { now: () => clock.t } });
  const W = SRO.solver.worker;
  const { msgs, post } = collector(() => clock.t);
  const relay = W.progressRelay(post, 'r');
  // a method reporting every 95 ms (its own 100 ms throttle with a little jitter)
  for (let i = 0; i < 12; i++) {
    relay({ fraction: i / 12, bestCost: 100 - i, iteration: i, message: 'm' + i });
    clock.t += 95;
  }
  let maxGap = 0;
  for (let i = 1; i < msgs.length; i++) maxGap = Math.max(maxGap, msgs[i].at - msgs[i - 1].at);
  assert.ok(msgs.length >= 11, 'posted ' + msgs.length + ' of 12');
  assert.ok(maxGap < 150, 'max gap ' + maxGap.toFixed(0) + ' ms');
});

test('worker: protocol shapes (ready, progress, done, error) match DESIGN.md', async () => {
  const SRO = loadAll({ highs: true });
  const S = SRO.solver, W = S.worker;
  const { msgs, post } = collector();
  await W.handle({ type: 'init', wasmGzB64: WASM_GZ_B64 }, post);
  const ready = msgs.shift();
  assert.equal(ready.type, 'ready');
  assert.equal(typeof ready.highs, 'boolean');
  assert.equal(ready.highs, true, ready.error);
  if (!S.methods.tabu) return;
  const inst = S.makeTestInstance(8, { nJobs: 10, nVehicles: 4, nRally: 4 });
  await W.handle({ type: 'solve', id: 7, instance: JSON.stringify(inst, SRO.util.jsonReplacer), method: 'tabu', params: { iterations: 300 }, settings: {} }, post);
  const prog = msgs.filter((m) => m.type === 'progress');
  assert.ok(prog.length >= 1);
  for (const p of prog) {
    assert.equal(p.id, 7);
    for (const f of ['fraction', 'bestCost', 'elapsedSec', 'iteration']) assert.equal(typeof p[f], 'number', f);
    assert.equal(typeof p.message, 'string');
    assert.ok(p.fraction >= 0 && p.fraction <= 1);
  }
  const done = msgs.find((m) => m.type === 'done');
  assert.equal(done.id, 7);
  assert.ok(done.result && Array.isArray(done.result.solution.routes));
  assert.ok(msgs.indexOf(done) > msgs.indexOf(prog[prog.length - 1]), 'done comes after the last progress');
  // the last posted best plan is the final plan or a costlier one (Cancel keeps something sound)
  const lastBest = prog.filter((p) => p.best).pop();
  assert.ok(S.evaluate(inst, lastBest.best).total >= done.result.total - 1e-6);
  // a method that throws mid-run: error with the request id and code, after any progress
  S.methods.sa = { key: 'sa', label: 'Broken', run(instance, p, hooks) { hooks.onProgress({ fraction: 0, bestCost: 1, elapsedSec: 0, iteration: 0, message: 'x' }); throw new Error('kaput'); } };
  msgs.length = 0;
  await W.handle({ type: 'solve', id: 'x', instance: inst, method: 'sa', params: {}, settings: {} }, post);
  const err = msgs.find((m) => m.type === 'error');
  assert.equal(err.id, 'x');
  assert.equal(err.code, 'method-failed');
  assert.match(err.message, /kaput/);
});

test('worker: compare after a failed HiGHS init keeps the heuristic rows and reports MIP as unavailable', async () => {
  const SRO = loadAll({ highs: true });
  const S = SRO.solver, W = S.worker;
  if (!S.methods.tabu || !S.methods.mip) return;
  const { msgs, post } = collector();
  await W.handle({ type: 'init', wasmGzB64: zlib.gzipSync(Buffer.from('junk')).toString('base64') }, post);
  assert.equal(msgs.shift().highs, false);
  const inst = S.makeTestInstance(9, { nJobs: 8, nVehicles: 3, nRally: 3 });
  await W.handle({ type: 'compare', id: 'c', instance: inst, methods: ['mip', 'tabu'], params: { tabu: { iterations: 200 } }, settings: {} }, post);
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done, JSON.stringify(msgs.find((m) => m.type === 'error')));
  const [mip, tabu] = done.result;
  assert.equal(mip.method, 'mip');
  assert.equal(mip.code, 'mip-unavailable');
  assert.match(mip.error, /heuristic methods still work/);
  assert.equal(tabu.feasible, true);
  assert.equal(tabu.best, true);
  assert.deepEqual(msgs.filter((m) => m.type === 'method-done').map((m) => m.row.method), ['tabu', 'mip']);
});

// ---- api.js --------------------------------------------------------------------------------------
test('compare: MIP is seeded with the best FEASIBLE heuristic plan, and its run does not change the heuristic rows', async () => {
  const SRO = loadAll({ highs: true });
  const S = SRO.solver, W = S.worker;
  if (!S.methods.mip) return;
  await W.handle({ type: 'init', wasmGzB64: WASM_GZ_B64 }, () => {});
  const inst = S.makeTestInstance(10, { nJobs: 10, nVehicles: 4, nRally: 4 });
  // 'tabu' returns a cheap-looking plan with a violation (a fuel job on a cargo truck); 'sa' a sound plan
  const sound = S.construct(inst);
  const broken = S.cloneSolution(sound);
  const fj = inst.jobs.findIndex((j) => j.group === 'fuel');
  const cv = inst.vehicles.findIndex((v) => v.type === 'cargo');
  broken.routes[cv].visits.push({ node: inst.jobs[fj].candidates[0].node, jobs: [{ job: fj, qty: inst.jobs[fj].qty }] });
  const stub = (sol) => ({ label: 'stub', run: (i, p, h) => ({ solution: sol, total: 0, feasible: true, stopReason: 'budget', iterations: 1, evals: 1, elapsedSec: 0, history: [] }) });
  S.methods.tabu = Object.assign(stub(broken), { key: 'tabu' });
  S.methods.sa = Object.assign(stub(sound), { key: 'sa' });
  const snap = {};
  const table = S.compare(inst, ['tabu', 'sa', 'mip'], { params: { mip: { timeLimitSec: 5 } }, onMethodDone: (r) => { if (r.result) snap[r.method] = JSON.stringify(r.result.solution); } });
  const by = Object.fromEntries(table.map((r) => [r.method, r]));
  assert.equal(by.tabu.feasible, false);
  assert.equal(by.mip.startFrom, 'sa');
  assert.equal(by.tabu.best, false);
  for (const k of ['tabu', 'sa', 'mip']) {
    assert.equal(JSON.stringify(by[k].result.solution), snap[k], k + ' plan changed after its row was posted');
    assert.equal(by[k].total, S.evaluate(inst, by[k].result.solution).total, k);
  }
  assert.ok(by.mip.total <= by.sa.total + 1e-6);
  assert.equal(table.filter((r) => r.best).length, 1);
});

test('compare: when every heuristic fails, MIP runs without a seed and the failures are rows, not a thrown error', () => {
  const SRO = loadCore();
  const S = SRO.solver;
  const inst = S.makeTestInstance(11, { nJobs: 6, nVehicles: 2, nRally: 2 });
  S.methods.tabu = { key: 'tabu', label: 'T', run() { throw new Error('t broke'); } };
  S.methods.sa = { key: 'sa', label: 'S', run() { return { total: 1 }; } };
  let mipStart = 'unset';
  S.methods.mip = { key: 'mip', label: 'M', run(i, p, h) { mipStart = h.start; const sol = S.construct(i); return { solution: sol, total: S.evaluate(i, sol).total, stopReason: 'time', extra: { status: 'Time limit reached', mipGap: 0.1 } }; } };
  S.setHighsStatus(true);
  S.mip = { isReady: () => true };
  const table = S.compare(inst, ['tabu', 'sa', 'mip'], {});
  assert.equal(mipStart, undefined);
  const by = Object.fromEntries(table.map((r) => [r.method, r]));
  assert.equal(by.tabu.code, 'method-failed');
  assert.equal(by.sa.code, 'bad-result');
  assert.equal(by.mip.startFrom, null);
  assert.equal(by.mip.best, true);
  assert.equal(by.mip.gap, 0.1);
});
