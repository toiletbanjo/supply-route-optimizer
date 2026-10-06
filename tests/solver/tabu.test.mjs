// Tabu search (src/solver/tabu.js): registration, plan validity (violation-free, total = evaluate),
// the tabu rules step by step (best admissible move, tabu attributes from adds/drops, tenure,
// aspiration), every knob used, determinism per seed, progress protocol, time cap, shouldStop, start
// plans, edge cases, brute-force optimum on tiny instances, and the quality check on 10 Phase 1
// instances against construct + localSearch and a 10x multi-start reference.
//
// Quality check (budget-bound, never time-bound, so the results do not depend on machine speed or
// load and the tolerances are not flaky):
//   default              tabu with default params except iterations 1000 (a quarter of the default
//                        budget); reference = best of 10 seeds at that budget (10x) and construct +
//                        localSearch. 10 x 11 runs of ~1.5-2 s each (idle machine), over worker threads.
//   TABU_QUALITY=full    tabu with the true default params; reference = best of 10 seeds at the
//                        default budget (10x). 10 x 11 runs of ~5-7 s each.
// TABU_QUALITY_LOG=1 prints the per-instance table. Skip it with --test-skip-pattern=quality.
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
  'src/solver/tabu.js'
];
const SRO = loadScripts(FILES);
const S = SRO.solver;
const TABU = S.methods.tabu;

// Phase 1 size: 30 jobs, 8 trucks (3 tankers), 10 rally candidates (max 8 used), 2 hubs, tight truck
// capacity (about the demand), deadlines 1-8 h out, 3 risk zones.
const P1 = {
  nJobs: 30, nVehicles: 8, nRally: 10, nHubs: 2, maxRallyPoints: 8, capacity: { tanker: 6000, cargo: 25 },
  deadlineMin: 60, deadlineMax: 480, riskZones: 3
};
const phase1 = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({}, P1, extra));
const small = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({ nJobs: 12, nVehicles: 4, nRally: 5, nHubs: 2 }, extra));
const fast = (extra = {}) => Object.assign({ timeCapSec: 600, iterations: 150, neighborhood: 40, restartAfter: 50 }, extra);
const rel = (a, b) => (a - b) / Math.max(1, Math.abs(b));
const tolOf = (x) => 1e-9 * Math.max(1, Math.abs(x));
const better = (aT, aF, bT, bF) => (aF !== bF ? aF : aT < bT - tolOf(bT));
// The progress, time-cap and stop tests run on a CPU-time clock (hooks.now), so other processes on a
// busy machine cannot stretch the gaps; the method's own guarantee is about its clock.
const cpuNow = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

function checkResult(inst, res, label) {
  assert.ok(res && res.solution, label + ': has a solution');
  const ev = S.evaluate(inst, res.solution);
  assert.equal(ev.violations.length, 0, label + ': no violations ' + JSON.stringify(ev.violations.slice(0, 2)));
  assert.equal(res.feasible, true, label + ': feasible');
  assert.equal(res.total, ev.total, label + ': total equals evaluate().total');
  assert.ok(S.isNormalized(inst, res.solution), label + ': normalized');
  for (const r of res.solution.routes) for (const v of r.visits) {
    assert.ok(v.jobs.length > 0, label + ': no empty visits');
    for (const c of v.jobs) assert.ok(c.qty > 0, label + ': positive chunks');
  }
  assert.ok(Number.isInteger(res.iterations) && res.iterations >= 0, label + ': iterations');
  assert.ok(res.extra.steps <= res.iterations, label + ': steps <= iterations');
  assert.ok(res.evals >= res.extra.steps, label + ': evals');
  assert.ok(['budget', 'time', 'stopped', 'converged'].includes(res.stopReason), label + ': stopReason ' + res.stopReason);
  assert.ok(res.elapsedSec >= 0);
  assert.ok(Array.isArray(res.history) && res.history.length >= 1, label + ': history');
  for (let i = 1; i < res.history.length; i++) {
    assert.ok(res.history[i].best <= res.history[i - 1].best + 1e-9, label + ': history best never goes up');
    assert.ok(res.history[i].t >= res.history[i - 1].t, label + ': history time order');
  }
  assert.equal(res.history[res.history.length - 1].best, res.total, label + ': history ends at the result');
  return ev;
}

test('registered as SRO.solver.methods.tabu with the knobs of params.js', () => {
  assert.equal(TABU.key, 'tabu');
  assert.equal(TABU.label, 'Tabu search');
  assert.equal(typeof TABU.run, 'function');
  assert.deepEqual(plain(S.PARAMS.tabu.map((e) => e.key)), ['seed', 'timeCapSec', 'iterations', 'tenure', 'neighborhood', 'restartAfter', 'aspiration']);
  // missing or invalid knobs fall back to the defaults (clampParams)
  const inst = small(1);
  const res = TABU.run(inst, { iterations: 'many', tenure: null, neighborhood: 30, restartAfter: -5, timeCapSec: 600 }, {});
  checkResult(inst, res, 'clamped params');
  assert.equal(res.iterations <= 4000, true);
});

test('small instances: violation-free plan, total = evaluate, never worse than construct, budget run', () => {
  let restarted = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const inst = small(seed, { locked: seed % 3, pinned: seed % 2, banned: seed % 2, closedZones: seed % 2, maxRallyPoints: 1 + seed % 4 });
    const res = TABU.run(inst, fast({ seed }), {});
    const ev = checkResult(inst, res, 'seed ' + seed);
    const start = S.evaluate(inst, S.construct(inst), { costOnly: true });
    assert.equal(res.extra.startTotal, start.total, 'seed ' + seed + ': starts from construct');
    assert.ok(ev.total <= start.total + 1e-9, 'seed ' + seed + ': not worse than construct');
    assert.equal(res.stopReason, 'budget', 'seed ' + seed);
    assert.equal(res.iterations, 150, 'seed ' + seed + ': the whole step budget is used');
    if (res.extra.restarts > 0) restarted++;
  }
  assert.ok(restarted >= 4, 'restarts on ' + restarted + ' of 8 instances');
});

test('tiny instances: reaches the brute-force optimum', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const inst = tinyInstance(SRO, seed);
    const bf = bruteForce(SRO, inst);
    const res = TABU.run(inst, fast({ seed, iterations: 120, neighborhood: 30 }), {});
    checkResult(inst, res, 'tiny ' + seed);
    // the brute force has no splits, so a plan with splits may beat it; never worse than it
    assert.ok(res.total <= bf.total + 1e-6 * Math.max(1, bf.total), 'tiny ' + seed + ': ' + res.total + ' vs brute force ' + bf.total);
  }
});

// Replays a run step by step: wraps SRO.solver.neighbors to record every candidate list and the plan it
// was sampled from (the next call's plan is the candidate that was taken), then re-applies the rules of
// DESIGN.md: drops of the taken move are tabu for `tenure` steps, a candidate is tabu when any of its
// adds is, aspiration admits a tabu candidate that beats the best plan, and the taken move is the best
// admissible one (zero-change candidates are skipped while any other candidate exists).
function replay(inst, params) {
  const orig = S.neighbors;
  const calls = [];
  S.neighbors = function (instance, sol, rng, k, opts) {
    const out = orig.call(this, instance, sol, rng, k, opts);
    calls.push({ sol, out, k });
    return out;
  };
  let res;
  try { res = TABU.run(inst, Object.assign({ timeCapSec: 600, restartAfter: 0 }, params), {}); } finally { S.neighbors = orig; }
  const p = S.clampParams('tabu', params);
  const until = new Map();
  const e0 = S.evaluate(inst, calls[0].sol, { costOnly: true });
  let bestT = e0.total, bestF = e0.feasible;
  const n = { steps: 0, worse: 0, blocked: 0, aspired: 0, allTabu: 0 };
  for (let i = 0; i + 1 < calls.length; i++) {
    const { sol, out, k } = calls[i];
    assert.equal(k, p.neighborhood, 'samples `neighborhood` moves per step');
    assert.ok(out.length > 0 && out.length <= k);
    const ec = S.evaluate(inst, sol, { costOnly: true });
    const curT = ec.total, curF = ec.feasible;
    const picked = out.find((c) => c.solution === calls[i + 1].sol);
    assert.ok(picked, 'step ' + i + ': the next plan is one of the sampled candidates');
    const tabuEnd = (c) => Math.max(-1, ...c.adds.map((a) => (until.has(a) && until.get(a) >= i ? until.get(a) : -1)));
    const isNull = (c) => c.feasible === curF && Math.abs(c.total - curT) <= tolOf(curT);
    const beatsBest = (c) => better(c.total, c.feasible, bestT, bestF);
    const real = out.filter((c) => !isNull(c));
    const admissible = real.filter((c) => tabuEnd(c) < 0 || (p.aspiration && beatsBest(c)));
    if (admissible.length) {
      assert.ok(admissible.includes(picked), 'step ' + i + ': takes an admissible move');
      for (const c of admissible) assert.ok(!better(c.total, c.feasible, picked.total, picked.feasible), 'step ' + i + ': takes the best admissible move');
      if (tabuEnd(picked) >= 0) { assert.ok(p.aspiration && beatsBest(picked), 'a tabu move only by aspiration'); n.aspired++; }
      if (real.some((c) => tabuEnd(c) >= 0 && better(c.total, c.feasible, picked.total, picked.feasible))) n.blocked++;
    } else if (real.length) {
      // every real candidate is tabu: the one whose tabu ends soonest
      const soonest = Math.min(...real.map(tabuEnd));
      assert.equal(tabuEnd(picked), soonest, 'step ' + i + ': all tabu, takes the one freed soonest');
      n.allTabu++;
    } else assert.ok(isNull(picked));
    if (better(curT, curF, picked.total, picked.feasible)) n.worse++;
    for (const d of picked.drops) until.set(d, i + p.tenure);
    if (better(picked.total, picked.feasible, bestT, bestF)) { bestT = picked.total; bestF = picked.feasible; }
    n.steps++;
  }
  return { res, n };
}

test('tabu rules replayed step by step: best admissible move, tenure, aspiration', (t) => {
  const tot = { steps: 0, worse: 0, blocked: 0, aspired: 0, allTabu: 0 };
  for (let seed = 1; seed <= 4; seed++) {
    const inst = phase1(seed);
    for (const [tenure, aspiration] of [[12, true], [40, false]]) {
      const { res, n } = replay(inst, { seed, iterations: 120, neighborhood: 60, tenure, aspiration });
      checkResult(inst, res, 'replay ' + seed);
      assert.equal(n.steps, res.extra.steps - 1, 'every step but the last is checked');
      if (!aspiration) assert.equal(res.extra.aspirations, 0);
      for (const key of Object.keys(tot)) tot[key] += n[key];
    }
  }
  t.diagnostic('replayed steps: ' + JSON.stringify(tot));
  assert.ok(tot.worse > 50, 'the walk takes worsening moves: ' + JSON.stringify(tot));
  assert.ok(tot.blocked > 20, 'tabu status blocks better moves: ' + JSON.stringify(tot));
  assert.ok(tot.aspired > 0, 'aspiration admits tabu moves that beat the best plan: ' + JSON.stringify(tot));
});

test('every knob is used: iterations, neighborhood, tenure, restartAfter, aspiration, seed', () => {
  const inst = phase1(6);
  const base = { seed: 5, timeCapSec: 600, iterations: 200, neighborhood: 50, restartAfter: 0 };
  const run = (x) => { const r = TABU.run(inst, Object.assign({}, base, x), {}); checkResult(inst, r, JSON.stringify(x)); return r; };
  const a = run({});
  // iterations: the step budget
  const b = run({ iterations: 400 });
  assert.equal(a.iterations, 200); assert.equal(b.iterations, 400);
  assert.equal(a.extra.steps, 200); assert.equal(b.extra.steps, 400);
  // neighborhood: candidates scored per step
  const c = run({ neighborhood: 150 });
  assert.ok(a.extra.walkEvals > 0.95 * 200 * 50 && a.extra.walkEvals <= 200 * 50, 'walk evals ' + a.extra.walkEvals);
  assert.ok(c.extra.walkEvals > 0.95 * 200 * 150 && c.extra.walkEvals <= 200 * 150, 'walk evals ' + c.extra.walkEvals);
  // tenure and aspiration change the walk
  const sig = (r) => JSON.stringify([r.total, r.evals, r.extra.aspirations, r.extra.allTabu, r.extra.nullSkipped]);
  assert.notEqual(sig(run({ tenure: 1 })), sig(run({ tenure: 60 })), 'tenure changes the walk');
  let aspSeen = 0;
  for (let seed = 1; seed <= 6 && !aspSeen; seed++) {
    const asp = run({ seed, aspiration: true, tenure: 60 }), noAsp = run({ seed, aspiration: false, tenure: 60 });
    assert.equal(noAsp.extra.aspirations, 0);
    if (asp.extra.aspirations > 0) { aspSeen = seed; assert.notEqual(sig(asp), sig(noAsp), 'aspiration changes the walk'); }
  }
  assert.ok(aspSeen, 'aspiration admitted a tabu move on one of 6 seeds');
  // restartAfter: restarts (0 = off); restart work is charged to the step budget
  assert.equal(a.extra.restarts, 0);
  const r = run({ restartAfter: 30, iterations: 600 });
  assert.ok(r.extra.restarts >= 1 && r.extra.trials >= r.extra.restarts, 'restarts: ' + r.extra.restarts);
  assert.equal(r.iterations, 600);
  assert.ok(r.extra.steps < 600, 'restart work counts against the budget');
  // seed
  assert.notEqual(sig(run({ seed: 6 })), sig(a), 'seed changes the walk');
});

test('start trials: charged to the step budget, never more than CFG.startShare of it', () => {
  const share = TABU._cfg.startShare;
  let seen = 0;
  for (const [seed, iterations] of [[6, 400], [2, 400], [3, 1000]]) {
    const inst = phase1(seed);
    const r = TABU.run(inst, { seed: 5, timeCapSec: 600, iterations, restartAfter: 0 }, {});
    checkResult(inst, r, 'start trials ' + seed);
    const charged = r.iterations - r.extra.steps;
    assert.equal(r.iterations, iterations);
    assert.equal(r.extra.trials, r.extra.startTrials, 'no restarts with restartAfter 0');
    assert.ok(charged <= Math.floor(share * iterations), 'charged ' + charged + ' of ' + iterations);
    if (r.extra.startTrials > 0) { seen++; assert.ok(charged > 0, 'start trials are charged'); } else assert.equal(charged, 0);
  }
  assert.ok(seen >= 2, 'start trials ran on ' + seen + ' of 3 runs');
});

test('same seed gives the identical plan', () => {
  const inst = phase1(3);
  const p = { seed: 77, timeCapSec: 600, iterations: 400, restartAfter: 120 };
  const a = TABU.run(inst, p, {}), b = TABU.run(inst, p, {});
  checkResult(inst, a, 'a');
  assert.equal(a.stopReason, 'budget');
  assert.ok(a.extra.restarts >= 1, 'covers a restart');
  assert.deepEqual(plain(a.solution), plain(b.solution));
  assert.equal(a.total, b.total);
  assert.equal(a.iterations, b.iterations);
  assert.equal(a.evals, b.evals);
  assert.deepEqual(plain(a.extra), plain(b.extra));
});

test('a start plan (hooks.start): used as given, never worse, violations repaired', () => {
  const rng = SRO.util.rng(5);
  for (let seed = 1; seed <= 6; seed++) {
    const inst = small(seed + 20);
    const start = randomSolution(SRO, inst, rng);
    const e0 = S.evaluate(inst, S.normalize(inst, start), { costOnly: true });
    const res = TABU.run(inst, fast({ seed }), { start });
    assert.equal(res.extra.startTotal, e0.total, 'starts from hooks.start');
    assert.ok(res.total <= e0.total, 'seed ' + seed);
    checkResult(inst, res, 'start ' + seed);   // every random start here can be repaired
  }
  // a good start plan is kept or improved
  const inst = phase1(7);
  const good = S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(1) });
  const res = TABU.run(inst, { seed: 1, timeCapSec: 600, iterations: 100 }, { start: good });
  assert.ok(res.total <= S.evaluate(inst, good).total);
});

test('progress: start plan first, at least every 250 ms, best only when it changed and always in sync', (t) => {
  const inst = phase1(2);
  const calls = [];
  let lastBest = null, lastBestCost = Infinity;
  const res = TABU.run(inst, { seed: 9, timeCapSec: 600, iterations: 800, restartAfter: 150 }, {
    now: cpuNow,
    onProgress: (p) => {
      calls.push({ t: cpuNow(), p });
      if (p.best) {
        assert.notEqual(p.best, lastBest, 'best is sent only when it changed');
        const c = S.evaluate(inst, p.best, { costOnly: true }).total;
        assert.ok(c < lastBestCost, 'a new best is better');
        lastBest = p.best; lastBestCost = c;
      }
      assert.ok(lastBest, 'the first call carries the start plan');
      assert.equal(p.bestCost, lastBestCost, 'bestCost is the cost of the last plan sent');
      for (const k of ['fraction', 'bestCost', 'currentCost', 'elapsedSec', 'iteration']) assert.equal(typeof p[k], 'number', k);
      assert.equal(typeof p.message, 'string');
      assert.ok(p.fraction >= 0 && p.fraction <= 1);
    }
  });
  checkResult(inst, res, 'progress run');
  assert.equal(res.stopReason, 'budget');
  assert.ok(res.extra.restarts >= 1, 'covers restarts');
  assert.equal(calls[0].p.iteration, 0);
  assert.equal(calls[0].p.bestCost, res.extra.startTotal, 'first call: the start plan');
  const last = calls[calls.length - 1].p;
  assert.equal(last.fraction, 1, 'last call fraction 1');
  assert.equal(last.bestCost, res.total, 'last bestCost = result total');
  assert.equal(lastBestCost, res.total, 'the last plan sent is the result');
  let maxGap = 0;
  for (let i = 1; i < calls.length; i++) {
    maxGap = Math.max(maxGap, calls[i].t - calls[i - 1].t);
    assert.ok(calls[i].p.iteration >= calls[i - 1].p.iteration, 'iteration never goes back');
    assert.ok(calls[i].p.fraction >= calls[i - 1].p.fraction - 1e-12, 'fraction never goes back');
  }
  t.diagnostic(`progress: ${calls.length} calls in ${res.elapsedSec.toFixed(2)} s (CPU), max gap ${maxGap.toFixed(0)} ms, ` +
    `${calls.filter((c) => c.p.best).length} with a new best`);
  assert.ok(res.elapsedSec > 0.8, 'long enough to check gaps: ' + res.elapsedSec);
  assert.ok(maxGap <= 250, 'max gap between progress calls ' + maxGap.toFixed(0) + ' ms (CPU clock)');
  assert.ok(calls.filter((c) => c.p.best).length >= 3, 'several new bests reported');
});

test('time cap honored within 10% (walk, restarts, reserve and polish), plan valid', (t) => {
  const inst = phase1(4);
  for (const cap of [2, 5]) {
    const t0 = performance.now();
    const res = TABU.run(inst, { seed: 3, timeCapSec: cap, iterations: 100000, restartAfter: 200 }, {});
    const wall = (performance.now() - t0) / 1000;
    checkResult(inst, res, 'cap ' + cap);
    assert.equal(res.stopReason, 'time');
    assert.ok(res.elapsedSec <= cap * 1.1, 'elapsed ' + res.elapsedSec + ' for cap ' + cap);
    assert.ok(wall <= cap * 1.1, 'wall ' + wall + ' for cap ' + cap);
    assert.ok(res.elapsedSec >= cap * 0.85, 'uses the time it has: ' + res.elapsedSec);
    if (cap >= 5) assert.ok(res.extra.restarts >= 1, 'restarts inside the cap');
    t.diagnostic(`cap ${cap} s: elapsed ${res.elapsedSec.toFixed(3)} s (wall ${wall.toFixed(3)} s), ${res.extra.steps} steps, ${res.extra.restarts} restarts`);
  }
  // the same on the CPU clock (a busy machine cannot stretch it)
  const res = TABU.run(inst, { seed: 4, timeCapSec: 2, iterations: 100000, restartAfter: 200 }, { now: cpuNow });
  assert.equal(res.stopReason, 'time');
  assert.ok(res.elapsedSec <= 2.2 && res.elapsedSec >= 1.7, 'CPU-clock elapsed ' + res.elapsedSec);
  // clampParams' minimum (5 s) applies to the form; a below-minimum cap passed directly is honored
  assert.equal(S.clampParams('tabu', { timeCapSec: 1 }).timeCapSec, 5);
});

test('shouldStop is asked at least every 250 ms; the run then stops at once with the best plan so far', (t) => {
  const inst = phase1(5);
  for (const stopAfter of [300, 1500]) {                        // in the walk, and later (restarts)
    let calls = 0, stopAt = 0, last = 0, maxGap = 0;
    const t0 = cpuNow();
    last = t0;
    const res = TABU.run(inst, { seed: 4, timeCapSec: 600, iterations: 100000, restartAfter: 100 }, {
      now: cpuNow,
      shouldStop: () => {
        const c = cpuNow();
        maxGap = Math.max(maxGap, c - last); last = c; calls++;
        if (c - t0 > stopAfter) { if (!stopAt) stopAt = c; return true; }
        return false;
      }
    });
    const after = cpuNow() - stopAt;
    t.diagnostic(`stop after ${stopAfter} ms: ${calls} shouldStop calls, max gap ${maxGap.toFixed(0)} ms (CPU), returned ${after.toFixed(0)} ms after it turned true`);
    checkResult(inst, res, 'stopped');
    assert.equal(res.stopReason, 'stopped');
    assert.ok(maxGap <= 250, 'max gap between shouldStop calls ' + maxGap.toFixed(0) + ' ms');
    assert.ok(after < 50, 'returned ' + after.toFixed(0) + ' ms (CPU) after shouldStop turned true');
    // the contract is a gap of at most 250 ms (checked above), so that many calls at least
    assert.ok(calls >= Math.floor(stopAfter / 250), 'shouldStop calls ' + calls);
    assert.ok(res.total <= res.extra.startTotal);
    if (stopAfter > 1000) assert.ok(res.extra.restarts >= 1, 'stopped after a restart');
  }
});

test('edge cases: no jobs, no trucks, everything locked to one truck, one rally point allowed', () => {
  const none = S.makeTestInstance(1, { nJobs: 0, nVehicles: 2 });
  const r0 = TABU.run(none, fast(), {});
  checkResult(none, r0, 'no jobs');
  assert.equal(r0.stopReason, 'converged');
  const noTrucks = S.makeTestInstance(2, { nJobs: 5, nVehicles: 0 });
  const r1 = TABU.run(noTrucks, fast(), {});
  assert.equal(r1.feasible, true);
  assert.equal(r1.total, S.evaluate(noTrucks, r1.solution).total);
  assert.equal(r1.stopReason, 'converged');
  const locked = small(3, { locked: 12 });
  checkResult(locked, TABU.run(locked, fast(), {}), 'locked');
  const oneRally = small(4, { maxRallyPoints: 1, pinned: 1, closedZones: 2 });
  const r3 = TABU.run(oneRally, fast(), {});
  checkResult(oneRally, r3, 'one rally point');
  assert.ok(S.evaluate(oneRally, r3.solution).stats.rallyPoints <= 1);
});

// ---- quality on 10 Phase 1 instances (worker threads; budget-bound, so deterministic) -------------
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
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
      const r = S.methods.tabu.run(inst, task.params, {});
      const e = S.evaluate(inst, r.solution, { costOnly: true });
      if (e.total !== r.total) throw new Error('total mismatch');
      total = r.total; feasible = r.feasible;
      extra = { stopReason: r.stopReason, iterations: r.iterations, steps: r.extra.steps, restarts: r.extra.restarts,
        startTrials: r.extra.startTrials, elapsedSec: r.elapsedSec, evals: r.evals, gainBy: r.extra.gainBy };
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

test('quality: 10 Phase 1 instances vs construct + localSearch and a 10x multi-start reference', { timeout: 60 * 60 * 1000 }, async (t) => {
  const full = process.env.TABU_QUALITY === 'full';
  const tested = full ? { timeCapSec: 1800 } : { timeCapSec: 1800, iterations: 1000 };
  const STARTS = 10;                       // reference = 10 seeds x the tested budget (the tested run is one)
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const tasks = [];
  for (const seed of seeds) {
    tasks.push({ seed, opts: P1, kind: 'ls', inst: seed });
    for (let k = 0; k < STARTS; k++) {
      const params = Object.assign({}, tested, k === 0 ? {} : { seed: 9000 + 131 * k });
      tasks.push({ seed, opts: P1, kind: k === 0 ? 'tabu' : 'ref', params, inst: seed });
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
    const tb = mine.find(([x]) => x.kind === 'tabu')[1];
    const all = mine.map(([, r]) => r);
    all.forEach((r) => assert.equal(r.feasible, true, 'every plan violation-free'));
    const ref = Math.min(...all.map((r) => r.total));
    rows.push({ seed, ls: ls.total, tabu: tb.total, ref, gap: rel(tb.total, ref), vsLs: rel(tb.total, ls.total),
      lsGap: rel(ls.total, ref), sec: tb.extra.elapsedSec, stop: tb.extra.stopReason, it: tb.extra.iterations,
      steps: tb.extra.steps, restarts: tb.extra.restarts, startTrials: tb.extra.startTrials, evals: tb.extra.evals });
  }
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const meanGap = mean((r) => r.gap), maxGap = Math.max(...rows.map((r) => r.gap));
  const meanVsLs = mean((r) => r.vsLs), meanLsGap = mean((r) => r.lsGap);
  const summary = `tabu quality (${full ? 'default params' : 'iterations 1000'}): ` +
    `mean gap to 10x reference ${(100 * meanGap).toFixed(2)}%, max ${(100 * maxGap).toFixed(2)}%; ` +
    `vs construct+localSearch ${(100 * meanVsLs).toFixed(2)}% (LS gap ${(100 * meanLsGap).toFixed(2)}%); ` +
    `tabu wins ${rows.filter((r) => r.tabu < r.ls - 1e-6).length}/10, ties ${rows.filter((r) => Math.abs(r.tabu - r.ls) <= 1e-6).length}; ` +
    `${mean((r) => r.sec).toFixed(2)} s, ${Math.round(mean((r) => r.evals)).toLocaleString('en-US')} evaluations per run; ` +
    `wall ${wall.toFixed(0)} s on ${threads} threads`;
  t.diagnostic(summary);
  if (process.env.TABU_QUALITY_LOG) {
    for (const r of rows) {
      console.log(`  seed ${r.seed}: LS ${r.ls.toFixed(1)}  tabu ${r.tabu.toFixed(1)}  ref ${r.ref.toFixed(1)}  gap ${(100 * r.gap).toFixed(2)}%  ` +
        `vs LS ${(100 * r.vsLs).toFixed(2)}%  ${r.sec.toFixed(2)} s  ${r.startTrials} start trials  ${r.steps} steps  ${r.restarts} restarts  ${r.stop}`);
    }
    console.log(summary);
  }
  rows.forEach((r) => assert.equal(r.stop, 'budget', 'seed ' + r.seed + ' ran its full budget (not cut by time)'));
  // measured 2026-10-06: iterations 1000: vs LS -4.32% (9/10 wins), mean gap 2.16%, max 6.76%;
  // default params: vs LS -5.76% (10/10), mean gap 2.41%, max 7.79%. The limits leave room for changes
  // in the shared move library and cost model without letting a real regression through.
  const lim = full ? { vsLs: -0.03, mean: 0.03, max: 0.10 } : { vsLs: -0.01, mean: 0.04, max: 0.12 };
  assert.ok(meanVsLs < lim.vsLs, 'beats construct + localSearch on average: ' + (100 * meanVsLs).toFixed(2) + '%');
  assert.ok(rows.every((r) => r.tabu <= r.ls * 1.02), 'never much worse than construct + localSearch');
  assert.ok(meanGap <= lim.mean, 'mean gap to the 10x reference ' + (100 * meanGap).toFixed(2) + '%');
  assert.ok(maxGap <= lim.max, 'max gap to the 10x reference ' + (100 * maxGap).toFixed(2) + '%');
});
