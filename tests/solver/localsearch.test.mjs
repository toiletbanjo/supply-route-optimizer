// Move library (apply/undo, copy-on-write, invariants, attributes), neighbors(), and localSearch
// (monotone, violation-free, near brute-force optimum on tiny instances).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSolver, plain, tinyInstance, bruteForce, randomSolution } from './fixtures.mjs';

const SRO = loadSolver();
const S = SRO.solver;
const M = S.moves;

function mixedInstance(seed) {
  const r = SRO.util.rng(seed * 101 + 3);
  return S.makeTestInstance(seed, {
    nJobs: 4 + r.int(26), nVehicles: 2 + r.int(6), nRally: 2 + r.int(7), nHubs: 1 + r.int(3),
    maxRallyPoints: 1 + r.int(6), locked: r.int(2), closedZones: r.int(2), pinned: r.int(2), banned: r.int(2)
  });
}

// A diverse (possibly worse, still structurally valid) solution: construct, then random moves accepted blindly.
function walked(inst, seed, steps = 25) {
  const rng = SRO.util.rng(seed);
  let sol = S.construct(inst, { rng });
  for (let k = 0; k < steps; k++) {
    const m = M.random(inst, sol, rng);
    if (!m) break;
    const nxt = M.result(inst, sol, m);
    if (nxt) sol = nxt;
  }
  return sol;
}

function checkInvariants(inst, sol, label) {
  assert.ok(S.isNormalized(inst, sol), label + ': normalized');
  for (const r of sol.routes) for (const v of r.visits) {
    assert.ok(v.jobs.length > 0, label + ': no empty visits');
    const seen = new Set();
    for (const c of v.jobs) {
      assert.ok(c.qty > 0, label + ': positive qty');
      assert.ok(!seen.has(c.job), label + ': one chunk per job per visit');
      seen.add(c.job);
    }
  }
}

test('every move type: apply then undo restores the identical solution and never mutates the input', (t) => {
  const counts = Object.fromEntries(M.TYPES.map((k) => [k, 0]));
  for (let seed = 1; seed <= 30; seed++) {
    const inst = mixedInstance(seed);
    const sol = walked(inst, seed);
    const rng = SRO.util.rng(seed + 1000);
    const ctx = M.context(inst, sol);
    for (const type of M.TYPES) {
      for (let k = 0; k < 15; k++) {
        const m = M.random(inst, sol, rng, { types: [type], ctx });
        if (!m) continue;
        const before = JSON.stringify(sol);
        const routesRef = sol.routes;
        const token = M.apply(inst, sol, m);
        assert.ok(token, type + ' applies');
        counts[type]++;
        checkInvariants(inst, sol, type);
        assert.equal(JSON.stringify({ routes: routesRef }), before, type + ": original routes untouched (copy-on-write)");
        M.undo(sol, token);
        assert.equal(sol.routes, routesRef);
        assert.equal(JSON.stringify(sol), before, type + ': undo restores');
      }
    }
  }
  t.diagnostic('moves applied per type: ' + JSON.stringify(counts));
  for (const type of M.TYPES) assert.ok(counts[type] > 0, 'generated at least one ' + type);
});

test('enumerated moves all build, keep invariants and quantities, and leave the input untouched', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const inst = mixedInstance(seed + 40);
    const sol = walked(inst, seed + 40, 10);
    const before = JSON.stringify(sol);
    const totalQty = (s) => s.routes.reduce((a, r) => a + r.visits.reduce((b, v) => b + v.jobs.reduce((c, x) => c + x.qty, 0), 0), 0);
    const q0 = totalQty(sol);
    let n = 0;
    M.forEach(inst, sol, (m) => {
      const res = M.result(inst, sol, m);
      assert.ok(res, 'enumerated ' + m.type + ' builds');
      checkInvariants(inst, res, m.type);
      const dq = totalQty(res) - q0;
      if (['twoOpt', 'orOpt', 'changeNode', 'merge', 'cross', 'exchange', 'swap', 'relocate'].includes(m.type)) assert.ok(Math.abs(dq) < 1e-6, m.type + ' keeps total quantity');
      if (m.type === 'defer') assert.ok(dq < 0);
      if (m.type === 'insert') assert.ok(dq > 0);
      n++;
      return n > 4000;
    });
    assert.ok(n > 0);
    assert.equal(JSON.stringify(sol), before);
  }
});

test('describe gives tabu attributes: adds / drops / sig / key', () => {
  const inst = mixedInstance(7);
  const sol = walked(inst, 7);
  const rng = SRO.util.rng(3);
  for (const type of M.TYPES) {
    const m = M.random(inst, sol, rng, { types: [type] });
    if (!m) continue;
    M.describe(inst, sol, m);
    assert.ok(Array.isArray(m.adds) && m.adds.length > 0 && m.adds.every((a) => typeof a === 'string'), type);
    assert.ok(Array.isArray(m.drops));
    assert.equal(m.sig, m.adds[0]);
    assert.ok(typeof m.key === 'string' && m.key.startsWith(type));
  }
  // a relocate's drop is the reverse of what relocating back adds
  const r = M.random(inst, sol, rng, { types: ['relocate'] });
  if (r) {
    M.describe(inst, sol, r);
    assert.match(r.drops[0], /^j\d+v\d+n\d+$/);
    assert.match(r.adds[0], /^j\d+v\d+n\d+$/);
  }
});

test('neighbors: k scored candidates; totals equal evaluate() of each neighbor; input untouched', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const inst = mixedInstance(seed + 80);
    const sol = S.construct(inst);
    const before = JSON.stringify(sol);
    const cands = S.neighbors(inst, sol, SRO.util.rng(seed), 50);
    assert.ok(cands.length > 0 && cands.length <= 50);
    for (const c of cands) {
      const e = S.evaluate(inst, c.solution, { costOnly: true });
      assert.equal(c.total, e.total);
      assert.equal(c.feasible, e.feasible);
      assert.ok(typeof c.sig === 'string' && Array.isArray(c.adds) && Array.isArray(c.drops));
      checkInvariants(inst, c.solution, c.move.type);
      // the candidate solution is exactly the move applied to the input
      assert.equal(JSON.stringify(M.result(inst, sol, c.move)), JSON.stringify(c.solution));
    }
    assert.equal(JSON.stringify(sol), before);
  }
});

test('localSearch never increases cost and keeps plans violation-free', (t) => {
  let gain = 0, base = 0, ms = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const inst = mixedInstance(seed + 200);
    const start = S.construct(inst);
    const e0 = S.evaluate(inst, start, { costOnly: true });
    assert.equal(e0.feasible, true);
    const t0 = performance.now();
    const stats = {};
    const out = S.localSearch(inst, start, { rng: SRO.util.rng(seed), maxIters: 30000, stats });
    ms += performance.now() - t0;
    const e1 = S.evaluate(inst, out);
    assert.ok(e1.total <= e0.total + 1e-9, `seed ${seed}: ${e1.total} > ${e0.total}`);
    assert.deepEqual(plain(e1.violations), [], 'seed ' + seed);
    assert.equal(stats.total, e1.total);
    checkInvariants(inst, out, 'ls');
    gain += e0.total - e1.total; base += e0.total;
  }
  t.diagnostic(`localSearch over construct: ${(gain / base * 100).toFixed(1)}% lower total cost on average, ${(ms / 40).toFixed(0)} ms per run`);
});

test('localSearch from a random infeasible plan reduces cost and never goes up', () => {
  const rng = SRO.util.rng(77);
  for (let seed = 1; seed <= 15; seed++) {
    const inst = mixedInstance(seed + 300);
    const start = randomSolution(SRO, inst, rng);
    const e0 = S.evaluate(inst, start, { costOnly: true });
    const out = S.localSearch(inst, start, { rng, maxIters: 20000 });
    const e1 = S.evaluate(inst, out, { costOnly: true });
    assert.ok(e1.total <= e0.total + 1e-9);
    if (!e0.feasible) assert.ok(e1.nViolations <= e0.nViolations);
  }
});

test('localSearch honors maxIters and timeLimitMs', () => {
  const inst = S.makeTestInstance(4, { nJobs: 30, nVehicles: 8, nRally: 8 });
  const st = {};
  S.localSearch(inst, S.construct(inst), { maxIters: 500, stats: st });
  assert.ok(st.evals <= 500 + 50, 'evals ' + st.evals);
  const st2 = {};
  const t0 = performance.now();
  S.localSearch(inst, S.emptySolution(inst), { timeLimitMs: 30, maxIters: 1e9, stats: st2 });
  assert.ok(performance.now() - t0 < 400);
});

function bfRate(t, label, extra, seeds) {
  let ok = 0, better = 0, n = 0, worst = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const inst = tinyInstance(SRO, seed, extra);
    const bf = bruteForce(SRO, inst);
    const ls = S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(seed) });
    const e = S.evaluate(inst, ls, { costOnly: true });
    assert.equal(e.feasible, true);
    n++;
    if (e.total <= bf.total * 1.01 + 1e-6) ok++;
    if (e.total < bf.total - 1e-6) better++;
    worst = Math.max(worst, e.total / bf.total - 1);
  }
  t.diagnostic(`${label}: localSearch(construct) within 1% of brute force on ${ok}/${n} seeds (${(ok / n * 100).toFixed(1)}%); ` +
    `${better} beat the no-split optimum using splits/partial loads; worst gap ${(worst * 100).toFixed(1)}%`);
  return ok / n;
}

test('tiny instances: localSearch from construct reaches within 1% of brute force (capacity-tight)', (t) => {
  assert.ok(bfRate(t, 'tight', {}, 100) >= 0.9);
});

test('tiny instances: localSearch from construct reaches within 1% of brute force (roomy trucks)', (t) => {
  const roomy = { capacity: { tanker: 12000, cargo: 50 }, fuelQty: [200, 2500], cargoQty: [1, 10] };
  assert.ok(bfRate(t, 'roomy', roomy, 100) >= 0.9);
});
