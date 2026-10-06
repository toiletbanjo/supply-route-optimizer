// evaluate() on hand-computed instances (DESIGN.md section 7, "Evaluation semantics"), every violation
// code, costOnly consistency and explainDeferred reasons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSolver, plain, near, randomSolution } from './fixtures.mjs';

const SRO = loadSolver();
const S = SRO.solver;
const close = (a, b, msg, tol = 1e-6) => assert.ok(near(a, b, tol), `${msg || ''} expected ${b}, got ${a}`);

function sym(n, pairs) {
  const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : null)));
  for (const [a, b, x] of pairs) { m[a][b] = x; m[b][a] = x; }
  return m;
}

// Hand instance. Nodes: 0 hub, 1 rally R1, 2 direct D1, 3 rally R2.
//   base minutes  0-1 60, 0-2 90, 0-3 30, 1-2 40, 1-3 50, 2-3 70
//   miles         0-1 30, 0-2 45, 0-3 15, 1-2 20, 1-3 25, 2-3 35
//   risk units    0-1 2,  0-2 3,  0-3 0,  1-2 4,  1-3 0,  2-3 1
// V0 tanker 2500 gal (available 0), V1 cargo 10 pallets (available 500), both at hub 0.
// J0 R-1 fuel 1000 gal, Priority (tier 1), class III, deadline 500, cand R1 (cost 5), D1 (0)
// J1 R-1 cargo 4 pal, Routine (tier 0), class I (rank 1), deadline 700, cand R1 (5), D1 (0), R2 (3)
// J2 R-2 cargo 6 pal, Urgent (tier 2), class V (rank 2), deadline 560, cand R1 (32), R2 (8)
// weights fuel 3, distance 3, risk 5, simplicity 2; mpg 2, service 15, load 20; startMin 400.
function hand(edit) {
  const inst = {
    startMin: 400,
    nodes: [
      { key: 'hub:H', kind: 'hub', gridId: 'H', label: 'Hub' },
      { key: 'rally:R1', kind: 'rally', gridId: 'R1', label: 'R1' },
      { key: 'direct:D1', kind: 'direct', gridId: null, label: 'D1' },
      { key: 'rally:R2', kind: 'rally', gridId: 'R2', label: 'R2' }
    ],
    minutes: sym(4, [[0, 1, 60], [0, 2, 90], [0, 3, 30], [1, 2, 40], [1, 3, 50], [2, 3, 70]]),
    miles: sym(4, [[0, 1, 30], [0, 2, 45], [0, 3, 15], [1, 2, 20], [1, 3, 25], [2, 3, 35]]),
    riskUnits: sym(4, [[0, 1, 2], [0, 2, 3], [0, 3, 0], [1, 2, 4], [1, 3, 0], [2, 3, 1]]),
    gridPaths: {},
    periods: [{ startMin: 0, endMin: 100000, speed: 1, risk: 1, name: 'Flat' }],
    vehicles: [
      { id: 'V0', type: 'tanker', capacity: 2500, hubNode: 0, availableAt: 0, color: '#2F6FE0' },
      { id: 'V1', type: 'cargo', capacity: 10, hubNode: 0, availableAt: 500, color: '#0F9488' }
    ],
    jobs: [
      { id: 'J0', requestId: 'R-1', lineIdxs: [0], group: 'fuel', qty: 1000, unit: 'gal', tier: 1, classRank: 0, deadline: 500, hardDeadline: false,
        candidates: [{ node: 1, platoonMiles: 10, platoonCost: 5, hint: false }, { node: 2, platoonMiles: 0, platoonCost: 0, hint: false }], lockedTruck: null },
      { id: 'J1', requestId: 'R-1', lineIdxs: [1], group: 'cargo', qty: 4, unit: 'pallet', tier: 0, classRank: 1, deadline: 700, hardDeadline: false,
        candidates: [{ node: 1, platoonMiles: 10, platoonCost: 5 }, { node: 2, platoonMiles: 0, platoonCost: 0 }, { node: 3, platoonMiles: 6, platoonCost: 3 }], lockedTruck: null },
      { id: 'J2', requestId: 'R-2', lineIdxs: [0], group: 'cargo', qty: 6, unit: 'pallet', tier: 2, classRank: 2, deadline: 560, hardDeadline: false,
        candidates: [{ node: 1, platoonMiles: 8, platoonCost: 32 }, { node: 3, platoonMiles: 2, platoonCost: 8 }], lockedTruck: null }
    ],
    weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },
    params: { mpg: 2, serviceMin: 15, loadMin: 20, maxRallyPoints: 8, pinnedRally: [], bannedRally: [] },
    penalties: { latePerMin: [1, 3, 50, 500], defer: [200, 600, 5000, 50000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6] },
    fixed: null
  };
  if (edit) edit(inst);
  return inst;
}
const visit = (node, ...chunks) => ({ node, jobs: chunks.map(([job, qty]) => ({ job, qty })) });
const costSum = (c) => c.fuel + c.distance + c.risk + c.simplicity + c.platoon + c.lateness + c.deferral;

test('hand instance is valid', () => {
  assert.deepEqual(plain(S.validateInstance(hand())), []);
});

test('basic schedule: start = max(startMin, availableAt) + loadMin, lateness, platoon once per (request, node)', () => {
  const inst = hand();
  const sol = { routes: [
    { vehicle: 0, visits: [visit(1, [0, 1000])] },
    { vehicle: 1, visits: [visit(1, [1, 4]), visit(3, [2, 6])] }
  ] };
  const ev = S.evaluate(inst, sol);
  assert.equal(ev.feasible, true);
  assert.deepEqual(plain(ev.violations), []);
  // V0: t0 = max(400, 0) + 20 = 420; 0->1 60 min -> arrive 480 (J0 due 500: on time); depart 495;
  //     1->0 60 -> back 555. miles 30+30 = 60, risk 2+2 = 4.
  const r0 = ev.routes[0];
  assert.equal(r0.vehicle, 0);
  close(r0.depart, 420); close(r0.stops[0].arrive, 480); close(r0.stops[0].depart, 495); close(r0.returnAt, 555);
  close(r0.miles, 60); close(r0.riskUnits, 4); close(r0.gallons, 30);
  // V1: t0 = max(400, 500) + 20 = 520; 0->1 60 -> 580 (J1 due 700 ok); depart 595; 1->3 50 -> 645
  //     (J2 due 560: 85 min late x 50/min x 6/6 = 4250); depart 660; 3->0 30 -> 690.
  //     miles 30+25+15 = 70, risk 2+0+0 = 2.
  const r1 = ev.routes[1];
  close(r1.depart, 520); close(r1.loadStart, 500);
  close(r1.stops[0].arrive, 580); close(r1.stops[1].arrive, 645); close(r1.stops[1].depart, 660); close(r1.returnAt, 690);
  close(r1.miles, 70); close(r1.riskUnits, 2);
  // totals: miles 130 -> gallons 65 -> fuel 3 x 65 = 195; distance 3 x 0.5 x 130 = 195; risk 5 x 6 = 30;
  // simplicity 2 x (5 x 3 stops + 25 x 2 trucks) = 130; platoon: (R-1, R1) = 5 once (J0 and J1 share it),
  // (R-2, R2) = 8 -> 3 x 13 = 39; lateness 4250; deferral 0. total 4839.
  close(ev.cost.fuel, 195); close(ev.cost.distance, 195); close(ev.cost.risk, 30);
  close(ev.cost.simplicity, 130); close(ev.cost.platoon, 39); close(ev.cost.lateness, 4250); close(ev.cost.deferral, 0);
  close(ev.total, 4839);
  // per-route attribution: the (R-1, R1) pair is charged to V0, where it first appears
  close(r0.cost.platoon, 15); close(r1.cost.platoon, 24);
  close(r0.cost.simplicity, 2 * (5 + 25)); close(r1.cost.simplicity, 2 * (10 + 25));
  close(r1.cost.lateness, 4250);
  assert.deepEqual(plain(ev.late), [{ job: 2, minutesLate: 85 }]);
  assert.deepEqual(plain(ev.hardLate), []);
  assert.deepEqual(plain(ev.rallyNodes), [1, 3]);
  assert.deepEqual(plain(ev.delivered), [1000, 4, 6]);
  assert.deepEqual(plain(ev.deferred), []);
  assert.equal(ev.stats.stops, 3); assert.equal(ev.stats.trucksUsed, 2);
  // legs include the return leg
  assert.equal(r1.legs.length, 3);
  assert.deepEqual(plain(r1.legs.map((l) => [l.from, l.to])), [[0, 1], [1, 3], [3, 0]]);
  // costOnly agrees
  const fast = S.evaluate(inst, sol, { costOnly: true });
  assert.equal(fast.total, ev.total); assert.equal(fast.feasible, true);
  assert.equal(S.totalCost(inst, sol), ev.total);
});

test('period boundary: leg speed and risk from the period containing the departure minute; lateness share', () => {
  // Day [0,1080) x1.0/x1.0, Dusk [1080,1170) x0.9/x1.2, Night [1170,1770) x0.7/x0.8
  const inst = hand((i) => {
    i.startMin = 1060;
    i.jobs[0].deadline = 1200;
    i.periods = [
      { startMin: 0, endMin: 1080, speed: 1.0, risk: 1.0, name: 'Day' },
      { startMin: 1080, endMin: 1170, speed: 0.9, risk: 1.2, name: 'Dusk' },
      { startMin: 1170, endMin: 1770, speed: 0.7, risk: 0.8, name: 'Night' }
    ];
  });
  // V0 delivers J0 in two chunks: 600 at R1, 400 at D1.
  const sol = { routes: [{ vehicle: 0, visits: [visit(1, [0, 600]), visit(2, [0, 400])] }, { vehicle: 1, visits: [] }] };
  const ev = S.evaluate(inst, sol);
  assert.equal(ev.feasible, true);
  const r = ev.routes[0];
  // t0 = 1060 + 20 = 1080: exactly the Dusk boundary, so leg 1 is Dusk: 60 / 0.9 = 66.667 -> 1146.667, risk 2 x 1.2
  close(r.depart, 1080);
  assert.equal(r.legs[0].periodIdx, 1);
  close(r.stops[0].arrive, 1080 + 60 / 0.9);
  assert.equal(r.stops[0].periodIdx, 1);
  // depart 1161.667 (still Dusk): 40 / 0.9 = 44.444 -> 1206.111 (arrives in Night, timed as Dusk), risk 4 x 1.2
  assert.equal(r.legs[1].periodIdx, 1);
  const arrive2 = 1080 + 60 / 0.9 + 15 + 40 / 0.9;
  close(r.stops[1].arrive, arrive2);
  assert.equal(r.stops[1].periodIdx, 2);
  // depart 1221.111 (Night): 90 / 0.7 = 128.571 -> 1349.683, risk 3 x 0.8
  assert.equal(r.legs[2].periodIdx, 2);
  close(r.returnAt, arrive2 + 15 + 90 / 0.7);
  close(r.riskUnits, 2 * 1.2 + 4 * 1.2 + 3 * 0.8);           // 9.6
  close(r.miles, 95);
  // lateness: 400 of 1000 arrive 6.111 min late at 3/min (Priority): 6.111 x 3 x 0.4 = 7.333
  close(ev.cost.lateness, (arrive2 - 1200) * 3 * 0.4);
  close(ev.cost.lateness, 7.333333333, 1e-8);
  assert.equal(ev.late.length, 1); close(ev.late[0].minutesLate, arrive2 - 1200);
  // fuel 3 x 47.5 = 142.5; distance 3 x 0.5 x 95 = 142.5; risk 5 x 9.6 = 48; simplicity 2 x (5 x 2 + 25) = 70;
  // platoon 3 x (5 at R1 + 0 at D1) = 15; deferral J1 200 x 0.9 = 180 + J2 5000 x 0.85 = 4250 -> 4430
  close(ev.cost.fuel, 142.5); close(ev.cost.distance, 142.5); close(ev.cost.risk, 48);
  close(ev.cost.simplicity, 70); close(ev.cost.platoon, 15); close(ev.cost.deferral, 4430);
  close(ev.total, 142.5 + 142.5 + 48 + 70 + 15 + 7.333333333333 + 4430, 1e-9);   // 4855.333
});

test('preloaded en-route truck, partial delivery (deferral share), platoon cost per distinct (request, node)', () => {
  const inst = hand((i) => {
    Object.assign(i.vehicles[0], { preloaded: true, startNode: 2, availableAt: 450 });
    i.vehicles[1].availableAt = 0;
    i.jobs[0].lockedTruck = 'V0';
  });
  const sol = { routes: [
    { vehicle: 0, visits: [visit(1, [0, 1000])] },
    { vehicle: 1, visits: [visit(3, [1, 4]), visit(1, [2, 3])] }
  ] };
  const ev = S.evaluate(inst, sol);
  assert.equal(ev.feasible, true, JSON.stringify(ev.violations));
  // V0 (preloaded, starts at D1): t0 = max(400, 450) + 0 = 450; 2->1 40 -> 490 (due 500 ok); depart 505;
  //   1->0 60 -> 565. miles 20+30 = 50; risk 4+2 = 6.
  close(ev.routes[0].depart, 450); close(ev.routes[0].loadStart, 450);
  close(ev.routes[0].stops[0].arrive, 490); close(ev.routes[0].returnAt, 565);
  close(ev.routes[0].miles, 50);
  assert.deepEqual(plain(ev.routes[0].legs.map((l) => [l.from, l.to])), [[2, 1], [1, 0]]);
  // V1: t0 = 400 + 20 = 420; 0->3 30 -> 450; depart 465; 3->1 50 -> 515 (J2 due 560 ok); depart 530; 1->0 60 -> 590.
  //   miles 15+25+30 = 70; risk 0+0+2 = 2.
  close(ev.routes[1].stops[1].arrive, 515); close(ev.routes[1].returnAt, 590);
  // miles 120 -> fuel 3 x 60 = 180, distance 180; risk 5 x 8 = 40; simplicity 2 x (15 + 50) = 130;
  // platoon: (R-1, R1) 5 + (R-1, R2) 3 + (R-2, R1) 32 = 40 -> x3 = 120;
  // deferral: J2 3 of 6 left: 0.5 x 5000 x 0.85 = 2125. total 2775.
  close(ev.cost.fuel, 180); close(ev.cost.distance, 180); close(ev.cost.risk, 40);
  close(ev.cost.simplicity, 130); close(ev.cost.platoon, 120); close(ev.cost.lateness, 0); close(ev.cost.deferral, 2125);
  close(ev.total, 2775);
  assert.deepEqual(plain(ev.deferred), [{ job: 2, qty: 3 }]);
});

test('hard deadline: a late Immediate job is listed in hardLate but is not a violation; empty route costs nothing', () => {
  const inst = hand((i) => { Object.assign(i.jobs[0], { tier: 3, hardDeadline: true, deadline: 470 }); });
  const sol = { routes: [{ vehicle: 0, visits: [visit(1, [0, 1000])] }, { vehicle: 1, visits: [] }] };
  const ev = S.evaluate(inst, sol);
  assert.equal(ev.feasible, true);
  assert.deepEqual(plain(ev.hardLate), [0]);
  assert.deepEqual(plain(ev.late), [{ job: 0, minutesLate: 10 }]);
  assert.equal(ev.routes.length, 1, 'only used routes are reported');
  // arrive 480, due 470: 10 x 500 x 1 = 5000. fuel 3 x 30 = 90, distance 90, risk 5 x 4 = 20,
  // simplicity 2 x (5 + 25) = 60 (one truck: the empty route is not used), platoon 3 x 5 = 15,
  // deferral J1 180 + J2 4250 = 4430. total 9705.
  close(ev.cost.lateness, 5000); close(ev.cost.simplicity, 60); close(ev.total, 9705);
});

test('empty plan: everything deferred at defer[tier] x classFactor[classRank]', () => {
  const ev = S.evaluate(hand(), { routes: [] });
  // J0 600 x 1.0 + J1 200 x 0.9 + J2 5000 x 0.85 = 600 + 180 + 4250 = 5030
  close(ev.total, 5030); close(ev.cost.deferral, 5030);
  assert.equal(ev.feasible, true);
  assert.deepEqual(plain(ev.deferred), [{ job: 0, qty: 1000 }, { job: 1, qty: 4 }, { job: 2, qty: 6 }]);
  assert.equal(S.evaluate(hand(), S.emptySolution(hand())).total, 5030);
});

test('periods past the expanded table wrap by whole days; a leg is timed by the departure period', () => {
  const periods = S.expandPeriods(S.DEFAULT_PERIOD_TABLE, 360, 72);
  const inst = hand((i) => { i.periods = periods; i.startMin = 360 + 4 * 1440; });   // beyond the 72 h table
  const sol = { routes: [{ vehicle: 0, visits: [visit(1, [0, 1000])] }] };
  const ev = S.evaluate(inst, sol);
  // t0 = 6120 + 20 = 6140 = Day 5 0620 -> Dawn (x0.9): 60 / 0.9
  const pi = ev.routes[0].legs[0].periodIdx;
  assert.equal(periods[pi].name, 'Dawn');
  close(ev.routes[0].stops[0].arrive, 6140 + 60 / 0.9);
});

test('capacity check tolerates float sums', () => {
  // 0.1 + 0.2 = 0.30000000000000004: not over a 0.3 capacity, not over a 0.3 job, no deferred crumb
  const inst = hand((i) => { i.vehicles[1].capacity = 0.3; i.jobs[1].qty = 0.3; });
  const sol = { routes: [{ vehicle: 1, visits: [visit(1, [1, 0.1]), visit(3, [1, 0.2])] }] };
  assert.ok(0.1 + 0.2 > 0.3);
  const ev = S.evaluate(inst, sol);
  assert.deepEqual(plain(ev.violations), []);
  assert.deepEqual(plain(ev.deferred.map((d) => d.job)), [0, 2]);
});

// ---- violations -------------------------------------------------------------------------------
const VIOLATION_CASES = [
  ['wrong-type: fuel on a cargo truck', null, { routes: [{ vehicle: 1, visits: [visit(1, [0, 5])] }] }, ['wrong-type']],
  ['over-capacity', (i) => { i.jobs[2].qty = 12; }, { routes: [{ vehicle: 1, visits: [visit(3, [2, 12])] }] }, ['over-capacity']],
  ['node not a candidate', null, { routes: [{ vehicle: 1, visits: [visit(2, [2, 6])] }] }, ['not-candidate']],
  ['banned rally node', (i) => { i.params.bannedRally = [3]; }, { routes: [{ vehicle: 1, visits: [visit(3, [2, 6])] }] }, ['not-candidate']],
  ['too many rally points', (i) => { i.params.maxRallyPoints = 1; },
    { routes: [{ vehicle: 0, visits: [visit(1, [0, 1000])] }, { vehicle: 1, visits: [visit(3, [2, 6])] }] }, ['too-many-rally']],
  ['unreachable legs (out and back)', (i) => { i.minutes[0][3] = Infinity; i.minutes[3][0] = Infinity; },
    { routes: [{ vehicle: 1, visits: [visit(3, [2, 6])] }] }, ['unreachable', 'unreachable']],
  ['vehicle used twice', null, { routes: [{ vehicle: 1, visits: [visit(1, [1, 4])] }, { vehicle: 1, visits: [visit(3, [2, 6])] }] }, ['vehicle-reused']],
  ['locked job on the wrong truck', (i) => {
    i.vehicles.push({ id: 'V2', type: 'cargo', capacity: 10, hubNode: 0, availableAt: 0 });
    i.jobs[1].lockedTruck = 'V2';
  }, { routes: [{ vehicle: 1, visits: [visit(1, [1, 4])] }] }, ['locked-truck']],
  ['quantity over job qty', null, { routes: [{ vehicle: 1, visits: [visit(1, [1, 3]), visit(3, [1, 3])] }] }, ['over-qty']],
  ['bad vehicle index', null, { routes: [{ vehicle: 7, visits: [visit(1, [1, 4])] }] }, ['bad-index']],
  ['negative quantity', null, { routes: [{ vehicle: 1, visits: [visit(1, [1, -1])] }] }, ['bad-qty']]
];
for (const [name, edit, sol, codes] of VIOLATION_CASES) {
  test(`violation: ${name}`, () => {
    const inst = hand(edit);
    const ev = S.evaluate(inst, sol);
    assert.deepEqual(plain(ev.violations.map((v) => v.code)), codes);
    assert.equal(ev.feasible, false);
    for (const v of ev.violations) assert.ok(typeof v.detail === 'string' && v.detail.length > 10);
    // each violation adds exactly 1e7 on top of the ordinary cost terms
    close(ev.total, costSum(ev.cost) + 1e7 * codes.length, 1e-12);
    const fast = S.evaluate(inst, sol, { costOnly: true });
    assert.equal(fast.total, ev.total);
    assert.equal(fast.feasible, false);
    assert.equal(fast.nViolations, codes.length);
  });
}

test('unreachable leg counts 0 minutes and 0 miles so totals stay finite', () => {
  const inst = hand((i) => { i.minutes[0][3] = Infinity; i.minutes[3][0] = Infinity; i.miles[0][3] = Infinity; i.miles[3][0] = Infinity; });
  const ev = S.evaluate(inst, { routes: [{ vehicle: 1, visits: [visit(3, [2, 6])] }] });
  assert.ok(Number.isFinite(ev.total));
  close(ev.routes[0].miles, 0);
});

test('costOnly matches the full result on random (often infeasible) solutions', () => {
  const rng = SRO.util.rng(99);
  for (let seed = 1; seed <= 60; seed++) {
    const inst = S.makeTestInstance(seed, { nJobs: 3 + (seed % 12), nVehicles: 1 + (seed % 5), closedZones: seed % 3, maxRallyPoints: seed % 4, locked: seed % 2 });
    for (let k = 0; k < 5; k++) {
      const sol = randomSolution(SRO, inst, rng);
      const full = S.evaluate(inst, sol), fast = S.evaluate(inst, sol, { costOnly: true });
      assert.equal(fast.total, full.total);
      assert.equal(fast.feasible, full.feasible);
      assert.equal(fast.nViolations, full.violations.length);
      close(full.total, costSum(full.cost) + 1e7 * full.violations.length, 1e-12);
      // per-route costs add up to the totals (deferral is plan-level)
      const sumR = (k2) => full.routes.reduce((a, r) => a + r.cost[k2], 0);
      for (const k2 of ['fuel', 'distance', 'risk', 'simplicity', 'platoon', 'lateness']) close(sumR(k2), full.cost[k2], 1e-9);
    }
  }
});

test('evaluate rebuilds its cache when the instance is replaced or weights change', () => {
  const inst = hand();
  const sol = { routes: [{ vehicle: 0, visits: [visit(1, [0, 1000])] }] };
  const a = S.evaluate(inst, sol).total;
  inst.weights.fuel = 6;                                   // in-place weight edit is detected
  const b = S.evaluate(inst, sol).total;
  close(b - a, 3 * 30);                                    // 30 more gallons-weight points
  inst.jobs[0].deadline = 400;                             // other in-place edits need invalidate()
  S.prepare.invalidate(inst);
  assert.ok(S.evaluate(inst, sol).cost.lateness > 0);
});

// ---- explainDeferred -----------------------------------------------------------------------------
function reasonOf(inst, sol, job) {
  const ev = S.evaluate(inst, sol);
  const ex = S.explainDeferred(inst, ev);
  const e = ex.find((x) => x.job === job);
  assert.ok(e, 'job ' + job + ' should be deferred');
  assert.ok(typeof e.note === 'string' && e.note.length > 10);
  return e;
}

test('explainDeferred: radius (no allowed pickup point)', () => {
  const inst = hand((i) => { i.jobs[2].candidates = []; });
  assert.equal(reasonOf(inst, { routes: [] }, 2).reason, 'radius');
  const inst2 = hand((i) => { i.jobs[2].candidates = [{ node: 3, platoonMiles: 2, platoonCost: 8 }]; i.params.bannedRally = [3]; });
  assert.equal(reasonOf(inst2, { routes: [] }, 2).reason, 'radius');
});

test('explainDeferred: no-truck (no tanker, or locked to a truck that is out)', () => {
  const inst = hand((i) => { i.vehicles = [i.vehicles[1]]; });
  assert.equal(reasonOf(inst, { routes: [] }, 0).reason, 'no-truck');
  const inst2 = hand((i) => { i.jobs[1].lockedTruck = 'V9'; });
  const e = reasonOf(inst2, { routes: [] }, 1);
  assert.equal(e.reason, 'no-truck'); assert.equal(e.detail, 'locked-truck-unavailable');
});

test('explainDeferred: closed-road (every candidate cut off)', () => {
  const inst = hand((i) => { for (const n of [1, 3]) { i.minutes[0][n] = Infinity; i.minutes[n][0] = Infinity; } });
  assert.equal(reasonOf(inst, { routes: [] }, 2).reason, 'closed-road');
});

test('explainDeferred: time (earliest arrival after the deadline)', () => {
  const inst = hand((i) => { i.jobs[2].deadline = 520; });
  // V1 t0 = 520; nearest candidate R2 is 30 min away -> earliest 550 > 520
  const e = reasonOf(inst, { routes: [] }, 2);
  assert.equal(e.reason, 'time'); close(e.earliestArrive, 550); assert.equal(e.deadline, 520);
});

test('explainDeferred: capacity (compatible trucks full)', () => {
  const inst = hand((i) => {
    i.jobs.push({ id: 'J3', requestId: 'R-3', group: 'cargo', qty: 5, unit: 'pallet', tier: 0, classRank: 4, deadline: 900, hardDeadline: false,
      candidates: [{ node: 3, platoonMiles: 1, platoonCost: 0.5 }], lockedTruck: null });
  });
  const sol = { routes: [{ vehicle: 1, visits: [visit(1, [1, 4]), visit(3, [2, 6])] }] };
  const e = reasonOf(inst, sol, 3);
  assert.equal(e.reason, 'capacity'); assert.equal(e.detail, 'trucks-full');
});
