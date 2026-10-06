// Adversarial review of the 2026-10-06 rule changes in DESIGN.md section 7 (FIFO travel across periods,
// lateness cap, unused pinned rally points, per-field penalty defaults), as implemented in evaluate.js and
// instance.js. Everything here is checked against code written independently of those files:
//   - travel: bisection on the cumulative base-minute function (a different algorithm from the forward
//     stepping in instance.js and in the other test files);
//   - evaluate: a reference evaluator written from the "Evaluation semantics" text.
// Defects this file caught (fixed in instance.js / evaluate.js):
//   1. A departure outside a period table with fractional boundaries could hit an empty segment (the
//      boundary was compared in shifted coordinates but computed in real ones); legGeneral then drove the
//      whole rest of the leg at one speed: up to ~360 min off, and later departures arriving up to 10,929
//      min earlier. 2. A one-period table shorter than a day split the timeline differently for departures
//      before and inside it, so FIFO slipped by an ulp. 3. explainDeferred said "trucks had some room"
//      when the only trucks with room could not reach the job (closed roads). 4. A short or broken
//      penalties array (e.g. latePerMin [1, 2]) was used as-is: it moved the tier clamp, so an Immediate
//      job was charged the Priority deferral, and validateInstance printed a bogus range per job.
//   5. A leg with finite minutes but Infinity risk units (the contract says Infinity = unreachable for all
//      three matrices) gave an Infinity total, or NaN with a zero period risk, reported as feasible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSolver, plain, randomSolution } from './fixtures.mjs';

const SRO = loadSolver();
const S = SRO.solver;
const relClose = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const close = (a, b, msg, tol = 1e-9) => assert.ok(relClose(a, b, tol), `${msg || ''} expected ${b}, got ${a}`);
const visit = (node, ...chunks) => ({ node, jobs: chunks.map(([job, qty]) => ({ job, qty })) });
const bareP = (periods) => S.prepare({ periods, nodes: [], vehicles: [], jobs: [] });

// ---- independent travel reference ------------------------------------------------------------------
// Period at minute t by the contract's convention: inside the table the last period starting at or before
// t (a gap keeps the period before it); outside a table spanning >= 24 h shift by whole days into
// [first, first + 1440) (before) or [last - 1440, last) (after); a shorter table extends its first / last.
function refIdx(periods, t) {
  const first = periods[0].startMin, last = periods[periods.length - 1].endMin;
  let tt = t;
  if (!(tt >= first && tt < last) && last - first >= 1440) {
    if (tt >= last) tt -= 1440 * (Math.floor((tt - last) / 1440) + 1);
    else tt += 1440 * Math.ceil((first - tt) / 1440);
  }
  let idx = 0;
  for (let i = 0; i < periods.length; i++) if (periods[i].startMin <= tt) idx = i;
  return idx;
}
function refCuts(periods, a, b) {
  const first = periods[0].startMin, last = periods[periods.length - 1].endMin, out = new Set();
  const shifts = [0];
  if (last - first >= 1440) for (let k = Math.floor((a - last) / 1440) - 2; k <= Math.ceil((b - first) / 1440) + 2; k++) shifts.push(k * 1440);
  for (const k of shifts) { for (const p of periods) out.add(p.startMin + k); out.add(last + k); }
  return [...out].filter((c) => c > a && c < b).sort((x, y) => x - y);
}
// { arrive, riskFactor } of a leg leaving at t that needs `base` base minutes: the arrival is the u with
// (base minutes covered on [t, u]) = base, found by bisection.
function refLeg(periods, t, base) {
  if (!periods || !periods.length) return { arrive: t + base, riskFactor: 1 };
  if (base === 0) return { arrive: t, riskFactor: periods[refIdx(periods, t)].risk };
  const hiBound = t + base / Math.min(...periods.map((p) => p.speed)) + 1;
  const cuts = refCuts(periods, t, hiBound);
  const pieces = [];                                  // [from, to, speed, risk] over [t, hiBound]
  let cur = t;
  for (const c of cuts.concat([hiBound])) { const p = periods[refIdx(periods, (cur + c) / 2)]; pieces.push([cur, c, p.speed, p.risk]); cur = c; }
  const covered = (u) => {
    let b = 0, rm = 0;
    for (const [x, y, sp, rk] of pieces) { if (x >= u) break; const e = Math.min(y, u); b += (e - x) * sp; rm += (e - x) * rk; }
    return [b, rm];
  };
  let lo = t, hi = hiBound;
  for (let it = 0; it < 200 && hi - lo > 1e-12 * Math.max(1, Math.abs(hi)); it++) { const mid = (lo + hi) / 2; if (covered(mid)[0] >= base) hi = mid; else lo = mid; }
  return { arrive: hi, riskFactor: covered(hi)[1] / (hi - t) };
}

// Random period tables with fractional boundaries: gaps, 1-8 periods, spans shorter than a day or
// several days long (not whole days), speeds 0.1-3, risks 0-3.
function randomTable(rng, wide) {
  const n = 1 + rng.int(7), out = [];
  let t = rng() * 3000 - 1000;
  for (let i = 0; i < n; i++) {
    if (i && rng() < 0.3) t += rng() * 100 + 0.01;
    const len = wide ? rng() * 900 + 150 : rng() * 250 + 0.5;
    out.push({ startMin: t, endMin: t + len, speed: rng() < 0.1 ? 1 : 0.1 + rng() * 2.9, risk: rng() < 0.1 ? 0 : rng() * 3 });
    t += len;
  }
  return out;
}
const f64 = new Float64Array(1), i64 = new BigInt64Array(f64.buffer);
function nextUp(x) { if (x === 0) return Number.MIN_VALUE; f64[0] = x; i64[0] += x > 0 ? 1n : -1n; return f64[0]; }
function nextDown(x) { return -nextUp(-x); }

// ---- 1. travel ----------------------------------------------------------------------------------------
test('review v2: legArrive equals a bisection integrator on fractional tables, incl. departures before / after the table', (t) => {
  // regression: a 57-hour table that is not a whole number of days, departing ~15.5 h before it. The
  // departure maps to the gap after period 0, then periods 1 and 2, then the real table's period 0.
  // The old code hit an empty segment at the first shifted boundary and drove the remaining 999 base
  // minutes at period 0's speed: arrival -570.62 instead of -211.13.
  const reg = [
    { startMin: -572.0279177185148, endMin: -125.0279177185148, speed: 1.1130682243267074, risk: 0.5559734185226262 },
    { startMin: -28.403804501295085, endMin: 579.239179049842, speed: 0.7180958445416763, risk: 0.8353369559627026 },
    { startMin: 700.239179049842, endMin: 1466.239179049842, speed: 0.44327585895080124, risk: 2.120421232189983 },
    { startMin: 1466.239179049842, endMin: 1930.8720514012873, speed: 2.8912891753483563, risk: 1.653747119475156 },
    { startMin: 1930.8720514012873, endMin: 2289.4033216230946, speed: 1.5378580025397242, risk: 0.19407212804071605 },
    { startMin: 2289.4033216230946, endMin: 2838.9919029131906, speed: 2.109952377458103, risk: 0 }];
  const out = new Float64Array(2);
  const a = S.legArrive(bareP(reg), -1505.5811461797857, 1040.672130184248, out);
  const ref = refLeg(reg, -1505.5811461797857, 1040.672130184248);
  close(a, ref.arrive, 'regression arrival', 1e-11); close(a, -211.130213228, 'regression arrival', 1e-10);
  close(out[0], ref.riskFactor, 'regression risk factor', 1e-8);

  const rng = SRO.util.rng(2026100601);
  let n = 0, worst = 0, outside = 0;
  for (let k = 0; k < 160; k++) {
    const periods = randomTable(rng, k % 2 === 0);
    const P = bareP(periods);
    const first = periods[0].startMin, last = periods[periods.length - 1].endMin;
    const bps = periods.flatMap((p) => [p.startMin, p.endMin]);
    for (let q = 0; q < 40; q++) {
      let dep = first - 3 * 1440 + rng() * (last - first + 6 * 1440);
      if (rng() < 0.2) dep = bps[rng.int(bps.length)] + (last - first >= 1440 ? 1440 * (rng.int(7) - 3) : 0);
      const base = rng() < 0.05 ? 0 : rng() * (rng() < 0.5 ? 60 : 2500);
      const got = S.legArrive(P, dep, base, out), r = refLeg(periods, dep, base);
      const err = Math.abs(got - r.arrive) / Math.max(1, Math.abs(r.arrive));
      worst = Math.max(worst, err);
      assert.ok(err < 1e-10, `table ${k} dep ${dep} base ${base}: ${got} vs ${r.arrive}`);
      if (base > 1e-6) assert.ok(Math.abs(out[0] - r.riskFactor) < 1e-7, `risk factor table ${k} dep ${dep}: ${out[0]} vs ${r.riskFactor}`);
      assert.equal(out[1], S.periodIndex(P, dep), 'out[1] is periodIndex at departure');
      // away from boundaries (where shifting rounds), periodIndex is the contract's period
      if (bps.every((b) => Math.abs(((dep - b) % 1440 + 1440) % 1440) > 1e-6 && Math.abs(((dep - b) % 1440 + 1440) % 1440 - 1440) > 1e-6)) {
        assert.equal(S.periodIndex(P, dep), refIdx(periods, dep), `periodIndex table ${k} at ${dep}`);
      }
      if (dep < first || dep >= last) outside++;
      n++;
    }
  }
  t.diagnostic(`${n} legs on 160 fractional tables (${outside} departures outside the table): largest relative gap to the bisection reference ${worst.toExponential(1)}`);
});

test('review v2: FIFO holds to the last bit at every shifted boundary of fractional tables (float-neighbour departures)', (t) => {
  const rng = SRO.util.rng(77);
  const tables = [
    // one period shorter than a day: departing 1 ulp before it used to arrive 1 ulp after departing at its start
    [{ startMin: 659.5892531331629, endMin: 1181.9872607244179, speed: 0.41858899097424, risk: 2.957854913547635 }]
  ];
  for (let k = 0; k < 90; k++) tables.push(randomTable(rng, k % 3 !== 0));
  let checks = 0;
  const out = new Float64Array(2);
  for (const periods of tables) {
    const P = bareP(periods), n = periods.length;
    const deps = [];
    for (const p of periods) for (const x of [p.startMin, p.endMin]) for (let k = -3; k <= 3; k++) {
      const d = x + 1440 * k; deps.push(d);
      let u = d, w = d;
      for (let q = 0; q < 3; q++) { u = nextUp(u); w = nextDown(w); deps.push(u, w); }
    }
    for (let q = 0; q < 60; q++) deps.push(periods[0].startMin - 4000 + rng() * (periods[n - 1].endMin - periods[0].startMin + 8000));
    deps.sort((a, b) => a - b);
    for (const base of [0, 1e-9, 0.37, 7, 61.5, 333.3, 1500, 4000]) {
      let prev = -Infinity, prevDep = null;
      for (const d of deps) {
        const a = S.legArrive(P, d, base, out);
        assert.ok(a >= prev, `FIFO: leave ${prevDep} -> ${prev}, leave ${d} -> ${a} (base ${base}) on ${JSON.stringify(periods)}`);
        assert.ok(base === 0 ? a === d : a > d);
        prev = a; prevDep = d; checks++;
      }
    }
  }
  t.diagnostic(`${checks} departures in sorted order (boundaries shifted by -3..3 days and their 3 float neighbours each side): 0 arrive earlier than the one before`);
});

test('review v2: whole-route FIFO: a truck that becomes available later never arrives anywhere earlier; legTiming equals the legs evaluate reports', () => {
  const rng = SRO.util.rng(31);
  let routes = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const inst = S.makeTestInstance(seed, { nJobs: 6 + seed % 10, nVehicles: 2 + seed % 4, closedZones: seed % 2, startMin: 300 + (seed * 211) % 2000 });
    if (seed % 4 === 1) inst.periods = randomTable(rng, true);
    if (seed % 4 === 2) inst.periods = [];
    if (seed % 3 === 0) inst.vehicles.forEach((v, i) => { if (i % 2) { v.preloaded = true; v.startNode = inst.nodes.length - 1; } });
    S.prepare.invalidate(inst);
    for (let k = 0; k < 4; k++) {
      const sol = randomSolution(SRO, inst, rng, { feasibleTypes: true });
      const ev = S.evaluate(inst, sol);
      for (const r of ev.routes) {
        for (const leg of r.legs) {
          if (leg.unreachable) continue;
          const tm = S.legTiming(inst, leg.depart, leg.from, leg.to);
          assert.equal(tm.arrive, leg.arrive); assert.equal(tm.riskUnits, leg.riskUnits); assert.equal(tm.periodIdx, leg.periodIdx); assert.equal(tm.riskFactor, leg.riskFactor);
        }
      }
      for (const delta of [1e-9, 0.37, 17, 333, 1440 * rng()]) {
        const v = rng.int(inst.vehicles.length), old = inst.vehicles[v].availableAt;
        inst.vehicles[v].availableAt = Math.max(old, inst.startMin) + delta;
        S.prepare.invalidate(inst);
        const ev2 = S.evaluate(inst, sol);
        const a = ev.routes.find((x) => x.vehicle === v), b = ev2.routes.find((x) => x.vehicle === v);
        if (a) {
          routes++;
          a.stops.forEach((s, i) => assert.ok(b.stops[i].arrive >= s.arrive, `seed ${seed} truck ${v} stop ${i}: ${s.arrive} -> ${b.stops[i].arrive} after +${delta}`));
          assert.ok(b.returnAt >= a.returnAt);
          assert.ok(b.cost.lateness >= a.cost.lateness - 1e-9 * Math.max(1, a.cost.lateness));
        }
        inst.vehicles[v].availableAt = old;
        S.prepare.invalidate(inst);
      }
    }
  }
  assert.ok(routes > 300);
});

// ---- 2. evaluate against an independent reference ------------------------------------------------------
const DEF = { latePerMin: [2, 6, 60, 600], defer: [5000, 15000, 60000, 250000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6], lateCapShare: 0.9, pinUnused: 2000 };
function refPenalties(inst) {
  const p = inst.penalties || {};
  const ok = (a, n) => Array.isArray(a) && a.length >= n && a.every((x) => typeof x === 'number' && x >= 0 && x < Infinity);
  return {
    latePerMin: ok(p.latePerMin, 4) ? p.latePerMin : DEF.latePerMin,
    defer: ok(p.defer, 4) ? p.defer : DEF.defer,
    classFactor: ok(p.classFactor, 5) ? p.classFactor : DEF.classFactor,
    lateCapShare: typeof p.lateCapShare === 'number' && p.lateCapShare >= 0 ? p.lateCapShare : DEF.lateCapShare,
    pinUnused: typeof p.pinUnused === 'number' && p.pinUnused >= 0 && p.pinUnused < Infinity ? p.pinUnused : DEF.pinUnused
  };
}
function refEvaluate(inst, sol) {
  const pen = refPenalties(inst), w = inst.weights, pa = inst.params, nodes = inst.nodes, nN = nodes.length;
  const banned = new Set(pa.bannedRally || []);
  const candOf = (j, n) => banned.has(n) ? null : (inst.jobs[j].candidates || []).find((c) => c && c.node === n) || null;
  const okIdx = (x, n) => Number.isInteger(x) && x >= 0 && x < n;
  let nViol = 0, miles = 0, risk = 0, stops = 0, trucks = 0, lateness = 0, stability = 0;
  const delivered = inst.jobs.map(() => 0), lateMax = inst.jobs.map(() => 0), pairs = new Map(), rally = new Set(), used = new Set(), gotQty = new Set();
  const chunksOf = inst.jobs.map(() => 0);
  for (const r of (sol && sol.routes) || []) {
    if (!r || !r.visits || !r.visits.length) continue;
    if (!okIdx(r.vehicle, inst.vehicles.length)) { nViol++; continue; }
    if (used.has(r.vehicle)) nViol++;
    used.add(r.vehicle); trucks++;
    const veh = inst.vehicles[r.vehicle];
    let t = Math.max(inst.startMin, veh.availableAt ?? inst.startMin) + (veh.preloaded ? 0 : pa.loadMin);
    let cur = veh.startNode ?? veh.hubNode, load = 0;
    const travel = (a, b) => {
      // "Infinity if unreachable" holds for all three matrices
      if (!(inst.minutes[a][b] < Infinity) || !(inst.miles[a][b] < Infinity) || !(inst.riskUnits[a][b] < Infinity)) { nViol++; return t; }
      const lg = refLeg(inst.periods, t, inst.minutes[a][b]);
      miles += inst.miles[a][b]; risk += inst.riskUnits[a][b] * lg.riskFactor;
      return lg.arrive;
    };
    for (const vi of r.visits) {
      if (!vi || !okIdx(vi.node, nN)) { nViol++; continue; }
      const arrive = travel(cur, vi.node);
      stops++;
      if (nodes[vi.node].kind === 'rally' && !nodes[vi.node].rallyDone) rally.add(vi.node);
      for (const ch of vi.jobs || []) {
        if (!ch || !okIdx(ch.job, inst.jobs.length)) { nViol++; continue; }
        const q = ch.qty;
        if (typeof q !== 'number' || !(q >= 0) || q === Infinity) { nViol++; continue; }
        const job = inst.jobs[ch.job];
        if ((job.group === 'fuel') !== (veh.type === 'tanker')) nViol++;
        // a preloaded (en-route) truck carries only the jobs locked to it (contract of 2026-10-06)
        if (job.lockedTruck != null ? job.lockedTruck !== veh.id : !!veh.preloaded) nViol++;
        const c = candOf(ch.job, vi.node);
        if (!c) nViol++;
        else if (q > 0) { const key = (job.requestId != null ? String(job.requestId) : '#' + ch.job) + '|' + vi.node; if (!pairs.has(key)) pairs.set(key, c.platoonCost || 0); }
        load += q; delivered[ch.job] += q;
        if (q > 0) {
          gotQty.add(vi.node);
          chunksOf[ch.job]++;
          const late = arrive - job.deadline;
          // ETA slip (contract of 2026-10-06): lateness + slip share the lateness cap; lateness first
          const slip = typeof job.prevEta === 'number' && job.slipPerMin > 0 ? arrive - job.prevEta : 0;
          if (late > 0 || slip > 0) {
            const dw = pen.defer[job.tier] * pen.classFactor[job.classRank];
            const cap = pen.lateCapShare === Infinity ? Infinity : pen.lateCapShare * dw;
            const lp = late > 0 ? late * pen.latePerMin[job.tier] : 0;
            lateness += Math.min(lp, cap) * q / job.qty;
            stability += (Math.min(lp + (slip > 0 ? slip * job.slipPerMin : 0), cap) - Math.min(lp, cap)) * q / job.qty;
            if (late > 0) lateMax[ch.job] = Math.max(lateMax[ch.job], late);
          }
        }
      }
      t = arrive + pa.serviceMin; cur = vi.node;
    }
    travel(cur, veh.hubNode);
    if (load > veh.capacity + 1e-9 * Math.max(1, veh.capacity)) nViol++;
  }
  let deferral = 0;
  inst.jobs.forEach((job, j) => {
    const d = job.qty - delivered[j], eps = 1e-9 * Math.max(1, job.qty);
    if (d > eps) deferral += d / job.qty * pen.defer[job.tier] * pen.classFactor[job.classRank];
    else if (d < -eps) nViol++;
  });
  if (pa.maxRallyPoints != null && rally.size > pa.maxRallyPoints) nViol++;
  const pinnedUnused = [...new Set(pa.pinnedRally || [])].filter((n) => okIdx(n, nN) && nodes[n].kind === 'rally' && !nodes[n].rallyDone &&
    inst.jobs.some((_, j) => candOf(j, n)) && !gotQty.has(n)).sort((a, b) => a - b);
  let platoon = 0;
  for (const c of pairs.values()) platoon += c;
  const cost = {
    // a split job: 3 x wS per positive chunk after its first (small-share fix of 2026-10-06)
    fuel: w.fuel * miles / pa.mpg, distance: w.distance * 0.5 * miles, risk: w.risk * risk,
    simplicity: w.simplicity * (5 * stops + 25 * trucks + 3 * chunksOf.reduce((a, k) => a + Math.max(0, k - 1), 0)),
    platoon: w.distance * platoon, lateness, stability, deferral, pinned: pen.pinUnused * pinnedUnused.length
  };
  const late = lateMax.map((m, job) => ({ job, minutesLate: m })).filter((x) => x.minutesLate > 0);
  return { total: Object.values(cost).reduce((a, b) => a + b, 0) + 1e7 * nViol, nViol, cost, pinnedUnused, late, delivered };
}

// Adversarial instance: caps that bind (deadlines up to 15 h before the start), partial / custom / malformed
// penalties, several pins (a duplicate, one on a hub, one out of range, maybe one nobody can use), banned
// points, closures, locks, preloaded en-route trucks, fractional or missing period tables.
function adversarial(seed, rng) {
  const inst = S.makeTestInstance(seed, {
    nJobs: 4 + seed % 14, nVehicles: 2 + seed % 5, nRally: 3 + seed % 5, closedZones: seed % 3, locked: seed % 3, pinned: 1 + seed % 3,
    banned: seed % 2, startMin: 200 + (seed * 131) % 2500, deadlineMin: -900, deadlineMax: 400, lateAvailableShare: 0.5,
    tierWeights: [0.25, 0.25, 0.25, 0.25]
  });
  const pens = [undefined, { lateCapShare: 0.37 }, { lateCapShare: Infinity, pinUnused: 777, defer: [100, 2000, 9000, 40000] },
    { latePerMin: [5, 50, 500, 5000], lateCapShare: 0, classFactor: [1, 1, 1, 1, 0.5] }, { latePerMin: [1, 2], pinUnused: NaN, lateCapShare: -1, defer: [] },
    { pinUnused: 0 }, { lateCapShare: 0.9, latePerMin: [2, 6, 60, 600], defer: [5000, 15000, 60000, 250000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6], pinUnused: 2000 }];
  const pick = pens[seed % pens.length];
  if (pick === undefined) delete inst.penalties; else inst.penalties = pick;
  const pins = inst.params.pinnedRally;
  if (pins.length) pins.push(pins[0]);                 // duplicate
  pins.push(0, 999);                                   // a hub (not a rally node) and an index out of range
  if (seed % 4 === 2) inst.periods = randomTable(rng, true);
  if (seed % 4 === 3) inst.periods = seed % 8 === 3 ? [] : randomTable(rng, false);
  if (seed % 3 === 0) inst.vehicles.forEach((v, i) => { if (i % 2) { v.preloaded = true; v.startNode = inst.nodes.length - 1 - i; } });
  // re-plan ETAs (prevEta, slipPerMin) on most jobs of every other instance (own rng: the plans drawn
  // from the shared one stay the same)
  if (seed % 2 === 1) {
    const er = SRO.util.rng(seed * 13 + 1);
    inst.jobs.forEach((j) => { if (er() < 0.7) { j.prevEta = inst.startMin - 120 + er() * 600; j.slipPerMin = er() < 0.2 ? 0 : er() * (seed % 4 === 1 ? 500 : 5); } });
  }
  S.prepare.invalidate(inst);
  return inst;
}

test('review v2: evaluate equals an independent reference evaluator on 1,200 adversarial plans (caps, pins, penalties, periods)', (t) => {
  const rng = SRO.util.rng(4711);
  let compared = 0, capped = 0, pinCharged = 0, infeasible = 0, slipped = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const inst = adversarial(seed, rng);
    const P = S.prepare(inst);
    for (let k = 0; k < 8; k++) {
      const sol = k === 0 ? S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(seed), maxIters: 200 }) : randomSolution(SRO, inst, rng, { feasibleTypes: k % 2 === 0 });
      if (k > 0 && rng() < 0.2) sol.routes.push({ vehicle: sol.routes[0].vehicle, visits: sol.routes[0].visits.slice(0, 1) });
      if (k > 0 && rng() < 0.2 && sol.routes[0].visits.length) sol.routes[0].visits[0].jobs.push({ job: 0, qty: 0 });
      if (k > 0 && rng() < 0.1) sol.routes[0].visits.push({ node: 0, jobs: [] });
      const ev = S.evaluate(inst, sol), ref = refEvaluate(inst, sol);
      const msg = `seed ${seed}/${k}`;
      for (const key of Object.keys(ref.cost)) assert.ok(relClose(ev.cost[key], ref.cost[key], 1e-8) || Math.abs(ev.cost[key] - ref.cost[key]) < 1e-6, `${msg} ${key}: ${ev.cost[key]} vs ${ref.cost[key]}`);
      assert.ok(relClose(ev.total, ref.total, 1e-9), `${msg} total ${ev.total} vs ${ref.total}`);
      assert.equal(ev.violations.length, ref.nViol, `${msg} violations ${JSON.stringify(plain(ev.violations.map((v) => v.code)))}`);
      assert.deepEqual(plain(ev.pinnedUnused).sort((a, b) => a - b), ref.pinnedUnused, msg);
      assert.equal(ev.stats.pinnedUnused, ref.pinnedUnused.length);
      assert.deepEqual(ev.late.map((x) => x.job), ref.late.map((x) => x.job), msg);
      // (the bisection reference is exact to ~1e-12 x the clock minute, so compare absolute minutes)
      ev.late.forEach((x, i) => assert.ok(Math.abs(x.minutesLate - ref.late[i].minutesLate) < 1e-7, `${msg} minutes late ${x.minutesLate} vs ${ref.late[i].minutesLate}`));
      ev.delivered.forEach((d, j) => close(d, ref.delivered[j], msg));
      // route costs + plan-level deferral and pinned + violations = total; costOnly is the same number
      const routeSum = ev.routes.reduce((a, r) => a + r.cost.total, 0);
      assert.ok(relClose(routeSum + ev.cost.deferral + ev.cost.pinned + 1e7 * ev.violations.length, ev.total, 1e-12));
      assert.equal(S.evaluate(inst, sol, { costOnly: true }).total, ev.total);
      // the lateness cap: never more than lateCapShare x the deferral cost of what was delivered
      const pen = refPenalties(inst);
      if (pen.lateCapShare < Infinity) {
        const bound = inst.jobs.reduce((a, job, j) => a + pen.lateCapShare * P.jDeferW[j] * ev.delivered[j] / job.qty, 0);
        assert.ok(ev.cost.lateness <= bound * (1 + 1e-12) + 1e-9, `${msg} lateness ${ev.cost.lateness} over the cap bound ${bound}`);
        assert.ok(ev.cost.lateness + ev.cost.stability <= bound * (1 + 1e-12) + 1e-9, `${msg} lateness + ETA slip over the cap bound ${bound}`);
        if (ev.cost.lateness > 0 && ev.late.some((x) => x.minutesLate * P.jLateW[x.job] > P.jLateCap[x.job])) capped++;
      }
      if (ev.cost.pinned > 0) pinCharged++;
      if (ev.cost.stability > 0) slipped++;
      if (!ev.feasible) infeasible++;
      compared++;
    }
  }
  t.diagnostic(`${compared} plans: ${capped} with a capped lateness, ${pinCharged} charged for an unused pin, ${infeasible} with violations, ${slipped} with an ETA slip cost`);
  assert.ok(capped > 100 && pinCharged > 100 && infeasible > 100 && compared - infeasible > 100 && slipped > 100);
});

// ---- 3. rule edge cases ---------------------------------------------------------------------------------
function sym(n, pairs) {
  const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)));
  for (const [a, b, x] of pairs) { m[a][b] = x; m[b][a] = x; }
  return m;
}
// nodes 0 hub H0, 1 rally A, 2 rally B, 3 hub H1. H1 is cut off from A and B (closed roads).
// V0 cargo 4 pallets at H0, V1 cargo 10 pallets at H1. J0 / J1: 4 pallets each, candidates A, B.
function closedHub(edit) {
  const inst = {
    startMin: 360,
    nodes: [{ key: 'hub:H0', kind: 'hub' }, { key: 'rally:A', kind: 'rally' }, { key: 'rally:B', kind: 'rally' }, { key: 'hub:H1', kind: 'hub' }],
    minutes: sym(4, [[0, 1, 30], [0, 2, 40], [1, 2, 20], [0, 3, 90]]),
    miles: sym(4, [[0, 1, 15], [0, 2, 20], [1, 2, 10], [0, 3, 45]]),
    riskUnits: sym(4, [[0, 1, 0], [0, 2, 0], [1, 2, 0], [0, 3, 0]]),
    gridPaths: {}, periods: [],
    vehicles: [{ id: 'V0', type: 'cargo', capacity: 4, hubNode: 0, availableAt: 0 }, { id: 'V1', type: 'cargo', capacity: 10, hubNode: 3, availableAt: 0 }],
    jobs: [0, 1].map((j) => ({ id: 'J' + j, requestId: 'R' + j, group: 'cargo', qty: 4, unit: 'pallet', tier: j, classRank: 0, deadline: 1000, hardDeadline: false,
      candidates: [{ node: 1, platoonMiles: 1, platoonCost: 1 }, { node: 2, platoonMiles: 1, platoonCost: 1 }], lockedTruck: null })),
    weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },
    params: { mpg: 2, serviceMin: 15, loadMin: 20, maxRallyPoints: 8, pinnedRally: [], bannedRally: [] },
    fixed: null
  };
  if (edit) edit(inst);
  return inst;
}

test('review v2: explainDeferred counts room only on trucks that can reach the job (an empty truck behind a closed road is no help)', () => {
  const inst = closedHub();
  assert.deepEqual(plain(S.validateInstance(inst)), []);
  const sol = { routes: [{ vehicle: 0, visits: [visit(1, [1, 4])] }] };   // V0 full with J1; J0 deferred
  let ex = S.explainDeferred(inst, S.evaluate(inst, sol));
  assert.equal(ex.length, 1);
  assert.equal(ex[0].reason, 'capacity');
  assert.equal(ex[0].detail, 'trucks-full', 'V1 has 10 pallets free but cannot reach A or B: ' + ex[0].note);
  assert.match(ex[0].note, /4 of 4/);
  // open the road H1 - A: now V1's room counts, so the deferral was a cost choice
  const open = closedHub((i) => { i.minutes[3][1] = i.minutes[1][3] = 60; i.miles[3][1] = i.miles[1][3] = 30; i.riskUnits[3][1] = i.riskUnits[1][3] = 0; });
  ex = S.explainDeferred(open, S.evaluate(open, sol));
  assert.equal(ex[0].reason, 'capacity'); assert.equal(ex[0].detail, 'cost');
  // and the solver delivers both once it can
  const best = S.evaluate(open, S.localSearch(open, S.construct(open), { rng: SRO.util.rng(1) }));
  assert.equal(best.deferred.length, 0);
  // a road with finite minutes and miles but Infinity risk units is unreachable too ("Infinity if
  // unreachable" holds for all three matrices); it used to give an Infinity total, or NaN when the
  // period risk is 0 (Infinity x 0), and NaN breaks every comparison a method makes
  const half = closedHub((i) => { i.minutes[3][1] = i.minutes[1][3] = 60; i.miles[3][1] = i.miles[1][3] = 30; i.periods = [{ startMin: 0, endMin: 5000, speed: 1, risk: 0 }]; });
  const viaH1 = { routes: [{ vehicle: 1, visits: [visit(1, [0, 4])] }] };
  const ev = S.evaluate(half, viaH1);
  assert.ok(Number.isFinite(ev.total));
  assert.deepEqual(plain(ev.violations.map((v) => v.code)), ['unreachable', 'unreachable']);
  assert.equal(S.evaluate(half, viaH1, { costOnly: true }).total, ev.total);
  assert.equal(S.legTiming(half, 400, 3, 1).arrive, Infinity);
  assert.equal(S.explainDeferred(half, S.evaluate(half, { routes: [] })).length, 2);
});

test('review v2: pins: duplicates count once; pins on a hub, out of range or that no job can use cost nothing (validateInstance reports the bad ones)', () => {
  const base = closedHub();
  const empty = { routes: [] };
  const pinned = (pins) => closedHub((i) => { i.params.pinnedRally = pins; });
  // nothing delivered: A and B are candidates of both jobs
  let ev = S.evaluate(pinned([1, 1, 2]), empty);
  assert.deepEqual(plain(ev.pinnedUnused), [1, 2]); assert.equal(ev.cost.pinned, 4000);
  assert.equal(ev.total, S.evaluate(base, empty).total + 4000);
  ev = S.evaluate(pinned([0, 3, 999, -1, 1.5]), empty);
  assert.equal(ev.cost.pinned, 0);
  const problems = S.validateInstance(pinned([0, 999]));
  assert.equal(problems.filter((p) => /is not a rally node/.test(p)).length, 2);
  // a pin used by one job is used, whatever the other jobs do; the pin does not count as a rally point
  // until something is delivered there
  ev = S.evaluate(pinned([1, 2]), { routes: [{ vehicle: 0, visits: [visit(1, [0, 4])] }] });
  assert.deepEqual(plain(ev.pinnedUnused), [2]); assert.deepEqual(plain(ev.rallyNodes), [1]);
  // a delivery at the pin by a job that may not use it is a violation; the pin itself still received a load
  const noB = closedHub((i) => { i.params.pinnedRally = [2]; i.jobs[0].candidates = i.jobs[0].candidates.filter((c) => c.node !== 2); });
  ev = S.evaluate(noB, { routes: [{ vehicle: 0, visits: [visit(2, [0, 4])] }] });
  assert.deepEqual(plain(ev.violations.map((v) => v.code)), ['not-candidate']);
  assert.equal(ev.cost.pinned, 0);
  // with a pin, the solver delivers through the pinned point when that costs less than 2000 extra
  const pin = closedHub((i) => { i.params.pinnedRally = [2]; i.vehicles[0].capacity = 8; });
  const sol = S.localSearch(pin, S.construct(pin), { rng: SRO.util.rng(2) });
  ev = S.evaluate(pin, sol);
  assert.equal(ev.cost.pinned, 0, JSON.stringify(plain(sol)));
  assert.deepEqual(plain(ev.rallyNodes), [2]);
});

test('review v2: lateCapShare 0 removes the lateness cost but still reports late and hard-late jobs; the cap scales with the chunk share', () => {
  // J0 Routine due 0 (hours ago), J1 Priority hard deadline due 0. V1 is reachable here (open road).
  const mk = (pen) => closedHub((i) => {
    i.vehicles[0].capacity = 8; i.jobs[0].deadline = 0; i.jobs[1].deadline = 0; i.jobs[1].hardDeadline = true;
    if (pen) i.penalties = pen;
  });
  const sol = { routes: [{ vehicle: 0, visits: [visit(1, [0, 1], [1, 4]), visit(2, [0, 3])] }] };
  // t0 = 380; A at 410 (410 min late), B at 410 + 15 + 20 = 445
  let ev = S.evaluate(mk({ lateCapShare: 0 }), sol);
  assert.equal(ev.cost.lateness, 0);
  assert.deepEqual(plain(ev.late), [{ job: 0, minutesLate: 445 }, { job: 1, minutesLate: 410 }]);
  assert.deepEqual(plain(ev.hardLate), [1]);
  // defaults: J0 cap 0.9 x 5000 = 4500; chunk 1/4 at 410 min x 2 = 820 (under the cap) -> 205; chunk 3/4 at
  // 445 x 2 = 890 -> 667.5. J1 cap 0.9 x 15000 x 1 = 13500; 410 x 6 = 2460 -> 2460.
  ev = S.evaluate(mk(), sol);
  close(ev.cost.lateness, 205 + 667.5 + 2460);
  // latePerMin x100: J0 chunks hit the cap 4500 -> 1125 + 3375; J1 41000 capped at 13500
  ev = S.evaluate(mk({ latePerMin: [200, 600, 6000, 60000] }), sol);
  close(ev.cost.lateness, 4500 + 13500);
  // whatever the lateness, delivering costs less in penalties than deferring (0.9 x deferral)
  const deferAll = S.evaluate(mk({ latePerMin: [200, 600, 6000, 60000] }), { routes: [] }).cost.deferral;
  close(deferAll, 5000 + 15000);
  assert.ok(ev.cost.lateness <= 0.9 * deferAll + 1e-9);
});

test('review v2: a short or broken penalties array falls back to its default (no tier shift), and validateInstance reports it once', () => {
  const inst = S.makeTestInstance(3, { nJobs: 8, tierWeights: [0.25, 0.25, 0.25, 0.25] });
  const tiers = new Set(inst.jobs.map((j) => j.tier));
  assert.ok(tiers.has(3) && tiers.has(2), 'instance has Urgent and Immediate jobs');
  const withPen = (pen) => { const x = S.makeTestInstance(3, { nJobs: 8, tierWeights: [0.25, 0.25, 0.25, 0.25] }); x.penalties = pen; return x; };
  const ref = S.evaluate(withPen({}), { routes: [] }).total;
  for (const pen of [{ latePerMin: [1, 2] }, { latePerMin: [] }, { defer: [1, 2, 3] }, { defer: [1, 2, 3, 'x'] }, { classFactor: [1, 1] },
    { classFactor: [1, 1, 1, 1, -1] }, { defer: [1, 2, 3, Infinity] }, { latePerMin: 'fast' }]) {
    const x = withPen(pen);
    assert.equal(S.evaluate(x, { routes: [] }).total, ref, JSON.stringify(pen));
    assert.deepEqual(plain(S.resolvePenalties(x)), plain(S.resolvePenalties(withPen({}))));
    const probs = S.validateInstance(x);
    assert.equal(probs.length, 1, JSON.stringify(pen) + ' -> ' + JSON.stringify(plain(probs)));
    assert.match(probs[0], /^penalties\./);
  }
  // a longer sound array is used as given
  const long = withPen({ defer: [1, 2, 3, 4, 5] });
  assert.deepEqual(plain(S.validateInstance(long)), []);
  assert.ok(S.evaluate(long, { routes: [] }).total < 100);
});

// ---- 4. the new defaults on harder instances ------------------------------------------------------------
// Roomy fleet (each truck type holds 1.5x its group's demand) plus closures, locks, pins, bans, preloaded
// en-route trucks, Immediate-heavy tiers and tight deadlines. Every deferral construct + localSearch leaves
// must have a reason other than "trucks had room": no single insertion of the deferred quantity (any
// compatible truck, any position, any allowed point) gives a feasible, cheaper plan.
function roomyHard(seed, variant) {
  const r = SRO.util.rng(seed * 977 + 1);
  const extra = [{ closedZones: 2 }, { locked: 4, pinned: 2, banned: 1 }, { tierWeights: [0.1, 0.1, 0.3, 0.5], deadlineMin: 30, deadlineMax: 240, closedZones: 1, pinned: 1 }][variant];
  const inst = S.makeTestInstance(seed, Object.assign({ nJobs: 20 + r.int(11), nVehicles: 8, nRally: 4 + r.int(5), nHubs: 1 + r.int(3), fuelShare: 0.35,
    lateAvailableShare: 0.2, maxRallyPoints: 8 }, extra));
  for (const [type, group, step] of [['tanker', 'fuel', 500], ['cargo', 'cargo', 5]]) {
    const vs = inst.vehicles.filter((v) => v.type === type);
    const demand = inst.jobs.filter((j) => j.group === group).reduce((a, j) => a + j.qty, 0);
    const cap = Math.max(type === 'tanker' ? 2500 : 10, Math.ceil(1.5 * demand / vs.length / step) * step);
    vs.forEach((v) => { v.capacity = cap; });
  }
  if (variant !== 2) inst.vehicles.forEach((v, i) => { if (i % 3 === 1) { v.preloaded = true; v.startNode = inst.nodes.length - 1 - i; } });
  S.prepare.invalidate(inst);
  return inst;
}

test('review v2: new defaults on harder roomy instances (closures, locks, pins, bans, preloaded trucks, Immediate-heavy, tight deadlines): no deferral a single insertion would improve', (t) => {
  const reasons = {};
  let jobs = 0, deferred = 0, late = 0, pinsUnused = 0, checked = 0;
  for (let variant = 0; variant < 3; variant++) {
    for (let seed = 1; seed <= 10; seed++) {
      const inst = roomyHard(seed, variant);
      const sol = S.localSearch(inst, S.construct(inst), { rng: SRO.util.rng(seed) });
      const ev = S.evaluate(inst, sol);
      assert.equal(ev.feasible, true);
      jobs += inst.jobs.length; deferred += ev.deferred.length; late += ev.late.length; pinsUnused += ev.pinnedUnused.length;
      for (const x of S.explainDeferred(inst, ev)) {
        const key = x.reason + '/' + x.detail;
        reasons[key] = (reasons[key] || 0) + 1;
        for (const v of S.compatibleVehicles(inst, x.job)) {
          const ri = sol.routes.findIndex((rt) => rt.vehicle === v);
          for (const n of S.candidateNodes(inst, x.job)) {
            for (let pos = 0; pos <= sol.routes[ri].visits.length; pos++) {
              const cand = S.cloneSolution(sol);
              cand.routes[ri].visits.splice(pos, 0, { node: n, jobs: [{ job: x.job, qty: x.qty }] });
              const e = S.evaluate(inst, cand, { costOnly: true });
              checked++;
              assert.ok(!(e.feasible && e.total < ev.total - 1e-6), `variant ${variant} seed ${seed}: deferring job ${x.job} (${key}) costs ${(e.total - ev.total).toFixed(1)} more than inserting it on truck ${v} at ${n}`);
            }
          }
        }
      }
    }
  }
  // ('capacity/cost' deferrals do occur: e.g. the last 50 gal of a split job whose only open road runs
  // through a high-risk zone; the insertion check above shows each one is cheaper than delivering it)
  t.diagnostic(`hard roomy: ${deferred} of ${jobs} jobs deferred ${JSON.stringify(reasons)}; ${late} delivered late; ${pinsUnused} pinned points unused; ${checked} single insertions checked, none cheaper`);
});
