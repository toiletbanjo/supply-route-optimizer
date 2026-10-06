// Ant colony optimization (src/solver/aco.js): registration and budget, the pheromone update rule,
// pheromone-guided ant construction (rally / delivery point and sequencing choices, capacity, type,
// locks, maxRallyPoints), every knob used, plan validity (violation-free, total = evaluate),
// determinism per seed, progress protocol, time cap, shouldStop, brute-force optimum on tiny instances,
// and the quality check on 10 Phase 1 instances against construct + localSearch and a 10x multi-start
// reference.
//
// Quality check (budget-bound, never time-bound, so the numbers do not depend on machine speed or load
// and the tolerances are not flaky):
//   default            ACO with default params except iterations 30 (a fifth of the default budget);
//                      reference = best of 10 seeds at that budget (10x) and construct + localSearch.
//   ACO_QUALITY=full   ACO with the true default params (150 iterations); reference = best of 10 seeds
//                      at the default budget (10x).
// ACO_QUALITY_LOG=1 prints the per-instance table. Skip it with --test-skip-pattern=quality.
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
  'src/solver/aco.js'
];
const SRO = loadScripts(FILES);
const S = SRO.solver;
const ACO = S.methods.aco;
const COST_ONLY = { costOnly: true };

// Phase 1 size: 30 jobs, 8 trucks, 10 rally candidates (max 8 used), 3 hubs, deadlines within 1-10 h,
// 3 risk zones.
const P1 = {
  nJobs: 30, nVehicles: 8, nRally: 10, nHubs: 3, maxRallyPoints: 8, capacity: { tanker: 7500, cargo: 30 },
  deadlineMin: 60, deadlineMax: 600, riskZones: 3, directShare: 0.3
};
const phase1 = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({}, P1, extra));
const small = (seed, extra = {}) => S.makeTestInstance(seed, Object.assign({ nJobs: 12, nVehicles: 4, nRally: 5, nHubs: 2 }, extra));
const fast = (extra = {}) => Object.assign({ timeCapSec: 60, iterations: 8, ants: 10 }, extra);
const rel = (a, b) => (a - b) / Math.max(1, Math.abs(b));

function checkResult(inst, res, label) {
  assert.ok(res && res.solution, label + ': has a solution');
  const ev = S.evaluate(inst, res.solution);
  assert.equal(ev.violations.length, 0, label + ': no violations ' + JSON.stringify(ev.violations.slice(0, 2)));
  assert.equal(res.feasible, true, label + ': feasible');
  assert.equal(res.total, ev.total, label + ': total equals evaluate().total');
  assert.ok(S.isNormalized(inst, res.solution), label + ': normalized');
  assert.ok(Number.isInteger(res.iterations) && res.iterations >= 0, label + ': iterations');
  assert.ok(res.evals >= res.extra.antsBuilt, label + ': evals');
  assert.ok(['budget', 'time', 'stopped', 'converged'].includes(res.stopReason), label + ': stopReason ' + res.stopReason);
  assert.ok(Array.isArray(res.history) && res.history.length >= 1, label + ': history');
  for (let i = 1; i < res.history.length; i++) {
    assert.ok(res.history[i].best <= res.history[i - 1].best + 1e-9, label + ': history best never goes up');
    assert.ok(res.history[i].t >= res.history[i - 1].t, label + ': history time order');
  }
  return ev;
}

test('registered as SRO.solver.methods.aco; budget() = iterations', () => {
  assert.equal(ACO.key, 'aco');
  assert.equal(ACO.label, 'Ant colony');
  assert.equal(typeof ACO.run, 'function');
  assert.equal(ACO.budget(null, {}), S.defaultParams('aco').iterations);
  assert.equal(ACO.budget(null, { iterations: 42 }), 42);
});

// ---- trails: the update rule in the header, exactly ------------------------------------------------
test('trail update rule: evaporation, normalized round-best deposit, elitist deposit, MAX-MIN bounds', () => {
  const inst = phase1(1);
  const P = S.prepare(inst);
  const nN = P.nN;
  const cfg = ACO._cfg;
  const p = { alpha: 1, evaporation: 0.1, q: 1 };
  const T = ACO._makeTrails(P, p);
  assert.equal(T.tauMax, cfg.tau0 / 0.1);
  assert.equal(T.tauMin, cfg.tau0 / cfg.tauRatio);
  assert.ok(T.arc.every((x) => x === T.tauMax) && T.jn.every((x) => x === T.tauMax), 'trails start at tauMax');
  assert.ok(T.arcPow.every((x) => x === 1) && T.jnPow.every((x) => x === 1));
  // two plans: A (round best) and B (best so far, cheaper)
  const A = S.construct(inst);
  const B = S.localSearch(inst, A, { rng: SRO.util.rng(1) });
  const cA = S.evaluate(inst, A, COST_ONLY).total, cB = S.evaluate(inst, B, COST_ONLY).total;
  assert.ok(cB < cA);
  const comps = (sol) => {
    const arcs = new Set(), jn = new Set();
    for (const r of sol.routes) {
      if (!r.visits.length) continue;
      let a = P.vStart[r.vehicle];
      for (const v of r.visits) { if (v.node !== a) arcs.add(a * nN + v.node); for (const c of v.jobs) jn.add(c.job * nN + v.node); a = v.node; }
      arcs.add(a * nN + P.vHub[r.vehicle]);
    }
    return { arcs, jn };
  };
  const cAc = comps(A), cBc = comps(B);
  // start below the cap so the deposits are visible: one round of pure evaporation first
  T.update(null, Infinity, null, Infinity);
  assert.ok(T.arc.every((x) => Math.abs(x - 9) < 1e-12), 'evaporation (1 - rho) x tau');
  T.update(A, cA, B, cB);
  const dA = 1 * (1 - cfg.eliteShare) * (cB / cA), dB = 1 * cfg.eliteShare;
  const expect = (inA, inB) => Math.min(T.tauMax, 9 * 0.9 + (inA ? dA : 0) + (inB ? dB : 0));
  let checked = { both: 0, a: 0, b: 0, none: 0 };
  for (let k = 0; k < nN * nN; k++) {
    const inA = cAc.arcs.has(k), inB = cBc.arcs.has(k);
    assert.ok(Math.abs(T.arc[k] - expect(inA, inB)) < 1e-9, 'arc ' + k);
    checked[inA && inB ? 'both' : inA ? 'a' : inB ? 'b' : 'none']++;
  }
  for (let k = 0; k < P.nJ * nN; k++) assert.ok(Math.abs(T.jn[k] - expect(cAc.jn.has(k), cBc.jn.has(k))) < 1e-9, 'jn ' + k);
  assert.ok(checked.both > 0 && checked.a > 0 && checked.b > 0 && checked.none > 0, JSON.stringify(checked));
  assert.ok(Math.abs(T.arcPow[[...cBc.arcs][0]] - Math.sqrt(T.arc[[...cBc.arcs][0]] / T.tauMax)) < 1e-12, 'arcPow = (tau / tauMax)^(alpha / 2)');
  // converged: the best plan's components tend to q / rho = tauMax, all others sit at the floor
  for (let i = 0; i < 150; i++) T.update(B, cB, B, cB);
  for (let k = 0; k < nN * nN; k++) {
    if (cBc.arcs.has(k)) assert.ok(T.arc[k] > T.tauMax - 1e-5 && T.arc[k] <= T.tauMax, 'arc ' + k + ' ' + T.arc[k]);
    else assert.equal(T.arc[k], T.tauMin);
  }
  for (let k = 0; k < P.nJ * nN; k++) {
    if (cBc.jn.has(k)) assert.ok(T.jn[k] > T.tauMax - 1e-5 && T.jn[k] <= T.tauMax, 'jn ' + k);
    else assert.equal(T.jn[k], T.tauMin);
  }
  T.reset();
  assert.ok(T.arc.every((x) => x === T.tauMax), 'reset to tauMax');
  // a small q holds the best plan's components at q / rho (here twice the floor); a huge q never
  // pushes a trail past tauMax
  const small = ACO._makeTrails(P, { alpha: 2, evaporation: 0.1, q: 0.01 });
  for (let i = 0; i < 400; i++) small.update(B, cB, B, cB);
  const kB = [...cBc.jn][0];
  assert.ok(Math.abs(small.jn[kB] - 0.1) < 1e-9, 'steady state q / rho: ' + small.jn[kB]);
  assert.ok(Math.abs(small.jnPow[kB] - Math.pow(0.1 / small.tauMax, 2)) < 1e-15, 'jnPow = (tau / tauMax)^alpha');
  const big = ACO._makeTrails(P, { alpha: 1, evaporation: 0.5, q: 1000 });
  for (let i = 0; i < 5; i++) big.update(A, cA, B, cB);
  assert.ok(big.arc.every((x) => x <= big.tauMax && x >= big.tauMin) && big.tauMax === 2);
  const flat = ACO._makeTrails(P, { alpha: 0, evaporation: 0.1, q: 1 });
  flat.update(A, cA, B, cB);
  assert.ok(flat.arcPow.every((x) => x === 1) && flat.jnPow.every((x) => x === 1), 'alpha 0 ignores the trails');
});

// ---- ant construction -----------------------------------------------------------------------------
function randomTrails(P, rng) {
  const arcPow = new Float64Array(P.nN * P.nN), jnPow = new Float64Array(P.nJ * P.nN);
  for (let k = 0; k < arcPow.length; k++) arcPow[k] = Math.pow(10, -3 * rng());
  for (let k = 0; k < jnPow.length; k++) jnPow[k] = Math.pow(10, -3 * rng());
  return { arcPow, jnPow };
}

test('ants: every plan is violation-free (capacity, type, locks, candidates, banned, maxRallyPoints, closures)', () => {
  let plans = 0, rallyCapped = 0, split = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const inst = seed % 3 === 0 ? phase1(seed, { closedZones: 2, locked: 3, pinned: 1, banned: 1, maxRallyPoints: 3 })
      : small(seed, { locked: seed % 4, pinned: seed % 3, banned: seed % 2, closedZones: seed % 3, maxRallyPoints: 1 + (seed % 3), capacity: { tanker: 1500, cargo: 6 } });
    const P = S.prepare(inst);
    const rng = SRO.util.rng(seed);
    for (const beta of [0, 3]) {
      const build = ACO._makeBuilder(inst, P, { beta, c0: 50 });
      for (let k = 0; k < 15; k++) {
        const sol = build(rng, randomTrails(P, rng));
        const ev = S.evaluate(inst, sol);
        assert.equal(ev.violations.length, 0, 'seed ' + seed + ': ' + JSON.stringify(ev.violations.slice(0, 2)));
        assert.ok(S.isNormalized(inst, sol));
        assert.ok(ev.stats.rallyPoints <= inst.params.maxRallyPoints);
        if (ev.stats.rallyPoints === inst.params.maxRallyPoints) rallyCapped++;
        const seen = new Map();
        for (const r of sol.routes) for (const v of r.visits) for (const c of v.jobs) seen.set(c.job, (seen.get(c.job) || 0) + 1);
        for (const n of seen.values()) if (n > 1) { split++; break; }
        plans++;
      }
    }
  }
  assert.ok(plans === 360 && rallyCapped > 10 && split > 0, `plans ${plans}, at the rally limit ${rallyCapped}, with splits ${split}`);
});

test('ants: the (job, node) trail picks the delivery / rally point', (t) => {
  let tried = 0, minShare = 1;
  for (let seed = 1; seed <= 6; seed++) {
    const inst = phase1(seed, { maxRallyPoints: 10 });          // every rally point may open
    const P = S.prepare(inst);
    const build = ACO._makeBuilder(inst, P, { beta: 3, c0: 50 });
    // a job with two or more candidate nodes that fits one truck
    const j = inst.jobs.findIndex((jb, i) => S.candidateNodes(inst, i).length >= 2 && jb.qty <= P1.capacity[jb.group === 'fuel' ? 'tanker' : 'cargo'] / 2);
    if (j < 0) continue;
    const nodes = S.candidateNodes(inst, j);
    for (const favored of nodes.slice(0, 2)) {
      const trails = { arcPow: new Float64Array(P.nN * P.nN).fill(1), jnPow: new Float64Array(P.nJ * P.nN).fill(1) };
      for (const n of nodes) trails.jnPow[j * P.nN + n] = n === favored ? 1 : 1e-7;
      const rng = SRO.util.rng(seed);
      let at = 0, delivered = 0;
      for (let k = 0; k < 40; k++) {
        const sol = build(rng, trails);
        for (const r of sol.routes) for (const v of r.visits) for (const c of v.jobs) if (c.job === j) { delivered++; if (v.node === favored) at++; }
      }
      // (a chunk can still land elsewhere when no truck with room can reach the favored node in time)
      assert.ok(delivered >= 40, 'seed ' + seed + ' job ' + j + ' delivered');
      assert.ok(at / delivered >= 0.9, `seed ${seed} job ${j}: ${at}/${delivered} chunks at the favored node ${favored}`);
      minShare = Math.min(minShare, at / delivered);
      tried++;
    }
  }
  t.diagnostic(tried + ' (job, favored node) cases; lowest share of chunks at the favored node ' + minShare.toFixed(3));
  assert.ok(tried >= 8);
});

test('ants: the (node, node) trail picks the visiting order', (t) => {
  // one cargo truck, two direct-delivery jobs with far deadlines: the trail alone decides the order
  let tried = 0, minFollow = 40;
  for (let seed = 1; seed <= 6; seed++) {
    const inst = S.makeTestInstance(seed, { nJobs: 2, nVehicles: 1, tankers: 0, fuelShare: 0, fixedShare: 1, twoJobShare: 0, nRally: 2, deadlineMin: 2000, deadlineMax: 2100, lateAvailableShare: 0, capacity: { tanker: 7500, cargo: 30 } });
    const P = S.prepare(inst);
    const [a, b] = [0, 1].map((j) => S.candidateNodes(inst, j)[0]);
    if (a === b) continue;
    const hub = P.vHub[0];
    const build = ACO._makeBuilder(inst, P, { beta: 3, c0: 50 });
    for (const [x, y] of [[a, b], [b, a]]) {
      const arcPow = new Float64Array(P.nN * P.nN).fill(1e-4), jnPow = new Float64Array(P.nJ * P.nN).fill(1);
      arcPow[hub * P.nN + x] = 1; arcPow[x * P.nN + y] = 1; arcPow[y * P.nN + hub] = 1;
      const rng = SRO.util.rng(seed);
      let follow = 0;
      for (let k = 0; k < 40; k++) {
        const v = build(rng, { arcPow, jnPow }).routes[0].visits.map((s) => s.node);
        if (v.length === 2 && v[0] === x && v[1] === y) follow++;
      }
      assert.ok(follow >= 36, `seed ${seed}: ${follow}/40 ants drive hub -> ${x} -> ${y} -> hub`);
      minFollow = Math.min(minFollow, follow);
      tried++;
    }
  }
  t.diagnostic(tried + ' orders tried; fewest ants following the trail: ' + minFollow + '/40');
  assert.ok(tried >= 6);
});

// ---- runs -----------------------------------------------------------------------------------------
test('small instances: violation-free plan, total = evaluate, never worse than the start, full budget run', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const inst = small(seed, { locked: seed % 3, pinned: seed % 2, banned: seed % 2, closedZones: seed % 2, maxRallyPoints: 1 + seed % 4 });
    const params = fast({ seed });
    const res = ACO.run(inst, params, {});
    const ev = checkResult(inst, res, 'seed ' + seed);
    const start = S.evaluate(inst, S.construct(inst, { rng: SRO.util.rng(seed) }), COST_ONLY);
    assert.equal(res.extra.startTotal, start.total, 'seed ' + seed + ': starts from construct');
    assert.ok(ev.total <= start.total + 1e-9, 'seed ' + seed + ': not worse than construct');
    assert.equal(res.stopReason, 'budget', 'seed ' + seed);
    assert.equal(res.iterations, 8);
    assert.equal(res.extra.antsBuilt, 80);
    assert.equal(res.extra.roundMean.length, 8);
    assert.ok(res.extra.lsEvals > 0 && res.extra.antMs > 0);
    assert.ok(ev.stats.rallyPoints <= inst.params.maxRallyPoints);
  }
});

test('tiny instances: reaches the brute-force optimum', () => {
  for (let seed = 1; seed <= 16; seed++) {
    const inst = tinyInstance(SRO, seed);
    const bf = bruteForce(SRO, inst);
    const res = ACO.run(inst, fast({ seed }), {});
    checkResult(inst, res, 'tiny ' + seed);
    // the brute force has no splits, so a plan with splits may beat it; never worse than it
    assert.ok(res.total <= bf.total + 1e-6 * Math.max(1, bf.total), 'tiny ' + seed + ': ' + res.total + ' vs brute force ' + bf.total);
  }
});

test('same seed gives the identical plan; another seed searches differently', () => {
  const inst = phase1(3);
  const p = { seed: 77, timeCapSec: 60, iterations: 12 };
  const a = ACO.run(inst, p, {}), b = ACO.run(inst, p, {});
  assert.equal(a.stopReason, 'budget');
  assert.deepEqual(plain(a.solution), plain(b.solution));
  assert.equal(a.total, b.total);
  assert.equal(a.iterations, b.iterations);
  assert.equal(a.evals, b.evals);
  assert.deepEqual(plain(a.extra.roundMean), plain(b.extra.roundMean));
  assert.equal(a.extra.antBest, b.extra.antBest);
  // (history points are merged per 50 ms of wall time, so only the last one is compared)
  assert.equal(a.history[a.history.length - 1].best, b.history[b.history.length - 1].best);
  const c = ACO.run(inst, Object.assign({}, p, { seed: 78 }), {});
  checkResult(inst, c, 'seed 78');
  assert.notDeepEqual(plain(c.extra.roundMean), plain(a.extra.roundMean), 'a different seed builds different ants');
});

// Learning curve: mean raw ant total of the last 5 rounds over that of the first 3, local search off so
// only ants and trails act (25 rounds of 10 ants, 4 Phase 1 windows; budget-bound, so deterministic).
function learning(x) {
  const ratios = [], firsts = [], runs = [];
  for (const seed of [1, 2, 3, 4]) {
    const inst = phase1(seed);
    const r = ACO.run(inst, Object.assign({ seed: 3, timeCapSec: 60, iterations: 25, ants: 10, localSearch: false }, x), {});
    checkResult(inst, r, JSON.stringify(x) + ' seed ' + seed);
    const m = r.extra.roundMean;
    const first = (m[0] + m[1] + m[2]) / 3, last = m.slice(-5).reduce((s, v) => s + v, 0) / 5;
    ratios.push(last / first); firsts.push(first); runs.push(r);
  }
  return { ratio: ratios.reduce((s, v) => s + v, 0) / ratios.length, first: firsts.reduce((s, v) => s + v, 0) / firsts.length, runs };
}

test('every knob is used: ants, iterations, alpha, beta, evaporation, q, localSearch (seed, timeCapSec: own tests)', (t) => {
  const base = learning({});
  const noTrail = learning({ alpha: 0 });
  const strong = learning({ alpha: 3 });
  const noEta = learning({ beta: 0 });
  const tinyQ = learning({ q: 0.01 });
  const bigQ = learning({ q: 10 });
  const slow = learning({ evaporation: 0.02 });
  const fastEvap = learning({ evaporation: 0.9 });
  t.diagnostic('last/first mean ant: default ' + base.ratio.toFixed(3) + ', alpha 0 ' + noTrail.ratio.toFixed(3) + ', alpha 3 ' + strong.ratio.toFixed(3) +
    ', q 0.01 ' + tinyQ.ratio.toFixed(3) + ', q 10 ' + bigQ.ratio.toFixed(3) + ', rho 0.02 ' + slow.ratio.toFixed(3) + ', rho 0.9 ' + fastEvap.ratio.toFixed(3) +
    '; first-round mean ant beta 0 / beta 3: ' + (noEta.first / base.first).toFixed(1));
  // alpha: with the trails the ants improve round by round; without them they do not learn
  assert.ok(base.ratio < 0.95, 'default ants learn: ' + base.ratio);
  assert.ok(strong.ratio < 0.95, 'alpha 3 ants learn: ' + strong.ratio);
  assert.ok(noTrail.ratio > 0.97, 'alpha 0: no learning ' + noTrail.ratio);
  // beta: without the cost heuristic the ants build far worse plans
  assert.ok(noEta.first > 2 * base.first, 'beta 0 ants ' + noEta.first + ' vs ' + base.first);
  // q: a tiny deposit leaves the trails flat (no learning); a large one takes a different path
  assert.ok(tinyQ.ratio > 0.97, 'q 0.01: no learning ' + tinyQ.ratio);
  assert.notDeepEqual(plain(bigQ.runs[0].extra.roundMean), plain(base.runs[0].extra.roundMean), 'q 10 differs from q 1');
  // evaporation: sets tauMax = 1 / rho; a slow one keeps the initial trails for longer (no learning yet)
  assert.equal(slow.runs[0].extra.tauMax, 50);
  assert.equal(base.runs[0].extra.tauMax, 10);
  assert.ok(slow.ratio > 0.97, 'rho 0.02: still exploring ' + slow.ratio);
  assert.notDeepEqual(plain(fastEvap.runs[0].extra.roundMean), plain(base.runs[0].extra.roundMean), 'rho 0.9 differs');
  // ants, iterations: the work done
  const inst = small(5);
  const r = ACO.run(inst, { seed: 1, timeCapSec: 60, ants: 7, iterations: 9 }, {});
  assert.equal(r.extra.antsBuilt, 63);
  assert.equal(r.iterations, 9);
  assert.equal(r.extra.roundMean.length, 9);
  // localSearch: off = no local search at all
  const off = ACO.run(inst, { seed: 1, timeCapSec: 60, ants: 7, iterations: 9, localSearch: false }, {});
  checkResult(inst, off, 'localSearch off');
  assert.equal(off.extra.lsEvals, 0);
  assert.equal(off.extra.polishEvals, 0);
  assert.equal(off.evals, off.extra.antsBuilt + 1);
  assert.ok(r.extra.lsEvals > 0 && r.evals > r.extra.antsBuilt + 1);
  assert.ok(r.total <= off.total + 1e-9 || r.extra.lsGain > 0);
});

test('a start plan with violations: the result is violation-free and never worse', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const inst = small(seed);
    const start = randomSolution(SRO, inst, SRO.util.rng(seed));
    const e0 = S.evaluate(inst, start);
    const res = ACO.run(inst, fast({ seed }), { start });
    checkResult(inst, res, 'seed ' + seed);
    assert.ok(res.total <= e0.total, 'seed ' + seed);
    assert.equal(res.extra.startTotal, S.evaluate(inst, S.normalize(inst, start), COST_ONLY).total, 'starts from hooks.start');
  }
});

// The progress test runs on a CPU-time clock (hooks.now), so other processes on a busy machine cannot
// stretch the gaps; the method's own guarantee is about its clock.
const cpuNow = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

test('progress: iteration 0 first, at least every 250 ms, best only when it changed and always in sync', () => {
  const inst = phase1(2);
  const calls = [];
  let lastBest = null;
  const res = ACO.run(inst, { seed: 9, timeCapSec: 60, iterations: 40 }, {
    now: cpuNow,
    onProgress: (p) => {
      calls.push({ t: cpuNow(), p });
      if (p.best) {
        assert.notEqual(p.best, lastBest, 'best is sent only when it changed');
        if (lastBest) assert.ok(S.evaluate(inst, p.best, COST_ONLY).total < S.evaluate(inst, lastBest, COST_ONLY).total, 'a new best is better');
        lastBest = p.best;
      }
      assert.ok(lastBest, 'the first call carries the start plan');
      assert.equal(p.bestCost, S.evaluate(inst, lastBest, COST_ONLY).total, 'bestCost is the last plan sent');
      for (const k of ['fraction', 'bestCost', 'currentCost', 'elapsedSec', 'iteration']) assert.equal(typeof p[k], 'number', k);
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
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i].p.iteration >= calls[i - 1].p.iteration);
    assert.ok(calls[i].p.fraction >= calls[i - 1].p.fraction);
  }
  assert.ok(calls.filter((c) => c.p.best).length >= 3, 'several new bests reported');
  assert.ok(calls.some((c) => /^Round \d+ of 40/.test(c.p.message)), 'round in the message');
});

test('time cap honored within 10% (rounds, reserve and polish), plan valid', () => {
  const inst = phase1(4);
  for (const cap of [2, 5]) {
    const t0 = performance.now();
    const res = ACO.run(inst, { seed: 3, timeCapSec: cap, iterations: 10000 }, {});
    const wall = (performance.now() - t0) / 1000;
    checkResult(inst, res, 'cap ' + cap);
    assert.equal(res.stopReason, 'time');
    assert.ok(res.elapsedSec <= cap * 1.1, 'elapsed ' + res.elapsedSec + ' for cap ' + cap);
    assert.ok(wall <= cap * 1.1, 'wall ' + wall + ' for cap ' + cap);
    assert.ok(res.elapsedSec >= cap * 0.85, 'uses the time it has: ' + res.elapsedSec);
    assert.ok(res.iterations > 0 && res.iterations < 10000);
  }
  // without local search there is no polish reserve: the rounds run to the cap
  const t0 = performance.now();
  const r = ACO.run(inst, { seed: 3, timeCapSec: 2, iterations: 10000, localSearch: false }, {});
  const wall = (performance.now() - t0) / 1000;
  checkResult(inst, r, 'cap 2, no local search');
  assert.equal(r.stopReason, 'time');
  assert.ok(wall <= 2.2 && r.elapsedSec >= 1.9, 'wall ' + wall);
  // clampParams' minimum (5 s) applies to the form; a below-minimum cap passed directly is honored
  assert.equal(S.clampParams('aco', { timeCapSec: 1 }).timeCapSec, 5);
});

test('shouldStop stops the run at once and returns the best plan so far', () => {
  const inst = phase1(5);
  let calls = 0, stopAt = 0;
  const t0 = performance.now();
  const res = ACO.run(inst, { seed: 4, timeCapSec: 60 }, {
    shouldStop: () => { calls++; if (performance.now() - t0 > 400) { if (!stopAt) stopAt = performance.now(); return true; } return false; }
  });
  const after = performance.now() - stopAt;
  checkResult(inst, res, 'stopped');
  assert.equal(res.stopReason, 'stopped');
  assert.ok(after < 100, 'returned ' + after.toFixed(0) + ' ms after shouldStop turned true');
  assert.ok(calls > 20, 'asked before every ant: ' + calls);
  assert.ok(res.total <= res.extra.startTotal);
  assert.equal(res.extra.polishEvals, 0, 'no polish after a stop');
});

test('edge cases: no jobs, no trucks, everything locked to one truck, no periods', () => {
  const none = S.makeTestInstance(1, { nJobs: 0, nVehicles: 2 });
  const r0 = ACO.run(none, fast(), {});
  checkResult(none, r0, 'no jobs');
  assert.equal(r0.stopReason, 'converged');
  assert.equal(r0.total, 0);
  const noTrucks = S.makeTestInstance(2, { nJobs: 5, nVehicles: 0 });
  const r1 = ACO.run(noTrucks, fast(), {});
  assert.equal(r1.feasible, true);
  assert.equal(r1.stopReason, 'converged');
  assert.equal(r1.total, S.evaluate(noTrucks, r1.solution).total);
  const locked = small(3, { locked: 12 });
  const r2 = ACO.run(locked, fast(), {});
  checkResult(locked, r2, 'locked');
  const flat = small(4, { flatPeriods: true });
  flat.periods = [];
  const r3 = ACO.run(flat, fast(), {});
  checkResult(flat, r3, 'no periods');
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
      const r = S.methods.aco.run(inst, task.params, {});
      const e = S.evaluate(inst, r.solution, { costOnly: true });
      if (e.total !== r.total) throw new Error('total mismatch');
      total = r.total; feasible = r.feasible;
      extra = { stopReason: r.stopReason, iterations: r.iterations, elapsedSec: r.elapsedSec, antMs: r.extra.antMs,
        lsMs: r.extra.lsMs, startTotal: r.extra.startTotal, antBest: r.extra.antBest, reinits: r.extra.reinits };
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
  const full = process.env.ACO_QUALITY === 'full';
  const tested = full ? { timeCapSec: 600 } : { timeCapSec: 600, iterations: 30 };
  const STARTS = 10;                       // reference = 10 seeds x the tested budget (the tested run is one)
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const tasks = [];
  for (const seed of seeds) {
    tasks.push({ seed, opts: P1, kind: 'ls', inst: seed });
    for (let k = 0; k < STARTS; k++) {
      const params = Object.assign({}, tested, k === 0 ? {} : { seed: 7000 + 101 * k });
      tasks.push({ seed, opts: P1, kind: k === 0 ? 'aco' : 'ref', params, inst: seed });
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
    const aco = mine.find(([x]) => x.kind === 'aco')[1];
    const all = mine.map(([, r]) => r);
    all.forEach((r) => assert.equal(r.feasible, true, 'every plan violation-free'));
    const ref = Math.min(...all.map((r) => r.total));
    const refs = mine.filter(([x]) => x.kind !== 'ls').map(([, r]) => r.total);
    rows.push({ seed, ls: ls.total, aco: aco.total, ref, gap: rel(aco.total, ref), vsLs: rel(aco.total, ls.total),
      lsGap: rel(ls.total, ref), seedSpread: rel(Math.max(...refs), Math.min(...refs)), sec: aco.extra.elapsedSec,
      stop: aco.extra.stopReason, it: aco.extra.iterations, antMs: aco.extra.antMs, lsMs: aco.extra.lsMs });
  }
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const meanGap = mean((r) => r.gap), maxGap = Math.max(...rows.map((r) => r.gap));
  const meanVsLs = mean((r) => r.vsLs), meanLsGap = mean((r) => r.lsGap);
  const summary = `ACO quality (${full ? 'default params' : 'iterations 30'}, ${rows[0].it} rounds of 20 ants): ` +
    `mean gap to 10x reference ${(100 * meanGap).toFixed(2)}%, max ${(100 * maxGap).toFixed(2)}%; ` +
    `vs construct+localSearch ${(100 * meanVsLs).toFixed(2)}% (LS gap ${(100 * meanLsGap).toFixed(2)}%); ` +
    `ACO wins ${rows.filter((r) => r.aco < r.ls - 1e-6).length}/10; ` +
    `${mean((r) => r.sec).toFixed(2)} s per run (${mean((r) => r.antMs).toFixed(2)} ms per ant); wall ${wall.toFixed(0)} s on ${threads} threads`;
  t.diagnostic(summary);
  if (process.env.ACO_QUALITY_LOG) {
    for (const r of rows) {
      console.log(`  seed ${r.seed}: LS ${r.ls.toFixed(1)}  ACO ${r.aco.toFixed(1)}  ref ${r.ref.toFixed(1)}  gap ${(100 * r.gap).toFixed(2)}%  ` +
        `vs LS ${(100 * r.vsLs).toFixed(2)}%  seed spread ${(100 * r.seedSpread).toFixed(2)}%  ${r.sec.toFixed(2)} s  ${r.stop}`);
    }
    console.log(summary);
  }
  rows.forEach((r) => assert.equal(r.stop, 'budget', 'seed ' + r.seed + ' ran its full budget (not cut by time)'));
  // Measured 2026-10-06 (deterministic, so these repeat exactly while evaluate/construct/localsearch stay
  // the same). Full defaults (150 rounds): mean gap 0.90%, max 3.29% (seed 2), -11.85% vs construct +
  // localSearch, better on 9 of 10 (seed 8: +1.95%, where construct + localSearch happens to land on the
  // best plan any run found). A fifth of the rounds (default mode): mean gap 2.17%, max 7.02% (seed 6),
  // -10.58% vs construct + localSearch, better on 9 of 10. (Before the review split the round polish into
  // a short first localSearch call and one for the rest: 0.87% / 2.52% and 2.20% / 6.04%; neutral on 40
  // harder windows.) The bounds leave room for small changes in the shared solver core.
  const lim = full ? { mean: 0.03, max: 0.08 } : { mean: 0.04, max: 0.10 };
  assert.ok(meanVsLs < -0.05, 'beats construct + localSearch on average: ' + (100 * meanVsLs).toFixed(2) + '%');
  assert.ok(meanGap <= lim.mean, 'mean gap to the 10x reference ' + (100 * meanGap).toFixed(2) + '%');
  assert.ok(maxGap <= lim.max, 'max gap to the 10x reference ' + (100 * maxGap).toFixed(2) + '%');
});
