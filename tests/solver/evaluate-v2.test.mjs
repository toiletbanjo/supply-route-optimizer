// Rule changes of 2026-10-06 in DESIGN.md section 7, and what they are for:
//   1. new default penalties (Routine deferral above any single job's routing cost) with lateness per
//      chunk capped at lateCapShare x the job's deferral cost; missing penalties fields fall back alone;
//   2. FIFO travel time integrated across time-of-day periods, leg risk = time-weighted mean period risk;
//   3. an unused pinned rally point (a candidate of some job, no delivered quantity) costs pinUnused.
// Then, with the new defaults: construct + localSearch defers nothing while there is room, and defers in
// tier order (Routine, Priority, Urgent, Immediate) when there is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadSolver, plain, near } from './fixtures.mjs';

const SRO = loadSolver();
const S = SRO.solver;
const close = (a, b, msg, tol = 1e-9) => assert.ok(near(a, b, tol), `${msg || ''} expected ${b}, got ${a}`);
const visit = (node, ...chunks) => ({ node, jobs: chunks.map(([job, qty]) => ({ job, qty })) });
const DEFAULT_TABLE_PERIODS = S.expandPeriods(S.DEFAULT_PERIOD_TABLE, 360, 72);   // [0, 5760): Day 1-4

function sym(n, pairs) {
  const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : null)));
  for (const [a, b, x] of pairs) { m[a][b] = x; m[b][a] = x; }
  return m;
}
// Mini instance (no penalties object: every penalty is a default).
//   nodes 0 hub H, 1 rally A, 2 direct D, 3 rally B
//   minutes 0-1 60, 0-2 120, 0-3 40, 1-2 50, 1-3 30, 2-3 70
//   miles   0-1 30, 0-2 60,  0-3 20, 1-2 25, 1-3 15, 2-3 35
//   risk    0-1 2,  0-2 4,   0-3 0,  1-2 1,  1-3 0,  2-3 3
//   V0 tanker 2500 gal, V1 cargo 10 pallets, both at hub 0, available 0; startMin 1030 (1710), load 20, service 15
//   J0 R-1 fuel 1000 gal Priority (1) class III (rank 0) due 2000, cand A (4), D (0)
//   J1 R-2 cargo 6 pal Urgent (2) class V (rank 2) due 2000, cand A (6), B (2)
//   J2 R-3 cargo 2 pal Routine (0) class I (rank 1) due 2000, cand D (0)
function mini(edit) {
  const inst = {
    startMin: 1030,
    nodes: [
      { key: 'hub:H', kind: 'hub', label: 'H' }, { key: 'rally:A', kind: 'rally', label: 'A' },
      { key: 'direct:D', kind: 'direct', label: 'D' }, { key: 'rally:B', kind: 'rally', label: 'B' }
    ],
    minutes: sym(4, [[0, 1, 60], [0, 2, 120], [0, 3, 40], [1, 2, 50], [1, 3, 30], [2, 3, 70]]),
    miles: sym(4, [[0, 1, 30], [0, 2, 60], [0, 3, 20], [1, 2, 25], [1, 3, 15], [2, 3, 35]]),
    riskUnits: sym(4, [[0, 1, 2], [0, 2, 4], [0, 3, 0], [1, 2, 1], [1, 3, 0], [2, 3, 3]]),
    gridPaths: {},
    periods: DEFAULT_TABLE_PERIODS.map((p) => Object.assign({}, p)),
    vehicles: [
      { id: 'V0', type: 'tanker', capacity: 2500, hubNode: 0, availableAt: 0 },
      { id: 'V1', type: 'cargo', capacity: 10, hubNode: 0, availableAt: 0 }
    ],
    jobs: [
      { id: 'J0', requestId: 'R-1', group: 'fuel', qty: 1000, unit: 'gal', tier: 1, classRank: 0, deadline: 2000, hardDeadline: false,
        candidates: [{ node: 1, platoonMiles: 8, platoonCost: 4 }, { node: 2, platoonMiles: 0, platoonCost: 0 }], lockedTruck: null },
      { id: 'J1', requestId: 'R-2', group: 'cargo', qty: 6, unit: 'pallet', tier: 2, classRank: 2, deadline: 2000, hardDeadline: false,
        candidates: [{ node: 1, platoonMiles: 12, platoonCost: 6 }, { node: 3, platoonMiles: 4, platoonCost: 2 }], lockedTruck: null },
      { id: 'J2', requestId: 'R-3', group: 'cargo', qty: 2, unit: 'pallet', tier: 0, classRank: 1, deadline: 2000, hardDeadline: false,
        candidates: [{ node: 2, platoonMiles: 0, platoonCost: 0 }], lockedTruck: null }
    ],
    weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },
    params: { mpg: 2, serviceMin: 15, loadMin: 20, maxRallyPoints: 8, pinnedRally: [], bannedRally: [] },
    fixed: null
  };
  if (edit) edit(inst);
  return inst;
}
const flat = (i) => { i.periods = []; };

// ---- 1. defaults ---------------------------------------------------------------------------------------
test('v2 defaults: DEFAULT_PENALTIES equal the DESIGN.md instance block; each missing field falls back alone', () => {
  const want = { latePerMin: [2, 6, 60, 600], defer: [5000, 15000, 60000, 250000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6], lateCapShare: 0.9, pinUnused: 2000 };
  assert.deepEqual(plain(S.DEFAULT_PENALTIES), want);
  const md = fs.readFileSync(new URL('../../docs/DESIGN.md', import.meta.url), 'utf8');
  const m = /^\s*penalties: (\{.*\}),\s*$/m.exec(md);
  assert.ok(m, 'penalties line in DESIGN.md');
  assert.deepEqual(plain(new Function('return ' + m[1])()), want);
  assert.deepEqual(plain(S.resolvePenalties(mini())), want, 'no penalties object');
  const part = S.resolvePenalties(mini((i) => { i.penalties = { defer: [1, 2, 3, 4], pinUnused: 7 }; }));
  assert.deepEqual(plain(part), Object.assign({}, want, { defer: [1, 2, 3, 4], pinUnused: 7 }));
  // evaluate uses the same per-field fallback: only latePerMin given, deferral and pins use the defaults
  const inst = mini((i) => { flat(i); i.penalties = { latePerMin: [0, 0, 0, 0] }; i.params.pinnedRally = [3]; });
  const ev = S.evaluate(inst, { routes: [] });
  close(ev.cost.deferral, 15000 * 1.0 + 60000 * 0.85 + 5000 * 0.9);   // 70500
  close(ev.cost.pinned, 2000);
  // validation: missing fields are fine, malformed ones are reported
  assert.deepEqual(plain(S.validateInstance(mini((i) => { i.penalties = { latePerMin: [2, 6, 60, 600] }; }))), []);
  assert.deepEqual(plain(S.validateInstance(mini())), []);
  const bad = S.validateInstance(mini((i) => { i.penalties = { defer: [1, 2], lateCapShare: -1, pinUnused: Infinity }; }));
  assert.ok(bad.some((p) => /penalties.defer/.test(p)));
  assert.ok(bad.some((p) => /lateCapShare/.test(p)));
  assert.ok(bad.some((p) => /pinUnused/.test(p)));
});

// ---- 2. FIFO travel time --------------------------------------------------------------------------------
// Independent reference: list every minute where the period can change (period starts and the table end,
// shifted by whole days when the table spans a day), read the period at the midpoint of each piece.
function refPeriodIdx(periods, t) {
  const first = periods[0].startMin, last = periods[periods.length - 1].endMin;
  let tt = t;
  if (last - first >= 1440) { while (tt >= last) tt -= 1440; while (tt < first) tt += 1440; }
  let idx = 0;
  for (let i = 0; i < periods.length; i++) if (periods[i].startMin <= tt) idx = i;
  return idx;
}
function refTravel(periods, t, base) {
  if (!periods.length) return { arrive: t + base, riskFactor: 1 };
  const first = periods[0].startMin, last = periods[periods.length - 1].endMin;
  const until = t + base / Math.min(...periods.map((p) => p.speed)) + 1;
  const shifts = [0];
  if (last - first >= 1440) for (let k = Math.floor((t - last) / 1440) - 1; k <= Math.ceil((until - first) / 1440) + 1; k++) shifts.push(k * 1440);
  const cuts = [];
  for (const sh of shifts) { for (const p of periods) cuts.push(p.startMin + sh); cuts.push(last + sh); }
  const pts = [...new Set(cuts.filter((c) => c > t && c < until))].sort((a, b) => a - b).concat([until]);
  let cur = t, rem = base, riskMin = 0;
  for (const c of pts) {
    const p = periods[refPeriodIdx(periods, (cur + c) / 2)];
    const room = (c - cur) * p.speed;
    if (room >= rem || c === until) {
      const arrive = cur + rem / p.speed;
      riskMin += (arrive - cur) * p.risk;
      return { arrive, riskFactor: arrive > t ? riskMin / (arrive - t) : periods[refPeriodIdx(periods, t)].risk };
    }
    riskMin += (c - cur) * p.risk; rem -= room; cur = c;
  }
  throw new Error('unreachable');
}

const TABLES = {
  // the real one: Day/Dusk/Night/Dawn expanded over 72 h (Night wraps midnight)
  default: DEFAULT_TABLE_PERIODS,
  // a boundary exactly at midnight, speeds above and below 1
  midnight: S.expandPeriods([{ name: 'AM', start: '0000', end: '1200', speed: 0.5, risk: 2 }, { name: 'PM', start: '1200', end: '0000', speed: 1.25, risk: 0.5 }], 0, 48),
  // shorter than a day, with a gap (the period before a gap keeps going) and a 1-minute period
  short: [{ startMin: 500, endMin: 560, speed: 0.6, risk: 1.5 }, { startMin: 600, endMin: 601, speed: 2, risk: 0 },
    { startMin: 601, endMin: 900, speed: 0.8, risk: 1 }]
};

test('v2 FIFO: on 10,000 random (departure, base minutes) pairs a later departure never arrives earlier', (t) => {
  const rng = SRO.util.rng(20261006);
  let pairs = 0, multi = 0, wrapped = 0, worstRef = 0;
  for (const [name, periods] of Object.entries(TABLES)) {
    const P = S.prepare({ periods, nodes: [], vehicles: [], jobs: [] });
    const out = new Float64Array(2), out2 = new Float64Array(2);
    const lo = periods[0].startMin - 2 * 1440, hi = periods[periods.length - 1].endMin + 2 * 1440;
    const n = name === 'default' ? 10000 : 3000;
    const cuts = periods.flatMap((p) => [p.startMin, p.endMin]);
    for (let k = 0; k < n; k++) {
      // departures anywhere (incl. before / after the table and exactly on a boundary), base 0-1500 min
      let dep = lo + rng() * (hi - lo);
      if (rng() < 0.1) dep = cuts[rng.int(cuts.length)] + (rng() < 0.5 ? 0 : 1440 * (rng.int(5) - 2));
      const base = rng() < 0.05 ? 0 : rng() * (rng() < 0.5 ? 120 : 1500);
      const r = rng();
      const later = dep + (r < 0.1 ? 0 : r < 0.2 ? 1e-9 : r < 0.3 ? 1e-6 * rng() : rng() * (rng() < 0.5 ? 5 : 300));
      const a1 = S.legArrive(P, dep, base, out), a2 = S.legArrive(P, later, base, out2);
      assert.ok(a2 >= a1, `${name}: leave ${dep} -> ${a1}, leave ${later} -> ${a2} (base ${base})`);
      assert.ok(a1 >= dep && (base === 0 ? a1 === dep : a1 > dep));
      // same numbers as the independent integrator
      const ref = refTravel(periods, dep, base);
      worstRef = Math.max(worstRef, Math.abs(a1 - ref.arrive) / Math.max(1, Math.abs(ref.arrive)));
      close(a1, ref.arrive, `${name} arrive dep ${dep} base ${base}`, 1e-11);
      close(out[0], ref.riskFactor, `${name} risk factor dep ${dep} base ${base}`, 1e-9);
      assert.equal(out[1], S.periodIndex(P, dep), 'out[1] is the departure period');
      if (out[0] !== periods[out[1]].risk) multi++;
      if (dep < periods[0].startMin || dep >= periods[periods.length - 1].endMin) wrapped++;
      pairs++;
    }
  }
  t.diagnostic(`FIFO: ${pairs} pairs, 0 violations; ${multi} legs crossed a period boundary, ${wrapped} departures outside the table; ` +
    `largest relative gap to the reference integrator ${worstRef.toExponential(1)}`);
  assert.ok(multi > 1000 && wrapped > 1000);
});

test('v2 FIFO: hand-computed legs across 0530, 0700, 1800, 1930 and midnight (default table)', () => {
  const inst = mini();
  const leg = (dep, base) => {
    const P = S.prepare(inst), out = new Float64Array(2);
    const arrive = S.legArrive(P, dep, base, out);
    return { arrive, rf: out[0], name: inst.periods[out[1]].name };
  };
  // Day 2 0500 (1740), 60 base: Night 30 min x 0.7 = 21 base; 39 base at Dawn 0.9 = 43.333 min -> 0613:20
  let l = leg(1740, 60);
  assert.equal(l.name, 'Night');
  close(l.arrive, 1440 + 330 + 39 / 0.9);
  close(l.rf, (30 * 0.8 + (39 / 0.9) * 1.2) / (30 + 39 / 0.9));          // 76 / 73.333 = 1.03636
  close(l.rf, 1.0363636363636364);
  // Day 1 1730 (1050), 60 base: Day 30 min = 30 base; 30 base at Dusk 0.9 = 33.333 min -> 1833:20
  l = leg(1050, 60);
  close(l.arrive, 1080 + 30 / 0.9); close(l.rf, (30 * 1 + (30 / 0.9) * 1.2) / (30 + 30 / 0.9));   // 1.10526
  // 1750 (1070), 120 base crosses 1800 and 1930: Day 10 + Dusk 90 x 0.9 = 81 -> 91 base; 29 base at Night 0.7
  l = leg(1070, 120);
  close(l.arrive, 1170 + 29 / 0.7);                                          // 2011:26
  close(l.rf, (10 * 1 + 90 * 1.2 + (29 / 0.7) * 0.8) / (100 + 29 / 0.7));  // 1.06869
  // 0520 (1760), 100 base crosses 0530 and 0700: Night 10 x 0.7 = 7; Dawn 90 x 0.9 = 81 -> 88; Day 12 -> 0712
  l = leg(1760, 100);
  close(l.arrive, 1440 + 432); close(l.rf, (10 * 0.8 + 90 * 1.2 + 12 * 1) / 112);
  // exactly 0530 is Dawn: 45 base / 0.9 = 50 min, all Dawn
  l = leg(1770, 45);
  assert.equal(l.name, 'Dawn'); close(l.arrive, 1820); assert.equal(l.rf, 1.2);
  // 2330 (1410), 70 base: Night runs through midnight with no boundary there: 100 min -> 0110
  l = leg(1410, 70);
  close(l.arrive, 1510); assert.equal(l.rf, 0.8);
  // midnight boundary table: 2300 (1380) at 1.25 then 0000 at 0.5: 60 min = 75 base; 25 base at 0.5 = 50 min -> 0050
  const mid = S.prepare({ periods: TABLES.midnight, nodes: [], vehicles: [], jobs: [] }), out = new Float64Array(2);
  close(S.legArrive(mid, 1380, 100, out), 1440 + 50); close(out[0], (60 * 0.5 + 50 * 2) / 110);

  // a full plan: V0 leaves 1730 and crosses 1800 out and 1930 back; V1 leaves Day 2 0500 and crosses
  // 0530 and 0700 on the way out
  const plan = mini((i) => { i.vehicles[1].availableAt = 1720; });
  const sol = { routes: [{ vehicle: 0, visits: [visit(1, [0, 1000])] }, { vehicle: 1, visits: [visit(2, [2, 2])] }] };
  const ev = S.evaluate(plan, sol);
  assert.equal(ev.feasible, true);
  const [r0, r1] = ev.routes;
  // V0: t0 = 1030 + 20 = 1050 (1730). H->A 60 base: arrive 1113.333, rf 70 / 63.333.
  close(r0.depart, 1050); close(r0.stops[0].arrive, 1080 + 30 / 0.9);
  const rfA = (30 + (30 / 0.9) * 1.2) / (30 + 30 / 0.9);
  close(r0.legs[0].riskFactor, rfA); close(r0.legs[0].riskUnits, 2 * rfA);
  // dep 1128.333 (Dusk): A->H 60 base: Dusk 41.667 min x 0.9 = 37.5 base; 22.5 base at Night 0.7 = 32.143 min
  const dep0 = 1080 + 30 / 0.9 + 15, dusk = 1170 - dep0, night = 22.5 / 0.7;
  close(dusk * 0.9, 37.5);
  close(r0.returnAt, 1170 + night);
  const rfB = (dusk * 1.2 + night * 0.8) / (dusk + night);
  close(r0.legs[1].riskFactor, rfB); assert.equal(plan.periods[r0.legs[1].periodIdx].name, 'Dusk');
  // V1: t0 = max(1030, 1720) + 20 = 1740 (Day 2 0500). H->D 120 base: Night 30 min = 21 base, Dawn 90 min =
  // 81 base, 18 base at Day -> arrive 1878 (0718); rf 150 / 138. D->H 120 base in Day -> 2013, rf 1.
  close(r1.depart, 1740); close(r1.stops[0].arrive, 1878); close(r1.returnAt, 1878 + 15 + 120);
  close(r1.legs[0].riskFactor, 150 / 138); close(r1.legs[1].riskFactor, 1);
  // costs: miles 180 -> fuel 3 x 90 = 270, distance 270; risk 5 x (2 rfA + 2 rfB + 4 x 150/138 + 4);
  // simplicity 2 x (5 x 2 + 25 x 2) = 120; platoon 3 x 4 = 12; no lateness; J1 deferred 60000 x 0.85
  const riskU = 2 * rfA + 2 * rfB + 4 * 150 / 138 + 4;
  close(ev.stats.riskUnits, riskU); close(ev.cost.risk, 5 * riskU);
  close(ev.cost.lateness, 0); close(ev.cost.deferral, 51000); close(ev.cost.pinned, 0);
  close(ev.total, 270 + 270 + 5 * riskU + 120 + 12 + 51000);
  assert.equal(S.evaluate(plan, sol, { costOnly: true }).total, ev.total);
});

test('v2 FIFO: no periods = speed 1 and risk 1; outside a day-spanning table legs repeat by whole days; short tables extend', () => {
  // no periods
  const none = mini(flat);
  let tm = S.legTiming(none, 1234.5, 0, 2);
  assert.deepEqual([tm.arrive, tm.riskFactor, tm.periodIdx, tm.riskUnits], [1234.5 + 120, 1, -1, 4]);
  const ev = S.evaluate(none, { routes: [{ vehicle: 1, visits: [visit(2, [2, 2])] }] });
  close(ev.routes[0].stops[0].arrive, 1050 + 120); close(ev.routes[0].riskUnits, 8);
  // unreachable legs report Infinity
  const cut = mini((i) => { i.minutes[0][2] = Infinity; });
  assert.equal(S.legTiming(cut, 1000, 0, 2).arrive, Infinity);
  // the default table spans whole days: a departure k days later (outside the table too) is the same leg
  const inst = mini();
  const rng = SRO.util.rng(3);
  for (let n = 0; n < 500; n++) {
    const dep = 1440 + rng() * 1440, base = rng() * 900, k = rng.int(9) - 3;
    const a = S.legTiming(inst, dep, 0, 1), b = S.legTiming(inst, dep + 1440 * k, 0, 1);
    const P = S.prepare(inst), o1 = new Float64Array(2), o2 = new Float64Array(2);
    const x = S.legArrive(P, dep, base, o1), y = S.legArrive(P, dep + 1440 * k, base, o2);
    close(y - 1440 * k, x, 'day shift ' + k, 1e-11); close(o2[0], o1[0], 'risk', 1e-9);
    close(b.arrive - 1440 * k, a.arrive, '', 1e-11);
  }
  // a table shorter than a day: before it the first period runs, after it the last one
  const P = S.prepare({ periods: [{ startMin: 600, endMin: 700, speed: 0.5, risk: 2 }, { startMin: 700, endMin: 800, speed: 2, risk: 1 }], nodes: [], vehicles: [], jobs: [] });
  const out = new Float64Array(2);
  // 500 -> 700 at 0.5 covers 100 base; the other 200 base at 2 take 100 min -> 800
  close(S.legArrive(P, 500, 300, out), 800); close(out[0], (200 * 2 + 100 * 1) / 300);
  close(S.legArrive(P, 5000, 300, out), 5150); assert.equal(out[0], 1);
});

// ---- lateness cap ----------------------------------------------------------------------------------
test('v2 lateness cap: min(minutes late x latePerMin, lateCapShare x defer x classFactor) x chunk share', () => {
  // flat periods. V1 t0 = 1050: H->B 40 -> 1090 (3 pallets of J1), dep 1105, B->A 30 -> 1135 (3 pallets).
  // J1 is Urgent (60/min), class rank 2 (factor 0.85): cap = 0.9 x 60000 x 0.85 = 45900 (765 min late).
  const sol = { routes: [{ vehicle: 1, visits: [visit(3, [1, 3]), visit(1, [1, 3])] }] };
  const run = (deadline, pen) => {
    const inst = mini((i) => { flat(i); i.jobs[1].deadline = deadline; if (pen !== undefined) i.penalties = pen; });
    const ev = S.evaluate(inst, sol);
    assert.equal(S.evaluate(inst, sol, { costOnly: true }).total, ev.total);
    assert.equal(ev.feasible, true);
    return ev;
  };
  // due 335: at B 755 min late -> 45300 (under the cap) x 3/6 = 22650; at A 800 min late -> 48000, capped
  // at 45900, x 3/6 = 22950. Minutes late are reported uncapped.
  let ev = run(335);
  close(ev.cost.lateness, 22650 + 22950);
  close(ev.routes[0].cost.lateness, 45600);
  assert.deepEqual(plain(ev.late), [{ job: 1, minutesLate: 800 }]);
  // far past the deadline: both chunks at the cap -> 45900, still under deferring it (51000)
  ev = run(1135 - 5000);
  close(ev.cost.lateness, 45900);
  assert.ok(ev.cost.lateness < 60000 * 0.85);
  // not late enough to reach the cap: 100 and 145 min late -> (6000 + 8700) x 0.5
  close(run(990).cost.lateness, 7350);
  // lateCapShare from the instance; missing -> 0.9; Infinity -> no cap
  close(run(335, { lateCapShare: 0.5 }).cost.lateness, 12750 + 12750);
  close(run(335, { latePerMin: [2, 6, 60, 600] }).cost.lateness, 45600);
  close(run(335, { lateCapShare: Infinity }).cost.lateness, 22650 + 24000);
  // cap follows custom defer / classFactor
  close(run(335, { defer: [1, 1, 10000, 1], classFactor: [1, 1, 0.5, 1, 1] }).cost.lateness, 0.9 * 5000);
});

test('v2 lateness cap: a load that can only arrive very late is delivered, not deferred (the old values deferred it)', () => {
  const old = { latePerMin: [1, 3, 50, 500], defer: [200, 600, 5000, 50000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6], lateCapShare: Infinity };
  for (const [label, pen, wantDelivered] of [['new defaults', undefined, 6], ['old values, no cap', old, 0]]) {
    const inst = mini((i) => { flat(i); i.jobs[1].deadline = i.startMin - 600; if (pen) i.penalties = pen; });
    const sol = S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(1), maxIters: 5000 });
    const ev = S.evaluate(inst, sol);
    assert.equal(ev.feasible, true);
    assert.equal(ev.delivered[1], wantDelivered, label);
  }
});

// ---- pinned rally points ----------------------------------------------------------------------------
test('v2 pinned: a pinned node some job could use that gets no delivered quantity costs pinUnused (plan-level)', () => {
  const pinB = (edit) => mini((i) => { flat(i); i.params.pinnedRally = [3]; if (edit) edit(i); });
  const check = (inst, sol, want, unused) => {
    const ev = S.evaluate(inst, sol);
    close(ev.cost.pinned, want);
    assert.deepEqual(plain(ev.pinnedUnused), unused);
    assert.equal(ev.stats.pinnedUnused, unused.length);
    // plan-level term: not in any route's cost; route costs + deferral + pinned = total
    const routeSum = ev.routes.reduce((a, r) => { assert.equal('pinned' in r.cost, false); return a + r.cost.total; }, 0);
    close(routeSum + ev.cost.deferral + ev.cost.pinned + 1e7 * ev.violations.length, ev.total);
    assert.equal(S.evaluate(inst, sol, { costOnly: true }).total, ev.total);
    return ev;
  };
  // nothing delivered: B (a candidate of J1) unused -> 2000 on top of deferring everything (70500)
  let ev = check(pinB(), { routes: [] }, 2000, [3]);
  close(ev.total, 70500 + 2000);
  // J1 delivered at B -> 0
  check(pinB(), { routes: [{ vehicle: 1, visits: [visit(3, [1, 6])] }] }, 0, []);
  // J1 delivered at A instead -> B unused -> 2000
  const atA = { routes: [{ vehicle: 1, visits: [visit(1, [1, 6])] }] };
  check(pinB(), atA, 2000, [3]);
  // a visit to B that delivers nothing (zero-quantity chunk) does not count as using it
  check(pinB(), { routes: [{ vehicle: 1, visits: [visit(3, [1, 0]), visit(1, [1, 6])] }] }, 2000, [3]);
  // two pins, one used (A by J0), one not (B)
  check(pinB((i) => { i.params.pinnedRally = [1, 3]; }), { routes: [{ vehicle: 0, visits: [visit(1, [0, 1000])] }] }, 2000, [3]);
  check(pinB((i) => { i.params.pinnedRally = [1, 3]; }), { routes: [] }, 4000, [1, 3]);
  // a pinned node no job can use costs nothing; nor does a pinned node that is also banned, nor a pinned
  // node that is not a rally point (both are instance errors validateInstance reports)
  check(pinB((i) => { i.jobs[1].candidates = i.jobs[1].candidates.filter((c) => c.node !== 3); }), { routes: [] }, 0, []);
  check(pinB((i) => { i.params.bannedRally = [3]; }), { routes: [] }, 0, []);
  assert.ok(S.validateInstance(pinB((i) => { i.params.bannedRally = [3]; })).some((p) => /both pinned and banned/.test(p)));
  check(pinB((i) => { i.params.pinnedRally = [2]; }), { routes: [] }, 0, []);
  assert.ok(S.validateInstance(pinB((i) => { i.params.pinnedRally = [2]; })).some((p) => /not a rally node/.test(p)));
  // custom pinUnused, and pinUnused 0
  check(pinB((i) => { i.penalties = { pinUnused: 500 }; }), atA, 500, [3]);
  check(pinB((i) => { i.penalties = { pinUnused: 0 }; }), atA, 0, [3]);
  // explainDeferred is unaffected by pins
  const withPin = pinB(), noPin = mini(flat);
  const ex1 = S.explainDeferred(withPin, S.evaluate(withPin, atA)), ex2 = S.explainDeferred(noPin, S.evaluate(noPin, atA));
  assert.deepEqual(plain(ex1), plain(ex2));
  assert.equal(ex1.length, 2);
});

test('v2 prepare cache: in-place edits of lateCapShare and pinUnused are seen', () => {
  const inst = mini((i) => { flat(i); i.params.pinnedRally = [3]; i.penalties = {}; i.jobs[1].deadline = 335; });
  const sol = { routes: [{ vehicle: 1, visits: [visit(3, [1, 3]), visit(1, [1, 3])] }] };
  close(S.evaluate(inst, sol).cost.lateness, 45600);
  inst.penalties.lateCapShare = 0.5;
  close(S.evaluate(inst, sol).cost.lateness, 25500);
  const empty = { routes: [] };
  close(S.evaluate(inst, empty).cost.pinned, 2000);
  inst.penalties.pinUnused = 750;
  close(S.evaluate(inst, empty).cost.pinned, 750);
  inst.penalties.pinUnused = NaN;                    // invalid -> default, and the cache stays stable
  close(S.evaluate(inst, empty).cost.pinned, 2000);
  const P = S.prepare(inst);
  assert.equal(S.prepare(inst), P);
});

// ---- what the new defaults are for ---------------------------------------------------------------------
const OLD_VALUES = { latePerMin: [1, 3, 50, 500], defer: [200, 600, 5000, 50000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6], lateCapShare: Infinity, pinUnused: 0 };

// Up to 30 jobs and 8 trucks; each truck type holds 1.5x its load group's demand (no closures, every job
// has a pickup point), so every job fits.
function roomyInstance(seed, penalties) {
  const r = SRO.util.rng(seed * 977 + 1);
  const inst = S.makeTestInstance(seed, { nJobs: 20 + r.int(11), nVehicles: 8, nRally: 4 + r.int(5), nHubs: 1 + r.int(3), fuelShare: 0.35,
    lateAvailableShare: 0.2, maxRallyPoints: 8, closedZones: 0, noCandidateShare: 0, penalties });
  for (const [type, group, step] of [['tanker', 'fuel', 500], ['cargo', 'cargo', 5]]) {
    const vs = inst.vehicles.filter((v) => v.type === type);
    const demand = inst.jobs.filter((j) => j.group === group).reduce((a, j) => a + j.qty, 0);
    const cap = Math.max(type === 'tanker' ? 2500 : 10, Math.ceil(1.5 * demand / vs.length / step) * step);
    vs.forEach((v) => { v.capacity = cap; });
  }
  S.prepare.invalidate(inst);
  return inst;
}

test('v2 defaults: construct + localSearch defers no job on 30 roomy instances (enough trucks)', (t) => {
  let jobs = 0, deferred = 0, late = 0, ms = 0, oldDeferred = 0, oldTiers = [0, 0, 0, 0];
  for (let seed = 1; seed <= 30; seed++) {
    const inst = roomyInstance(seed);
    const t0 = performance.now();
    const sol = S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(seed) });
    ms += performance.now() - t0;
    const ev = S.evaluate(inst, sol);
    assert.equal(ev.feasible, true);
    jobs += inst.jobs.length; deferred += ev.deferred.length; late += ev.late.length;
    // the same instance under the old values (no cap, Routine deferral 200): for comparison only
    const old = roomyInstance(seed, OLD_VALUES);
    const evOld = S.evaluate(old, S.localSearch(old, S.construct(old), { rng: SRO.util.rng(seed) }));
    oldDeferred += evOld.deferred.length;
    evOld.deferred.forEach((d) => oldTiers[old.jobs[d.job].tier]++);
  }
  t.diagnostic(`roomy: ${deferred} of ${jobs} jobs deferred with the new defaults (${late} delivered late), ` +
    `avg ${(ms / 30).toFixed(0)} ms construct + localSearch; the old values deferred ${oldDeferred} ` +
    `(Routine/Priority/Urgent/Immediate ${oldTiers.join('/')})`);
  assert.equal(deferred, 0);
  assert.ok(oldDeferred > 0, 'the old values showed the problem on the same instances');
});

test('v2 defaults: when capacity is short, Routine is deferred before Priority before Urgent before Immediate', (t) => {
  // 16-25 jobs, one tanker (2500 gal) and two cargo trucks (10 pallets); every fuel job 1000 gal, every
  // cargo job 4 pallets (equal sizes, so a job's share is the same unit of load); deadlines 10-25 h out.
  let pairs = 0, violations = 0, deferredJobs = 0, jobs = 0;
  const byTier = [[0, 0], [0, 0], [0, 0], [0, 0]];        // [deferred, total] per tier
  for (let seed = 1; seed <= 30; seed++) {
    const r = SRO.util.rng(seed * 977 + 1);
    const inst = S.makeTestInstance(seed, { nJobs: 16 + r.int(10), nVehicles: 3, tankers: 1, nRally: 4 + r.int(4), nHubs: 1 + r.int(2),
      fuelShare: 0.35, capacity: { tanker: 2500, cargo: 10 }, deadlineMin: 600, deadlineMax: 1500, lateAvailableShare: 0, maxRallyPoints: 8 });
    inst.jobs.forEach((j) => { j.qty = j.group === 'fuel' ? 1000 : 4; });
    S.prepare.invalidate(inst);
    const ev = S.evaluate(inst, S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(seed) }));
    assert.equal(ev.feasible, true);
    const cap = { fuel: 2500, cargo: 20 }, demand = { fuel: 0, cargo: 0 };
    inst.jobs.forEach((j) => { demand[j.group] += j.qty; });
    assert.ok(demand.fuel > cap.fuel || demand.cargo > cap.cargo, 'capacity is short in seed ' + seed);
    inst.jobs.forEach((j, k) => {
      const def = j.qty - ev.delivered[k] > 1e-9;
      byTier[j.tier][1]++; if (def) { byTier[j.tier][0]++; deferredJobs++; }
      jobs++;
    });
    // no (partly) deferred job outranks a job of the same load group that got any delivery
    for (const a of inst.jobs.keys()) for (const b of inst.jobs.keys()) {
      if (inst.jobs[a].group !== inst.jobs[b].group) continue;
      if (!(inst.jobs[a].qty - ev.delivered[a] > 1e-9) || !(ev.delivered[b] > 1e-9)) continue;
      pairs++;
      if (inst.jobs[a].tier > inst.jobs[b].tier) violations++;
    }
  }
  t.diagnostic(`short: ${deferredJobs} of ${jobs} jobs (partly) deferred; deferred/total by tier Routine..Immediate ` +
    `${byTier.map((x) => x[0] + '/' + x[1]).join(', ')}; ${pairs} (deferred, delivered) pairs checked, ${violations} out of tier order`);
  assert.equal(violations, 0);
  assert.ok(pairs > 500);
  // the share of jobs deferred falls with each tier (an Immediate job is deferred only when its trucks
  // are full of Immediate loads, e.g. three 1000-gal Immediate fuel jobs for one 2500-gal tanker)
  const share = byTier.map(([d, n]) => d / n);
  for (let k = 1; k < 4; k++) assert.ok(share[k] < share[k - 1], `tier ${k} deferred share ${share[k]} vs ${share[k - 1]}`);
});

// ---- speed ---------------------------------------------------------------------------------------------
test('v2 speed: evaluate costOnly with FIFO periods on the 20-stop perf benchmark', (t) => {
  const inst = S.makeTestInstance(1, { nJobs: 30, nVehicles: 8, nRally: 8, capacity: { tanker: 7500, cargo: 30 }, deadlineMax: 900, directShare: 0.3 });
  const sol = S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(1) });
  const ev = S.evaluate(inst, sol);
  assert.ok(ev.stats.stops >= 15);
  assert.ok(ev.routes.some((r) => r.legs.some((l) => l.riskFactor !== inst.periods[l.periodIdx].risk)), 'some leg crosses a period boundary');
  const rate = (fn, ms = 300) => { let n = 0; const t0 = performance.now(); while (performance.now() - t0 < ms) { for (let i = 0; i < 200; i++) fn(); n += 200; } return n / ((performance.now() - t0) / 1000); };
  let best = 0;
  for (let k = 0; k < 3; k++) best = Math.max(best, rate(() => S.evaluate(inst, sol, { costOnly: true })));
  t.diagnostic(`evaluate costOnly ${Math.round(best).toLocaleString('en-US')}/s on ${ev.stats.stops} stops, ${ev.stats.trucksUsed} trucks (target above ~300k/s standalone)`);
  // the floor is loose because node --test runs files in parallel; the standalone figure is in the diagnostic
  assert.ok(best > 100000, 'costOnly evaluations per second ' + best);
});
