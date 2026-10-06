// Small-share splits (localsearch.js pickTarget / GEN.split, evaluate.js EXTRA_CHUNK). Before the fix a
// random move filled whatever room a truck had left, so a job was split into a large chunk plus a small
// one (SA 10 + 390 gal at one node 13 h apart, tabu 670 + 30, ACO 0.9 + 0.7 + 0.1 pallets), and a second
// chunk cost nothing extra. Now a random move makes no new chunk below MIN_SHARE (10%) of its job while
// another truck has room for that much (unless the chunk is the rest of the job, or merges into a chunk of
// the same job), and evaluate charges EXTRA_CHUNK x wS per chunk of a job after its first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from '../load.mjs';
import { SOLVER_FILES } from './fixtures.mjs';

const SRO = loadScripts(SOLVER_FILES);
const S = SRO.solver;
const M = S.moves;

function sym(n, pairs) {
  const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : null)));
  for (const [a, b, x] of pairs) { m[a][b] = x; m[b][a] = x; }
  return m;
}
// Nodes: 0 hub, 1 rally A, 2 rally B. Cargo trucks of 10 pallets. J0 9.5 and J1 4 pallets ride on V0
// and V1; J2 (8 pallets) is the job the moves place. 10% of J2 is 0.8 pallets; V0 has 0.5 left.
const A = { node: 1, platoonMiles: 2, platoonCost: 5 }, B = { node: 2, platoonMiles: 1, platoonCost: 3 };
const job = (k, qty) => ({ id: 'J' + k, requestId: 'R-' + (k + 1), lineIdxs: [0], group: 'cargo', qty, unit: 'pallet', tier: 0,
  classRank: 1, deadline: 900, hardDeadline: false, candidates: [A, B], lockedTruck: null });
function three(qty1 = 4, nVehicles = 3) {
  return {
    startMin: 400,
    nodes: [{ key: 'hub:H', kind: 'hub', gridId: 'H', label: 'Hub' }, { key: 'rally:A', kind: 'rally', gridId: 'A', label: 'A' },
      { key: 'rally:B', kind: 'rally', gridId: 'B', label: 'B' }],
    minutes: sym(3, [[0, 1, 40], [0, 2, 30], [1, 2, 20]]),
    miles: sym(3, [[0, 1, 20], [0, 2, 15], [1, 2, 10]]),
    riskUnits: sym(3, [[0, 1, 0], [0, 2, 0], [1, 2, 0]]),
    gridPaths: {},
    periods: [{ startMin: 0, endMin: 100000, speed: 1, risk: 1, name: 'Flat' }],
    vehicles: Array.from({ length: nVehicles }, (_, v) => ({ id: 'V' + v, type: 'cargo', capacity: 10, hubNode: 0, availableAt: 400 })),
    jobs: [job(0, 9.5), job(1, qty1), job(2, 8)],
    weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },
    params: { mpg: 2, serviceMin: 15, loadMin: 20, maxRallyPoints: 2, pinnedRally: [], bannedRally: [] },
    penalties: { latePerMin: [1, 3, 50, 500], defer: [5000, 6000, 7000, 50000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6] },
    fixed: null
  };
}
const at = (node, ...chunks) => ({ node, jobs: chunks.map(([j, qty]) => ({ job: j, qty })) });
const plan = (...visits) => ({ routes: visits.map((vs, v) => ({ vehicle: v, visits: vs })) });
// every move of `types` drawn from sol in n tries: [{ type, r2, v2, q }]
function draws(inst, sol, types, n = 3000) {
  const rng = SRO.util.rng(11), ctx = M.context(inst, sol), out = [];
  for (let i = 0; i < n; i++) {
    const m = M.random(inst, sol, rng, { types, ctx });
    if (m) out.push(m);
  }
  return out;
}
const MIN = 0.8;   // 10% of J2

test('insert: no new chunk below 10% of the job while another truck has room; allowed when no other truck can carry it, or as the rest of the job', () => {
  const inst = three();
  assert.deepEqual(Array.from(S.validateInstance(inst)), []);
  const sol = plan([at(1, [0, 9.5])], [at(1, [1, 4])], []);       // J2 deferred
  const ms = draws(inst, sol, ['insert']);
  assert.ok(ms.length > 1000);
  assert.ok(ms.every((m) => m.q >= MIN - 1e-9), 'smallest insert ' + Math.min(...ms.map((m) => m.q)));
  assert.equal(ms.filter((m) => m.r2 === 0).length, 0, 'V0 (0.5 left) gets no piece of J2');
  assert.ok(ms.some((m) => m.r2 === 1 && Math.abs(m.q - 6) < 1e-9) && ms.some((m) => m.r2 === 2 && m.q === 8), 'the roomy trucks still do');
  // only V0 has room: the 0.5 is the only way to carry any of J2, so it stays a move
  const full = three(10, 2);
  const tight = draws(full, plan([at(1, [0, 9.5])], [at(1, [1, 10])]), ['insert']);
  assert.ok(tight.length > 0 && tight.every((m) => m.r2 === 0 && Math.abs(m.q - 0.5) < 1e-9));
  // the last 0.5 of J2 completes the job, so it is no sliver
  const rest = draws(inst, plan([at(1, [0, 9.5])], [at(1, [1, 2.5])], [at(2, [2, 7.5])]), ['insert']);
  assert.ok(rest.some((m) => m.r2 === 0 && Math.abs(m.q - 0.5) < 1e-9), 'the rest of a job fits the last room');
});

test('split and relocate: no new small chunk while another truck has room; topping up a chunk of the same job is fine', () => {
  const inst = three();
  const sol = plan([at(1, [0, 9.5])], [at(1, [1, 4])], [at(2, [2, 8])]);
  const ms = draws(inst, sol, ['split', 'relocate']);
  assert.ok(ms.length > 1000);
  const j2 = ms.filter((m) => m.r1 === 2);
  assert.ok(j2.length > 300);
  assert.ok(j2.every((m) => m.q >= MIN - 1e-9), 'smallest J2 piece ' + Math.min(...j2.map((m) => m.q)));
  assert.ok(j2.every((m) => m.r2 !== 0), 'no piece of J2 to V0');
  // a split leaves no sliver behind either
  for (const m of ms.filter((x) => x.type === 'split')) {
    const ch = sol.routes[m.r1].visits[m.v1].jobs[m.c1];
    assert.ok(ch.qty - m.q >= 0.1 * inst.jobs[ch.job].qty - 1e-9, 'split leaves ' + (ch.qty - m.q) + ' of job ' + ch.job);
  }
  // V0 already carries some of J2 at A: 0.5 more into that chunk adds no chunk
  const topped = plan([at(1, [0, 9], [2, 0.5])], [at(1, [1, 4])], [at(2, [2, 7.5])]);
  const tm = draws(inst, topped, ['split', 'relocate']).filter((m) => m.r1 === 2);
  assert.ok(tm.some((m) => m.r2 === 0 && m.v2 === 0 && Math.abs(m.q - 0.5) < 1e-9), 'merge into the chunk of J2 on V0');
  assert.ok(tm.every((m) => !(m.r2 === 0 && m.v2 !== 0)), 'never a new visit of V0 for 0.5');
});

test('evaluate: EXTRA_CHUNK x wS per chunk of a job after its first, on the route that delivers it later; stats.extraChunks', () => {
  const inst = three();
  const whole = plan([at(1, [0, 9.5])], [at(1, [1, 4])], [at(2, [2, 8])]);
  const split2 = plan([at(1, [0, 9.5])], [at(1, [1, 4]), at(2, [2, 3])], [at(2, [2, 5])]);
  const split3 = plan([at(1, [0, 9.5])], [at(1, [1, 4], [2, 3])], [at(1, [2, 2]), at(2, [2, 3])]);
  const e1 = S.evaluate(inst, whole), e2 = S.evaluate(inst, split2), e3 = S.evaluate(inst, split3);
  assert.equal(S.EXTRA_CHUNK, 3);
  assert.deepEqual([e1.stats.extraChunks, e2.stats.extraChunks, e3.stats.extraChunks], [0, 1, 2]);
  const wS = inst.weights.simplicity;
  // the same plans without the charge
  S.EXTRA_CHUNK = 0;
  let f2, f3;
  try { f2 = S.evaluate(inst, split2); f3 = S.evaluate(inst, split3); } finally { S.EXTRA_CHUNK = 3; }
  assert.ok(Math.abs(e2.total - f2.total - 3 * wS) < 1e-9);
  assert.ok(Math.abs(e3.total - f3.total - 2 * 3 * wS) < 1e-9);
  assert.ok(Math.abs(e2.cost.simplicity - f2.cost.simplicity - 3 * wS) < 1e-9);
  // V1 meets J2 first in solution order; V2 delivers the later chunk and carries the charge
  assert.ok(Math.abs(e2.routes[1].cost.simplicity - f2.routes[1].cost.simplicity) < 1e-9);
  assert.ok(Math.abs(e2.routes[2].cost.simplicity - f2.routes[2].cost.simplicity - 3 * wS) < 1e-9);
  // route costs add up to the plan's simplicity
  const sum = e3.routes.reduce((s, r) => s + r.cost.simplicity, 0);
  assert.ok(Math.abs(sum - e3.cost.simplicity) < 1e-9);
});
