// Shared helpers for solver tests: loads the worker group up to localsearch.js, plus a brute-force
// optimizer for tiny instances (<= 4 jobs, <= 2 vehicles, no splits).
import { loadScripts } from '../load.mjs';

export const SOLVER_FILES = [
  'src/core/ns.js',
  'src/core/util.js',
  'src/solver/instance.js',
  'src/solver/params.js',
  'src/solver/evaluate.js',
  'src/solver/construct.js',
  'src/solver/localsearch.js'
];

export function loadSolver() { return loadScripts(SOLVER_FILES); }

// Objects created inside the vm context have that context's prototypes, which deepStrictEqual
// rejects; compare plain JSON copies instead.
export function plain(x) { return JSON.parse(JSON.stringify(x)); }

export function near(actual, expected, tol = 1e-6) {
  return Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected));
}

// Small instance for brute force: 2-4 jobs, 2 vehicles, every job fits a truck.
export function tinyInstance(SRO, seed, extra = {}) {
  const r = SRO.util.rng(seed * 7919 + 13);
  return SRO.solver.makeTestInstance(seed, Object.assign({
    nJobs: 2 + r.int(3), nVehicles: 2, nRally: 3, nHubs: 1 + r.int(2), noSplit: true,
    tankers: r() < 0.5 ? 1 : (r() < 0.5 ? 0 : 2), fuelShare: 0.4, riskZones: 1, deadlineMax: 400
  }, extra));
}

function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((x, i) => {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([x].concat(p));
  });
  return out;
}

// Exhaustive optimum over solutions without splits: every job is either deferred whole or delivered
// whole by one compatible vehicle at one of its candidate nodes; each vehicle visits each of its nodes
// once (all its jobs there in one visit), in every order. Scored with SRO.solver.evaluate; only
// violation-free solutions count. Returns { total, solution, evaluated }.
export function bruteForce(SRO, inst) {
  const S = SRO.solver;
  const nJ = inst.jobs.length, nV = inst.vehicles.length;
  if (nJ > 4 || nV > 2) throw new Error('bruteForce is for <= 4 jobs and <= 2 vehicles');
  const options = inst.jobs.map((job, j) => {
    const o = [null];
    inst.vehicles.forEach((veh, v) => {
      if (!S.vehicleCompatible(veh, job)) return;
      for (const n of S.candidateNodes(inst, j)) o.push({ v, n });
    });
    return o;
  });
  let best = { total: Infinity, solution: null, evaluated: 0 };
  const assign = new Array(nJ);
  const evalAssignment = () => {
    const per = [];
    for (let v = 0; v < nV; v++) per.push(new Map());
    assign.forEach((o, j) => {
      if (!o) return;
      const m = per[o.v];
      if (!m.has(o.n)) m.set(o.n, []);
      m.get(o.n).push(j);
    });
    const perms = per.map((m) => permutations([...m.keys()]));
    const pick = new Array(nV).fill(0);
    for (;;) {
      const sol = {
        routes: per.map((m, v) => ({
          vehicle: v,
          visits: perms[v][pick[v]].map((n) => ({ node: n, jobs: m.get(n).map((j) => ({ job: j, qty: inst.jobs[j].qty })) }))
        }))
      };
      const e = S.evaluate(inst, sol, { costOnly: true });
      best.evaluated++;
      if (e.feasible && e.total < best.total) best = { total: e.total, solution: sol, evaluated: best.evaluated };
      let v = 0;
      while (v < nV && ++pick[v] >= perms[v].length) { pick[v] = 0; v++; }
      if (v === nV) break;
    }
  };
  const rec = (j) => {
    if (j === nJ) { evalAssignment(); return; }
    for (const o of options[j]) { assign[j] = o; rec(j + 1); }
  };
  rec(0);
  return best;
}

// A random (possibly infeasible) solution, for move and evaluate consistency tests.
export function randomSolution(SRO, inst, rng, { feasibleTypes = false } = {}) {
  const S = SRO.solver;
  const sol = S.emptySolution(inst);
  inst.jobs.forEach((job, j) => {
    if (rng() < 0.2) return;                                    // deferred
    const nodes = S.candidateNodes(inst, j);
    const vs = feasibleTypes ? S.compatibleVehicles(inst, j) : inst.vehicles.map((_, i) => i);
    if (!vs.length) return;
    const parts = rng() < 0.25 ? 2 : 1;
    let left = job.qty;
    for (let p = 0; p < parts; p++) {
      const q = p === parts - 1 ? left : Math.round(left * 0.5 * 100) / 100;
      left -= q;
      if (!(q > 0)) continue;
      const v = vs[rng.int(vs.length)];
      const n = nodes.length && rng() < 0.9 ? nodes[rng.int(nodes.length)] : rng.int(inst.nodes.length);
      const visits = sol.routes[v].visits;
      const same = visits.find((x) => x.node === n);
      if (same && rng() < 0.7) {
        const c = same.jobs.find((x) => x.job === j);
        if (c) c.qty += q; else same.jobs.push({ job: j, qty: q });
      } else visits.splice(rng.int(visits.length + 1), 0, { node: n, jobs: [{ job: j, qty: q }] });
    }
  });
  return sol;
}
