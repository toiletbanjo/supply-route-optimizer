// Schedule simulation and cost breakdown: the single source of truth for cost (DESIGN.md section 7,
// "Evaluation semantics" and "Cost", including the rule changes of 2026-10-06). Every method scores
// with SRO.solver.evaluate.
//
//   evaluate(instance, solution)                     -> full result (schedule, costs, violations)
//   evaluate(instance, solution, { costOnly: true }) -> { total, feasible, nViolations } (hot path,
//                                                       no per-call allocation beyond that object)
//   totalCost(instance, solution)                    -> the same total as a plain number
//   explainDeferred(instance, evalResult)            -> reason per deferred job
//
// Rules implemented exactly as the contract states:
//   start    t0 = max(startMin, availableAt) + (preloaded ? 0 : loadMin), from startNode (default hubNode),
//            visits in order, then back to hubNode.
//   legs     FIFO travel (SRO.solver.legArrive in instance.js): the leg needs minutes[i][j] base minutes
//            and in each time-of-day period the truck covers base minutes at period.speed per clock
//            minute, so leaving later never arrives earlier. Leg risk = riskUnits[i][j] x the
//            time-weighted mean period.risk over the leg's clock minutes. No periods: speed 1, risk 1.
//            Miles and risk are counted on every leg incl. the return. An unreachable leg (minutes,
//            miles or risk units Infinity: the contract's "Infinity if unreachable" holds for all three
//            matrices, and Infinity risk units would otherwise give an Infinity or NaN total) is a
//            violation; it is then counted as 0 minutes / 0 miles / 0 risk so totals stay finite and
//            comparable.
//   stops    arrival = delivery time for every chunk there; each stop adds serviceMin; no waiting.
//            Every visit is a stop, even an empty one (moves never create empty visits).
//   costs    fuel = wF x miles/mpg; distance = wD x 0.5 x miles; risk = wR x factored risk units;
//            simplicity = wS x (5 x stops + 25 x trucks used); platoon = wD x platoonCost once per
//            distinct (requestId, node) that receives a positive quantity (a zero-quantity chunk
//            brings no platoon to the node); lateness per chunk = min(max(0, arrive - deadline) x
//            latePerMin[tier], lateCapShare x defer[tier] x classFactor[classRank]) x qty/job.qty;
//            deferral per job = deferred/job.qty x defer[tier] x classFactor[classRank]; pinned =
//            pinUnused per pinned rally node that is a candidate of some job but receives no positive
//            quantity; total = sum + 1e7 per violation. Missing penalties fields use DEFAULT_PENALTIES.
//
// Full result notes: cost = { fuel, distance, risk, simplicity, platoon, lateness, deferral, pinned };
// routes lists only routes with stops (routeIdx = index in solution.routes; extra fields vehicleId,
// loadStart, load, capacity) and route.cost has the per-route terms only (fuel, distance, risk,
// simplicity, platoon, lateness, total): deferral and pinned are plan-level, route-independent terms.
// pinnedUnused lists the pinned nodes charged. stop.periodIdx is the period of the arrival minute,
// leg.periodIdx the period of the departure minute (display only); leg.riskUnits already includes
// the mean period factor, leg.riskFactor is that factor. late has one entry per job (its largest
// lateness over its chunks; lateness minutes are not capped, only their cost); stats = { miles,
// gallons, riskUnits, stops, trucksUsed, rallyPoints, pinnedUnused }.
//
// Violation codes: wrong-type, over-capacity, not-candidate (incl. banned rally nodes), too-many-rally,
// unreachable, vehicle-reused (a vehicle in more than one route that has stops), locked-truck, over-qty,
// plus bad-index / bad-qty for malformed solutions (index out of range; qty negative, non-finite or not
// a number). Quantities use a relative tolerance of 1e-9 (capacity, over-qty, deferred remainder).
// hardLate lists late jobs whose deadline is hard: every Immediate (tier 3) job, plus any job with
// hardDeadline: true (urgency.js sets it for Urgent too).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};
  // Local aliases: global lookups are slow inside Node vm contexts (tests) and cost nothing here.
  const INF = Infinity, mmax = Math.max;
  const F64 = Float64Array;

  const V = S.VIOLATION_CODES = {
    WRONG_TYPE: 'wrong-type', OVER_CAPACITY: 'over-capacity', NOT_CANDIDATE: 'not-candidate',
    TOO_MANY_RALLY: 'too-many-rally', UNREACHABLE: 'unreachable', VEHICLE_REUSED: 'vehicle-reused',
    LOCKED_TRUCK: 'locked-truck', OVER_QTY: 'over-qty', BAD_INDEX: 'bad-index', BAD_QTY: 'bad-qty'
  };
  const EMPTY = [];

  function vehName(inst, v) { const x = inst.vehicles[v]; return x && x.id != null ? String(x.id) : 'vehicle ' + v; }
  function jobName(inst, j) { const x = inst.jobs[j]; return x && x.id != null ? String(x.id) : 'job ' + j; }
  function nodeName(inst, n) { const x = inst.nodes[n]; return x && (x.label || x.key) ? String(x.label || x.key) : 'node ' + n; }

  // Core simulation. `full` builds the detailed result; otherwise only totals are tracked.
  function run(inst, sol, full) {
    const P = S.prepare(inst);
    const nN = P.nN, nV = P.nV, nJ = P.nJ;
    let epoch = P.epoch + 1;
    if (epoch > 2000000000) { P.vehStamp.fill(0); P.rallyStamp.fill(0); P.pairStamp.fill(0); P.nodeStamp.fill(0); epoch = 1; }
    P.epoch = epoch;
    const delivered = P.delivered; delivered.fill(0);
    const M = P.minutes, MI = P.miles, RK = P.risk;
    const vehStamp = P.vehStamp, rallyStamp = P.rallyStamp, pairStamp = P.pairStamp, nodeStamp = P.nodeStamp, isRally = P.isRally;
    const jFuel = P.jFuel, jLockV = P.jLockV, cand = P.cand, candCost = P.candCost, jReq = P.jReq;
    const jDeadline = P.jDeadline, jLateW = P.jLateW, jLateCap = P.jLateCap, jInvQty = P.jInvQty;
    const serviceMin = P.serviceMin;
    const hasPeriods = P.nP > 0, legArrive = S.legArrive, legOut = P.legOut;

    let nViol = 0;
    const violations = full ? [] : null;
    let miles = 0, risk = 0, nStops = 0, nTrucks = 0, platoon = 0, lateness = 0, nRally = 0;
    const routesOut = full ? [] : null;
    const lateMax = full ? new F64(nJ) : null;
    const routes = (sol && sol.routes) || EMPTY;

    for (let r = 0; r < routes.length; r++) {
      const route = routes[r];
      const visits = route ? route.visits : null;
      if (!visits || visits.length === 0) continue;
      const v = route.vehicle;
      if (!(v >= 0 && v < nV) || (v | 0) !== v) {
        nViol++;
        if (full) violations.push({ code: V.BAD_INDEX, route: r, detail: 'Route ' + r + ' names vehicle ' + v + ', which does not exist.' });
        continue;
      }
      if (vehStamp[v] === epoch) {
        nViol++;
        if (full) violations.push({ code: V.VEHICLE_REUSED, route: r, vehicle: v, detail: 'Truck ' + vehName(inst, v) + ' is given more than one trip.' });
      }
      vehStamp[v] = epoch;
      nTrucks++;
      const fuelV = P.vFuel[v];
      const t0 = P.vT0[v];
      let t = t0, cur = P.vStart[v], load = 0, rMiles = 0, rRisk = 0, rPlatoon = 0, rLate = 0, rStops = 0;
      const stopsOut = full ? [] : null, legsOut = full ? [] : null;

      for (let s = 0; s < visits.length; s++) {
        const visit = visits[s];
        const node = visit ? visit.node : -1;
        if (!(node >= 0 && node < nN) || (node | 0) !== node) {
          nViol++;
          if (full) violations.push({ code: V.BAD_INDEX, route: r, visit: s, detail: 'Truck ' + vehName(inst, v) + ' stop ' + (s + 1) + ' names node ' + node + ', which does not exist.' });
          continue;
        }
        // leg cur -> node: FIFO travel across periods, risk x time-weighted mean period risk
        const k = cur * nN + node;
        const base = M[k];
        let arrive;
        if (base === INF || base !== base || MI[k] === INF || RK[k] === INF) {
          nViol++;
          arrive = t;
          if (full) violations.push({ code: V.UNREACHABLE, route: r, visit: s, vehicle: v, node: node, detail: 'No open road from ' + nodeName(inst, cur) + ' to ' + nodeName(inst, node) + ' for truck ' + vehName(inst, v) + '.' });
          if (full) legsOut.push({ from: cur, to: node, depart: t, arrive: t, miles: 0, riskUnits: 0, riskFactor: 0, periodIdx: -1, unreachable: true });
        } else {
          let rf = 1;
          if (hasPeriods) { arrive = legArrive(P, t, base, legOut); rf = legOut[0]; } else arrive = t + base;
          const lm = MI[k], lr = RK[k] * rf;
          rMiles += lm; rRisk += lr;
          if (full) legsOut.push({ from: cur, to: node, depart: t, arrive: arrive, miles: lm, riskUnits: lr, riskFactor: rf, periodIdx: hasPeriods ? legOut[1] : -1 });
        }
        rStops++;
        if (isRally[node] && rallyStamp[node] !== epoch) { rallyStamp[node] = epoch; nRally++; }
        const jobs = visit.jobs || EMPTY;
        for (let c = 0; c < jobs.length; c++) {
          const ch = jobs[c];
          const j = ch ? ch.job : -1;
          if (!(j >= 0 && j < nJ) || (j | 0) !== j) {
            nViol++;
            if (full) violations.push({ code: V.BAD_INDEX, route: r, visit: s, detail: 'Truck ' + vehName(inst, v) + ' stop ' + (s + 1) + ' names job ' + j + ', which does not exist.' });
            continue;
          }
          const q = ch.qty;
          if (typeof q !== 'number' || !(q >= 0) || q === INF) {
            nViol++;
            if (full) violations.push({ code: V.BAD_QTY, route: r, visit: s, job: j, detail: jobName(inst, j) + ' has an invalid quantity (' + q + ').' });
            continue;
          }
          if (jFuel[j] !== fuelV) {
            nViol++;
            if (full) violations.push({ code: V.WRONG_TYPE, route: r, visit: s, job: j, vehicle: v, detail: jobName(inst, j) + ' (' + (jFuel[j] ? 'bulk fuel' : 'cargo') + ') cannot ride on ' + vehName(inst, v) + '.' });
          }
          const lk = jLockV[j];
          if (lk !== -1 && lk !== v) {
            nViol++;
            if (full) violations.push({ code: V.LOCKED_TRUCK, route: r, visit: s, job: j, vehicle: v, detail: jobName(inst, j) + ' is locked to truck ' + inst.jobs[j].lockedTruck + ' but rides on ' + vehName(inst, v) + '.' });
          }
          const ck = j * nN + node;
          if (cand[ck] < 0) {
            nViol++;
            if (full) violations.push({ code: V.NOT_CANDIDATE, route: r, visit: s, job: j, node: node, detail: jobName(inst, j) + ' cannot be delivered at ' + nodeName(inst, node) + (P.banned[node] ? ' (banned rally point).' : ' (not an allowed pickup point).') });
          } else if (q > 0) {
            // a zero-quantity chunk delivers nothing, so it does not bring the platoon to the node
            const pk = jReq[j] * nN + node;
            if (pairStamp[pk] !== epoch) { pairStamp[pk] = epoch; rPlatoon += candCost[ck]; }
          }
          load += q;
          delivered[j] += q;
          if (q > 0) {
            nodeStamp[node] = epoch;                     // the node received a delivery (pinned rule)
            const late = arrive - jDeadline[j];
            if (late > 0) {
              // capped at lateCapShare x the job's deferral cost, then scaled by the chunk's share
              let lp = late * jLateW[j];
              if (lp > jLateCap[j]) lp = jLateCap[j];
              rLate += lp * q * jInvQty[j];
              if (full && late > lateMax[j]) lateMax[j] = late;
            }
          }
        }
        const dep = arrive + serviceMin;
        if (full) stopsOut.push({ node: node, visitIdx: s, arrive: arrive, depart: dep, periodIdx: hasPeriods ? S.periodIndex(P, arrive) : -1, jobs: jobs.map(function (x) { return { job: x.job, qty: x.qty }; }) });
        t = dep;
        cur = node;
      }
      // return leg
      const hub = P.vHub[v];
      const kr = cur * nN + hub;
      const baseR = M[kr];
      let returnAt;
      if (baseR === INF || baseR !== baseR || MI[kr] === INF || RK[kr] === INF) {
        nViol++;
        returnAt = t;
        if (full) {
          violations.push({ code: V.UNREACHABLE, route: r, vehicle: v, node: hub, detail: 'No open road from ' + nodeName(inst, cur) + ' back to ' + nodeName(inst, hub) + ' for truck ' + vehName(inst, v) + '.' });
          legsOut.push({ from: cur, to: hub, depart: t, arrive: t, miles: 0, riskUnits: 0, riskFactor: 0, periodIdx: -1, unreachable: true });
        }
      } else {
        let rf = 1;
        if (hasPeriods) { returnAt = legArrive(P, t, baseR, legOut); rf = legOut[0]; } else returnAt = t + baseR;
        const lm = MI[kr], lr = RK[kr] * rf;
        rMiles += lm; rRisk += lr;
        if (full) legsOut.push({ from: cur, to: hub, depart: t, arrive: returnAt, miles: lm, riskUnits: lr, riskFactor: rf, periodIdx: hasPeriods ? legOut[1] : -1 });
      }
      const cap = P.vCap[v];
      if (load > cap + 1e-9 * mmax(1, cap)) {
        nViol++;
        if (full) violations.push({ code: V.OVER_CAPACITY, route: r, vehicle: v, detail: 'Truck ' + vehName(inst, v) + ' carries ' + load + ' but holds ' + cap + '.' });
      }
      miles += rMiles; risk += rRisk; nStops += rStops; platoon += rPlatoon; lateness += rLate;
      if (full) {
        const gal = rMiles * P.invMpg;
        const rc = {
          fuel: P.wF * gal, distance: P.wD * 0.5 * rMiles, risk: P.wR * rRisk,
          simplicity: P.wS * (5 * rStops + 25), platoon: P.wD * rPlatoon, lateness: rLate
        };
        rc.total = rc.fuel + rc.distance + rc.risk + rc.simplicity + rc.platoon + rc.lateness;
        routesOut.push({
          vehicle: v, routeIdx: r, vehicleId: inst.vehicles[v].id,
          loadStart: P.vLoadStart[v], depart: t0, returnAt: returnAt,
          miles: rMiles, gallons: gal, riskUnits: rRisk, load: load, capacity: cap,
          stops: stopsOut, legs: legsOut, cost: rc
        });
      }
    }

    // deferral and over-delivery
    let deferral = 0;
    const deferredOut = full ? [] : null;
    const jQty = P.jQty, jEps = P.jEps, jDeferW = P.jDeferW;
    for (let j = 0; j < nJ; j++) {
      const d = jQty[j] - delivered[j];
      if (d > jEps[j]) {
        deferral += d * jInvQty[j] * jDeferW[j];
        if (full) deferredOut.push({ job: j, qty: d });
      } else if (d < -jEps[j]) {
        nViol++;
        if (full) violations.push({ code: V.OVER_QTY, job: j, detail: jobName(inst, j) + ': ' + delivered[j] + ' planned but only ' + jQty[j] + ' requested.' });
      }
    }
    if (nRally > P.maxRally) {
      nViol++;
      if (full) violations.push({ code: V.TOO_MANY_RALLY, detail: 'The plan uses ' + nRally + ' rally points; the limit is ' + P.maxRally + '.' });
    }
    // pinned rally points some job could use that received no delivered quantity
    const pins = P.pinNodes;
    let nPinUnused = 0;
    const pinnedOut = full ? [] : null;
    for (let a = 0; a < pins.length; a++) {
      if (nodeStamp[pins[a]] !== epoch) { nPinUnused++; if (full) pinnedOut.push(pins[a]); }
    }

    const gallons = miles * P.invMpg;
    const cFuel = P.wF * gallons, cDist = P.wD * 0.5 * miles, cRisk = P.wR * risk;
    const cSimp = P.wS * (5 * nStops + 25 * nTrucks), cPlat = P.wD * platoon, cPin = P.pinUnused * nPinUnused;
    const total = cFuel + cDist + cRisk + cSimp + cPlat + lateness + deferral + cPin + S.VIOLATION_PENALTY * nViol;
    if (!full) return { total: total, feasible: nViol === 0, nViolations: nViol };

    const late = [], hardLate = [], rallyNodes = [];
    for (let j = 0; j < nJ; j++) {
      if (lateMax[j] > 0) {
        late.push({ job: j, minutesLate: lateMax[j] });
        if (P.jHard[j]) hardLate.push(j);
      }
    }
    for (let n = 0; n < nN; n++) if (isRally[n] && rallyStamp[n] === epoch) rallyNodes.push(n);
    return {
      total: total,
      feasible: nViol === 0,
      cost: { fuel: cFuel, distance: cDist, risk: cRisk, simplicity: cSimp, platoon: cPlat, lateness: lateness, deferral: deferral, pinned: cPin },
      routes: routesOut,
      delivered: Array.from(delivered),
      deferred: deferredOut,
      late: late,
      hardLate: hardLate,
      rallyNodes: rallyNodes,
      pinnedUnused: pinnedOut,
      violations: violations,
      stats: { miles: miles, gallons: gallons, riskUnits: risk, stops: nStops, trucksUsed: nTrucks, rallyPoints: nRally, pinnedUnused: nPinUnused }
    };
  }

  S.evaluate = function (instance, solution, opts) {
    return run(instance, solution, !(opts && opts.costOnly));
  };
  S.totalCost = function (instance, solution) { return run(instance, solution, false).total; };

  // ---- deferral explanations ----------------------------------------------------------------------
  // For each deferred job in evalResult (from a full evaluate) returns
  //   { job, qty, reason: 'radius'|'no-truck'|'closed-road'|'time'|'capacity', detail, note, earliestArrive?, deadline? }
  // Checks in order: no allowed pickup point (radius), no truck of the right type/lock (no-truck), no
  // reachable candidate from any such truck (closed-road), earliest possible arrival after the deadline
  // (time), otherwise capacity (detail: 'trucks-full' | 'rally-limit' | 'cost'; room is counted only on
  // trucks that can reach one of the job's pickup points and get back to their hub). Notes carry no clock
  // times: format.js owns time formatting, so the minute values are returned as fields.
  S.explainDeferred = function (instance, evalResult) {
    const P = S.prepare(instance);
    const nN = P.nN, legOut = new F64(2);
    const ev = evalResult || S.evaluate(instance, { routes: [] });
    if (!Array.isArray(ev.deferred)) throw new TypeError('SRO.solver.explainDeferred needs a full evaluate() result (not { costOnly: true }).');
    const loadByVeh = new F64(P.nV);
    (ev.routes || []).forEach(function (r) { if (r.vehicle >= 0 && r.vehicle < P.nV) loadByVeh[r.vehicle] += r.load || 0; });
    const rallyUsed = (ev.rallyNodes || []).length;
    const usedSet = new Set(ev.rallyNodes || []);
    return (ev.deferred || []).map(function (d) {
      const j = d.job, job = instance.jobs[j];
      const out = { job: j, qty: d.qty };
      const unit = job.unit || (job.group === 'fuel' ? 'gal' : 'pallets');
      const cands = P.jCandNodes[j];
      if (!cands.length) {
        out.reason = 'radius'; out.detail = 'no-candidate';
        out.note = 'No allowed pickup point is within the platoon\'s travel radius (or every one in range is banned).';
        return out;
      }
      const vs = [];
      for (let v = 0; v < P.nV; v++) {
        if (P.vFuel[v] !== P.jFuel[j]) continue;
        if (P.jLockV[j] !== -1 && P.jLockV[j] !== v) continue;
        vs.push(v);
      }
      if (!vs.length) {
        out.reason = 'no-truck';
        const kind = job.group === 'fuel' ? 'fuel tanker' : 'cargo truck';
        if (job.lockedTruck == null) {
          out.detail = 'no-vehicle-type';
          out.note = 'No ' + kind + ' is available for this plan.';
        } else if (P.jLockV[j] >= 0) {
          out.detail = 'locked-truck-wrong-type';
          out.note = 'Locked to truck ' + job.lockedTruck + ', which cannot carry this load (it needs a ' + kind + ').';
        } else {
          out.detail = 'locked-truck-unavailable';
          out.note = 'Locked to truck ' + job.lockedTruck + ', which is not available for this plan.';
        }
        return out;
      }
      let earliest = INF, reachable = 0;
      const reachVs = [];                          // trucks that can get to some candidate and back
      for (let a = 0; a < vs.length; a++) {
        const v = vs[a], st = P.vStart[v], hub = P.vHub[v], t0 = P.vT0[v];
        let reaches = false;
        for (let b = 0; b < cands.length; b++) {
          const n = cands[b];
          const go = P.minutes[st * nN + n], back = P.minutes[n * nN + hub];
          if (!(go < INF) || !(back < INF) || !(P.miles[st * nN + n] < INF) || !(P.miles[n * nN + hub] < INF) ||
            !(P.risk[st * nN + n] < INF) || !(P.risk[n * nN + hub] < INF)) continue;
          reachable++; reaches = true;
          // straight there with the same FIFO travel rule as evaluate
          const arr = S.legArrive(P, t0, go, legOut);
          if (arr < earliest) earliest = arr;
        }
        if (reaches) reachVs.push(v);
      }
      if (!reachable) {
        out.reason = 'closed-road'; out.detail = 'unreachable';
        out.note = 'Closed roads cut off every allowed pickup point from the trucks that could carry it.';
        return out;
      }
      out.earliestArrive = earliest;
      out.deadline = P.jDeadline[j] < INF ? P.jDeadline[j] : null;
      if (earliest > P.jDeadline[j]) {
        out.reason = 'time'; out.detail = 'after-deadline';
        out.note = 'No truck could arrive before the deadline.';
        return out;
      }
      out.reason = 'capacity';
      // room only counts on trucks that can reach the job: an empty truck cut off by a closed road is
      // no help, and calling that "trucks had some room" would mislead the planner
      let free = 0, cap = 0;
      reachVs.forEach(function (v) { cap += P.vCap[v]; free += mmax(0, P.vCap[v] - loadByVeh[v]); });
      const allRally = cands.every(function (n) { return P.isRally[n] && !usedSet.has(n); });
      if (free <= 1e-9 * mmax(1, cap) || free < d.qty * 0.05) {
        out.detail = 'trucks-full';
        out.note = 'Every ' + (job.group === 'fuel' ? 'tanker' : 'cargo truck') + ' that could carry it is full (' + (cap - free) + ' of ' + cap + ' ' + unit + ' loaded).';
      } else if (allRally && rallyUsed >= P.maxRally) {
        out.detail = 'rally-limit';
        out.note = 'Its pickup points would need another rally point, and the plan already uses the limit of ' + P.maxRally + '.';
      } else {
        out.detail = 'cost';
        out.note = 'Trucks had some room, but fitting it in would have delayed higher-priority loads or cost more than carrying it next window.';
      }
      return out;
    });
  };
})(typeof self !== 'undefined' ? self : globalThis);
