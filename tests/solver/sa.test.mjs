// Simulated annealing (src/solver/sa.js): registration and budget, every knob used, plan validity
// (violation-free, total = evaluate), determinism per seed, progress protocol, time cap, shouldStop,
// auto start temperature (ignores violation samples), brute-force optimum on tiny instances, and the
// quality check on 10 Phase 1 instances against construct + localSearch and a 10x multi-start run.
//
// Quality check (results are budget-bound, never time-bound, so they do not depend on machine speed or
// load, and the tolerances are not flaky):
//   default            SA with default params except itersPerTemp 10 (a tenth of the default budget);
//                      reference = best of 10 seeds at that budget (10x) and construct + localSearch.
//   SA_QUALITY=full    SA with the true default params; reference = best of 10 seeds at the default
//                      budget (10x). 10 x 11 runs of ~10 s each, spread over worker threads.
// SA_QUALITY_LOG=1 prints the per-instance table. Skip it with --test-skip-pattern=quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadScripts, ROOT } from '../load.mjs';
import { tinyInstance, bruteForce, randomSolution, plain } from './fixtures.mjs';

const FILES = [
  'src/core/ns.js',
  'src/core/util.js',
  'src/solver/instance.js',
  'src/solver/params.js',
  'src/solver/evaluate.js',
  'src/solver/construct.js',
  'src/solver/localsearch.js',
  'src/solver/sa.js'
];
const SRO = loadScripts(FILES);
const S = SRO.solver;
const SA = S.methods.sa;

// Phase 1 size: 30 jobs, 8 trucks, 10 rally candidates (max 8 used), 3 hubs, deadlines within 1-10 h,
// 3 risk zones.
const P1 = {
  nJobs: 30, nVehicles: 8, nRally: 10, nHubs: 3, maxRallyPoints: 8, capacity: { tanker: 7500, cargo: 30 },
  deadlineMin: 60, deadlineMax: 600, riskZones: 3, directShare: 0.3
};
const phase1 = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({}, P1, extra));
const small = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({ nJobs: 12, nVehicles: 4, nRally: 5, nHubs: 2 }, extra));
const fast = (extra = {}) => Object.assign({ timeCapSec: 60, itersPerTemp: 10, coolingRate: 0.99 }, extra);
const rel = (a, b) => (a - b) / Math.max(1, Math.abs(b));

function checkResult(inst, res, label) {
  assert.ok(res && res.solution, label + ': has a solution');
  const ev = S.evaluate(inst, res.solution);
  assert.equal(ev.violations.length, 0, label + ': no violations ' + JSON.stringify(ev.violations.slice(0, 2)));
  assert.equal(res.feasible, true, label + ': feasible');
  assert.equal(res.total, ev.total, label + ': total equals evaluate().total');
  assert.ok(S.isNormalized(inst, res.solution), label + ': normalized');
  assert.ok(Number.isInteger(res.iterations) && res.iterations >= 0, label + ': iterations');
  assert.ok(res.evals >= res.iterations - res.extra.nullMoves, label + ': evals');
  assert.ok(['budget', 'time', 'stopped', 'converged'].includes(res.stopReason), label + ': stopReason ' + res.stopReason);
  assert.ok(Array.isArray(res.history) && res.history.length >= 1, label + ': history');
  for (let i = 1; i < res.history.length; i++) {
    assert.ok(res.history[i].best <= res.history[i - 1].best + 1e-9, label + ': history best never goes up');
    assert.ok(res.history[i].t >= res.history[i - 1].t, label + ': history time order');
  }
  return ev;
}

test('registered as SRO.solver.methods.sa; budget() follows the cooling schedule knobs', () => {
  assert.equal(SA.key, 'sa');
  assert.equal(SA.label, 'Simulated annealing');
  assert.equal(typeof SA.run, 'function');
  const d = S.defaultParams('sa');
  const sch = SA.schedule(d);
  // defaults: cool 0.995 from 1 to 0.001 (1379 steps), 2 reheats from 0.3 (1138 steps each), 100 moves/step
  assert.equal(sch.stepsFirst, Math.ceil(Math.log(0.001) / Math.log(0.995)));
  assert.equal(sch.stepsReheat, Math.ceil(Math.log(0.001 / SA._cfg.reheatFrac) / Math.log(0.995)));
  assert.equal(SA.budget(null, d), (sch.stepsFirst + 2 * sch.stepsReheat) * 100);
  assert.equal(SA.budget(null, d), 365500);
  assert.ok(SA.budget(null, d) > 200000 && SA.budget(null, d) < 600000, 'default budget ' + SA.budget(null, d));
  // each schedule knob moves the budget the right way
  const b = (x) => SA.budget(null, Object.assign({}, d, x));
  assert.ok(b({ coolingRate: 0.999 }) > b({}));
  assert.ok(b({ itersPerTemp: 200 }) === 2 * b({}));
  assert.ok(b({ stopTempRatio: 1e-5 }) > b({}));
  assert.ok(b({ reheats: 0 }) < b({}) && b({ reheats: 5 }) > b({}));
  // a stop ratio above the reheat fraction still reheats above the stop temperature
  const hi = SA.schedule(Object.assign({}, d, { stopTempRatio: 0.5 }));
  assert.ok(hi.reheatRatio > 0.5 && hi.stepsReheat >= 1);
});

test('small instances: violation-free plan, total = evaluate, never worse than the start, full schedule run', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const inst = small(seed, { locked: seed % 3, pinned: seed % 2, banned: seed % 2, closedZones: seed % 2, maxRallyPoints: 1 + seed % 4 });
    const params = fast({ seed });
    const res = SA.run(inst, params, {});
    const ev = checkResult(inst, res, 'seed ' + seed);
    const start = S.evaluate(inst, S.construct(inst, { rng: SRO.util.rng(S.clampParams('sa', params).seed) }), { costOnly: true });
    assert.ok(ev.total <= start.total + 1e-9, 'seed ' + seed + ': not worse than construct');
    assert.equal(res.extra.startTotal, start.total, 'seed ' + seed + ': starts from construct');
    assert.equal(res.stopReason, 'budget', 'seed ' + seed);
    assert.equal(res.iterations, SA.budget(inst, params), 'seed ' + seed + ': iterations = budget');
    assert.equal(res.extra.reheatsDone, 2);
    assert.ok(res.extra.accepted > 0 && res.extra.acceptRate > 0 && res.extra.acceptRate < 1);
    assert.ok(res.extra.movesPerSec > 0, 'moves per second reported');
  }
});

test('tiny instances: reaches the brute-force optimum', () => {
  for (let seed = 1; seed <= 16; seed++) {
    const inst = tinyInstance(SRO, seed);
    const bf = bruteForce(SRO, inst);
    const res = SA.run(inst, fast({ seed }), {});
    checkResult(inst, res, 'tiny ' + seed);
    // the brute force has no splits, so a plan with splits may beat it; never worse than it
    assert.ok(res.total <= bf.total + 1e-6 * Math.max(1, bf.total), 'tiny ' + seed + ': ' + res.total + ' vs brute force ' + bf.total);
  }
});

test('same seed gives the identical plan; another seed searches differently', () => {
  const inst = phase1(3);
  const p = { seed: 77, timeCapSec: 60, itersPerTemp: 10 };
  const a = SA.run(inst, p, {}), b = SA.run(inst, p, {});
  assert.equal(a.stopReason, 'budget');
  assert.deepEqual(plain(a.solution), plain(b.solution));
  assert.equal(a.total, b.total);
  assert.equal(a.iterations, b.iterations);
  assert.equal(a.evals, b.evals);
  assert.equal(a.extra.T0, b.extra.T0);
  assert.equal(a.extra.accepted, b.extra.accepted);
  // (history points are merged per 50 ms of wall time, so only the last one is compared)
  assert.equal(a.history[a.history.length - 1].best, b.history[b.history.length - 1].best);
  const c = SA.run(inst, Object.assign({}, p, { seed: 78 }), {});
  checkResult(inst, c, 'seed 78');
  assert.ok(c.extra.accepted !== a.extra.accepted || c.extra.T0 !== a.extra.T0, 'a different seed takes a different walk');
});

test('every knob is used: startTemp, autoAcceptRate, coolingRate, itersPerTemp, stopTempRatio, reheats', () => {
  const inst = small(11);
  const base = fast({ seed: 5 });
  const run = (x) => SA.run(inst, Object.assign({}, base, x), {});
  // manual start temperature
  const m = run({ startTemp: 250 });
  assert.equal(m.extra.autoTemp, false);
  assert.equal(m.extra.T0, 250);
  assert.ok(Math.abs(m.extra.tStop - 250 * S.clampParams('sa', base).stopTempRatio) < 1e-9);
  // auto: a higher accept share gives a higher start temperature
  const lo = run({ autoAcceptRate: 0.2 }), hi = run({ autoAcceptRate: 0.8 });
  assert.equal(lo.extra.autoTemp, true);
  assert.ok(hi.extra.T0 > lo.extra.T0, 'T0 ' + lo.extra.T0 + ' < ' + hi.extra.T0);
  // schedule knobs set the number of proposals exactly (run to the end of the schedule)
  for (const x of [{}, { coolingRate: 0.95 }, { itersPerTemp: 3 }, { stopTempRatio: 0.05 }, { reheats: 0 }, { reheats: 4 }]) {
    const r = run(x);
    assert.equal(r.stopReason, 'budget', JSON.stringify(x));
    assert.equal(r.iterations, SA.budget(inst, Object.assign({}, base, x)), JSON.stringify(x));
    assert.equal(r.extra.reheatsDone, S.clampParams('sa', Object.assign({}, base, x)).reheats, JSON.stringify(x));
    assert.ok(r.extra.tStop > 0 && r.extra.reheatTemp > r.extra.tStop);
  }
});

test('auto start temperature: mean acceptance of the uphill samples = autoAcceptRate; violation samples ignored', () => {
  // closed zones make some moves create unreachable legs (violations, +1e7 each)
  let sawViolation = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const inst = small(seed, { closedZones: 3, nJobs: 16 });
    const start = S.construct(inst);
    const e = S.evaluate(inst, start, { costOnly: true });
    for (const rate of [0.1, 0.5, 0.9]) {
      const a = SA._autoTemp(inst, start, e.total, e.nViolations, SRO.util.rng(seed), rate);
      sawViolation += a.violSamples;
      assert.ok(a.T0 > 0 && a.T0 < 1e6, 'T0 ' + a.T0 + ' stays far below the violation penalty');
      if (a.uphill) {
        const acc = a.ups.reduce((s, d) => s + Math.exp(-d / a.T0), 0) / a.ups.length;
        assert.ok(Math.abs(acc - rate) < 1e-6, 'mean acceptance ' + acc + ' vs ' + rate);
        assert.ok(a.ups.every((d) => d > 0 && d < 1e7), 'only violation-free uphill deltas');
      }
    }
  }
  assert.ok(sawViolation > 0, 'the instances produced some violation samples');
});

test('a start plan with violations: violations are never added, the result is violation-free', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const inst = small(seed);
    const start = randomSolution(SRO, inst, SRO.util.rng(seed));
    const e0 = S.evaluate(inst, start);
    const res = SA.run(inst, fast({ seed }), { start });
    checkResult(inst, res, 'seed ' + seed);
    assert.ok(res.total <= e0.total, 'seed ' + seed);
    assert.equal(res.extra.startTotal, S.evaluate(inst, S.normalize(inst, start), { costOnly: true }).total, 'starts from hooks.start');
  }
});

// The progress test runs on a CPU-time clock (hooks.now), so other processes on a busy machine cannot
// stretch the gaps; the method's own guarantee is about its clock.
const cpuNow = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

test('progress: iteration 0 first, at least every 250 ms, best only when it changed and always in sync', () => {
  const inst = phase1(2);
  const calls = [];
  let lastBest = null;
  const res = SA.run(inst, { seed: 9, timeCapSec: 60, itersPerTemp: 20 }, {
    now: cpuNow,
    onProgress: (p) => {
      calls.push({ t: cpuNow(), p });
      if (p.best) {
        assert.notEqual(p.best, lastBest, 'best is sent only when it changed');
        if (lastBest) assert.ok(S.evaluate(inst, p.best, { costOnly: true }).total < S.evaluate(inst, lastBest, { costOnly: true }).total, 'a new best is better');
        lastBest = p.best;
      }
      assert.ok(lastBest, 'the first call carries the start plan');
      assert.equal(p.bestCost, S.evaluate(inst, lastBest, { costOnly: true }).total, 'bestCost is the last plan sent');
      for (const k of ['fraction', 'bestCost', 'elapsedSec', 'iteration', 'temperature', 'movesPerSec']) assert.equal(typeof p[k], 'number', k);
      assert.equal(typeof p.message, 'string');
      assert.ok(p.fraction >= 0 && p.fraction <= 1);
    }
  });
  checkResult(inst, res, 'progress run');
  assert.equal(res.stopReason, 'budget');
  assert.equal(calls[0].p.iteration, 0, 'first call at iteration 0 (end of setup)');
  assert.ok(calls[0].p.best, 'first call has the start plan');
  assert.equal(calls[calls.length - 1].p.fraction, 1, 'last call fraction 1');
  assert.equal(calls[calls.length - 1].p.bestCost, res.total, 'last bestCost = result total');
  assert.equal(S.evaluate(inst, lastBest).total, res.total, 'the last plan sent is the result');
  let maxGap = 0;
  for (let i = 1; i < calls.length; i++) maxGap = Math.max(maxGap, calls[i].t - calls[i - 1].t);
  assert.ok(res.elapsedSec > 0.8, 'long enough to check gaps: ' + res.elapsedSec);
  assert.ok(maxGap <= 250, 'max gap between progress calls ' + maxGap.toFixed(0) + ' ms (CPU clock)');
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].p.iteration >= calls[i - 1].p.iteration);
  assert.ok(calls.filter((c) => c.p.best).length >= 3, 'several new bests reported');
  assert.ok(calls.some((c) => / moves\/s/.test(c.p.message)), 'moves per second in the message');
  assert.ok(res.extra.movesPerSec > 0 && res.extra.evalsPerSec >= res.extra.movesPerSec);
});

test('time cap honored within 10% (search, reserve and polish), plan valid', () => {
  const inst = phase1(4);
  for (const cap of [2, 5]) {
    const t0 = performance.now();
    const res = SA.run(inst, { seed: 3, timeCapSec: cap, coolingRate: 0.99999, itersPerTemp: 1000 }, {});
    const wall = (performance.now() - t0) / 1000;
    checkResult(inst, res, 'cap ' + cap);
    assert.equal(res.stopReason, 'time');
    assert.ok(res.elapsedSec <= cap * 1.1, 'elapsed ' + res.elapsedSec + ' for cap ' + cap);
    assert.ok(wall <= cap * 1.1, 'wall ' + wall + ' for cap ' + cap);
    assert.ok(res.elapsedSec >= cap * 0.85, 'uses the time it has: ' + res.elapsedSec);
  }
  // clampParams' minimum (5 s) applies to the form; a below-minimum cap passed directly is honored
  assert.equal(S.clampParams('sa', { timeCapSec: 1 }).timeCapSec, 5);
});

test('shouldStop stops the run at once and returns the best plan so far', () => {
  const inst = phase1(5);
  let calls = 0, stopAt = 0;
  const t0 = performance.now();
  const res = SA.run(inst, { seed: 4, timeCapSec: 60 }, {
    shouldStop: () => { calls++; if (performance.now() - t0 > 400) { if (!stopAt) stopAt = performance.now(); return true; } return false; }
  });
  const after = performance.now() - stopAt;
  checkResult(inst, res, 'stopped');
  assert.equal(res.stopReason, 'stopped');
  assert.ok(after < 100, 'returned ' + after.toFixed(0) + ' ms after shouldStop turned true');
  assert.ok(calls > 10);
  assert.ok(res.total <= res.extra.startTotal);
});

test('edge cases: no jobs, no trucks, everything locked to one truck', () => {
  const none = S.makeTestInstance(1, { nJobs: 0, nVehicles: 2 });
  const r0 = SA.run(none, fast(), {});
  checkResult(none, r0, 'no jobs');
  assert.equal(r0.stopReason, 'converged');
  const noTrucks = S.makeTestInstance(2, { nJobs: 5, nVehicles: 0 });
  const r1 = SA.run(noTrucks, fast(), {});
  assert.equal(r1.feasible, true);
  assert.equal(r1.total, S.evaluate(noTrucks, r1.solution).total);
  const locked = small(3, { locked: 12 });
  const r2 = SA.run(locked, fast(), {});
  checkResult(locked, r2, 'locked');
});

// ---- quality on 10 Phase 1 instances (worker threads; budget-bound, so deterministic) -------------
// The worker threads run at the lowest CPU priority (on Linux, per thread), so the timing-sensitive tests
// of other files that node --test runs at the same time are not starved; the results are budget-bound,
// so a slower run gives the same numbers.
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
try { require('node:os').setPriority(19); } catch (e) { /* not allowed here: run at normal priority */ }
import(workerData.loadUrl).then(({ loadScripts }) => {
  const SRO = loadScripts(workerData.files);
  const S = SRO.solver;
  parentPort.on('message', (task) => {
    const inst = S.makeTestInstance(task.seed, task.opts);
    const t0 = performance.now();
    let total, feasible, extra = null;
    if (task.kind === 'ls') {
      const sol = S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(task.seed), timeLimitMs: 60000 });
      const e = S.evaluate(inst, sol, { costOnly: true });
      total = e.total; feasible = e.feasible;
    } else {
      const r = S.methods.sa.run(inst, task.params, {});
      const e = S.evaluate(inst, r.solution, { costOnly: true });
      if (e.total !== r.total) throw new Error('total mismatch');
      total = r.total; feasible = r.feasible;
      extra = { stopReason: r.stopReason, iterations: r.iterations, movesPerSec: r.extra.movesPerSec, annealSec: r.extra.annealSec,
        elapsedSec: r.elapsedSec, T0: r.extra.T0, polishGain: r.extra.polishGain };
    }
    parentPort.postMessage({ id: task.id, total, feasible, ms: performance.now() - t0, extra });
  });
});
`;

function runPool(tasks, nThreads) {
  return new Promise((resolve, reject) => {
    const results = new Array(tasks.length);
    let next = 0, done = 0;
    const workers = [];
    const finish = (err) => { workers.forEach((w) => w.terminate()); err ? reject(err) : resolve(results); };
    for (let i = 0; i < Math.min(nThreads, tasks.length); i++) {
      const w = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { loadUrl: pathToFileURL(path.join(ROOT, 'tests/load.mjs')).href, files: FILES }
      });
      workers.push(w);
      const feed = () => { if (next < tasks.length) { const id = next++; w.postMessage(Object.assign({ id }, tasks[id])); } };
      w.on('message', (m) => { results[m.id] = m; done++; if (done === tasks.length) finish(); else feed(); });
      w.on('error', finish);
      feed();
    }
  });
}

test('quality: 10 Phase 1 instances vs construct + localSearch and a 10x multi-start reference', { timeout: 30 * 60 * 1000 }, async (t) => {
  const full = process.env.SA_QUALITY === 'full';
  const tested = full ? { timeCapSec: 600 } : { timeCapSec: 600, itersPerTemp: 10 };
  const STARTS = 10;                       // reference = 10 seeds x the tested budget (the tested run is one)
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const tasks = [];
  for (const seed of seeds) {
    tasks.push({ seed, opts: P1, kind: 'ls', inst: seed });
    for (let k = 0; k < STARTS; k++) {
      const params = Object.assign({}, tested, k === 0 ? {} : { seed: 7000 + 101 * k });
      tasks.push({ seed, opts: P1, kind: k === 0 ? 'sa' : 'ref', params, inst: seed });
    }
  }
  const threads = Math.max(2, Math.min(6, (os.availableParallelism ? os.availableParallelism() : os.cpus().length)));
  const t0 = performance.now();
  const out = await runPool(tasks, threads);
  const wall = (performance.now() - t0) / 1000;
  const rows = [];
  for (const seed of seeds) {
    const mine = tasks.map((x, i) => [x, out[i]]).filter(([x]) => x.inst === seed);
    const ls = mine.find(([x]) => x.kind === 'ls')[1];
    const sa = mine.find(([x]) => x.kind === 'sa')[1];
    const all = mine.map(([, r]) => r);
    all.forEach((r) => assert.equal(r.feasible, true, 'every plan violation-free'));
    const ref = Math.min(...all.map((r) => r.total));
    rows.push({ seed, ls: ls.total, sa: sa.total, ref, gap: rel(sa.total, ref), vsLs: rel(sa.total, ls.total),
      lsGap: rel(ls.total, ref), mps: sa.extra.movesPerSec, sec: sa.extra.elapsedSec, stop: sa.extra.stopReason, it: sa.extra.iterations });
  }
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const meanGap = mean((r) => r.gap), maxGap = Math.max(...rows.map((r) => r.gap));
  const meanVsLs = mean((r) => r.vsLs), meanLsGap = mean((r) => r.lsGap);
  const summary = `SA quality (${full ? 'default params' : 'itersPerTemp 10'}, ${rows[0].it.toLocaleString('en-US')} moves): ` +
    `mean gap to 10x reference ${(100 * meanGap).toFixed(2)}%, max ${(100 * maxGap).toFixed(2)}%; ` +
    `vs construct+localSearch ${(100 * meanVsLs).toFixed(2)}% (LS gap ${(100 * meanLsGap).toFixed(2)}%); ` +
    `SA wins ${rows.filter((r) => r.sa < r.ls - 1e-6).length}/10, ties ${rows.filter((r) => Math.abs(r.sa - r.ls) <= 1e-6).length}; ` +
    `${Math.round(mean((r) => r.mps)).toLocaleString('en-US')} moves/s, ${mean((r) => r.sec).toFixed(2)} s per run; wall ${wall.toFixed(0)} s on ${threads} threads`;
  t.diagnostic(summary);
  if (process.env.SA_QUALITY_LOG) {
    for (const r of rows) {
      console.log(`  seed ${r.seed}: LS ${r.ls.toFixed(1)}  SA ${r.sa.toFixed(1)}  ref ${r.ref.toFixed(1)}  gap ${(100 * r.gap).toFixed(2)}%  ` +
        `vs LS ${(100 * r.vsLs).toFixed(2)}%  ${r.sec.toFixed(2)} s  ${Math.round(r.mps)} moves/s  ${r.stop}`);
    }
    console.log(summary);
  }
  rows.forEach((r) => assert.equal(r.stop, 'budget', 'seed ' + r.seed + ' ran its full budget (not cut by time)'));
  // Measured 2026-10-06 (deterministic, so these repeat exactly while evaluate/construct/localsearch stay
  // the same). Full defaults: mean gap 1.95%, max 9.36% (seed 1, a hard instance where the default seed
  // lands in a poor basin: 6,543 vs 5,983; the other nine are within 3.6%), -11.2% vs construct +
  // localSearch, better on 9 of 10 and equal on the tenth. A tenth of the budget (default mode): mean gap
  // 3.81%, max 8.71%, -9.3% vs construct + localSearch, better on 9 of 10 (seed 8: +1.1%).
  // Re-measured after the review (start trials, T0 from best-of-3 proposals): full defaults mean gap
  // 0.87%, max 2.86%, -12.4% vs construct + localSearch, better on 10 of 10; a tenth of the budget: mean
  // gap 3.28%, max 11.96% (seed 7: 9,963 vs 8,899; this mode's single runs vary ~10% with the seed),
  // -9.7% vs construct + localSearch, better on 9 of 10 (seed 8: +0.8%).
  const lim = full ? { mean: 0.03, max: 0.12 } : { mean: 0.05, max: 0.12 };
  assert.ok(meanVsLs < -0.03, 'beats construct + localSearch on average: ' + (100 * meanVsLs).toFixed(2) + '%');
  assert.ok(rows.every((r) => r.sa <= r.ls * 1.03), 'never much worse than construct + localSearch');
  assert.ok(meanGap <= lim.mean, 'mean gap to the 10x reference ' + (100 * meanGap).toFixed(2) + '%');
  assert.ok(maxGap <= lim.max, 'max gap to the 10x reference ' + (100 * maxGap).toFixed(2) + '%');
});
