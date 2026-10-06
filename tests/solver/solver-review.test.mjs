// Independent review tests for the solver core (instance, evaluate, construct, moves, localSearch).
// Adversarial cases, hand-computed numbers and randomized property checks against a reference
// evaluator written directly from DESIGN.md section 7 "Evaluation semantics" and "Cost".
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSolver, plain, near, randomSolution } from './fixtures.mjs';

const SRO = loadSolver();
const S = SRO.solver;
const M = S.moves;
const close = (a, b, msg, tol = 1e-9) => assert.ok(near(a, b, tol), `${msg || ''} expected ${b}, got ${a}`);
const codes = (ev) => plain(ev.violations.map((v) => v.code));
const visit = (node, ...chunks) => ({ node, jobs: chunks.map(([job, qty]) => ({ job, qty })) });

// ---- reference evaluator (straight from the DESIGN text; linear period scan, no caching) ----------
// Updated 2026-10-06 for the rule changes in DESIGN.md section 7: FIFO travel integrated across periods
// with time-weighted leg risk (refTravel), lateness per chunk capped at lateCapShare x deferral cost,
// unused pinned rally points (pinUnused), and per-field penalty defaults. The integrator is independent
// of instance.js: it lists every minute at which the period can change and reads the period at the
// midpoint of each piece.
const REF_PENALTIES = { latePerMin: [2, 6, 60, 600], defer: [5000, 15000, 60000, 250000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6], lateCapShare: 0.9, pinUnused: 2000 };
function refPeriodIdx(periods, t) {
  if (!periods || !periods.length) return -1;
  const first = periods[0].startMin, last = periods[periods.length - 1].endMin;
  let tt = t;
  if (last - first >= 1440) { while (tt >= last) tt -= 1440; while (tt < first) tt += 1440; }
  let idx = 0;
  for (let i = 0; i < periods.length; i++) if (periods[i].startMin <= tt) idx = i;
  return idx;
}
// Leg leaving at t that needs `base` base minutes: { arrive, riskFactor }.
function refTravel(periods, t, base) {
  if (!periods || !periods.length) return { arrive: t + base, riskFactor: 1 };
  const first = periods[0].startMin, last = periods[periods.length - 1].endMin;
  const minSpeed = Math.min(...periods.map((p) => p.speed));
  const until = t + base / minSpeed + 1;
  const cuts = [];
  const shifts = [0];
  if (last - first >= 1440) for (let k = Math.floor((t - last) / 1440) - 1; k <= Math.ceil((until - first) / 1440) + 1; k++) shifts.push(k * 1440);
  for (const sh of shifts) { for (const p of periods) cuts.push(p.startMin + sh); cuts.push(last + sh); }
  const pts = [...new Set(cuts.filter((c) => c > t && c < until))].sort((a, b) => a - b);
  pts.push(Infinity);
  let cur = t, rem = base, riskMin = 0;
  for (const c of pts) {
    const mid = c === Infinity ? (cur + until) / 2 : (cur + c) / 2;   // no cut in (cur, until)
    const p = periods[refPeriodIdx(periods, mid)];
    const room = (c - cur) * p.speed;
    if (room >= rem) {
      const arrive = cur + rem / p.speed;
      riskMin += (arrive - cur) * p.risk;
      return { arrive, riskFactor: arrive > t ? riskMin / (arrive - t) : periods[refPeriodIdx(periods, t)].risk };
    }
    riskMin += (c - cur) * p.risk; rem -= room; cur = c;
  }
  throw new Error('unreachable');
}
function refEvaluate(inst, sol) {
  const w = inst.weights, pa = inst.params, nN = inst.nodes.length;
  const pen = Object.assign({}, REF_PENALTIES, ...Object.entries(inst.penalties || {}).filter(([, x]) => x != null).map(([k, x]) => ({ [k]: x })));
  let miles = 0, risk = 0, stops = 0, trucks = 0, late = 0, nViol = 0;
  const pairs = new Map(), delivered = inst.jobs.map(() => 0), rally = new Set(), usedVeh = new Set(), gotQty = new Set();
  for (const r of (sol && sol.routes) || []) {
    if (!r || !r.visits || !r.visits.length) continue;
    const v = r.vehicle, veh = inst.vehicles[v];
    if (!Number.isInteger(v) || !veh) { nViol++; continue; }
    if (usedVeh.has(v)) nViol++;
    usedVeh.add(v); trucks++;
    let t = Math.max(inst.startMin, veh.availableAt ?? inst.startMin) + (veh.preloaded ? 0 : pa.loadMin);
    let cur = veh.startNode ?? veh.hubNode, load = 0;
    const leg = (a, b) => {
      if (!(inst.minutes[a][b] < Infinity) || !(inst.miles[a][b] < Infinity)) { nViol++; return t; }
      const tr = refTravel(inst.periods, t, inst.minutes[a][b]);
      miles += inst.miles[a][b]; risk += inst.riskUnits[a][b] * tr.riskFactor;
      return tr.arrive;
    };
    for (const vi of r.visits) {
      if (!vi || !Number.isInteger(vi.node) || vi.node < 0 || vi.node >= nN) { nViol++; continue; }
      const arrive = leg(cur, vi.node);
      stops++;
      if (inst.nodes[vi.node].kind === 'rally') rally.add(vi.node);
      for (const ch of vi.jobs || []) {
        const job = ch && inst.jobs[ch.job];
        if (!job || !Number.isInteger(ch.job)) { nViol++; continue; }
        if (typeof ch.qty !== 'number' || !(ch.qty >= 0) || ch.qty === Infinity) { nViol++; continue; }
        if (S.GROUP_TYPE[job.group] !== veh.type) nViol++;
        if (job.lockedTruck != null && job.lockedTruck !== veh.id) nViol++;
        const banned = (pa.bannedRally || []).includes(vi.node);
        const cand = banned ? null : (job.candidates || []).find((c) => c.node === vi.node);
        if (!cand) nViol++;
        else if (ch.qty > 0) { const key = job.requestId + '|' + vi.node; if (!pairs.has(key)) pairs.set(key, cand.platoonCost || 0); }
        if (ch.qty > 0) gotQty.add(vi.node);
        load += ch.qty; delivered[ch.job] += ch.qty;
        if (ch.qty > 0 && job.deadline != null) {
          const cap = pen.lateCapShare * pen.defer[job.tier] * pen.classFactor[job.classRank];
          late += Math.min(Math.max(0, arrive - job.deadline) * pen.latePerMin[job.tier], cap) * ch.qty / job.qty;
        }
      }
      t = arrive + pa.serviceMin; cur = vi.node;
    }
    t = leg(cur, veh.hubNode);
    if (load > veh.capacity * (1 + 1e-9)) nViol++;
  }
  let deferral = 0;
  inst.jobs.forEach((job, j) => {
    const d = job.qty - delivered[j], eps = 1e-9 * Math.max(1, job.qty);
    if (d > eps) deferral += d / job.qty * pen.defer[job.tier] * pen.classFactor[job.classRank];
    else if (d < -eps) nViol++;
  });
  if (pa.maxRallyPoints != null && rally.size > pa.maxRallyPoints) nViol++;
  let platoon = 0;
  for (const c of pairs.values()) platoon += c;
  // pinned rally nodes some job could use (banned nodes are never candidates) that got no positive quantity
  let pinned = 0;
  for (const n of new Set(pa.pinnedRally || [])) {
    if ((pa.bannedRally || []).includes(n) || !inst.nodes[n] || inst.nodes[n].kind !== 'rally') continue;
    if (inst.jobs.some((job) => (job.candidates || []).some((c) => c.node === n)) && !gotQty.has(n)) pinned += pen.pinUnused;
  }
  const cost = { fuel: w.fuel * miles / pa.mpg, distance: w.distance * 0.5 * miles, risk: w.risk * risk,
    simplicity: w.simplicity * (5 * stops + 25 * trucks), platoon: w.distance * platoon, lateness: late, deferral, pinned };
  return { total: Object.values(cost).reduce((a, b) => a + b, 0) + 1e7 * nViol, nViol, cost };
}

// ---- hand instance --------------------------------------------------------------------------------
function sym(n, pairs) {
  const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : null)));
  for (const [a, b, x] of pairs) { m[a][b] = x; m[b][a] = x; }
  return m;
}
// Nodes 0 hub, 1 rally A, 2 rally B, 3 direct D.
//   minutes 0-1 30, 0-2 60, 0-3 45, 1-2 40, 1-3 20, 2-3 50
//   miles   0-1 20, 0-2 40, 0-3 30, 1-2 25, 1-3 10, 2-3 35
//   risk    0-1 1,  0-2 0,  0-3 2,  1-2 3,  1-3 0,  2-3 0
// V0 cargo 10, V1 cargo 10, V2 tanker 2500; all at hub 0, available 0. startMin 600, load 20, service 15, mpg 2.
// J0 R-1 cargo 12 pallets, Urgent (2), class rank 1, due 680, cand A (6), D (3)
// J1 R-1 fuel 1000 gal, Routine (0), class rank 0, due 900, cand A (6)
// J2 R-2 cargo 4 pallets, Priority (1), class rank 3, due 700, cand A (2), B (9)
function h2(edit) {
  const inst = {
    startMin: 600,
    nodes: [
      { key: 'hub:H', kind: 'hub', label: 'Hub' }, { key: 'rally:A', kind: 'rally', label: 'A' },
      { key: 'rally:B', kind: 'rally', label: 'B' }, { key: 'direct:D', kind: 'direct', label: 'D' }
    ],
    minutes: sym(4, [[0, 1, 30], [0, 2, 60], [0, 3, 45], [1, 2, 40], [1, 3, 20], [2, 3, 50]]),
    miles: sym(4, [[0, 1, 20], [0, 2, 40], [0, 3, 30], [1, 2, 25], [1, 3, 10], [2, 3, 35]]),
    riskUnits: sym(4, [[0, 1, 1], [0, 2, 0], [0, 3, 2], [1, 2, 3], [1, 3, 0], [2, 3, 0]]),
    gridPaths: {},
    periods: [{ startMin: 0, endMin: 100000, speed: 1, risk: 1, name: 'Flat' }],
    vehicles: [
      { id: 'V0', type: 'cargo', capacity: 10, hubNode: 0, availableAt: 0 },
      { id: 'V1', type: 'cargo', capacity: 10, hubNode: 0, availableAt: 0 },
      { id: 'V2', type: 'tanker', capacity: 2500, hubNode: 0, availableAt: 0 }
    ],
    jobs: [
      { id: 'J0', requestId: 'R-1', group: 'cargo', qty: 12, unit: 'pallet', tier: 2, classRank: 1, deadline: 680, hardDeadline: false,
        candidates: [{ node: 1, platoonMiles: 12, platoonCost: 6 }, { node: 3, platoonMiles: 6, platoonCost: 3 }], lockedTruck: null },
      { id: 'J1', requestId: 'R-1', group: 'fuel', qty: 1000, unit: 'gal', tier: 0, classRank: 0, deadline: 900, hardDeadline: false,
        candidates: [{ node: 1, platoonMiles: 12, platoonCost: 6 }], lockedTruck: null },
      { id: 'J2', requestId: 'R-2', group: 'cargo', qty: 4, unit: 'pallet', tier: 1, classRank: 3, deadline: 700, hardDeadline: false,
        candidates: [{ node: 1, platoonMiles: 4, platoonCost: 2 }, { node: 2, platoonMiles: 18, platoonCost: 9 }], lockedTruck: null }
    ],
    weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },
    params: { mpg: 2, serviceMin: 15, loadMin: 20, maxRallyPoints: 8, pinnedRally: [], bannedRally: [] },
    penalties: { latePerMin: [1, 3, 50, 500], defer: [200, 600, 5000, 50000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6] },
    fixed: null
  };
  if (edit) edit(inst);
  return inst;
}

test('review: hand instance h2 is valid', () => {
  assert.deepEqual(plain(S.validateInstance(h2())), []);
});

test('review: split deliveries across trucks, platoon dedupe across trucks and load groups, zero-qty chunk', () => {
  const inst = h2();
  const sol = { routes: [
    { vehicle: 0, visits: [visit(1, [0, 8]), visit(2, [2, 2])] },
    { vehicle: 1, visits: [visit(1, [0, 4], [2, 2]), visit(3, [0, 0])] },
    { vehicle: 2, visits: [visit(1, [1, 1000])] }
  ] };
  const ev = S.evaluate(inst, sol);
  assert.deepEqual(codes(ev), []);
  // t0 = max(600, 0) + 20 = 620 for every truck.
  // V0: 0->A 30 -> 650 (J0 8 of 12, due 680: on time); dep 665; A->B 40 -> 705 (J2 2 of 4, due 700:
  //     5 min x 3/min x 2/4 = 7.5); dep 720; B->0 60 -> 780. miles 20+25+40 = 85; risk 1+3+0 = 4.
  // V1: 0->A 30 -> 650 (J0 4, J2 2 on time); dep 665; A->D 20 -> 685 (zero chunk of J0: no lateness);
  //     dep 700; D->0 45 -> 745. miles 20+10+30 = 60; risk 1+0+2 = 3.
  // V2: 0->A 30 -> 650 (J1 on time); dep 665; A->0 30 -> 695. miles 40; risk 2.
  close(ev.routes[0].stops[1].arrive, 705); close(ev.routes[0].returnAt, 780);
  close(ev.routes[1].stops[1].arrive, 685); close(ev.routes[1].returnAt, 745);
  close(ev.routes[2].returnAt, 695);
  // miles 185 -> gallons 92.5 -> fuel 277.5; distance 3 x 0.5 x 185 = 277.5; risk 5 x 9 = 45;
  // simplicity 2 x (5 x 5 stops + 25 x 3 trucks) = 200;
  // platoon pairs: (R-1, A) 6 once (J0 on V0, J0 on V1 and J1 on V2 all share it); (R-2, B) 9; (R-2, A) 2;
  //   (R-1, D) only gets a zero chunk, so the platoon never comes: not charged. 17 x 3 = 51.
  // lateness 7.5; every job fully delivered: deferral 0. total 858.5
  close(ev.cost.fuel, 277.5); close(ev.cost.distance, 277.5); close(ev.cost.risk, 45);
  close(ev.cost.simplicity, 200); close(ev.cost.platoon, 51); close(ev.cost.lateness, 7.5); close(ev.cost.deferral, 0);
  close(ev.total, 858.5);
  assert.deepEqual(plain(ev.delivered), [12, 1000, 4]);
  assert.deepEqual(plain(ev.deferred), []);
  assert.deepEqual(plain(ev.late), [{ job: 2, minutesLate: 5 }]);
  assert.deepEqual(plain(ev.rallyNodes), [1, 2]);
  // per-route platoon: V0 charges (R-1, A) 6 + (R-2, B) 9; V1 (R-2, A) 2; V2 nothing new
  close(ev.routes[0].cost.platoon, 45); close(ev.routes[1].cost.platoon, 6); close(ev.routes[2].cost.platoon, 0);
  // with a real (positive) chunk at D the (R-1, D) pair is charged: +3 x 3 = 9, and J0 is over-delivered
  const sol2 = plain(sol); sol2.routes[1].visits[1].jobs[0].qty = 1;
  const ev2 = S.evaluate(inst, sol2);
  close(ev2.cost.platoon, 60);
  assert.deepEqual(codes(ev2), ['over-qty']);
  // two different requests at one node are charged separately; one request's two groups only once
  close(refEvaluate(inst, sol).total, ev.total);
});

test('review: partial split with the rest deferred: deferral share and per-chunk lateness share', () => {
  const inst = h2((i) => { i.jobs[0].deadline = 640; });
  // J0 (12, Urgent, rank 1, due 640): 5 on V0 at A (650: 10 late), 3 on V1 at D (0->D 45 -> 665: 25 late); 4 deferred.
  const sol = { routes: [{ vehicle: 0, visits: [visit(1, [0, 5])] }, { vehicle: 1, visits: [visit(3, [0, 3])] }] };
  const ev = S.evaluate(inst, sol);
  assert.deepEqual(codes(ev), []);
  // lateness 10 x 50 x 5/12 + 25 x 50 x 3/12 = 208.333 + 312.5 = 520.833
  close(ev.cost.lateness, 10 * 50 * 5 / 12 + 25 * 50 * 3 / 12);
  // deferral: J0 4/12 x 5000 x 0.9 = 1500; J1 1 x 200 x 1.0 = 200; J2 1 x 600 x 0.8 = 480 -> 2180
  close(ev.cost.deferral, 1500 + 200 + 480);
  assert.deepEqual(plain(ev.deferred), [{ job: 0, qty: 4 }, { job: 1, qty: 1000 }, { job: 2, qty: 4 }]);
  assert.deepEqual(plain(ev.late), [{ job: 0, minutesLate: 25 }]);
  close(refEvaluate(inst, sol).total, ev.total);
});

// Updated 2026-10-06: legs are integrated across periods (FIFO). The first two cases below give the same
// numbers as under the old departure-period rule; the third used to arrive at 680 - 1e-6 with risk 1.
test('review: period boundary is half-open and a leg is integrated across it (FIFO, incl. return leg)', () => {
  const periods = [{ startMin: 0, endMin: 650, speed: 1, risk: 1 }, { startMin: 650, endMin: 2000, speed: 0.5, risk: 2 }];
  const sol = { routes: [{ vehicle: 2, visits: [visit(1, [1, 1000])] }] };
  // t0 = 620 (period 0): 0->A 30 base min fill period 0 exactly -> arrive 650 (stop is in period 1);
  // dep 665 (period 1): A->0 30 / 0.5 = 60 -> 725. risk 1 x 1 + 1 x 2 = 3.
  let ev = S.evaluate(h2((i) => { i.periods = periods; }), sol);
  let r = ev.routes[0];
  assert.equal(r.legs[0].periodIdx, 0); close(r.stops[0].arrive, 650); assert.equal(r.stops[0].periodIdx, 1);
  assert.equal(r.legs[1].periodIdx, 1); close(r.returnAt, 725); close(r.riskUnits, 3);
  // departing exactly at the boundary (startMin 630 -> t0 650) is the new period: 30 / 0.5 = 60 -> 710
  ev = S.evaluate(h2((i) => { i.periods = periods; i.startMin = 630; }), sol);
  r = ev.routes[0];
  assert.equal(r.legs[0].periodIdx, 1); close(r.stops[0].arrive, 710); close(r.riskUnits, 4);
  // a hair before the boundary: 1e-6 base min at speed 1, the other 30 - 1e-6 at 0.5 -> 710 - 2e-6;
  // the leg risk is the time-weighted mean, a hair under 2
  ev = S.evaluate(h2((i) => { i.periods = periods; i.startMin = 630 - 1e-6; }), sol);
  r = ev.routes[0];
  assert.equal(r.legs[0].periodIdx, 0, 'periodIdx is the departure period');
  close(r.stops[0].arrive, 710 - 2e-6, '', 1e-12);
  close(r.legs[0].riskFactor, (1e-6 * 1 + (60 - 2e-6) * 2) / (60 - 1e-6), '', 1e-12);
  assert.ok(r.legs[0].riskFactor < 2);
  // later departure never arrives earlier across the boundary
  let prev = -Infinity;
  for (let d = -3; d <= 3; d += 0.25) {
    const a = S.evaluate(h2((i) => { i.periods = periods; i.startMin = 630 + d; }), sol).routes[0].stops[0].arrive;
    assert.ok(a >= prev, 'FIFO at ' + d); prev = a;
  }
});

test('review: Infinity legs (minutes or miles), return-leg only, and repeated visits at one node', () => {
  // miles Infinity alone also makes the leg unreachable
  let inst = h2((i) => { i.miles[0][2] = Infinity; });
  let ev = S.evaluate(inst, { routes: [{ vehicle: 0, visits: [visit(2, [2, 4])] }] });
  assert.deepEqual(codes(ev), ['unreachable']);
  assert.ok(Number.isFinite(ev.total));
  // only the return A->hub is closed: one violation; out leg miles (20) still count, the closed one counts 0
  inst = h2((i) => { i.minutes[1][0] = Infinity; });
  ev = S.evaluate(inst, { routes: [{ vehicle: 2, visits: [visit(1, [1, 1000])] }] });
  assert.deepEqual(codes(ev), ['unreachable']);
  close(ev.routes[0].miles, 20);
  assert.equal(ev.routes[0].legs[1].unreachable, true);
  close(ev.total, refEvaluate(inst, { routes: [{ vehicle: 2, visits: [visit(1, [1, 1000])] }] }).total);
  // the costOnly path agrees
  assert.equal(S.evaluate(inst, { routes: [{ vehicle: 2, visits: [visit(1, [1, 1000])] }] }, { costOnly: true }).nViolations, 1);
  // two consecutive visits at A: a 0-minute leg, but each visit is a stop with its own service time
  inst = h2();
  ev = S.evaluate(inst, { routes: [{ vehicle: 0, visits: [visit(1, [0, 4]), visit(1, [2, 4])] }] });
  assert.deepEqual(codes(ev), []);
  close(ev.routes[0].stops[1].arrive, 665); close(ev.routes[0].returnAt, 710);
  assert.equal(ev.stats.stops, 2);
});

test('review: locked jobs: right truck ok, wrong truck flagged, deferral is not a violation, ghost and wrong-type locks', () => {
  const lockJ2 = (to) => h2((i) => { i.jobs[2].lockedTruck = to; });
  assert.deepEqual(codes(S.evaluate(lockJ2('V1'), { routes: [{ vehicle: 1, visits: [visit(2, [2, 4])] }] })), []);
  assert.deepEqual(codes(S.evaluate(lockJ2('V1'), { routes: [{ vehicle: 0, visits: [visit(2, [2, 4])] }] })), ['locked-truck']);
  assert.deepEqual(codes(S.evaluate(lockJ2('V1'), { routes: [] })), []);
  // locked to a truck that is not in the plan: any delivery is a violation; construct defers it
  const ghost = lockJ2('V9');
  assert.deepEqual(codes(S.evaluate(ghost, { routes: [{ vehicle: 1, visits: [visit(2, [2, 4])] }] })), ['locked-truck']);
  const ev = S.evaluate(ghost, S.construct(ghost));
  assert.equal(ev.feasible, true); assert.equal(ev.delivered[2], 0);
  const ex = S.explainDeferred(ghost, ev).find((x) => x.job === 2);
  assert.equal(ex.reason, 'no-truck'); assert.equal(ex.detail, 'locked-truck-unavailable');
  // locked to a truck of the wrong type: validate reports it; explanation names the real cause
  const wrong = lockJ2('V2');
  assert.ok(S.validateInstance(wrong).some((p) => /cannot carry this load/.test(p)));
  const ev2 = S.evaluate(wrong, S.construct(wrong));
  assert.equal(ev2.feasible, true);
  const ex2 = S.explainDeferred(wrong, ev2).find((x) => x.job === 2);
  assert.equal(ex2.reason, 'no-truck'); assert.equal(ex2.detail, 'locked-truck-wrong-type');
  assert.match(ex2.note, /cannot carry/);
});

test('review: construct and localSearch keep locked jobs on their truck, incl. preloaded en-route trucks', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const inst = S.makeTestInstance(seed, { nJobs: 14, nVehicles: 5, locked: 4, closedZones: seed % 2 });
    inst.vehicles.forEach((v, k) => { if (k % 2) Object.assign(v, { preloaded: true, startNode: inst.nodes.length - 1 - k, availableAt: inst.startMin + 15 * k }); });
    S.prepare.invalidate(inst);
    assert.deepEqual(plain(S.validateInstance(inst)), [], 'seed ' + seed);
    const sol = S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(seed), maxIters: 4000 });
    const ev = S.evaluate(inst, sol);
    assert.deepEqual(codes(ev), [], 'seed ' + seed);
    for (const r of sol.routes) for (const v of r.visits) for (const c of v.jobs) {
      const lk = inst.jobs[c.job].lockedTruck;
      if (lk != null) assert.equal(inst.vehicles[r.vehicle].id, lk);
    }
    close(refEvaluate(inst, sol).total, ev.total, 'seed ' + seed, 1e-9);
  }
});

test('review: maxRallyPoints counts distinct rally nodes over all trucks; hubs, direct nodes and unused pins do not count', () => {
  const sameA = { routes: [
    { vehicle: 0, visits: [visit(1, [0, 6])] }, { vehicle: 1, visits: [visit(1, [0, 6])] }, { vehicle: 2, visits: [visit(1, [1, 1000])] }
  ] };
  assert.deepEqual(codes(S.evaluate(h2((i) => { i.params.maxRallyPoints = 1; }), sameA)), [], 'one rally node shared by 3 trucks');
  assert.deepEqual(codes(S.evaluate(h2((i) => { i.params.maxRallyPoints = 0; }), sameA)), ['too-many-rally']);
  // a direct node never counts
  assert.deepEqual(codes(S.evaluate(h2((i) => { i.params.maxRallyPoints = 0; }), { routes: [{ vehicle: 0, visits: [visit(3, [0, 8])] }] })), []);
  // two rally nodes over a limit of 1: exactly one violation, not one per extra node
  const ab = { routes: [{ vehicle: 0, visits: [visit(1, [2, 2]), visit(2, [2, 2])] }] };
  assert.deepEqual(codes(S.evaluate(h2((i) => { i.params.maxRallyPoints = 1; }), ab)), ['too-many-rally']);
  // a pinned rally point counts only when used
  const onlyA = { routes: [{ vehicle: 0, visits: [visit(1, [2, 4])] }] };
  assert.deepEqual(codes(S.evaluate(h2((i) => { i.params.maxRallyPoints = 1; i.params.pinnedRally = [2]; }), onlyA)), []);
  assert.deepEqual(codes(S.evaluate(h2((i) => { i.params.maxRallyPoints = 1; i.params.pinnedRally = [2]; }), ab)), ['too-many-rally']);
  // missing maxRallyPoints means no limit
  assert.deepEqual(codes(S.evaluate(h2((i) => { delete i.params.maxRallyPoints; }), ab)), []);
});

test('review: hardLate lists every late Immediate job and any late job flagged hardDeadline (Urgent), nothing else', () => {
  const inst = h2((i) => {
    i.jobs[0].tier = 3; i.jobs[0].hardDeadline = false; i.jobs[0].deadline = 640;   // Immediate without the flag
    i.jobs[2].tier = 1; i.jobs[2].deadline = 640;                                  // late Priority: soft
    i.jobs[1].tier = 2; i.jobs[1].hardDeadline = true; i.jobs[1].deadline = 640;    // late Urgent with the flag
  });
  const sol = { routes: [{ vehicle: 0, visits: [visit(1, [0, 6], [2, 4])] }, { vehicle: 2, visits: [visit(1, [1, 1000])] }] };
  const ev = S.evaluate(inst, sol);
  assert.deepEqual(codes(ev), [], 'late is never a violation');
  assert.deepEqual(plain(ev.late.map((x) => x.job)), [0, 1, 2]);
  assert.deepEqual(plain(ev.hardLate), [0, 1]);
});

test('review: malformed quantities are bad-qty and never poison the load sum', () => {
  const inst = h2();
  for (const bad of ['3', NaN, Infinity, -1, null, undefined]) {
    const sol = { routes: [{ vehicle: 0, visits: [visit(1, [2, bad], [0, 9])] }] };
    const ev = S.evaluate(inst, sol);
    assert.deepEqual(codes(ev), ['bad-qty'], 'qty ' + String(bad));
    assert.equal(ev.routes[0].load, 9, 'load stays numeric for qty ' + String(bad));
    assert.equal(S.evaluate(inst, sol, { costOnly: true }).total, ev.total);
  }
});

test('review: an invalid negative-quantity job is reported and does not make the empty plan infeasible', () => {
  const inst = h2((i) => { i.jobs[2].qty = -4; });
  assert.ok(S.validateInstance(inst).some((p) => /J2 quantity must be greater than 0/.test(p)));
  assert.equal(S.evaluate(inst, S.emptySolution(inst)).feasible, true);
  assert.equal(S.evaluate(inst, S.construct(inst)).feasible, true);
});

test('review: validateInstance rejects a non-finite availableAt', () => {
  const inst = h2((i) => { i.vehicles[0].availableAt = Infinity; });
  assert.ok(S.validateInstance(inst).some((p) => /V0 availableAt/.test(p)));
});

test('review: the prepare cache sees replaced penalty arrays and pinned/banned lists', () => {
  const inst = h2();
  const sol = { routes: [{ vehicle: 0, visits: [visit(2, [2, 4])] }] };
  const a = S.evaluate(inst, sol);
  inst.penalties.defer = [400, 1200, 10000, 100000];          // deferral doubles: J0 + J1 deferred
  const b = S.evaluate(inst, sol);
  close(b.cost.deferral, 2 * a.cost.deferral);
  inst.penalties.latePerMin = [0, 0, 0, 0];
  inst.penalties.classFactor = [1, 1, 1, 1, 1];
  assert.equal(S.evaluate(inst, sol).cost.lateness, 0);
  inst.params.bannedRally = [2];
  assert.equal(S.isCandidate(inst, 2, 2), false);
  assert.deepEqual(codes(S.evaluate(inst, sol)), ['not-candidate']);
  inst.params.bannedRally = [];
  assert.deepEqual(codes(S.evaluate(inst, sol)), []);
});

test('review: explainDeferred refuses a costOnly result instead of silently returning nothing', () => {
  const inst = h2();
  assert.throws(() => S.explainDeferred(inst, S.evaluate(inst, { routes: [] }, { costOnly: true })), /full evaluate/);
  assert.equal(S.explainDeferred(inst, null).length, 3);
});

// ---- randomized: evaluate vs the reference ---------------------------------------------------------
test('review: evaluate equals the reference evaluator on 3000 messy random solutions', () => {
  const rng = SRO.util.rng(5);
  let compared = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const inst = S.makeTestInstance(seed, {
      nJobs: 1 + seed % 20, nVehicles: 1 + seed % 6, closedZones: seed % 3, maxRallyPoints: seed % 5, locked: seed % 3,
      banned: seed % 2, pinned: seed % 2, startMin: 300 + (seed * 97) % 3000, lateAvailableShare: 0.5
    });
    if (seed % 3 === 0) inst.vehicles.forEach((v, i) => { if (i % 2) { v.preloaded = true; v.startNode = inst.nodes.length - 1; } });
    if (seed % 7 === 0) inst.periods = [];
    S.prepare.invalidate(inst);
    for (let k = 0; k < 10; k++) {
      const sol = randomSolution(SRO, inst, rng);
      if (rng() < 0.3) sol.routes.push({ vehicle: sol.routes[0].vehicle, visits: sol.routes[0].visits.slice(0, 1) });   // truck reused
      if (rng() < 0.2) sol.routes[0].visits.push({ node: 0, jobs: [] });                                                  // empty visit
      if (rng() < 0.2 && sol.routes[0].visits.length) sol.routes[0].visits[0].jobs.push({ job: 0, qty: 0 });               // zero chunk
      if (rng() < 0.1) sol.routes.push({ vehicle: 99, visits: [visit(0, [0, 1])] });                                       // bad index
      const ev = S.evaluate(inst, sol), ref = refEvaluate(inst, sol);
      close(ev.total, ref.total, `seed ${seed}/${k}`, 1e-9);
      assert.equal(ev.violations.length, ref.nViol, `seed ${seed}/${k}`);
      for (const key of Object.keys(ref.cost)) close(ev.cost[key], ref.cost[key], `${key} seed ${seed}/${k}`, 1e-9);
      const fast = S.evaluate(inst, sol, { costOnly: true });
      assert.equal(fast.total, ev.total); assert.equal(fast.nViolations, ev.violations.length);
      compared++;
    }
  }
  assert.equal(compared, 3000);
});

test('review: periodIndex equals a linear scan on irregular tables (gaps, short spans, boundaries, wrap)', () => {
  const rng = SRO.util.rng(11);
  for (let k = 0; k < 300; k++) {
    const n = 1 + rng.int(8); let t = rng.int(2000) - 500; const ps = [];
    for (let i = 0; i < n; i++) {
      const gap = rng() < 0.3 ? rng.int(100) : 0, len = 1 + rng.int(rng() < 0.5 ? 200 : 900);
      ps.push({ startMin: t + gap, endMin: t + gap + len, speed: 0.5 + rng(), risk: rng() * 2 });
      t += gap + len;
    }
    const P = S.prepare({ periods: ps, nodes: [], vehicles: [], jobs: [] });
    for (let q = 0; q < 150; q++) {
      const tt = ps[0].startMin - 3000 + rng() * (ps[n - 1].endMin - ps[0].startMin + 6000);
      assert.equal(S.periodIndex(P, tt), refPeriodIdx(ps, tt));
    }
    for (const p of ps) { assert.equal(S.periodIndex(P, p.startMin), refPeriodIdx(ps, p.startMin)); assert.equal(S.periodIndex(P, p.endMin), refPeriodIdx(ps, p.endMin)); }
  }
});

test('review: expandPeriods matches the time-of-day table for random edited tables and start times', () => {
  const rng = SRO.util.rng(12);
  const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + String(m % 60).padStart(2, '0');
  const mins = (s) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2), 10);
  for (let k = 0; k < 300; k++) {
    const nRows = 1 + rng.int(5);
    const cuts = new Set();
    while (cuts.size < nRows) cuts.add(rng.int(48) * 30);
    const cs = [...cuts].sort((a, b) => a - b);
    const table = cs.map((c, i) => ({ name: 'P' + i, start: hhmm(c), end: hhmm(cs[(i + 1) % cs.length]), speed: 0.5 + i * 0.1, risk: 1 + i }));
    rng.shuffle(table);
    const from = rng.int(5 * 1440);
    const ps = S.expandPeriods(table, from, 72);
    for (let i = 1; i < ps.length; i++) assert.equal(ps[i].startMin, ps[i - 1].endMin, 'contiguous');
    assert.ok(ps[0].startMin <= from && ps[ps.length - 1].endMin >= from + 72 * 60, 'covers the window');
    for (let q = 0; q < 60; q++) {
      const t = ps[0].startMin + rng.int(ps[ps.length - 1].endMin - ps[0].startMin);
      const p = ps.find((x) => x.startMin <= t && t < x.endMin);
      const tod = ((t % 1440) + 1440) % 1440;
      const row = table.find((r) => { const a = mins(r.start), b = mins(r.end); return b > a ? tod >= a && tod < b : (tod >= a || tod < b); });
      assert.equal(p.name, row.name, `table ${JSON.stringify(table)} t ${t}`);
    }
  }
});

// ---- construct / localSearch on adversarial instances -------------------------------------------------
const VARIANTS = {
  noVehicles: (i) => { i.vehicles = []; },
  noJobs: (i) => { i.jobs = []; },
  zeroCapacity: (i) => { i.vehicles.forEach((v) => { v.capacity = 0; }); },
  rallyLimit0: (i) => { i.params.maxRallyPoints = 0; },
  morePinsThanLimit: (i) => { i.params.pinnedRally = i.nodes.map((n, k) => (n.kind === 'rally' ? k : -1)).filter((k) => k >= 0).slice(0, 3); i.params.maxRallyPoints = 1; },
  everythingClosed: (i) => { const n = i.nodes.length; for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (a !== b) { i.minutes[a][b] = Infinity; i.miles[a][b] = Infinity; } },
  noWayBackToHub0: (i) => { for (let a = 1; a < i.nodes.length; a++) i.minutes[a][0] = Infinity; },
  enRoute: (i) => { i.vehicles.forEach((v, k) => { if (k % 2 === 0) Object.assign(v, { preloaded: true, startNode: i.nodes.length - 1, availableAt: i.startMin + 30 }); }); },
  enRouteCutOff: (i) => { const s = i.nodes.length - 1; i.vehicles.forEach((v) => Object.assign(v, { preloaded: true, startNode: s })); for (let b = 0; b < s; b++) i.minutes[s][b] = Infinity; },
  lockedToGhost: (i) => { i.jobs.forEach((j) => { j.lockedTruck = 'GHOST'; }); },
  allLocked: (i) => { i.jobs.forEach((j) => { const v = i.vehicles.find((x) => S.typeCompatible(x, j)); j.lockedTruck = v ? v.id : null; }); },
  floatQuantities: (i) => { i.vehicles.forEach((v) => { v.capacity = 0.3; }); i.jobs.forEach((j, k) => { j.qty = [0.1, 0.2, 0.3, 0.7][k % 4]; }); },
  hugeJobs: (i) => { i.jobs.forEach((j) => { j.qty *= 13; }); },
  deadlinesPassed: (i) => { i.jobs.forEach((j) => { j.deadline = i.startMin - 500; j.tier = 3; j.hardDeadline = true; }); },
  freeDeferral: (i) => { i.penalties.defer = [0, 0, 0, 0]; },
  zeroWeights: (i) => { i.weights = { fuel: 0, distance: 0, risk: 0, simplicity: 0 }; },
  noPeriods: (i) => { i.periods = []; },
  duplicateCandidates: (i) => { i.jobs.forEach((j) => { j.candidates = j.candidates.concat(j.candidates.map((c) => Object.assign({}, c, { platoonCost: 999 }))); }); },
  hubAsCandidate: (i) => { i.jobs.forEach((j) => { j.candidates.push({ node: 0, platoonMiles: 30, platoonCost: 15 }); }); },
  oneRequest: (i) => { i.jobs.forEach((j) => { j.requestId = 'R-X'; }); },
  noRequestIds: (i) => { i.jobs.forEach((j) => { delete j.requestId; }); },
  negativeQty: (i) => { if (i.jobs.length) i.jobs[0].qty = -5; }
};

test('review: construct is violation-free, normalized and never worse than the empty plan on adversarial instances; localSearch never worse', () => {
  let runs = 0;
  for (const [name, edit] of Object.entries(VARIANTS)) {
    for (let seed = 1; seed <= 12; seed++) {
      const inst = S.makeTestInstance(seed, { nJobs: 2 + seed % 15, nVehicles: 1 + seed % 5, nRally: seed % 6, closedZones: seed % 2, pinned: seed % 2, banned: seed % 2, locked: seed % 2, maxRallyPoints: seed % 4 });
      edit(inst);
      S.prepare.invalidate(inst);
      const label = `${name} seed ${seed}`;
      const e0 = S.evaluate(inst, S.emptySolution(inst));
      assert.equal(e0.feasible, true, label + ': empty plan');
      const sol = S.construct(inst, seed % 2 ? { rng: SRO.util.rng(seed) } : {});
      const ev = S.evaluate(inst, sol);
      assert.deepEqual(codes(ev), [], label);
      assert.ok(ev.total <= e0.total + 1e-9, label + ': not worse than deferring everything');
      assert.ok(S.isNormalized(inst, sol), label);
      const ls = S.localSearch(inst, sol, { rng: SRO.util.rng(seed), maxIters: 3000 });
      const e2 = S.evaluate(inst, ls);
      assert.deepEqual(codes(e2), [], label + ' (localSearch)');
      assert.ok(e2.total <= ev.total + 1e-9 * Math.max(1, ev.total), label + ' (localSearch never worse)');
      const ex = S.explainDeferred(inst, e2);
      assert.equal(ex.length, e2.deferred.length);
      for (const x of ex) assert.ok(['radius', 'no-truck', 'closed-road', 'time', 'capacity'].includes(x.reason), label);
      runs++;
    }
  }
  assert.equal(runs, Object.keys(VARIANTS).length * 12);
});

test('review: a job three trucks large is split into capacity-sized chunks; with two trucks a third is deferred', () => {
  const inst = S.makeTestInstance(21, { nJobs: 1, nVehicles: 3, tankers: 3, nRally: 0, fuelShare: 1, twoJobShare: 0, lateAvailableShare: 0, deadlineMin: 1500, deadlineMax: 2000 });
  Object.assign(inst.jobs[0], { qty: 7500, tier: 3, hardDeadline: true });
  S.prepare.invalidate(inst);
  let ev = S.evaluate(inst, S.construct(inst));
  assert.deepEqual(codes(ev), []);
  assert.equal(ev.delivered[0], 7500);
  assert.equal(ev.routes.length, 3);
  for (const r of ev.routes) assert.ok(r.load <= 2500 + 1e-9);
  inst.vehicles.pop();
  ev = S.evaluate(inst, S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(1) }));
  assert.deepEqual(codes(ev), []);
  assert.equal(ev.delivered[0], 5000);
  assert.deepEqual(plain(ev.deferred), [{ job: 0, qty: 2500 }]);
  // deferral = 2500/7500 x defer[Immediate] x classFactor[rank] (defer[3] is 250000 since the 2026-10-06
  // defaults; it was 50000)
  assert.equal(inst.penalties.defer[3], 250000);
  close(ev.cost.deferral, inst.penalties.defer[3] / 3 * inst.penalties.classFactor[inst.jobs[0].classRank]);
});

// ---- moves -------------------------------------------------------------------------------------------
function perJob(inst, sol) {
  const d = inst.jobs.map(() => 0);
  for (const r of sol.routes) for (const v of r.visits) for (const c of v.jobs) d[c.job] += c.qty;
  return d;
}

test('review: every enumerated and random move keeps per-job quantities exact, builds, describes, and undoes', () => {
  const PRESERVE = new Set(['relocate', 'split', 'swap', 'twoOpt', 'orOpt', 'changeNode', 'merge', 'cross', 'exchange']);
  let checked = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const r = SRO.util.rng(seed * 13);
    const inst = S.makeTestInstance(seed, { nJobs: 5 + r.int(18), nVehicles: 2 + r.int(5), nRally: 2 + r.int(6), maxRallyPoints: 1 + r.int(5), locked: r.int(3), closedZones: r.int(2) });
    const rng = SRO.util.rng(seed);
    let sol = S.construct(inst, { rng });
    for (let k = 0; k < 30; k++) { const m = M.random(inst, sol, rng); const n = m && M.result(inst, sol, m); if (n) sol = n; }
    const before = JSON.stringify(sol), d0 = perJob(inst, sol), ctx = M.context(inst, sol);
    const check = (m) => {
      const res = M.result(inst, sol, m);
      assert.ok(res, m.type + ' builds');
      const d1 = perJob(inst, res);
      const src = m.r1 != null && m.v1 != null && m.c1 != null ? sol.routes[m.r1].visits[m.v1].jobs[m.c1] : null;
      d1.forEach((x, j) => {
        let want = d0[j];
        if (m.type === 'insert' && j === m.j) want += m.q;
        if (m.type === 'defer' && j === src.job) want -= m.q;
        if (m.type === 'replace') { if (j === m.j) want += m.q; if (j === src.job) want -= src.qty; }
        assert.ok(Math.abs(x - want) < 1e-9, `${m.type} job ${j}: ${x} vs ${want}`);
      });
      if (!PRESERVE.has(m.type)) assert.ok(['insert', 'defer', 'replace'].includes(m.type));
      for (const rr of res.routes) for (const v of rr.visits) {
        assert.ok(v.jobs.length > 0, m.type + ' leaves no empty visit');
        assert.equal(new Set(v.jobs.map((c) => c.job)).size, v.jobs.length, m.type + ' one chunk per job per visit');
        for (const c of v.jobs) assert.ok(c.qty > 0);
      }
      const mm = Object.assign({}, m);
      M.describe(inst, sol, mm, ctx);
      assert.ok(mm.adds.length > 0 && typeof mm.sig === 'string' && typeof mm.key === 'string');
      const s2 = JSON.parse(before), ref = s2.routes, tok = M.apply(inst, s2, m);
      assert.ok(tok);
      M.undo(s2, tok);
      assert.equal(s2.routes, ref);
      assert.equal(JSON.stringify(s2), before);
      checked++;
    };
    M.forEach(inst, sol, (m) => { check(m); return false; }, { types: M.TYPES, ctx });
    for (let k = 0; k < 300; k++) { const m = M.random(inst, sol, rng, { ctx }); if (m) check(m); }
    assert.equal(JSON.stringify(sol), before, 'input never mutated');
  }
  assert.ok(checked > 1000, 'checked ' + checked);
});

test('review: tabu attributes: undoing a relocate or a 2-opt is caught by the first move\'s drops', () => {
  let relocs = 0, twoOpts = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const inst = S.makeTestInstance(seed, { nJobs: 12, nVehicles: 4, nRally: 5 });
    const sol = S.construct(inst);
    const ctx = M.context(inst, sol);
    M.forEach(inst, sol, (m) => {
      M.describe(inst, sol, m, ctx);
      const after = M.result(inst, sol, m);
      if (m.type === 'twoOpt') {
        const back = { type: 'twoOpt', r: m.r, i: m.i, k: m.k };
        M.describe(inst, after, back);
        assert.equal(JSON.stringify(M.result(inst, after, back)), JSON.stringify(sol));
        assert.ok(back.adds.some((a) => m.drops.includes(a)), 'reverse 2-opt is tabu');
        twoOpts++;
      } else if (m.type === 'relocate' && m.q === sol.routes[m.r1].visits[m.v1].jobs[m.c1].qty) {
        // relocating the job back to (truck, node) it left re-adds the attribute the first move dropped
        const j = sol.routes[m.r1].visits[m.v1].jobs[m.c1].job;
        const backAttr = 'j' + j + 'v' + sol.routes[m.r1].vehicle + 'n' + sol.routes[m.r1].visits[m.v1].node;
        assert.equal(m.drops[0], backAttr);
        const ctx2 = M.context(inst, after);
        let found = false;
        M.forEach(inst, after, (b) => {
          M.describe(inst, after, b, ctx2);
          if (b.adds[0] === backAttr) { found = true; return true; }
          return false;
        }, { types: ['relocate'], ctx: ctx2 });
        if (found) relocs++;
      }
      return relocs > 200 && twoOpts > 200;
    }, { types: ['relocate', 'twoOpt'], ctx });
  }
  assert.ok(relocs > 20 && twoOpts > 20, `relocs ${relocs}, 2-opts ${twoOpts}`);
});

// ---- API edges other methods will hit -------------------------------------------------------------
test('review: neighbors, insertJobs, refill and localSearch accept a solution that is not normalized', () => {
  const inst = S.makeTestInstance(3, { nJobs: 10, nVehicles: 4 });
  const empty = S.evaluate(inst, { routes: [] }).total;
  const nb = S.neighbors(inst, { routes: [] }, SRO.util.rng(1), 8);
  assert.ok(nb.length > 0, 'neighbors of { routes: [] }');
  for (const c of nb) assert.equal(c.total, S.evaluate(inst, c.solution, { costOnly: true }).total);
  const ins = S.insertJobs(inst, { routes: [] }, null, {});
  assert.ok(ins.total < empty && S.isNormalized(inst, ins.solution));
  assert.equal(ins.total, S.evaluate(inst, ins.solution, { costOnly: true }).total);
  const rf = S.refill(inst, { routes: [] }, {});
  assert.ok(rf.total < empty);
  assert.equal(rf.total, S.evaluate(inst, rf.solution, { costOnly: true }).total);
  for (const bad of [null, { routes: [] }, { routes: [{ vehicle: 0, visits: null }, null] }]) {
    const out = S.localSearch(inst, bad, { maxIters: 3000 });
    const ev = S.evaluate(inst, out);
    assert.ok(ev.feasible && ev.total < empty);
  }
});

test('review: localSearch never returns worse than a malformed input, even when normalizing it hurts', () => {
  const rng = SRO.util.rng(31);
  for (let seed = 1; seed <= 30; seed++) {
    const inst = S.makeTestInstance(seed, { nJobs: 8, nVehicles: 3, nRally: 4 });
    const sol = randomSolution(SRO, inst, rng);
    // the same truck twice (vehicle-reused), an empty visit, a zero chunk and a bad node
    sol.routes.push({ vehicle: 0, visits: [visit(inst.jobs[0].candidates[0].node, [0, inst.jobs[0].qty / 2])] });
    sol.routes[1].visits.push({ node: 0, jobs: [] }, { node: 999, jobs: [{ job: 1, qty: 0 }] });
    const e0 = S.evaluate(inst, sol, { costOnly: true });
    for (const maxIters of [0, 50, 3000]) {
      const out = S.localSearch(inst, sol, { rng: SRO.util.rng(seed), maxIters });
      const e1 = S.evaluate(inst, out, { costOnly: true });
      assert.ok(e1.total <= e0.total + 1e-9 * Math.max(1, e0.total), `seed ${seed} maxIters ${maxIters}`);
    }
  }
});

test('review: localSearch drops an empty visit that only costs a stop and a detour', () => {
  // an empty stop at the hub mid-route: no job can be delivered there, so no merge can absorb it
  const inst = h2();
  const sol = { routes: [{ vehicle: 2, visits: [{ node: 0, jobs: [] }, visit(1, [1, 1000])] }, { vehicle: 0, visits: [] }, { vehicle: 1, visits: [] }] };
  const out = S.localSearch(inst, sol, { rng: SRO.util.rng(1), refill: false, maxIters: 200 });
  assert.ok(!out.routes.some((r) => r.visits.some((v) => !v.jobs.length)));
  assert.ok(S.evaluate(inst, out).total < S.evaluate(inst, sol).total);
});

test('review: normalize drops zero-quantity chunks (never raises the cost)', () => {
  const inst = h2();
  const sol = { routes: [{ vehicle: 0, visits: [visit(1, [0, 0], [2, 4]), visit(3, [0, 0])] }] };
  const out = S.normalize(inst, sol);
  assert.deepEqual(plain(out.routes[0].visits), [{ node: 1, jobs: [{ job: 2, qty: 4 }] }, { node: 3, jobs: [] }]);
  assert.ok(S.evaluate(inst, out).total <= S.evaluate(inst, sol).total);
});

// ---- params.js against the DESIGN.md table itself (labels, defaults, ranges) ---------------------------
test('review: PARAMS labels, defaults and ranges equal the DESIGN.md "Method parameters" table', async () => {
  const fs = await import('node:fs');
  const md = fs.readFileSync(new URL('../../docs/DESIGN.md', import.meta.url), 'utf8');
  const section = md.split('### Method parameters')[1].split('\nRules:')[0];
  const rows = section.split('\n').filter((l) => /^\| (all|tabu|sa|aco|mip) \|/.test(l));
  assert.ok(rows.length >= 20, 'parsed ' + rows.length + ' rows');
  const num = (s) => Number(s);
  for (const row of rows) {
    const [method, key, label, dflt, range] = row.split('|').slice(1, -1).map((c) => c.trim().replace(/`/g, ''));
    for (const m of method === 'all' ? S.METHOD_KEYS : [method]) {
      const e = S.paramSpec(m, key);
      assert.ok(e, `${m}.${key} exists`);
      assert.equal(e.label, label, `${m}.${key} label`);
      if (range === 'bool') { assert.equal(e.type, 'bool'); assert.equal(e.default, dflt === 'true'); continue; }
      const mr = /^([\d.e+-]+?)(?: \(off\))?-([\d.e+]+)$/.exec(range);
      assert.ok(mr, 'range ' + range);
      assert.equal(e.min, num(mr[1]), `${m}.${key} min`);
      assert.equal(e.max, num(mr[2]), `${m}.${key} max`);
      if (dflt === 'settings.timeLimitSec') {
        assert.equal(e.defaultFrom, 'timeLimitSec');
        assert.equal(S.defaultParams(m, { timeLimitSec: 120 })[key], 120);
      } else assert.equal(e.default, num(dflt), `${m}.${key} default`);
    }
  }
});
