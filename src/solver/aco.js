// Ant colony optimization (DESIGN.md section 7, "Methods" and "Method interface"): SRO.solver.methods.aco.
//
//   SRO.solver.methods.aco.run(instance, params, hooks) -> { solution, total, feasible, evals, iterations,
//       elapsedSec, stopReason, history, extra }
//   SRO.solver.methods.aco.budget(instance, params) -> params.iterations (rounds; the unit of result.iterations)
//
// Start. construct() with the run's seeded RNG sets the cost scale c0 of the heuristic desirability
// (CFG.c0Share x its routing cost per stop) and is the first best plan; hooks.start (normalized), when
// given, is offered first and kept unless construct() beats it (a violation-free plan beats one with
// violations), so a run stopped before its first ant never returns a given plan's violations.
//
// Ants. Each round, params.ants ants each build a whole plan from an empty one by sequential insertion:
//   order    jobs locked to a truck first, then by deadline minus a lead time per tier (Routine 0,
//            Priority 1 h, Urgent 4 h, Immediate 12 h: CFG.tierLeadMin) plus a seeded jitter of up to
//            CFG.jitterMin minutes, so each ant tries a slightly different order. (A strict tier-first
//            order made far worse ants: early-deadline Routine jobs ended up late behind later Priority
//            ones; measured on Phase 1 windows, the best of 40 ants was 3.0x the construct + localSearch
//            plan with tier-first order and 1.1x with this one.)
//   choices  each chunk of a job (the remaining quantity, or what fits the truck) goes to one option:
//            join a visit the plan already has at one of the job's candidate nodes, or a new visit at a
//            candidate node at any position of any compatible truck (type, lock, free capacity). A new
//            rally node is offered only while the rally points in use, plus the slots held back for
//            pinned rally points not yet used, stay within maxRallyPoints (as construct does); legs that
//            are unreachable are never offered. The ant picks option o with probability
//                p(o) ~ [ tau(j, n) x sqrt(tau(a, n) x tau(n, b)) ]^alpha x [ c0 / (c0 + cost(o) x rem / q) ]^beta
//            tau(j, n) = (job, delivery node) trail: how the colony picks rally / delivery points;
//            tau(a, n), tau(n, b) = (node, node) sequencing trails of the arcs the option drives (a and b
//            are the stops before and after it: the truck's start node and its home hub at the ends;
//            for a join, the arcs into and out of that visit);
//            cost(o) = exact incremental cost of the option (the same terms evaluate() charges): travel
//            (miles and period risk), stop and truck-use costs, the platoon's trip when the (request,
//            node) pair is new, minus the unused-pinned-point charge it removes, the job's own lateness
//            at the arrival time, and the lateness it adds to the stops it pushes back. With the order
//            above this is the urgency / deadline part of the heuristic. rem / q scales the cost to the
//            whole remaining quantity when the chunk only covers part of it. An option that costs more
//            than the deferral it avoids is not offered; a job with no option left stays (partly)
//            deferred.
//   Each ant plan is violation-free and scored with evaluate().
//
// Round. The round-best ant (lowest total) gets a bounded localSearch (CFG.lsEvals evaluations, compound
// refill moves included; a short first call of CFG.lsFirstChunk, then one for the rest, with a progress
// check between) when params.localSearch is on, is offered as the best plan, and then lays trail.
//
// Trail update rule (MAX-MIN ant system with an elitist share), once per round after the polish:
//   tau <- (1 - rho) x tau                                    on every (node, node) and (job, node) trail
//   tau += q x (1 - eliteShare) x (C_best / C_round)          on each component of the round-best plan
//   tau += q x eliteShare                                     on each component of the best plan so far
//   tau <- min(tauMax, max(tauMin, tau))       tauMax = tau0 / rho        tauMin = tau0 / tauRatio
// rho = params.evaporation, q = params.q, C = plan total (evaluate), tau0 = 1, eliteShare = 0.5,
// tauRatio = 20. A plan's components: the arcs each truck drives (start node -> first stop -> ... -> last
// stop -> home hub; consecutive stops at one node add no arc) and its (job, node) delivery points, each
// counted once. C_best / C_round <= 1, so a round lays at most q on a component and the trails stay in
// [tauMin, tauMax] whatever q is. A component of the best plan every round converges to min(tauMax,
// q / rho): at the default q = 1 that is tauMax (200x the floor at rho = 0.1); a larger q makes a good
// round's components jump toward tauMax at once (faster, greedier convergence); a smaller q holds even
// the best plan's components below tauMax, so the colony keeps exploring (q = 0.01 at rho = 0.1: twice
// the floor). A larger rho forgets faster and narrows the band (tauMax / tauMin = tauRatio / rho). The
// trails start at tauMax (exploration first) and are reset to tauMax after a stall (no new best plan
// for CFG.stallShare x iterations rounds, at least CFG.stallMin); the best plan is kept and keeps
// laying trail, so the colony re-converges around it from a fresh start. alpha = 0 ignores the trails,
// beta = 0 the cost heuristic.
//
// Polish. With params.localSearch the best plan gets a final localSearch to a local optimum. With it off
// there is no local search at all (ants and trails only). Every localSearch runs on an evaluation budget,
// so the result does not depend on machine speed.
//
// Limits. Stops after params.iterations rounds ('budget'), at params.timeCapSec ('time'; with local search
// a small share of the cap, up to 2 s, is held back for the final polish, and the whole run, polish
// included, ends at the cap), on hooks.shouldStop() ('stopped', no polish), or at once when there is
// nothing to plan (no jobs or no trucks: 'converged'). Deterministic for a given params.seed whenever the
// run is not cut by time: SRO.util.rng only; the clock only ends the run and never steers the search.
//
// Progress. hooks.onProgress is called right after the start plan is ready (iteration 0, which estimate.js
// reads as the end of the setup), soon after the best plan improves (a new best waits at most
// CFG.bestMinMs), at least every CFG.progressMs otherwise, right before every localSearch call (when
// CFG.preLsMs has passed since the last report; one ant takes well under a millisecond, a localSearch
// call cannot report from inside and takes about 20-60 ms on a Phase 1 window in Node, up to ~110 ms for
// the first call on a raw ant: see CFG.lsFirstChunk), and once at the end: { fraction, bestCost,
// currentCost (the last round-best total), elapsedSec, iteration, message, best? }; `best` (the plan) is
// present only when it changed since the previous call. hooks.shouldStop and hooks.now are asked before
// every ant and every localSearch.
//
// params: SRO.solver.clampParams('aco', params) output (missing or invalid knobs fall back to the
// defaults). A timeCapSec below the form's minimum is honored as given (tests, short runs), as in tabu.js
// and sa.js. result.iterations = rounds completed; evals = plans evaluated (ants and localSearch).
// history: [{ t: seconds, best: total }], at most one point per CFG.historyMs (the last best in it).
// extra: { ants, antsBuilt, antMs (mean ms per ant), startTotal (hooks.start's total when given, else
// construct's), startFrom ('start' | 'construct': the first best plan), antBest (best raw ant), roundMean: [mean
// raw ant total per round], acoBest (before the final polish), polishGain, polishEvals, lsGain, lsEvals,
// lsMs, reinits, tauMin, tauMax, c0, budget }.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};
  S.methods = S.methods || {};
  // Local aliases: global lookups are slow inside Node vm contexts (tests) and cost nothing here.
  const INF = Infinity, mmax = Math.max, mmin = Math.min, mabs = Math.abs, mpow = Math.pow, mceil = Math.ceil;
  const F64 = Float64Array, I32 = Int32Array, U8 = Uint8Array;
  const COST_ONLY = { costOnly: true };

  const CFG = {
    progressMs: 50,           // progress at least this often (contract: 250 ms) ...
    preLsMs: 25,              // ... and right before a localSearch call when this long has passed since the
                              // last report: a call cannot report from inside, so the longest gap is about
                              // one localSearch call (measured on hard Phase 1 windows in Node: at most ~110
                              // ms, typically 20-60; about 33 reports a second, 6 of them with a new plan)
    bestMinMs: 40,            // a new best plan is reported at most this long after it is found
    historyMs: 50,            // history keeps at most one point per this many ms (the last best in it)
    tau0: 1,                  // trail scale the bounds are measured against (see the update rule)
    tauRatio: 20,             // tauMin = tau0 / tauRatio
    eliteShare: 0.5,          // share of each round's deposit laid on the best plan so far (rest: round best)
    stallShare: 0.15,         // reset the trails after this share of the iterations without a new best ...
    stallMin: 10,             // ... but never after fewer rounds than this
    c0Share: 0.5,             // eta = c0 / (c0 + cost); c0 = this x construct()'s routing cost per stop
    tierLeadMin: [0, 60, 240, 720],   // job order: deadline - this lead (minutes, per tier) ...
    jitterMin: 30,            // ... + U(0, this) minutes per ant
    lsEvals: 4000,            // evaluations for the round-best ant's localSearch ...
    lsFirstChunk: 1000,       // ... of which the first localSearch call makes at most this many (the raw
                              // ant's steep first descent is the slow part; a short first call keeps the
                              // longest gap between progress reports near 100 ms in Node instead of ~170 ms;
                              // measured neutral on quality: 22 better, 15 worse of 40 hard Phase 1 windows)
    lsRuin: 1,                // ... with this many routes emptied and refilled per end phase
    lsChunk: 5000,            // final polish: evaluations per localSearch chunk
    lsIdleChunks: 2,          // final polish ends after this many chunks in a row without a gain
    polishShare: 0.05,        // share of the time cap held back for the final polish ...
    polishReserveMaxMs: 2000  // ... but at most this many ms
  };
  // Tuning (2026-10-06, 10 Phase 1 windows x 4 seeds at the default params, 150 rounds of 20 ants; mean
  // gap to the best plan any method or setting found). With a tier-first order: tauRatio 10 / 20 / 50:
  // 1.9 / 2.0 / 2.1%; eliteShare 0.25 / 0.5 / 0.75: 2.3 / 2.0 / 2.0%; stallShare 0.08 / 0.15 / 0.3: 2.2 /
  // 2.0 / 1.9%; c0Share 0.25 / 0.5 / 1: 2.0 / 2.0 / 2.0%; lsEvals 4000 / 8000: 2.0 / 1.7% at 1.5x the time;
  // a polished start plan: 1.9%. The deadline order above then gave 1.3% (jitter 30 min; 1.5% with 90 min;
  // per-ant random lead scales, an ACS-style greedy pick or an order by deadline minus travel time did not
  // help).

  function defaultNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function tol(x) { return 1e-9 * mmax(1, mabs(x)); }
  // a strictly better than b (a violation-free plan always beats one with violations)
  function better(aTotal, aFeas, bTotal, bFeas) {
    if (aFeas !== bFeas) return aFeas;
    return aTotal < bTotal - tol(bTotal);
  }

  function readParams(params) {
    const p = S.clampParams ? S.clampParams('aco', params) : Object.assign({}, params);
    const raw = params && params.timeCapSec;
    if (typeof raw === 'number' && raw > 0 && isFinite(raw)) p.timeCapSec = raw;
    return p;
  }

  // ---- trails ------------------------------------------------------------------------------------------
  // makeTrails(P, { alpha, evaporation, q }) -> { arc, jn, arcPow, jnPow, tauMin, tauMax, reset(),
  //   update(roundBest, roundTotal, best, bestTotal) }. arc[a * nN + b] and jn[j * nN + n] are the trails;
  // arcPow = (arc / tauMax)^(alpha / 2) and jnPow = (jn / tauMax)^alpha are what the ants read (an option
  // adds two arcs, so their product is their geometric mean to the power alpha).
  function forEachComponent(P, sol, arcFn, jnFn) {
    const nN = P.nN, routes = (sol && sol.routes) || [];
    for (let r = 0; r < routes.length; r++) {
      const v = routes[r].vehicle, visits = routes[r].visits;
      if (!visits || !visits.length || !(v >= 0 && v < P.nV)) continue;
      let a = P.vStart[v];
      for (let s = 0; s < visits.length; s++) {
        const n = visits[s].node;
        if (!(n >= 0 && n < nN)) continue;
        if (n !== a) arcFn(a * nN + n);
        const js = visits[s].jobs;
        for (let c = 0; c < js.length; c++) if (js[c].job >= 0 && js[c].job < P.nJ && js[c].qty > 0) jnFn(js[c].job * nN + n);
        a = n;
      }
      arcFn(a * nN + P.vHub[v]);
    }
  }

  function makeTrails(P, p) {
    const nN = P.nN, nJ = P.nJ;
    const alpha = p.alpha >= 0 ? p.alpha : 1, rho = p.evaporation > 0 && p.evaporation <= 1 ? p.evaporation : 0.1, q = p.q >= 0 ? p.q : 1;
    const tauMax = CFG.tau0 / rho, tauMin = CFG.tau0 / CFG.tauRatio;
    const arc = new F64(mmax(1, nN * nN)), jn = new F64(mmax(1, nJ * nN));
    const arcPow = new F64(arc.length), jnPow = new F64(jn.length);
    const arcStamp = new I32(arc.length), jnStamp = new I32(jn.length);
    let stamp = 0;
    function pow() {
      const ha = alpha / 2;
      for (let k = 0; k < arc.length; k++) arcPow[k] = alpha === 0 ? 1 : mpow(arc[k] / tauMax, ha);
      for (let k = 0; k < jn.length; k++) jnPow[k] = alpha === 0 ? 1 : mpow(jn[k] / tauMax, alpha);
    }
    function deposit(sol, amount) {
      stamp++;
      forEachComponent(P, sol,
        function (k) { if (arcStamp[k] !== stamp) { arcStamp[k] = stamp; arc[k] += amount; } },
        function (k) { if (jnStamp[k] !== stamp) { jnStamp[k] = stamp; jn[k] += amount; } });
    }
    function clamp(a) {
      for (let k = 0; k < a.length; k++) { const x = a[k]; a[k] = x > tauMax ? tauMax : x < tauMin ? tauMin : x; }
    }
    const T = {
      arc: arc, jn: jn, arcPow: arcPow, jnPow: jnPow, tauMin: tauMin, tauMax: tauMax,
      reset: function () { arc.fill(tauMax); jn.fill(tauMax); pow(); },
      // one round of the update rule in the header; roundBest may be null (then only the best plan lays)
      update: function (roundBest, roundTotal, best, bestTotal) {
        const keep = 1 - rho;
        for (let k = 0; k < arc.length; k++) arc[k] *= keep;
        for (let k = 0; k < jn.length; k++) jn[k] *= keep;
        if (roundBest) {
          const ratio = roundTotal > 0 && bestTotal >= 0 && bestTotal < INF ? mmin(1, bestTotal / roundTotal) : 1;
          deposit(roundBest, q * (1 - CFG.eliteShare) * ratio);
        }
        if (best) deposit(best, q * CFG.eliteShare);
        clamp(arc); clamp(jn);
        pow();
      }
    };
    T.reset();
    return T;
  }

  // ---- ant construction ----------------------------------------------------------------------------
  // makeBuilder(instance, P?, { beta, c0, jitterMin?, tierLeadMin? }) -> build(rng, trails) -> normalized,
  // violation-free solution (one route per vehicle). trails = { jnPow, arcPow } as makeTrails gives them.
  // build.debug exposes the steps of one ant for tests.
  function makeBuilder(instance, P, opts) {
    P = P || S.prepare(instance);
    opts = opts || {};
    const nN = P.nN, nV = P.nV, nJ = P.nJ;
    const beta = opts.beta >= 0 ? opts.beta : 3, c0 = opts.c0 > 0 ? opts.c0 : 1;
    const jitter = opts.jitterMin != null ? opts.jitterMin : CFG.jitterMin;
    const leads = opts.tierLeadMin || CFG.tierLeadMin;
    const M = P.minutes, MI = P.miles, RK = P.risk;
    const cm = P.wF * P.invMpg + P.wD * 0.5, wR = P.wR, wD = P.wD;
    const stopCost = P.wS * 5, truckCost = P.wS * 25, service = P.serviceMin;
    const hasPeriods = P.nP > 0, legArrive = S.legArrive, legOut = new F64(2);
    const isRally = P.isRally, candCost = P.candCost, jReq = P.jReq;
    const jDeadline = P.jDeadline, jLateW = P.jLateW, jLateCap = P.jLateCap, jInvQty = P.jInvQty, jEps = P.jEps;
    const jPrevEta = P.jPrevEta, jSlipW = P.jSlipW;
    const vT0 = P.vT0, vStart = P.vStart, vHub = P.vHub, vCap = P.vCap, vFuel = P.vFuel;
    const pinNode = new U8(nN);
    for (let i = 0; i < P.pinNodes.length; i++) pinNode[P.pinNodes[i]] = 1;

    // per-vehicle route state: visit nodes, chunks, arrival minutes, cost of the leg into each visit,
    // cost of the return leg
    const rNode = [], rJobs = [], rArr = [], rLeg = [];
    for (let v = 0; v < nV; v++) { rNode.push([]); rJobs.push([]); rArr.push([]); rLeg.push([]); }
    const rRet = new F64(nV), load = new F64(nV), rem = new F64(nJ);
    const rallyCnt = new I32(nN), pinReach = new U8(nN);
    const pairStamp = new I32(mmax(1, P.nReq * nN)), nodeStamp = new I32(nN);
    let epoch = 0, rallyUsed = 0, pinFree = 0;
    // options of the chunk being placed
    let cap = 64, nOpt = 0;
    let oV = new I32(cap), oP = new I32(cap), oN = new I32(cap), oQ = new F64(cap), oW = new F64(cap), oD = new F64(cap);
    const key = new F64(nJ), orderIdx = [];
    for (let j = 0; j < nJ; j++) orderIdx.push(j);

    function arrive(t, a, b) {
      const base = M[a * nN + b];
      if (hasPeriods) return legArrive(P, t, base, legOut);
      legOut[0] = 1; return t + base;
    }
    function legCost(a, b, rf) { const k = a * nN + b; return cm * MI[k] + wR * RK[k] * rf; }
    // lateness + ETA slip cost of the whole job j delivered at minute a, within the lateness cap (as
    // evaluate charges lateness + stability; the caller scales it by the chunk share)
    function lateCost(j, a) {
      const l = a - jDeadline[j], e = a - jPrevEta[j];
      if (!(l > 0) && !(e > 0 && jSlipW[j] > 0)) return 0;
      const x = (l > 0 ? l * jLateW[j] : 0) + (e > 0 ? e * jSlipW[j] : 0);
      return x > jLateCap[j] ? jLateCap[j] : x;
    }
    // exact schedule of route v from visit s0 on (arrivals, leg costs, return leg), as evaluate() runs it
    function reschedule(v, s0) {
      const nodes = rNode[v], arr = rArr[v], legs = rLeg[v], k = nodes.length;
      let t = s0 === 0 ? vT0[v] : arr[s0 - 1] + service;
      let cur = s0 === 0 ? vStart[v] : nodes[s0 - 1];
      for (let s = s0; s < k; s++) {
        const n = nodes[s];
        const a = arrive(t, cur, n);
        legs[s] = legCost(cur, n, legOut[0]);
        arr[s] = a; t = a + service; cur = n;
      }
      if (k) { const h = vHub[v]; arrive(t, cur, h); rRet[v] = legCost(cur, h, legOut[0]); } else rRet[v] = 0;
    }
    // lateness change when visits s0.. of route v arrive d minutes later
    function shiftLate(v, s0, d) {
      if (d === 0) return 0;
      const arr = rArr[v], jobs = rJobs[v];
      let out = 0;
      for (let s = s0; s < arr.length; s++) {
        const a0 = arr[s], a1 = a0 + d, js = jobs[s];
        for (let c = 0; c < js.length; c++) {
          const j = js[c].job;
          const x = lateCost(j, a1) - lateCost(j, a0);
          if (x !== 0) out += x * js[c].qty * jInvQty[j];
        }
      }
      return out;
    }
    function grow() {
      cap *= 2;
      const g = function (a, T) { const b = new T(cap); b.set(a); return b; };
      oV = g(oV, I32); oP = g(oP, I32); oN = g(oN, I32); oQ = g(oQ, F64); oW = g(oW, F64); oD = g(oD, F64);
    }
    function addOpt(v, p, n, q, d, w) {
      if (nOpt === cap) grow();
      oV[nOpt] = v; oP[nOpt] = p; oN[nOpt] = n; oQ[nOpt] = q; oD[nOpt] = d; oW[nOpt] = w; nOpt++;
    }
    function eta(d, perShare) {
      if (beta === 0) return 1;
      const x = d > 0 ? d * perShare : 0;
      return mpow(c0 / (c0 + x), beta);
    }

    function reset() {
      epoch++;
      if (epoch > 2000000000) { pairStamp.fill(0); nodeStamp.fill(0); epoch = 1; }
      for (let v = 0; v < nV; v++) { rNode[v].length = 0; rJobs[v].length = 0; rArr[v].length = 0; rLeg[v].length = 0; rRet[v] = 0; load[v] = 0; }
      for (let j = 0; j < nJ; j++) rem[j] = P.jQty[j];
      rallyCnt.fill(0); rallyUsed = 0;
      // pinned rally nodes some job could use hold back their slot until they are opened (as construct)
      pinReach.fill(0); pinFree = 0;
      for (let i = 0; i < P.pinNodes.length; i++) { const n = P.pinNodes[i]; if (!pinReach[n]) { pinReach[n] = 1; pinFree++; } }
    }

    // Every feasible option for the next chunk of job j, weighted tau^alpha x eta^beta (see the header).
    function options(j, jnPow, arcPow) {
      nOpt = 0;
      const r = rem[j];
      const cands = P.jCandNodes[j];
      const lk = P.jLockV[j];
      const gainW = P.jDeferW[j] * jInvQty[j];
      for (let v = 0; v < nV; v++) {
        if (vFuel[v] !== P.jFuel[j]) continue;
        if (lk === -1 ? P.vPre[v] : lk !== v) continue;     // lock; en-route trucks carry only their own loads
        const free = vCap[v] - load[v];
        if (free <= jEps[j]) continue;
        const q = r < free ? r : free;
        const share = q * jInvQty[j], perShare = r / q, gain = gainW * q;
        const nodes = rNode[v], arr = rArr[v], legs = rLeg[v], k = nodes.length;
        const start = vStart[v], hub = vHub[v];
        for (let ci = 0; ci < cands.length; ci++) {
          const n = cands[ci];
          const platoon = pairStamp[jReq[j] * nN + n] !== epoch ? wD * candCost[j * nN + n] : 0;
          const tj = jnPow[j * nN + n];
          // join an existing visit at n (no travel; that visit's arrival time)
          for (let s = 0; s < k; s++) {
            if (nodes[s] !== n) continue;
            const d = lateCost(j, arr[s]) * share + platoon;
            if (!(d < gain)) continue;
            const a = s ? nodes[s - 1] : start, b = s + 1 < k ? nodes[s + 1] : hub;
            addOpt(v, -1 - s, n, q, d, tj * arcPow[a * nN + n] * arcPow[n * nN + b] * eta(d, perShare));
          }
          // a new visit at n, at every position
          if (isRally[n] && rallyCnt[n] === 0) {
            const reserve = pinFree - (pinReach[n] ? 1 : 0);
            if (rallyUsed + 1 + reserve > P.maxRally) continue;
          }
          const pin = pinNode[n] && nodeStamp[n] !== epoch ? P.pinUnused : 0;
          for (let p = 0; p <= k; p++) {
            const a = p ? nodes[p - 1] : start, b = p < k ? nodes[p] : hub;
            if ((p > 0 && a === n) || (p < k && b === n)) continue;     // joining that visit is cheaper
            const k1 = a * nN + n, k2 = n * nN + b;
            if (!(M[k1] < INF) || !(MI[k1] < INF) || !(M[k2] < INF) || !(MI[k2] < INF)) continue;
            const an = arrive(p ? arr[p - 1] + service : vT0[v], a, n);
            const c1 = legCost(a, n, legOut[0]);
            const ab = arrive(an + service, n, b);
            const c2 = legCost(n, b, legOut[0]);
            let d = c1 + c2 - (p < k ? legs[p] : rRet[v]) + stopCost + (k === 0 ? truckCost : 0) +
              lateCost(j, an) * share + platoon - pin;
            if (p < k) d += shiftLate(v, p, ab - arr[p]);
            if (!(d < gain)) continue;
            addOpt(v, p, n, q, d, tj * arcPow[k1] * arcPow[k2] * eta(d, perShare));
          }
        }
      }
      return nOpt;
    }

    function place(j, i) {
      const v = oV[i], p = oP[i], n = oN[i], q = oQ[i];
      if (p < 0) {
        const js = rJobs[v][-1 - p];
        let found = false;
        for (let c = 0; c < js.length; c++) if (js[c].job === j) { js[c] = { job: j, qty: js[c].qty + q }; found = true; break; }
        if (!found) js.push({ job: j, qty: q });
      } else {
        rNode[v].splice(p, 0, n); rJobs[v].splice(p, 0, [{ job: j, qty: q }]); rArr[v].splice(p, 0, 0); rLeg[v].splice(p, 0, 0);
        if (isRally[n] && rallyCnt[n]++ === 0) {
          rallyUsed++;
          if (pinReach[n]) { pinReach[n] = 0; pinFree--; }
        }
        reschedule(v, p);
      }
      load[v] += q;
      rem[j] -= q;
      if (rem[j] <= jEps[j]) rem[j] = 0;
      pairStamp[jReq[j] * nN + n] = epoch;
      nodeStamp[n] = epoch;
    }

    function jobOrder(rng) {
      for (let j = 0; j < nJ; j++) {
        const dl = jDeadline[j] < INF ? jDeadline[j] : 1e9;
        key[j] = (P.jLockV[j] >= 0 ? 0 : 1e12) + dl - (leads[P.jTier[j]] || 0) + rng() * jitter;
      }
      orderIdx.sort(function (a, b) { return key[a] - key[b] || a - b; });
      return orderIdx;
    }

    const build = function (rng, trails) {
      reset();
      const jnPow = trails.jnPow, arcPow = trails.arcPow;
      const order = jobOrder(rng);
      for (let oi = 0; oi < nJ; oi++) {
        const j = order[oi];
        if (P.jLockV[j] === -2 || !P.jCandNodes[j].length) continue;
        let guard = 0;
        while (rem[j] > jEps[j] && guard++ < 1000) {
          const no = options(j, jnPow, arcPow);
          if (!no) break;
          let sum = 0;
          for (let i = 0; i < no; i++) sum += oW[i];
          let pick = -1;
          if (sum > 0 && sum < INF) {
            let x = rng() * sum;
            for (let i = 0; i < no; i++) { x -= oW[i]; if (x < 0) { pick = i; break; } }
            if (pick < 0) pick = no - 1;
            while (pick > 0 && !(oW[pick] > 0)) pick--;
          } else {
            // the weights under- or overflowed (extreme alpha / beta): the cheapest option per share
            rng();
            let bd = INF;
            for (let i = 0; i < no; i++) { const x = oD[i] * rem[j] / oQ[i]; if (x < bd || pick < 0) { bd = x; pick = i; } }
          }
          place(j, pick);
        }
      }
      const routes = [];
      for (let v = 0; v < nV; v++) {
        const visits = [];
        for (let s = 0; s < rNode[v].length; s++) visits.push({ node: rNode[v][s], jobs: rJobs[v][s] });
        routes.push({ vehicle: v, visits: visits });
      }
      return { routes: routes };
    };
    // test hook: step through one ant by hand (reset(), options(j, jnPow, arcPow) -> count, option(i),
    // place(j, i)); option(i) = { vehicle, pos (>= 0: new visit there; -1 - s: join visit s), node, qty,
    // cost (the exact incremental cost the header describes), weight }
    build.debug = {
      reset: reset, options: options, place: place,
      option: function (i) { return { vehicle: oV[i], pos: oP[i], node: oN[i], qty: oQ[i], cost: oD[i], weight: oW[i] }; }
    };
    return build;
  }

  // ---- the method ------------------------------------------------------------------------------------
  function run(instance, params, hooks) {
    hooks = hooks || {};
    const p = readParams(params);
    const now = typeof hooks.now === 'function' ? hooks.now : defaultNow;
    const shouldStop = typeof hooks.shouldStop === 'function' ? hooks.shouldStop : null;
    const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : null;
    const rng = SRO.util.rng(p.seed);
    const t0 = now();
    const capMs = p.timeCapSec * 1000;
    const endAt = t0 + capMs;
    const searchEndAt = p.localSearch ? endAt - mmin(CFG.polishReserveMaxMs, capMs * CFG.polishShare) : endAt;
    const P = S.prepare(instance);
    const nJ = P.nJ;
    const nAnts = mmax(1, p.ants | 0), budget = mmax(1, p.iterations | 0);

    let evals = 0, it = 0, antInRound = 0, phase = 'start', stopReason = null;
    let best = null, bestTotal = INF, bestFeas = false, bestChanged = false;
    let lastReport = -INF, lastImproveIt = 0, reinits = 0, antsBuilt = 0;
    let antMs = 0, lsMs = 0, lsEvals = 0, lsGain = 0, antBest = INF, roundTotal = INF;
    const history = [], roundMean = [];

    function fmtInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    // force: always; a number: report when at least that many ms have passed since the last report
    function report(force) {
      if (!onProgress) return;
      const t = now();
      const wait = typeof force === 'number' ? mmin(force, bestChanged ? CFG.bestMinMs : CFG.progressMs)
        : force ? 0 : bestChanged ? CFG.bestMinMs : CFG.progressMs;
      if (t - lastReport < wait) return;
      lastReport = t;
      const elapsed = t - t0;
      let fraction = mmax((it + antInRound / (nAnts + 1)) / budget, capMs > 0 ? elapsed / capMs : 0);
      if (phase === 'polish') fraction = mmax(fraction, 0.98);
      fraction = phase === 'done' ? 1 : mmin(0.99, fraction);
      const round = 'Round ' + fmtInt(mmin(budget, it + 1)) + ' of ' + fmtInt(budget);
      const msg = {
        fraction: mmax(0, fraction), bestCost: bestTotal, currentCost: roundTotal < INF ? roundTotal : bestTotal,
        elapsedSec: elapsed / 1000, iteration: it,
        message: phase === 'start' ? 'Start plan ready; ' + nAnts + ' ants per round'
          : phase === 'ants' ? round + ': ants building plans (' + antInRound + ' of ' + nAnts + ')'
          : phase === 'ls' ? round + ': polishing the best ant of the round'
          : phase === 'polish' ? 'Polishing the best plan' : 'Done'
      };
      if (bestChanged) { msg.best = best; bestChanged = false; }
      onProgress(msg);
    }
    function addHistory(total) {
      const t = (now() - t0) / 1000;
      const last = history.length > 1 ? history[history.length - 1] : null;   // the start point stays
      if (last && t - last.t < CFG.historyMs / 1000) last.best = total;
      else history.push({ t: t, best: total });
    }
    // offer a plan as the new best; returns true when it is
    function offer(sol, total, feas) {
      if (best !== null && !better(total, feas, bestTotal, bestFeas)) return false;
      best = sol; bestTotal = total; bestFeas = feas; bestChanged = true;
      addHistory(total);
      return true;
    }
    function timeUp(limit) {
      if (shouldStop && shouldStop()) { stopReason = 'stopped'; return true; }
      if (now() >= limit) { stopReason = stopReason || 'time'; return true; }
      return false;
    }
    // one bounded localSearch (an evaluation budget; the clock only cuts it at the time cap)
    function polishOnce(sol, total, feas, maxEvals, limit) {
      report(CFG.preLsMs);
      const tl = now();
      const st = {};
      const out = S.localSearch(instance, sol, {
        rng: rng, maxIters: maxEvals, timeLimitMs: mmax(1, limit - now()), ruinRoutes: CFG.lsRuin, stats: st
      });
      const used = (st.evals || 0) + 1;
      evals += used; lsEvals += used;
      const e = S.evaluate(instance, out, COST_ONLY);
      lsMs += now() - tl;
      if (better(e.total, e.feasible, total, feas)) {
        lsGain += total - e.total;
        return { solution: out, total: e.total, feasible: e.feasible, localOptimum: !!st.localOptimum };
      }
      return { solution: sol, total: total, feasible: feas, localOptimum: !!st.localOptimum };
    }

    // ---- start plan and the cost scale c0 ----
    // construct() is built even when hooks.start is given: it sets c0 (so the ants' heuristic does not
    // depend on how good or how broken the given plan is) and it is offered as a first best plan, so a
    // run stopped before its first ant still returns a violation-free plan when the given one is not
    // (a contingency re-plan's adjusted old plan can carry violations).
    const built = S.construct(instance, { rng: rng });
    const e0 = S.evaluate(instance, built);
    evals++;
    let startTotal = e0.total, startFrom = 'construct';
    if (hooks.start) {
      const given = S.normalize(instance, hooks.start);
      const eg = S.evaluate(instance, given, COST_ONLY);
      evals++;
      startTotal = eg.total;
      offer(given, eg.total, eg.feasible);
      startFrom = 'start';
    }
    if (offer(built, e0.total, e0.feasible) && hooks.start) startFrom = 'construct';
    let c0 = NaN;
    if (e0.stats.stops > 0) {
      const c = e0.cost;
      c0 = CFG.c0Share * (c.fuel + c.distance + c.risk + c.simplicity + c.platoon) / e0.stats.stops;
    }
    if (!(c0 > 0) || !isFinite(c0)) {
      // no stops to learn from: a round trip over an average leg, plus a stop
      let sum = 0, n = 0;
      const cm = P.wF * P.invMpg + P.wD * 0.5;
      for (let k = 0; k < P.nN * P.nN; k++) if (P.miles[k] > 0 && P.miles[k] < INF && P.minutes[k] < INF) { sum += cm * P.miles[k] + P.wR * P.risk[k]; n++; }
      c0 = CFG.c0Share * (n ? 2 * sum / n : 0) + P.wS * 5;
      if (!(c0 > 0) || !isFinite(c0)) c0 = 1;
    }
    const trails = makeTrails(P, p);
    const build = makeBuilder(instance, P, { beta: p.beta, c0: c0 });
    const stallLimit = mmax(CFG.stallMin, mceil(CFG.stallShare * budget));
    report(true);

    // ---- rounds ----
    if (nJ === 0 || P.nV === 0) stopReason = 'converged';
    while (!stopReason && it < budget) {
      phase = 'ants';
      let rb = null, rbTotal = INF, rbFeas = false, sum = 0, n = 0;
      for (antInRound = 0; antInRound < nAnts; antInRound++) {
        if (timeUp(searchEndAt)) break;
        const ta = now();
        const sol = build(rng, trails);
        const e = S.evaluate(instance, sol, COST_ONLY);
        evals++; antsBuilt++;
        antMs += now() - ta;
        sum += e.total; n++;
        if (e.feasible && e.total < antBest) antBest = e.total;
        if (rb === null || better(e.total, e.feasible, rbTotal, rbFeas)) { rb = sol; rbTotal = e.total; rbFeas = e.feasible; }
        report(false);
      }
      // the raw round-best ant is offered at once, so a run stopped mid-round keeps it
      let improved = rb !== null && offer(rb, rbTotal, rbFeas);
      if (stopReason) break;
      roundMean.push(n ? sum / n : INF);
      if (p.localSearch) {
        phase = 'ls';
        if (timeUp(searchEndAt)) break;
        // CFG.lsEvals evaluations: a first call of at most CFG.lsFirstChunk, then one for the rest
        // (progress between them), unless the first ends at a local optimum
        for (let left = CFG.lsEvals, first = true; left > 0; first = false) {
          const before = evals;
          const r1 = polishOnce(rb, rbTotal, rbFeas, first ? mmin(left, CFG.lsFirstChunk) : left, searchEndAt);
          left -= evals - before;
          rb = r1.solution; rbTotal = r1.total; rbFeas = r1.feasible;
          if (offer(rb, rbTotal, rbFeas)) improved = true;
          if (r1.localOptimum || left <= 0 || timeUp(searchEndAt)) break;
        }
      }
      it++; antInRound = 0;
      roundTotal = rbTotal;
      if (improved) lastImproveIt = it;
      trails.update(rb, rbTotal, best, bestTotal);
      if (it - lastImproveIt >= stallLimit) { trails.reset(); reinits++; lastImproveIt = it; }
      report(false);
    }
    if (!stopReason) stopReason = 'budget';

    // ---- final polish ----
    const acoBest = bestTotal;
    let polishEvals = 0;
    if (stopReason !== 'stopped' && stopReason !== 'converged' && p.localSearch) {
      phase = 'polish';
      report(true);
      const reason = stopReason;
      stopReason = null;
      let idle = 0;
      for (;;) {
        if (timeUp(endAt)) break;
        const before = evals;
        const r2 = polishOnce(best, bestTotal, bestFeas, CFG.lsChunk, endAt);
        polishEvals += evals - before;
        if (offer(r2.solution, r2.total, r2.feasible)) idle = 0; else idle++;
        report(false);
        if (r2.localOptimum || idle >= CFG.lsIdleChunks) break;
      }
      if (stopReason !== 'stopped') stopReason = reason;
    }

    phase = 'done';
    const fin = S.evaluate(instance, best, COST_ONLY);
    const elapsedSec = (now() - t0) / 1000;
    report(true);
    return {
      solution: best, total: fin.total, feasible: fin.feasible, evals: evals, iterations: it,
      elapsedSec: elapsedSec, stopReason: stopReason, history: history,
      extra: {
        ants: nAnts, antsBuilt: antsBuilt, antMs: antsBuilt ? antMs / antsBuilt : 0, startTotal: startTotal, startFrom: startFrom,
        antBest: antBest, roundMean: roundMean, acoBest: acoBest, polishGain: acoBest - fin.total, polishEvals: polishEvals,
        lsGain: lsGain, lsEvals: lsEvals, lsMs: lsMs, reinits: reinits, tauMin: trails.tauMin, tauMax: trails.tauMax,
        c0: c0, budget: budget
      }
    };
  }

  S.methods.aco = {
    key: 'aco',
    label: (S.METHOD_LABELS && S.METHOD_LABELS.aco) || 'Ant colony',
    run: run,
    // rounds the full run makes (the unit of result.iterations), for estimate.js
    budget: function (instance, params) { return readParams(params).iterations; },
    _cfg: CFG,
    _makeTrails: makeTrails,
    _makeBuilder: makeBuilder
  };
})(typeof self !== 'undefined' ? self : globalThis);
