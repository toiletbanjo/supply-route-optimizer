// Rally-point compound moves (localsearch.js): moveRally, rallyState, rallySwap / pinRepair, the pin
// repair in every localSearch end phase, and the tabu and SA rally shakes while the limit binds. Before
// these, no single move emptied a whole rally point: a pinned point left unused at maxRallyPoints stayed
// unused (2,000 a plan), and tabu kept its construct plan at maxRallyPoints 2 on 2 of 3 seeds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from '../load.mjs';
import { SOLVER_FILES, plain } from './fixtures.mjs';

const SRO = loadScripts(SOLVER_FILES.concat(['src/solver/tabu.js', 'src/solver/sa.js', 'src/solver/aco.js']));
const S = SRO.solver;
const M = S.moves;

function sym(n, pairs) {
  const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : null)));
  for (const [a, b, x] of pairs) { m[a][b] = x; m[b][a] = x; }
  return m;
}
// Nodes: 0 hub, 1 rally A, 2 rally B (closer). Two cargo trucks of 10 pallets, two 8-pallet jobs that
// can use A or B (one truck each), maxRallyPoints 1, A pinned. Deferring is dear, so both go.
const A = { node: 1, platoonMiles: 2, platoonCost: 5 }, B = { node: 2, platoonMiles: 1, platoonCost: 3 };
const job = (k, cands) => ({ id: 'J' + k, requestId: 'R-' + (k + 1), lineIdxs: [0], group: 'cargo', qty: 8, unit: 'pallet', tier: 0,
  classRank: 1, deadline: 900, hardDeadline: false, candidates: cands, lockedTruck: null });
function twoPoints(edit) {
  const inst = {
    startMin: 400,
    nodes: [{ key: 'hub:H', kind: 'hub', gridId: 'H', label: 'Hub' }, { key: 'rally:A', kind: 'rally', gridId: 'A', label: 'A' },
      { key: 'rally:B', kind: 'rally', gridId: 'B', label: 'B' }],
    minutes: sym(3, [[0, 1, 40], [0, 2, 30], [1, 2, 20]]),
    miles: sym(3, [[0, 1, 20], [0, 2, 15], [1, 2, 10]]),
    riskUnits: sym(3, [[0, 1, 0], [0, 2, 0], [1, 2, 0]]),
    gridPaths: {},
    periods: [{ startMin: 0, endMin: 100000, speed: 1, risk: 1, name: 'Flat' }],
    vehicles: [{ id: 'V0', type: 'cargo', capacity: 10, hubNode: 0, availableAt: 400 }, { id: 'V1', type: 'cargo', capacity: 10, hubNode: 0, availableAt: 400 }],
    jobs: [job(0, [A, B]), job(1, [A, B])],
    weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },
    params: { mpg: 2, serviceMin: 15, loadMin: 20, maxRallyPoints: 1, pinnedRally: [1], bannedRally: [] },
    penalties: { latePerMin: [1, 3, 50, 500], defer: [5000, 6000, 7000, 50000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6] },
    fixed: null
  };
  if (edit) edit(inst);
  return inst;
}
const visitAt = (vehicle, node, jobs) => ({ vehicle, visits: [{ node, jobs: jobs.map((j) => ({ job: j, qty: 8 })) }] });
const BOTH_AT_B = { routes: [visitAt(0, 2, [0]), visitAt(1, 2, [1])] };
const usesNode = (sol, n) => sol.routes.some((r) => r.visits.some((v) => v.node === n && v.jobs.length));
const total = (inst, sol) => S.evaluate(inst, sol, { costOnly: true }).total;

test('rallyState: rally points used, the cap, unused pins, and whether the limit binds', () => {
  const inst = twoPoints();
  assert.deepEqual(problemsOf(inst), []);
  const st = S.rallyState(inst, BOTH_AT_B);
  assert.deepEqual(Array.from(st.used), [2]);
  assert.equal(st.atCap, true);
  assert.deepEqual(Array.from(st.pins), [1]);
  assert.equal(st.bound, true);
  assert.ok(Math.abs(st.share[2] - 2) < 1e-12, 'two whole jobs at B');
  const roomy = S.rallyState(twoPoints((i) => { i.params.maxRallyPoints = 2; }), BOTH_AT_B);
  assert.equal(roomy.atCap, false);
  assert.equal(roomy.bound, false);
  assert.equal(S.evaluate(inst, BOTH_AT_B).cost.pinned, 2000);
});

function problemsOf(inst) { return Array.from(S.validateInstance(inst)); }

test('at the limit no single sweep move reaches the pin; moveRally moves a whole rally point', () => {
  const inst = twoPoints();
  const t0 = total(inst, BOTH_AT_B);
  let n = 0;
  M.forEach(inst, BOTH_AT_B, (m) => {
    n++;
    const r = M.result(inst, BOTH_AT_B, m);
    if (!r) return false;
    const e = S.evaluate(inst, r, { costOnly: true });
    assert.ok(!(e.feasible && e.total < t0 - 1e-9), m.type + ' improves on its own');
    return false;
  }, { types: M.SWEEP_TYPES });
  assert.ok(n > 0);
  const moves = [];
  M.forEach(inst, BOTH_AT_B, (m) => { moves.push(m); return false; }, { types: ['moveRally'] });
  assert.deepEqual(plain(moves), [{ type: 'moveRally', u: 2, w: 1 }]);
  const before = JSON.stringify(BOTH_AT_B);
  const r = M.result(inst, BOTH_AT_B, moves[0]);
  assert.equal(JSON.stringify(BOTH_AT_B), before, 'input untouched');
  assert.ok(r.routes.every((rt) => rt.visits.every((v) => v.node === 1)), 'every visit at B now at A');
  const e = S.evaluate(inst, r);
  assert.equal(e.feasible, true);
  assert.ok(e.total < t0 - 1000, 'saves the unused-pin cost');
  const mm = Object.assign({}, moves[0]);
  M.describe(inst, BOTH_AT_B, mm);
  assert.deepEqual(plain(mm.drops).sort(), ['j0v0n2', 'j1v1n2']);
  assert.deepEqual(plain(mm.adds).sort(), ['j0v0n1', 'j1v1n1']);
  // the default enumeration includes it; below the limit it enumerates nothing
  let seen = 0;
  M.forEach(inst, BOTH_AT_B, (m) => { if (m.type === 'moveRally') seen++; return false; });
  assert.equal(seen, 1);
  const roomy = twoPoints((i) => { i.params.maxRallyPoints = 2; });
  M.forEach(roomy, BOTH_AT_B, () => assert.fail('no moveRally below the limit'), { types: ['moveRally'] });
});

test('pinRepair trades the rally point in use for the unused pin; localSearch uses it in its end phase', () => {
  const inst = twoPoints();
  const t0 = total(inst, BOTH_AT_B);
  const pr = S.pinRepair(inst, BOTH_AT_B, { rng: SRO.util.rng(1) });
  assert.equal(pr.opened, 1);
  assert.equal(pr.closed, 2);
  assert.equal(pr.pin, true);
  assert.ok(pr.evals > 0);
  assert.ok(usesNode(pr.solution, 1) && !usesNode(pr.solution, 2));
  const e = S.evaluate(inst, pr.solution);
  assert.equal(e.feasible, true);
  assert.equal(e.cost.pinned, 0);
  assert.equal(e.deferred.length, 0);
  assert.ok(e.total < t0 - 1000);
  // localSearch: its sweep finds the moveRally; without that move, its end phase repairs the pin
  assert.equal(S.evaluate(inst, S.localSearch(inst, BOTH_AT_B, { seed: 1 })).cost.pinned, 0);
  const st = {};
  const ls = S.localSearch(inst, BOTH_AT_B, { seed: 1, types: M.SWEEP_TYPES, stats: st });
  assert.equal(S.evaluate(inst, ls).cost.pinned, 0);
  assert.ok(st.refills >= 1, 'by the end phase');
  // pins only: nothing to repair without a pin
  assert.equal(S.pinRepair(twoPoints((i) => { i.params.pinnedRally = []; }), BOTH_AT_B, {}), null);
});

test('rallySwap opens a rally point a deferred job needs when the limit binds (no pin involved)', () => {
  // J1 can only use A; the plan has J0 at B and defers J1
  const inst = twoPoints((i) => { i.params.pinnedRally = []; i.jobs[1].candidates = [A]; });
  const onlyJ0 = { routes: [visitAt(0, 2, [0])] };
  const st = S.rallyState(inst, onlyJ0);
  assert.deepEqual(Array.from(st.pins), []);
  assert.equal(st.bound, true, 'J1 waits for a rally point the plan does not use');
  assert.equal(S.pinRepair(inst, onlyJ0, {}), null);
  const rs = S.rallySwap(inst, onlyJ0, { rng: SRO.util.rng(2) });
  assert.equal(rs.opened, 1);
  assert.equal(rs.closed, 2);
  assert.equal(rs.pin, false);
  const e = S.evaluate(inst, rs.solution);
  assert.equal(e.feasible, true);
  assert.equal(e.deferred.length, 0, 'both jobs delivered at A');
  assert.ok(e.total < total(inst, onlyJ0) - 1000);
  // not bound: nothing to open
  assert.equal(S.rallySwap(twoPoints((i) => { i.params.pinnedRally = []; }), BOTH_AT_B, {}), null);
});

test('below the rally limit localSearch runs exactly as before moveRally existed (same random stream)', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const inst = S.makeTestInstance(seed, { nJobs: 16, nVehicles: 4, nRally: 6, maxRallyPoints: 10 });
    const sol = S.construct(inst);
    const now = S.localSearch(inst, sol, { seed: 3 });
    const old = S.localSearch(inst, sol, { seed: 3, types: M.SWEEP_TYPES });   // explicit types: no SWEEP_LAST
    assert.equal(JSON.stringify(now), JSON.stringify(old), 'seed ' + seed);
  }
});

test('localSearch measures its time limit on opts.now; tabu, SA and ACO pass hooks.now', () => {
  const inst = S.makeTestInstance(4, { nJobs: 24, nVehicles: 5, nRally: 6 });
  const sol = S.construct(inst);
  let t = 0, reads = 0;
  const fake = () => { reads++; t += 1000; return t; };          // every read is a second later
  const st = {};
  S.localSearch(inst, sol, { seed: 1, timeLimitMs: 5000, now: fake, stats: st });
  assert.ok(reads > 0, 'read the given clock');
  assert.ok(st.ms >= 5000 && st.ms % 1000 === 0, 'ms on the given clock: ' + st.ms);
  assert.ok(st.evals < 256 * 12, 'stopped at the fake deadline after ' + st.evals + ' evaluations');
  const orig = S.localSearch;
  const clocks = new Set();
  const mine = () => performance.now();
  S.localSearch = function (i, s, o) { clocks.add(o && o.now); return orig.apply(this, arguments); };
  try {
    S.methods.tabu.run(inst, S.clampParams('tabu', { iterations: 60, seed: 1 }), { now: mine });
    S.methods.sa.run(inst, S.clampParams('sa', { coolingRate: 0.9, itersPerTemp: 20, reheats: 0, seed: 1 }), { now: mine });
    S.methods.aco.run(inst, S.clampParams('aco', { ants: 2, iterations: 2, seed: 1 }), { now: mine });
  } finally { S.localSearch = orig; }
  assert.deepEqual([...clocks], [mine], 'every localSearch call ran on hooks.now');
});

// maxRallyPoints-bound windows with two pinned rally points (the tabu-review family).
const P1 = { nJobs: 30, nVehicles: 8, nRally: 10, nHubs: 2, maxRallyPoints: 8, capacity: { tanker: 6000, cargo: 25 }, deadlineMin: 60, deadlineMax: 480, riskZones: 3 };

test('tabu: rally shakes (rally swaps and pin repairs among them) run at the limit, not below it', () => {
  let swaps = 0, shakes = 0;
  for (const seed of [1, 2, 3]) {
    const inst = S.makeTestInstance(seed, Object.assign({}, P1, { locked: 4, pinned: 2, banned: 2, closedZones: 2, maxRallyPoints: 3 }));
    const res = S.methods.tabu.run(inst, S.clampParams('tabu', { iterations: 600, seed }), {});
    const ev = S.evaluate(inst, res.solution);
    assert.equal(ev.feasible, true);
    assert.ok(ev.stats.rallyPoints <= 3);
    shakes += res.extra.rallyTrials; swaps += res.extra.swapTrials;
  }
  assert.ok(shakes > 0 && swaps > 0, `rally trials ${shakes}, swaps ${swaps}`);
  const free = S.makeTestInstance(3, Object.assign({}, P1, { locked: 4, pinned: 2, banned: 2, closedZones: 2, maxRallyPoints: 10 }));
  const r = S.methods.tabu.run(free, S.clampParams('tabu', { iterations: 600, seed: 3 }), {});
  assert.equal(r.extra.rallyTrials, 0);
  assert.equal(r.extra.swapTrials, 0);
});

test('SA: a rally burst after each cooling cycle while the plan is at the limit, none below it', () => {
  const sa = { coolingRate: 0.9, itersPerTemp: 40, reheats: 1 };
  const inst = S.makeTestInstance(2, Object.assign({}, P1, { pinned: 2, maxRallyPoints: 3 }));
  const res = S.methods.sa.run(inst, S.clampParams('sa', Object.assign({ seed: 2 }, sa)), {});
  assert.equal(S.evaluate(inst, res.solution).feasible, true);
  assert.ok(res.extra.rallyTrials > 0, 'rally trials ' + res.extra.rallyTrials);
  assert.ok(res.extra.rallyGain >= 0);
  const free = S.makeTestInstance(2, Object.assign({}, P1, { pinned: 2, maxRallyPoints: 10 }));
  const r = S.methods.sa.run(free, S.clampParams('sa', Object.assign({ seed: 2 }, sa)), {});
  assert.equal(r.extra.rallyTrials, 0);
});
