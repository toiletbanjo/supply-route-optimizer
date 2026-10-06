// Exact method: MIP model generator (CPLEX LP text) + HiGHS runner + solution decoding (DESIGN.md
// section 7, "MIP (mip.js) - verified facts" and "Method interface"). Pure JS: no DOM; runs in the
// solver Web Worker and in Node tests.
//
//   SRO.solver.mip.setLoader(fn)          fn() -> promise for the highs module (Node: require('highs')();
//                                          worker: Module({ instantiateWasm }) from the inlined wasm)
//   SRO.solver.mip.ready() -> Promise     calls the loader once and caches the module
//   SRO.solver.mip.available() -> bool    true once ready() has resolved (alias isReady, for api.js)
//   SRO.solver.mip.buildModel(instance, { start?, reference?, factors?, capLateness?, waypoints? })
//                                          -> model (pure JS, no HiGHS needed: tests, size estimates)
//   SRO.solver.mip.toLP(model) -> LP text;  decode(model, values) -> solution;  objective(model, values);
//   checkValues(model, values) -> [violated rows/bounds];  periodFactors(instance, reference?)
//   SRO.solver.mip.highsOptions / modelOptions: extra HiGHS / buildModel options for every run
//                                          (experiments and tests; 'threads' is never passed)
//   SRO.solver.methods.mip.run(instance, params, hooks)  (method interface)
//
// ---- Formulation ------------------------------------------------------------------------------------
// Chunks. Each job is split into chunks no larger than the smallest capacity of the vehicles that may
// carry it (type + lock), so any chunk fits any of them. With a warm start the chunks follow the start
// plan: each (truck, node) piece of the job in the start becomes a chunk (split further if it is larger
// than that capacity), and the undelivered rest becomes chunk(s); this makes the start plan
// representable. Without a start a job becomes ceil(qty / smallest capacity) equal chunks. A chunk is
// delivered whole by one (vehicle, node) option or deferred.
//
// Stops. One delivery stop per (vehicle, node): every chunk a vehicle delivers at a node is merged into
// that stop, and a delivery stop delivers at least one chunk. Legs between places are "ways": the direct
// leg, plus the cheapest one-waypoint detour a -> w -> b when it costs less (riskUnits and miles need not
// obey the triangle inequality, so a detour around a risk zone can pay). A waypoint is an empty stop in
// the decoded plan and is costed exactly as evaluate() counts it: both legs, 5 x wS for the stop, service
// minutes, and the rally count when w is a rally node (never a banned node). Detours the start plan uses
// (a revisit of a node, an empty stop) are always included, so a start whose repeat visits only carry
// more of what the first visit could carry maps exactly (its deliveries move to the first visit of their
// node, which is never later). Variables:
//   k_v      binary   vehicle v used (25 x wS)           y_v_n   binary   v stops at n (5 x wS)
//   x_v_a_b[_wW] binary  v drives a -> b (a = s: start node, b = e: back to the hub), directly or via W;
//                     cost = miles x (wF / mpg + 0.5 wD) + wR x riskUnits x riskFactor (+ 5 wS via W)
//   z_c_v_n  binary   chunk c delivered by v at n         u_c     [0,1]    chunk c deferred (defer share)
//   T_v_n    cont.    arrival minute of v at n            L_c     >= 0     minutes chunk c is late
//   S_c      >= 0     minutes chunk c arrives after its job's prevEta (re-plans; cost slipPerMin x share)
//   b_c      binary   lateness (+ slip) of c capped (cost = lateCapShare x its deferral cost x share);
//                     only when the cap can bind (the latest possible arrival costs more than the cap)
//   w_q_n    [0,1]    platoon of request q comes to node n (wD x platoonCost)
//   g_j_v_n  [0,1]    job j delivered by v at n; h_j [0,1] j delivered at all (only for jobs of two or
//                     more chunks; cost EXTRA_CHUNK x wS x (g - h): evaluate's charge per extra chunk)
//   r_n      binary   rally node n used (only when maxRallyPoints can bind)
//   p_n      [0,1]    pinned rally node n receives nothing (pinUnused);   one = 1 carries constant costs
// Rows: assignment sum z + u = 1; z <= y; y <= sum z (no empty delivery stop); y <= k; flow in = flow out
// = y, out of the start = into the hub = k; capacity sum size x z <= cap x k; time T_b >= T_a + service +
// tau_ab - M(1 - x_ab) (also eliminates subtours) plus T_b >= sum_a (minT_a + service + tau_ab) x_ab;
// order o_b >= o_a + 1 - K(1 - x_ab), 0 <= o <= K - 1, on inner arcs that take under a minute (service 0
// and co-located nodes), where the time rows alone would allow a free closed loop beside the route;
// lateness L_c >= T_v_n - deadline - M(1 - z) - M' b_c per option and L_c + M' b_c >= sum (minT -
// deadline)+ z; slip S_c >= T_v_n - prevEta - M(1 - z) - M' b_c per option; platoon w_q_n >= sum_v
// z_c_v_n per chunk of the request; extra chunks g_j_v_n >= z_c_v_n per chunk of j, h_j <= sum g_j;
// rally y_v_n <= r_n, x via a rally waypoint <= r_w, sum r <= maxRallyPoints; pinned p_n + sum z_.._n
// >= 1; identical vehicles (same type, capacity, hub, start node, start time, no locked jobs) are used
// in index order (k_v >= k_v').
//
// Exact pruning only: options/arcs for the wrong vehicle type or lock (or an unlocked job on a preloaded
// en-route truck, which carries only its own loads), banned or unreachable nodes, rally
// nodes when maxRallyPoints = 0, rally -> rally arcs when it is 1, arcs a -> b with no two distinct chunks
// (one at a, one at b) that fit the vehicle together, and (v, n) pairs no route can reach within the
// number of stops the capacity allows. Time never prunes (lateness is soft).
//
// Approximations (documented; evaluate() remains the single source of truth and scores every plan):
//   - Travel minutes = base minutes / S and leg risk = riskUnits x R, where S and R are the time-weighted
//     means of period.speed and period.risk over the planning horizon [earliest truck start, max(that +
//     6 h, latest return of the reference plan)] (periodFactors). With one flat period (tests) the model
//     is exact: model objective = evaluate total for every plan it can represent.
//   - Splits only at chunk boundaries; at most one delivery stop per (vehicle, node); at most one waypoint
//     between two stops. The proven gap is relative to this model, not to every conceivable plan.
//   - Big-M time bounds: maxT = vehicle start + the longest ways of a route with as many stops as the
//     capacity allows (valid for every plan the model contains, so none is cut off).
//
// ---- Run ----------------------------------------------------------------------------------------------
// run(instance, params, hooks): (1) start plan = hooks.start, else (warmStart) a short tabu pass
// (SRO.solver.methods.tabu, or construct + localSearch when tabu is not loaded) of 10% of the time limit
// (2-10 s); with warmStart false the MIP runs cold and construct() is only the fallback plan. (2) build
// the model and LP text; the start mapped onto the model (deliveries at the first visit of their node)
// is decoded and scored too. (3) HiGHS with time_limit = what is left of min(timeLimitSec, timeCapSec),
// mip_rel_gap = mipGap, random_seed = seed, and the start as a MIP start (sparse, every column, mapped by
// column name: HiGHS numbers LP columns by first appearance), set only when it satisfies every row.
// Every improving incumbent is decoded, re-scored with evaluate and reported (hooks.onProgress with
// `best`) when its evaluate total is the best so far; mipInterrupt gives progress at most every 200 ms
// (fraction = elapsed / time limit, never decreasing; plus gap and dualBound in model terms) and stops
// the solve when hooks.shouldStop() is true. HiGHS fires no callback while it works inside a sub-MIP or
// a root cut round, so on Phase-1 models progress can pause for a few seconds. Returns the best plan by
// evaluate total among the start and all incumbents; extra = { status, statusCode, mipGap (proven gap of
// the returned plan: (its model objective - dual bound) / its model objective), highsGap, dualBound,
// modelObjective, planModelObjective, rows, cols, binaries, nnz, chunks, lpBytes, buildSec, solveSec,
// warmStartSec, startFrom, startTotal, startAccepted, startUsed, startExact, mipBestTotal, source
// ('start' | 'mip'), nodes, speedFactor, riskFactor, exactModel, firstIncumbentSec, error? } and proof =
// { stopReason: 'optimal' | 'gap' | 'time' | 'cancel' | 'error', gap (extra.mipGap), dualBound,
// gapTarget, exactModel } (what was proven: the gap is relative to the model, which is exact only with
// one flat period). stopReason 'optimal' only when the returned plan's gap is at most 1e-6: HiGHS
// reports 'Optimal' as soon as its gap is within mipGap, and that is stopReason 'gap', status 'Within
// target gap'. The HiGHS model is always disposed. When our own deadline check interrupts HiGHS (its
// time check lags on a busy machine) the status is 'Time limit reached'. When HiGHS itself fails (createModel or run throws: LP parse, wasm
// abort, memory) the start plan is returned with status 'Solve error', extra.error and a warning (in
// result.warnings); an error in this file's callbacks (decode / evaluate / onProgress) interrupts HiGHS at
// its next callback and is rethrown. decode() trims a load HiGHS packs over a capacity within its
// feasibility tolerance (a sliver chunk) from the largest chunk, so a decoded plan never overfills a truck.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};
  S.methods = S.methods || {};
  const MIP = S.mip = S.mip || {};
  const INF = Infinity, mmax = Math.max, mmin = Math.min, mabs = Math.abs, mceil = Math.ceil, mround = Math.round;
  const F64 = Float64Array, I32 = Int32Array, U8 = Uint8Array;
  const COST_ONLY = { costOnly: true };
  const SRC = -1, SNK = -2;                       // arc end codes: the start node / back to the hub
  const ZERO_ARC_MIN = 1;                         // inner arcs faster than this (service incl.) get order rows

  const STATUS_NAMES = { 0: 'Not set', 1: 'Load error', 2: 'Model error', 3: 'Presolve error', 4: 'Solve error',
    5: 'Postsolve error', 6: 'Empty', 7: 'Optimal', 8: 'Infeasible', 9: 'Primal infeasible or unbounded',
    10: 'Unbounded', 11: 'Bound on objective reached', 12: 'Target for objective reached', 13: 'Time limit reached',
    14: 'Iteration limit reached', 15: 'Unknown', 16: 'Solution limit reached', 17: 'Interrupted by user' };
  MIP.STATUS_NAMES = STATUS_NAMES;
  const OPTIMAL_GAP = 1e-6;                       // a returned plan within this gap of the dual bound is optimal
  // result.proof.stopReason from the method's stopReason
  const PROOF_REASON = { optimal: 'optimal', gap: 'gap', time: 'time', stopped: 'cancel' };

  function defaultNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function toNum(x) { return typeof x === 'bigint' ? Number(x) : (typeof x === 'number' ? x : Number(x)); }

  // ---- HiGHS loader ------------------------------------------------------------------------------------
  let loader = null, highs = null, pending = null, lastError = null;
  MIP.setLoader = function (fn) {
    loader = typeof fn === 'function' ? fn : null;
    highs = null; pending = null; lastError = null;
  };
  MIP.ready = function () {
    if (highs) return Promise.resolve(highs);
    if (pending) return pending;
    if (!loader) return Promise.reject(new Error('The exact solver (HiGHS) has no loader: call SRO.solver.mip.setLoader first.'));
    let p;
    try { p = Promise.resolve(loader()); } catch (e) { p = Promise.reject(e); }
    pending = p.then(function (h) {
      if (!h || typeof h.createModel !== 'function') throw new Error('The HiGHS loader did not return a highs module.');
      highs = h; lastError = null; return h;
    }, function (e) { pending = null; lastError = e; throw e; });
    return pending;
  };
  MIP.available = function () { return !!highs; };
  MIP.isReady = MIP.available;
  MIP.loadError = function () { return lastError; };
  MIP.highs = function () { return highs; };
  // Extra HiGHS options merged into every solve (tuning experiments; 'threads' is always ignored).
  MIP.highsOptions = MIP.highsOptions || {};
  // Extra buildModel options for every run (tests/experiments): { waypoints: false, capLateness: ... }.
  MIP.modelOptions = MIP.modelOptions || {};

  // ---- period factors ------------------------------------------------------------------------------
  // Time-weighted mean period speed and risk over the planning horizon (see the header). `reference`:
  // a plan whose latest return extends the horizon (optional). Returns { speed, risk, from, to, flat }.
  MIP.periodFactors = function (instance, reference) {
    const P = S.prepare(instance);
    let from = INF;
    for (let v = 0; v < P.nV; v++) if (P.vT0[v] < from) from = P.vT0[v];
    if (!(from < INF)) from = typeof instance.startMin === 'number' ? instance.startMin : 0;
    let to = from + 360;
    if (reference) {
      try {
        const ev = S.evaluate(instance, reference);
        (ev.routes || []).forEach(function (r) { if (r.returnAt > to && r.returnAt < INF) to = r.returnAt; });
      } catch (e) { /* malformed reference: keep the default horizon */ }
    }
    if (to > from + 7 * 1440) to = from + 7 * 1440;
    if (P.nP === 0) return { speed: 1, risk: 1, from: from, to: to, flat: true };
    let sSum = 0, rSum = 0, n = 0, s0 = -1, r0 = -1, flat = true;
    for (let t = from; t < to; t += 1) {
      const pi = S.periodIndex(P, t + 0.5);
      const sp = P.pSpeed[pi], rk = P.pRisk[pi];
      if (n === 0) { s0 = sp; r0 = rk; } else if (sp !== s0 || rk !== r0) flat = false;
      sSum += sp; rSum += rk; n++;
    }
    if (n === 0) { const pi = S.periodIndex(P, from); return { speed: P.pSpeed[pi], risk: P.pRisk[pi], from: from, to: to, flat: true }; }
    return { speed: flat ? s0 : sSum / n, risk: flat ? r0 : rSum / n, from: from, to: to, flat: flat };
  };

  // ---- model building ------------------------------------------------------------------------------
  function hasVisits(route) { return !!(route && route.visits && route.visits.length); }

  // All-pairs shortest base minutes (Floyd-Warshall); used for reachability and earliest arrivals.
  function shortestMinutes(P) {
    const n = P.nN, d = new F64(n * n);
    for (let i = 0; i < n * n; i++) { const x = P.minutes[i]; d[i] = (x < INF && P.miles[i] < INF) ? x : INF; }
    for (let i = 0; i < n; i++) d[i * n + i] = 0;
    for (let k = 0; k < n; k++) {
      const kr = k * n;
      for (let i = 0; i < n; i++) {
        const ik = d[i * n + k];
        if (ik === INF) continue;
        const ir = i * n;
        for (let j = 0; j < n; j++) { const v = ik + d[kr + j]; if (v < d[ir + j]) d[ir + j] = v; }
      }
    }
    return d;
  }

  // A route as segments between delivery stops: [{ a, b, ways: [waypoint nodes] }] with a = SRC or the
  // stop node, b = SNK or the next stop node. The delivery stop of a node is its first visit (when the
  // node is in `stops`); every other visit (a revisit, an empty visit) is a waypoint.
  function startSegments(visits, stops) {
    const first = new Map();
    (visits || []).forEach(function (vi, s) { if (!first.has(vi.node)) first.set(vi.node, s); });
    const segs = [];
    let a = SRC, ways = [];
    (visits || []).forEach(function (vi, s) {
      const n = vi.node;
      if (stops.has(n) && first.get(n) === s) { segs.push({ a: a, b: n, ways: ways }); a = n; ways = []; }
      else ways.push(n);
    });
    segs.push({ a: a, b: SNK, ways: ways });
    return segs;
  }

  MIP.buildModel = function (instance, opts) {
    opts = opts || {};
    const P = S.prepare(instance);
    const nN = P.nN, nV = P.nV, nJ = P.nJ;
    const svc = P.serviceMin;
    const factors = opts.factors || MIP.periodFactors(instance, opts.reference || opts.start || null);
    const spd = factors.speed > 0 ? factors.speed : 1, rkf = factors.risk >= 0 ? factors.risk : 1;
    const capMode = opts.capLateness == null ? 'auto' : opts.capLateness;
    const useWays = opts.waypoints !== false;
    const pen = S.resolvePenalties ? S.resolvePenalties(instance) : (instance.penalties || {});
    const pinUnused = typeof P.pinUnused === 'number' ? P.pinUnused : (pen.pinUnused || 0);
    const lateCap = function (j) {
      if (P.jLateCap) return P.jLateCap[j];
      const cs = typeof pen.lateCapShare === 'number' ? pen.lateCapShare : INF;
      return cs === INF ? INF : cs * P.jDeferW[j];
    };
    const pinNodes = P.pinNodes ? Array.from(P.pinNodes) : [];
    const maxRally = P.maxRally;
    const arcCostPerMile = P.wF * P.invMpg + 0.5 * P.wD;
    const SP = shortestMinutes(P);

    // ---- vehicles: compatibility, identical groups, start permutation --------------------------------
    const lockedTo = new U8(nV);
    for (let j = 0; j < nJ; j++) if (P.jLockV[j] >= 0) lockedTo[P.jLockV[j]] = 1;
    const groupOf = new I32(nV).fill(-1), groups = [];
    {
      const byKey = Object.create(null);
      for (let v = 0; v < nV; v++) {
        if (lockedTo[v]) continue;
        const key = P.vFuel[v] + '|' + P.vCap[v] + '|' + P.vHub[v] + '|' + P.vStart[v] + '|' + P.vT0[v] + '|' + P.vPre[v];
        if (!(key in byKey)) { byKey[key] = groups.length; groups.push([]); }
        groupOf[v] = byKey[key]; groups[byKey[key]].push(v);
      }
    }
    // The start plan, normalized, with each identical-vehicle group's used trucks moved to the group's
    // first indexes (same cost: the trucks are interchangeable for evaluate).
    let start = null;
    if (opts.start) {
      const ns = S.normalize(instance, opts.start);
      const routes = ns.routes.map(function (r) { return { vehicle: r.vehicle, visits: r.visits }; });
      groups.forEach(function (g) {
        if (g.length < 2) return;
        const order = g.filter(function (v) { return hasVisits(ns.routes[v]); }).concat(g.filter(function (v) { return !hasVisits(ns.routes[v]); }));
        for (let k = 0; k < g.length; k++) routes[g[k]] = { vehicle: g[k], visits: ns.routes[order[k]].visits };
      });
      start = { routes: routes };
    }

    const jobVehs = new Array(nJ), jobMinCap = new F64(nJ);
    for (let j = 0; j < nJ; j++) {
      const vs = [];
      let mc = INF;
      for (let v = 0; v < nV; v++) {
        if (P.vFuel[v] !== P.jFuel[j]) continue;
        if (P.jLockV[j] === -1 ? P.vPre[v] : P.jLockV[j] !== v) continue;   // lock; en-route trucks: own loads only
        if (!(P.vCap[v] > 0)) continue;
        vs.push(v); if (P.vCap[v] < mc) mc = P.vCap[v];
      }
      jobVehs[j] = vs; jobMinCap[j] = mc;
    }
    // basic reachability of node n for vehicle v (a path out of the start node and back to the hub)
    const reach = function (v, n) {
      return SP[P.vStart[v] * nN + n] < INF && SP[n * nN + P.vHub[v]] < INF;
    };
    const optionOk = function (j, v, n) {
      if (P.cand[j * nN + n] < 0) return false;
      if (maxRally === 0 && P.isRally[n]) return false;
      return reach(v, n);
    };

    // ---- chunks ---------------------------------------------------------------------------------------
    const chunks = [];                             // { job, size, share, sv, sn } (sv/sn: start option or -1)
    let startExact = !!start;
    const startNotes = [];
    function addChunks(j, qty, sv, sn) {
      const q = P.jQty[j], mc = jobMinCap[j];
      const k = mc < INF && qty > mc * (1 + 1e-9) ? mceil(qty / mc - 1e-9) : 1;
      let left = qty;
      for (let i = 0; i < k; i++) {
        const sz = i === k - 1 ? left : qty / k;
        left -= sz;
        chunks.push({ job: j, size: sz, share: q > 0 ? sz / q : 0, sv: sv, sn: sn });
      }
    }
    {
      const pieces = new Array(nJ);
      for (let j = 0; j < nJ; j++) pieces[j] = [];
      if (start) {
        for (let v = 0; v < nV; v++) {
          const visits = start.routes[v].visits;
          for (let s = 0; s < visits.length; s++) {
            const n = visits[s].node;
            const js = visits[s].jobs;
            for (let c = 0; c < js.length; c++) {
              const j = js[c].job, q = js[c].qty;
              if (!(q > 0)) continue;
              const list = pieces[j];
              let hit = null;
              for (let a = 0; a < list.length; a++) if (list[a].v === v && list[a].n === n) { hit = list[a]; break; }
              if (hit) hit.qty += q; else list.push({ v: v, n: n, qty: q });
            }
          }
        }
      }
      for (let j = 0; j < nJ; j++) {
        const q = P.jQty[j];
        if (!(q > 0)) continue;
        let used = 0;
        const list = pieces[j];
        for (let a = 0; a < list.length; a++) {
          const pc = list[a];
          let qty = mmin(pc.qty, q - used);
          if (!(qty > P.jEps[j])) { if (pc.qty > P.jEps[j]) { startExact = false; startNotes.push('over-qty job ' + j); } continue; }
          if (jobVehs[j].indexOf(pc.v) < 0 || !optionOk(j, pc.v, pc.n)) {
            startExact = false; startNotes.push('job ' + j + ' piece on vehicle ' + pc.v + ' at node ' + pc.n + ' is not a model option');
            continue;
          }
          addChunks(j, qty, pc.v, pc.n);
          used += qty;
        }
        const rest = q - used;
        if (rest > P.jEps[j]) addChunks(j, rest, -1, -1);
      }
    }
    const nC = chunks.length;

    // ---- options, visit sets, capacity-limited stop counts ---------------------------------------------
    const optsOf = new Array(nC);                  // per chunk [[v, n]]
    const vnChunks = new Array(nV);                // per vehicle Map node -> [chunk]
    for (let v = 0; v < nV; v++) vnChunks[v] = new Map();
    for (let c = 0; c < nC; c++) {
      const ch = chunks[c], j = ch.job, list = [];
      const vs = jobVehs[j], nodes = P.jCandNodes[j];
      for (let a = 0; a < vs.length; a++) {
        const v = vs[a];
        if (ch.size > P.vCap[v] * (1 + 1e-9)) continue;
        for (let b = 0; b < nodes.length; b++) {
          const n = nodes[b];
          if (!optionOk(j, v, n)) continue;
          list.push([v, n]);
          let m = vnChunks[v].get(n);
          if (!m) { m = []; vnChunks[v].set(n, m); }
          m.push(c);
        }
      }
      optsOf[c] = list;
    }
    const tau = function (a, b) { return P.minutes[a * nN + b] / spd; };
    // (a leg with infinite risk units would cost Infinity in evaluate: never worth modelling)
    const finiteLeg = function (a, b) { const k = a * nN + b; return P.minutes[k] < INF && P.miles[k] < INF && P.risk[k] < INF; };
    const legCost = function (a, b) { const k = a * nN + b; return P.miles[k] * arcCostPerMile + P.wR * P.risk[k] * rkf; };
    // rally nodes some vehicle may deliver at; only these (and non-rally, non-banned nodes) can be waypoints,
    // unless the rally limit can never bind
    const rallyUnion = new U8(nN);
    let totalRally = 0;
    for (let n = 0; n < nN; n++) if (P.isRally[n] && !P.banned[n]) totalRally++;
    for (let v = 0; v < nV; v++) vnChunks[v].forEach(function (list, n) { if (P.isRally[n]) rallyUnion[n] = 1; });
    const wayOk = function (w) {
      if (P.banned[w]) return false;
      if (!P.isRally[w]) return true;
      if (maxRally === 0) return false;
      return !!rallyUnion[w] || maxRally >= totalRally;
    };
    // waypoints the start plan uses between two consecutive delivery stops (forced via arcs)
    const startWays = new Array(nV);
    for (let v = 0; v < nV; v++) startWays[v] = new Map();
    if (start) {
      const stopAt = new Array(nV);
      for (let v = 0; v < nV; v++) stopAt[v] = new Set();
      chunks.forEach(function (ch) { if (ch.sv >= 0) stopAt[ch.sv].add(ch.sn); });
      for (let v = 0; v < nV; v++) {
        const segs = startSegments(start.routes[v].visits, stopAt[v]);
        segs.forEach(function (sg) {
          if (sg.ways.length !== 1) return;
          const key = sg.a + ',' + sg.b;
          let m = startWays[v].get(key); if (!m) { m = new Set(); startWays[v].set(key, m); }
          m.add(sg.ways[0]);
        });
      }
    }
    // Ways to drive from a to b (a = SRC or a node, b = SNK or a node): the direct leg, plus the cheapest
    // one-waypoint detour (an empty stop: +5 x wS, + service minutes) when it costs less than the direct
    // leg (risk and miles need not obey the triangle inequality), plus any detour the start plan uses.
    function wayList(v, a, b) {
      const A = a === SRC ? P.vStart[v] : a, B = b === SNK ? P.vHub[v] : b;
      const out = [];
      const dc = finiteLeg(A, B) ? legCost(A, B) : INF;
      if (dc < INF) out.push({ w: -1, cost: dc, tau: tau(A, B) });
      const forced = useWays ? startWays[v].get(a + ',' + b) : null;
      let best = null;
      for (let w = 0; w < (useWays ? nN : 0); w++) {
        if (w === A || w === B || !finiteLeg(A, w) || !finiteLeg(w, B)) continue;
        const isForced = !!(forced && forced.has(w));
        if (!isForced && !wayOk(w)) continue;
        if (maxRally === 1 && P.isRally[w] && ((a !== SRC && P.isRally[a]) || (b !== SNK && P.isRally[b]))) continue;
        const c = legCost(A, w) + legCost(w, B) + 5 * P.wS;
        const t = tau(A, w) + svc + tau(w, B);
        if (isForced) out.push({ w: w, cost: c, tau: t });
        else if (c < dc - 1e-9 * mmax(1, dc) && (!best || c < best.cost || (c === best.cost && t < best.tau))) best = { w: w, cost: c, tau: t };
      }
      if (best && !(forced && forced.has(best.w))) out.push(best);
      return out;
    }
    const veh = new Array(nV);
    for (let v = 0; v < nV; v++) {
      const st = P.vStart[v], hub = P.vHub[v], t0 = P.vT0[v], cap = P.vCap[v];
      const nodes = Array.from(vnChunks[v].keys()).sort(function (a, b) { return a - b; });
      // most stops a route can make: each stop needs its own chunk, all within the capacity
      const sizes = [];
      const seen = new U8(nC);
      nodes.forEach(function (n) { vnChunks[v].get(n).forEach(function (c) { if (!seen[c]) { seen[c] = 1; sizes.push(chunks[c].size); } }); });
      sizes.sort(function (a, b) { return a - b; });
      let K = 0, load = 0;
      for (let i = 0; i < sizes.length; i++) { if (load + sizes[i] > cap * (1 + 1e-9)) break; load += sizes[i]; K++; }
      K = mmin(K, nodes.length);
      // every way to drive between places, and the longest one out of each place (time big-M)
      const ways = new Map();
      let outS = 0;
      const outMax = [];
      nodes.forEach(function (b) {
        const l = wayList(v, SRC, b); ways.set(SRC + ',' + b, l);
        l.forEach(function (e) { outS = mmax(outS, e.tau); });
      });
      nodes.forEach(function (a) {
        let m = 0;
        nodes.forEach(function (b) {
          if (a === b) return;
          const l = wayList(v, a, b); ways.set(a + ',' + b, l);
          l.forEach(function (e) { m = mmax(m, e.tau); });
        });
        ways.set(a + ',' + SNK, wayList(v, a, SNK));
        outMax.push(m);
      });
      outMax.sort(function (a, b) { return b - a; });
      let H = t0 + outS;
      for (let i = 0; i < K - 1 && i < outMax.length; i++) H += outMax[i] + svc;
      const minT = new Map(), keep = [];
      nodes.forEach(function (n) {
        const mt = t0 + SP[st * nN + n] / spd;
        if (K < 1 || mt > H + 1e-9) return;        // no route within the stop limit reaches n
        minT.set(n, mt); keep.push(n);
      });
      veh[v] = { st: st, hub: hub, t0: t0, cap: cap, K: K, H: H, nodes: keep, minT: minT, ways: ways };
    }

    // ---- columns and rows -------------------------------------------------------------------------------
    const cName = [], cLb = [], cUb = [], cInt = [], cObj = [];
    const colIndex = new Map();
    function col(name, lb, ub, isInt, obj) {
      const i = cName.length;
      cName.push(name); cLb.push(lb); cUb.push(ub); cInt.push(isInt ? 1 : 0); cObj.push(obj || 0);
      colIndex.set(name, i);
      return i;
    }
    const rows = [];                               // { name, idx, val, sense: 'L'|'G'|'E', rhs }
    function row(name, idx, val, sense, rhs) { rows.push({ name: name, idx: idx, val: val, sense: sense, rhs: rhs }); }

    let constObj = 0;
    const kCol = new I32(nV).fill(-1);
    const yCol = new Array(nV), tCol = new Array(nV), zAt = new Array(nV), arcs = new Array(nV);
    const oCol = new Array(nV), zeroArcs = new Array(nV);   // order columns / zero-time inner arcs
    for (let v = 0; v < nV; v++) { oCol[v] = new Map(); zeroArcs[v] = []; }
    // z columns: zc[c] = [[v, n, col]]
    const zc = new Array(nC);
    // vehicles with at least one visitable node
    for (let v = 0; v < nV; v++) {
      yCol[v] = new Map(); tCol[v] = new Map(); zAt[v] = new Map(); arcs[v] = [];
      const V = veh[v];
      if (!V.nodes.length) continue;
      kCol[v] = col('k' + v, 0, 1, true, P.wS * 25);
      V.nodes.forEach(function (n) {
        yCol[v].set(n, col('y' + v + '_' + n, 0, 1, true, P.wS * 5));
        zAt[v].set(n, []);
      });
    }
    // chunk columns
    const uCol = new I32(nC).fill(-1), LCol = new I32(nC).fill(-1), SCol = new I32(nC).fill(-1), bCol = new I32(nC).fill(-1);
    for (let c = 0; c < nC; c++) {
      const ch = chunks[c], j = ch.job;
      const list = [];
      optsOf[c].forEach(function (o) {
        const v = o[0], n = o[1];
        if (!veh[v].minT.has(n)) return;
        const zi = col('z' + c + '_' + v + '_' + n, 0, 1, true, 0);
        list.push([v, n, zi]);
        zAt[v].get(n).push([c, zi]);
      });
      zc[c] = list;
      const deferCost = P.jDeferW[j] * ch.share;
      if (!list.length) { constObj += deferCost; continue; }
      uCol[c] = col('u' + c, 0, 1, false, deferCost);
    }
    // arcs per vehicle (pair-feasibility and rally pruning)
    for (let v = 0; v < nV; v++) {
      const V = veh[v];
      if (!V.nodes.length) continue;
      // two smallest chunks per node (size, chunk) for the pair test
      const small = new Map();
      V.nodes.forEach(function (n) {
        let a = null, b = null;
        zAt[v].get(n).forEach(function (e) {
          const c = e[0], sz = chunks[c].size;
          if (!a || sz < a[0]) { b = a; a = [sz, c]; } else if (!b || sz < b[0]) b = [sz, c];
        });
        small.set(n, [a, b]);
      });
      const pairOk = function (na, nb) {
        const A = small.get(na), B = small.get(nb);
        if (!A[0] || !B[0]) return false;
        const lim = V.cap * (1 + 1e-9);
        if (A[0][1] !== B[0][1]) return A[0][0] + B[0][0] <= lim;
        let best = INF;
        if (A[1]) best = mmin(best, A[1][0] + B[0][0]);
        if (B[1]) best = mmin(best, A[0][0] + B[1][0]);
        return best <= lim;
      };
      const xName = function (a, b, w) {
        return 'x' + v + '_' + (a === SRC ? 's' : a) + '_' + (b === SNK ? 'e' : b) + (w >= 0 ? '_w' + w : '');
      };
      const addArcs = function (a, b) {
        (V.ways.get(a + ',' + b) || []).forEach(function (e) {
          arcs[v].push([a, b, col(xName(a, b, e.w), 0, 1, true, e.cost), e.w, e.tau]);
        });
      };
      V.nodes.forEach(function (n) { addArcs(SRC, n); });
      V.nodes.forEach(function (a) {
        V.nodes.forEach(function (b) {
          if (a === b) return;
          if (maxRally === 1 && P.isRally[a] && P.isRally[b]) return;
          if (!pairOk(a, b)) return;
          addArcs(a, b);
        });
      });
      V.nodes.forEach(function (n) { addArcs(n, SNK); });
      V.nodes.forEach(function (n) {
        tCol[v].set(n, col('T' + v + '_' + n, V.minT.get(n), mmax(V.minT.get(n), V.H), false, 0));
      });
      // Inner arcs that take (almost) no time (service 0 and co-located nodes) cannot break a cycle
      // through the time rows, so a closed loop of them would "deliver" for free beside the real route.
      // Order rows on those arcs only (o_b >= o_a + 1 - K (1 - x_ab), 0 <= o <= K - 1) forbid such loops:
      // any cycle is either all zero-time arcs (cut here) or has an arc of >= ZERO_ARC_MIN (cut by time).
      arcs[v].forEach(function (e) {
        if (e[0] === SRC || e[1] === SNK || svc + e[4] >= ZERO_ARC_MIN) return;
        zeroArcs[v].push(e);
        [e[0], e[1]].forEach(function (n) {
          if (!oCol[v].has(n)) oCol[v].set(n, col('o' + v + '_' + n, 0, mmax(0, V.K - 1), false, 0));
        });
      });
    }
    // lateness and ETA-slip columns (one cap binary covers both, as evaluate caps lateness + stability)
    const maxLateOf = new F64(nC), maxSlipOf = new F64(nC), capMinOf = new F64(nC);
    for (let c = 0; c < nC; c++) {
      const ch = chunks[c], j = ch.job, d = P.jDeadline[j], e = P.jPrevEta[j], ws = P.jSlipW[j];
      if (!zc[c].length || (!(d < INF) && !(e < INF && ws > 0))) continue;
      let maxLate = 0, maxSlip = 0;
      zc[c].forEach(function (o) {
        const V = veh[o[0]];
        if (d < INF) maxLate = mmax(maxLate, V.H - d);
        if (e < INF && ws > 0) maxSlip = mmax(maxSlip, V.H - e);
      });
      maxLateOf[c] = maxLate; maxSlipOf[c] = maxSlip;
      const hasL = maxLate > 0 && P.jLateW[j] > 0, hasS = maxSlip > 0;
      if (hasL) LCol[c] = col('L' + c, 0, INF, false, P.jLateW[j] * ch.share);
      if (hasS) SCol[c] = col('S' + c, 0, INF, false, ws * ch.share);
      if (!hasL && !hasS) continue;
      const cap = lateCap(j);
      capMinOf[c] = cap < INF && hasL ? cap / P.jLateW[j] : INF;
      const wantCap = capMode === true || (capMode === 'auto' &&
        (hasS ? cap < (hasL ? maxLate * P.jLateW[j] : 0) + maxSlip * ws : capMinOf[c] < maxLate));
      if (wantCap && cap < INF) bCol[c] = col('b' + c, 0, 1, true, cap * ch.share);
    }
    // platoon columns: (request, node) pairs with a positive platoon cost
    const wCol = new Map();                        // key req * nN + n -> col
    for (let c = 0; c < nC; c++) {
      const j = chunks[c].job;
      zc[c].forEach(function (o) {
        const n = o[1], cost = P.candCost[j * nN + n];
        if (!(cost > 0)) return;
        const key = P.jReq[j] * nN + n;
        if (!wCol.has(key)) wCol.set(key, col('w' + P.jReq[j] + '_' + n, 0, 1, false, P.wD * cost));
      });
    }
    // extra-chunk columns (evaluate charges EXTRA_CHUNK x wS per positive chunk of a job after its
    // first; the chunks of a job at one stop are merged, so a job delivered by v at n is one chunk):
    // for a job with two or more model chunks, g_j_v_n [0,1] (j delivered by v at n) and h_j [0,1] (j
    // delivered at all); cost xc x (sum g - h), the delivery stops of the job less one
    const xc = P.wS * (S.EXTRA_CHUNK || 0);
    const gCol = new Map(), hCol = new Map();      // key (j * nV + v) * nN + n -> col; j -> col
    if (xc > 0) {
      const nOf = new I32(nJ);
      for (let c = 0; c < nC; c++) nOf[chunks[c].job]++;
      for (let c = 0; c < nC; c++) {
        const j = chunks[c].job;
        if (nOf[j] < 2) continue;
        zc[c].forEach(function (o) {
          const key = (j * nV + o[0]) * nN + o[1];
          if (!gCol.has(key)) gCol.set(key, col('g' + j + '_' + o[0] + '_' + o[1], 0, 1, false, xc));
          if (!hCol.has(j)) hCol.set(j, col('h' + j, 0, 1, false, -xc));   // only with a g to bound it
        });
      }
    }
    // rally columns: rally nodes a vehicle may stop at (deliveries or waypoints)
    const rallyNodes = [];
    {
      const seen = new U8(nN);
      const add = function (n) { if (n >= 0 && P.isRally[n] && !seen[n]) { seen[n] = 1; rallyNodes.push(n); } };
      for (let v = 0; v < nV; v++) { veh[v].nodes.forEach(add); arcs[v].forEach(function (e) { add(e[3]); }); }
      rallyNodes.sort(function (a, b) { return a - b; });
    }
    const rCol = new Map();
    if (maxRally < rallyNodes.length) rallyNodes.forEach(function (n) { rCol.set(n, col('r' + n, 0, 1, true, 0)); });
    // pinned columns
    const pCol = new Map();
    const zByNode = new Map();
    for (let v = 0; v < nV; v++) zAt[v].forEach(function (list, n) {
      let m = zByNode.get(n); if (!m) { m = []; zByNode.set(n, m); }
      list.forEach(function (e) { m.push(e[1]); });
    });
    pinNodes.forEach(function (n) {
      const zs = zByNode.get(n);
      if (zs && zs.length) pCol.set(n, col('p' + n, 0, 1, false, pinUnused));
      else constObj += pinUnused;
    });
    const oneCol = constObj !== 0 ? col('one', 1, 1, false, constObj) : -1;

    // ---- rows ---------------------------------------------------------------------------------------------
    for (let c = 0; c < nC; c++) {
      if (uCol[c] < 0) continue;
      const idx = [uCol[c]], val = [1];
      zc[c].forEach(function (o) { idx.push(o[2]); val.push(1); });
      row('as' + c, idx, val, 'E', 1);
    }
    for (let v = 0; v < nV; v++) {
      const V = veh[v];
      if (kCol[v] < 0) continue;
      const outs = new Map(), ins = new Map();
      V.nodes.forEach(function (n) { outs.set(n, []); ins.set(n, []); });
      const dep = [], ret = [];
      arcs[v].forEach(function (e) {
        if (e[0] === SRC) dep.push(e[2]); else outs.get(e[0]).push(e[2]);
        if (e[1] === SNK) ret.push(e[2]); else ins.get(e[1]).push(e[2]);
      });
      row('dp' + v, dep.concat([kCol[v]]), dep.map(function () { return 1; }).concat([-1]), 'E', 0);
      row('rt' + v, ret.concat([kCol[v]]), ret.map(function () { return 1; }).concat([-1]), 'E', 0);
      const capIdx = [], capVal = [];
      V.nodes.forEach(function (n) {
        const y = yCol[v].get(n);
        const o = outs.get(n), i = ins.get(n);
        row('fo' + v + '_' + n, o.concat([y]), o.map(function () { return 1; }).concat([-1]), 'E', 0);
        row('fi' + v + '_' + n, i.concat([y]), i.map(function () { return 1; }).concat([-1]), 'E', 0);
        const zs = zAt[v].get(n);
        const eIdx = [y], eVal = [1];
        zs.forEach(function (e) {
          row('zy' + e[0] + '_' + v + '_' + n, [e[1], y], [1, -1], 'L', 0);
          eIdx.push(e[1]); eVal.push(-1);
          capIdx.push(e[1]); capVal.push(chunks[e[0]].size);
        });
        row('ne' + v + '_' + n, eIdx, eVal, 'L', 0);
        row('yk' + v + '_' + n, [y, kCol[v]], [1, -1], 'L', 0);
      });
      capIdx.push(kCol[v]); capVal.push(-V.cap);
      row('cp' + v, capIdx, capVal, 'L', 0);
      // time: big-M per inner arc + predecessor lower bound per node
      const pred = new Map();
      V.nodes.forEach(function (n) { pred.set(n, [[tCol[v].get(n)], [1]]); });
      arcs[v].forEach(function (e) {
        const a = e[0], b = e[1], x = e[2];
        if (b === SNK) return;
        const Tb = tCol[v].get(b), pb = pred.get(b);
        if (a === SRC) {
          const lbv = V.t0 + e[4];
          if (lbv > V.minT.get(b) + 1e-9) { pb[0].push(x); pb[1].push(-lbv); }
          return;
        }
        const Ta = tCol[v].get(a), tt = e[4];
        const minTa = V.minT.get(a), maxTa = mmax(minTa, V.H), minTb = V.minT.get(b);
        const M = maxTa + svc + tt - minTb;
        if (M > 1e-9) row('tm' + v + '_' + a + '_' + b + (e[3] >= 0 ? '_w' + e[3] : ''), [Tb, Ta, x], [1, -1, -M], 'G', svc + tt - M);
        const lbv = minTa + svc + tt;
        if (lbv > minTb + 1e-9) { pb[0].push(x); pb[1].push(-lbv); }
      });
      V.nodes.forEach(function (n) {
        const pb = pred.get(n);
        if (pb[0].length > 1) row('tp' + v + '_' + n, pb[0], pb[1], 'G', 0);
      });
      zeroArcs[v].forEach(function (e) {
        const K = mmax(1, V.K);
        row('od' + v + '_' + e[0] + '_' + e[1] + (e[3] >= 0 ? '_w' + e[3] : ''), [oCol[v].get(e[1]), oCol[v].get(e[0]), e[2]], [1, -1, -K], 'G', 1 - K);
      });
    }
    // lateness
    for (let c = 0; c < nC; c++) {
      if (LCol[c] < 0) continue;
      const j = chunks[c].job, d = P.jDeadline[j], L = LCol[c], b = bCol[c];
      const Mb = maxLateOf[c];
      const aggIdx = [L], aggVal = [1];
      if (b >= 0) { aggIdx.push(b); aggVal.push(Mb); }
      zc[c].forEach(function (o) {
        const v = o[0], n = o[1], z = o[2], V = veh[v];
        const maxT = mmax(V.minT.get(n), V.H), Mz = maxT - d;
        if (!(Mz > 0)) return;                     // never late through this option
        const idx = [L, tCol[v].get(n), z], val = [1, -1, -Mz];
        if (b >= 0) { idx.push(b); val.push(Mb); }
        row('lt' + c + '_' + v + '_' + n, idx, val, 'G', -d - Mz);
        const lmin = V.minT.get(n) - d;
        if (lmin > 1e-9) { aggIdx.push(z); aggVal.push(-lmin); }
      });
      if (aggIdx.length > (b >= 0 ? 2 : 1)) row('la' + c, aggIdx, aggVal, 'G', 0);
    }
    // ETA slip (as lateness, against prevEta)
    for (let c = 0; c < nC; c++) {
      if (SCol[c] < 0) continue;
      const j = chunks[c].job, e = P.jPrevEta[j], Sc = SCol[c], b = bCol[c];
      const Mb = maxSlipOf[c];
      zc[c].forEach(function (o) {
        const v = o[0], n = o[1], z = o[2], V = veh[v];
        const maxT = mmax(V.minT.get(n), V.H), Mz = maxT - e;
        if (!(Mz > 0)) return;                     // never after prevEta through this option
        const idx = [Sc, tCol[v].get(n), z], val = [1, -1, -Mz];
        if (b >= 0) { idx.push(b); val.push(Mb); }
        row('st' + c + '_' + v + '_' + n, idx, val, 'G', -e - Mz);
      });
    }
    // platoon
    for (let c = 0; c < nC; c++) {
      const j = chunks[c].job;
      const byNode = new Map();
      zc[c].forEach(function (o) {
        const key = P.jReq[j] * nN + o[1];
        if (!wCol.has(key)) return;
        let m = byNode.get(key); if (!m) { m = []; byNode.set(key, m); }
        m.push(o[2]);
      });
      byNode.forEach(function (zs, key) {
        row('pl' + c + '_' + (key % nN), [wCol.get(key)].concat(zs), [1].concat(zs.map(function () { return -1; })), 'G', 0);
      });
    }
    // extra chunks: g_j_v_n >= z_c_v_n per chunk of the job, h_j <= sum g_j
    if (gCol.size) {
      const gsOf = new Map();
      for (let c = 0; c < nC; c++) {
        const j = chunks[c].job;
        zc[c].forEach(function (o) {
          const g = gCol.get((j * nV + o[0]) * nN + o[1]);
          if (g === undefined) return;
          row('gz' + c + '_' + o[0] + '_' + o[1], [g, o[2]], [1, -1], 'G', 0);
          let m = gsOf.get(j); if (!m) { m = new Set(); gsOf.set(j, m); }
          m.add(g);
        });
      }
      hCol.forEach(function (h, j) {
        const gs = Array.from(gsOf.get(j) || []);
        row('hg' + j, [h].concat(gs), [1].concat(gs.map(function () { return -1; })), 'L', 0);
      });
    }
    // rally limit
    if (rCol.size) {
      rCol.forEach(function (r, n) {
        for (let v = 0; v < nV; v++) if (yCol[v].has(n)) row('ry' + v + '_' + n, [yCol[v].get(n), r], [1, -1], 'L', 0);
      });
      for (let v = 0; v < nV; v++) arcs[v].forEach(function (e) {
        if (e[3] >= 0 && rCol.has(e[3])) row('rw' + v + '_' + e[3] + '_' + e[2], [e[2], rCol.get(e[3])], [1, -1], 'L', 0);
      });
      const idx = Array.from(rCol.values());
      row('rl', idx, idx.map(function () { return 1; }), 'L', maxRally);
    }
    // pinned rally points
    pCol.forEach(function (p, n) {
      const zs = zByNode.get(n);
      row('pn' + n, [p].concat(zs), [1].concat(zs.map(function () { return 1; })), 'G', 1);
    });
    // symmetry: identical vehicles are used in index order
    groups.forEach(function (g) {
      for (let i = 0; i + 1 < g.length; i++) {
        if (kCol[g[i]] >= 0 && kCol[g[i + 1]] >= 0) row('sy' + g[i + 1], [kCol[g[i]], kCol[g[i + 1]]], [1, -1], 'G', 0);
      }
    });

    let nnz = 0, nBin = 0;
    rows.forEach(function (r) { nnz += r.idx.length; });
    for (let i = 0; i < cInt.length; i++) nBin += cInt[i];
    const model = {
      instance: instance, P: P, factors: factors, chunks: chunks, zc: zc, veh: veh, arcs: arcs,
      kCol: kCol, yCol: yCol, tCol: tCol, oCol: oCol, zAt: zAt, uCol: uCol, LCol: LCol, SCol: SCol, bCol: bCol, wCol: wCol, rCol: rCol, pCol: pCol,
      gCol: gCol, hCol: hCol,
      oneCol: oneCol, constObj: constObj, groups: groups,
      cols: { name: cName, lb: cLb, ub: cUb, int: cInt, obj: cObj }, colIndex: colIndex, rows: rows,
      stats: {
        rows: rows.length, cols: cName.length, binaries: nBin, continuous: cName.length - nBin, nnz: nnz,
        chunks: nC, jobs: nJ, vehicles: nV, arcs: arcs.reduce(function (s, a) { return s + a.length; }, 0),
        visits: yCol.reduce(function (s, m) { return s + m.size; }, 0), options: zc.reduce(function (s, a) { return s + a.length; }, 0),
        capBinaries: bCol.reduce(function (s, b) { return s + (b >= 0 ? 1 : 0); }, 0),
        orderRows: zeroArcs.reduce(function (s, a) { return s + a.length; }, 0),
        maxStops: veh.map(function (V) { return V.K; })
      },
      exact: !!factors.flat,
      start: start, startExact: false, startValues: null, startNotes: startNotes
    };
    if (start) {
      const m = mapStart(model, start);
      model.startValues = m.values;
      model.startExact = startExact && m.exact;
      m.notes.forEach(function (s) { startNotes.push(s); });
    }
    return model;
  };

  // Column values (model order) for the (permuted, normalized) start plan. Chunks with a start option are
  // delivered there; a vehicle whose route the model cannot follow (an arc or stop it does not contain)
  // has its chunks deferred instead and `exact` turns false.
  function mapStart(model, start) {
    const P = model.P, nN = P.nN, nV = P.nV, svc = P.serviceMin;
    const spd = model.factors.speed > 0 ? model.factors.speed : 1;
    const x = new F64(model.cols.name.length);
    const notes = [];
    let exact = true;
    if (model.oneCol >= 0) x[model.oneCol] = 1;
    const chunks = model.chunks, nC = chunks.length;
    const delivered = new U8(nC);                   // chunk delivered in the mapped plan
    // chunks by start option
    const byOpt = new Map();
    for (let c = 0; c < nC; c++) {
      const ch = chunks[c];
      if (ch.sv < 0) continue;
      const key = ch.sv * nN + ch.sn;
      let m = byOpt.get(key); if (!m) { m = []; byOpt.set(key, m); }
      m.push(c);
    }
    const arcMap = new Array(nV);                   // 'a,b,w' -> arc entry
    for (let v = 0; v < nV; v++) {
      const m = new Map();
      model.arcs[v].forEach(function (e) { m.set(e[0] + ',' + e[1] + ',' + e[3], e); });
      arcMap[v] = m;
    }
    const arrive = new Map();                       // v * nN + n -> arrival minute (model time)
    const wayRally = new Set();                     // rally nodes used as waypoints
    for (let v = 0; v < nV; v++) {
      const visits = start.routes[v] ? start.routes[v].visits : [];
      const stops = new Set();
      visits.forEach(function (vi) { if (byOpt.has(v * nN + vi.node)) stops.add(vi.node); });
      if (!stops.size) continue;
      // deliveries move to the first visit of their node (never later); other visits become waypoints
      const segs = startSegments(visits, stops);
      let ok = model.kCol[v] >= 0;
      const used = [];
      for (let i = 0; i < segs.length && ok; i++) {
        const sg = segs[i];
        const e = sg.ways.length <= 1 ? arcMap[v].get(sg.a + ',' + sg.b + ',' + (sg.ways.length ? sg.ways[0] : -1)) : null;
        if (!e || (sg.b !== SNK && !model.yCol[v].has(sg.b))) { ok = false; break; }
        used.push(e);
      }
      if (!ok) { exact = false; notes.push('route of vehicle ' + v + ' is not representable; its chunks start deferred'); continue; }
      x[model.kCol[v]] = 1;
      const V = model.veh[v];
      let t = V.t0, pos = 0;
      used.forEach(function (e) {
        x[e[2]] = 1;
        if (e[3] >= 0 && P.isRally[e[3]]) wayRally.add(e[3]);
        if (e[1] === SNK) return;
        const n = e[1], T = t + e[4];
        arrive.set(v * nN + n, T);
        x[model.yCol[v].get(n)] = 1;
        x[model.tCol[v].get(n)] = T;
        if (model.oCol && model.oCol[v].has(n)) x[model.oCol[v].get(n)] = pos;
        pos++;
        byOpt.get(v * nN + n).forEach(function (c) {
          const o = model.zc[c].find(function (z) { return z[0] === v && z[1] === n; });
          if (o) { x[o[2]] = 1; delivered[c] = 1; }
        });
        t = T + svc;
      });
    }
    // unvisited arrival times sit at their lower bounds
    for (let v = 0; v < nV; v++) model.tCol[v].forEach(function (col, n) { if (!arrive.has(v * nN + n)) x[col] = model.cols.lb[col]; });
    for (let c = 0; c < nC; c++) {
      if (model.uCol[c] >= 0 && !delivered[c]) x[model.uCol[c]] = 1;
      const Lc = model.LCol[c], Sc = model.SCol ? model.SCol[c] : -1;
      if ((Lc < 0 && Sc < 0) || !delivered[c]) continue;
      const ch = chunks[c], j = ch.job, d = P.jDeadline[j];
      const T = arrive.get(ch.sv * nN + ch.sn);
      const late = Lc >= 0 ? T - d : 0, slip = Sc >= 0 ? T - P.jPrevEta[j] : 0;
      if (!(late > 0) && !(slip > 0)) continue;
      const b = model.bCol[c];
      if (b >= 0 && ((late > 0 ? late * P.jLateW[j] : 0) + (slip > 0 ? slip * P.jSlipW[j] : 0)) * ch.share > model.cols.obj[b]) x[b] = 1;
      else { if (late > 0) x[Lc] = late; if (slip > 0) x[Sc] = slip; }
    }
    // extra chunks: the (v, n) each job is delivered at
    if (model.gCol && model.gCol.size) {
      for (let c = 0; c < nC; c++) {
        if (!delivered[c]) continue;
        const j = chunks[c].job;
        model.zc[c].forEach(function (o) {
          if (!(x[o[2]] > 0.5)) return;
          const g = model.gCol.get((j * nV + o[0]) * nN + o[1]);
          if (g !== undefined) { x[g] = 1; x[model.hCol.get(j)] = 1; }
        });
      }
    }
    // platoon, rally, pinned
    model.wCol.forEach(function (col, key) {
      const req = Math.floor(key / nN), n = key % nN;
      for (let c = 0; c < nC; c++) {
        if (!delivered[c] || chunks[c].sn !== n || P.jReq[chunks[c].job] !== req) continue;
        x[col] = 1; break;
      }
    });
    model.rCol.forEach(function (col, n) {
      if (wayRally.has(n)) { x[col] = 1; return; }
      for (let v = 0; v < nV; v++) if (model.yCol[v].has(n) && x[model.yCol[v].get(n)] > 0.5) { x[col] = 1; break; }
    });
    model.pCol.forEach(function (col, n) {
      let any = false;
      for (let c = 0; c < nC && !any; c++) if (delivered[c] && chunks[c].sn === n) any = true;
      if (!any) x[col] = 1;
    });
    return { values: x, exact: exact, notes: notes };
  }
  MIP.mapStart = function (model, start) { return mapStart(model, start); };

  // ---- LP text -------------------------------------------------------------------------------------------
  function fmt(x) {
    if (x === mround(x) && mabs(x) < 1e15) return String(x);
    return String(Number(x.toPrecision(15)));
  }
  function terms(out, idx, val, names) {
    let n = 0;
    for (let i = 0; i < idx.length; i++) {
      const c = val[i];
      if (c === 0) continue;
      const a = mabs(c);
      out.push((n === 0 ? (c < 0 ? '- ' : '') : (c < 0 ? ' - ' : ' + ')) + (a === 1 ? '' : fmt(a) + ' ') + names[idx[i]]);
      n++;
      if (n % 10 === 0) out.push('\n  ');
    }
    return n;
  }
  MIP.toLP = function (model) {
    const names = model.cols.name, obj = model.cols.obj, lb = model.cols.lb, ub = model.cols.ub, isInt = model.cols.int;
    const out = ['\\ SRO supply route MIP (notional data)\nMinimize\n obj: '];
    const oi = [], ov = [];
    for (let i = 0; i < names.length; i++) if (obj[i] !== 0) { oi.push(i); ov.push(obj[i]); }
    if (!terms(out, oi, ov, names)) out.push('0 ' + (names[0] || 'dummy'));
    out.push('\nSubject To\n');
    model.rows.forEach(function (r) {
      out.push(' ' + r.name + ': ');
      if (!terms(out, r.idx, r.val, names)) out.push('0 ' + names[r.idx[0]]);
      out.push(r.sense === 'L' ? ' <= ' : r.sense === 'G' ? ' >= ' : ' = ', fmt(r.rhs), '\n');
    });
    out.push('Bounds\n');
    for (let i = 0; i < names.length; i++) {
      if (isInt[i]) continue;
      if (lb[i] === ub[i]) out.push(' ' + names[i] + ' = ' + fmt(lb[i]) + '\n');
      else if (lb[i] !== 0 || ub[i] !== INF) out.push(' ' + fmt(lb[i]) + ' <= ' + names[i] + ' <= ' + (ub[i] === INF ? 'inf' : fmt(ub[i])) + '\n');
    }
    out.push('Binary\n');
    let line = '';
    for (let i = 0; i < names.length; i++) {
      if (!isInt[i]) continue;
      line += ' ' + names[i];
      if (line.length > 200) { out.push(line, '\n'); line = ''; }
    }
    if (line) out.push(line, '\n');
    out.push('End\n');
    return out.join('');
  };

  // ---- values: objective, feasibility check, decoding ----------------------------------------------------
  MIP.objective = function (model, x) {
    const obj = model.cols.obj;
    let s = 0;
    for (let i = 0; i < obj.length; i++) if (obj[i] !== 0) s += obj[i] * x[i];
    return s;
  };
  // Rows, bounds and integrality violated by x (model column order), with an absolute + relative tolerance.
  MIP.checkValues = function (model, x, tol) {
    tol = tol == null ? 1e-6 : tol;
    const out = [], C = model.cols;
    for (let i = 0; i < C.name.length; i++) {
      const v = x[i];
      if (!(v >= C.lb[i] - tol * mmax(1, mabs(C.lb[i]))) || !(v <= C.ub[i] + tol * mmax(1, mabs(C.ub[i])))) out.push({ kind: 'bound', name: C.name[i], value: v, lb: C.lb[i], ub: C.ub[i] });
      else if (C.int[i] && mabs(v - mround(v)) > 1e-6) out.push({ kind: 'integer', name: C.name[i], value: v });
    }
    model.rows.forEach(function (r) {
      let a = 0, scale = mabs(r.rhs);
      for (let k = 0; k < r.idx.length; k++) { const t = r.val[k] * x[r.idx[k]]; a += t; scale = mmax(scale, mabs(t)); }
      const e = tol * mmax(1, scale);
      const bad = r.sense === 'L' ? a > r.rhs + e : r.sense === 'G' ? a < r.rhs - e : mabs(a - r.rhs) > e;
      if (bad) out.push({ kind: 'row', name: r.name, activity: a, sense: r.sense, rhs: r.rhs });
    });
    return out;
  };

  // Solution for column values x (model order): each used vehicle follows its arcs from the start node;
  // a stop the arcs do not reach (numerical noise only) is placed by its arrival time. Chunks of one job
  // at one stop are merged.
  MIP.decode = function (model, x) {
    const P = model.P, nV = P.nV;
    const sol = S.emptySolution(model.instance);
    const taken = new U8(model.chunks.length);
    for (let v = 0; v < nV; v++) {
      if (model.kCol[v] < 0 || !(x[model.kCol[v]] > 0.5)) continue;
      const next = new Map();                     // a -> [b, waypoint] of the active arc out of a
      model.arcs[v].forEach(function (e) { if (x[e[2]] > 0.5 && !next.has(e[0])) next.set(e[0], [e[1], e[3]]); });
      const seq = [], inSeq = new Set();          // [{ n, w }]: stop n, reached through waypoint w (-1: direct)
      let cur = SRC, tail = -1;
      for (let g = 0; g <= model.veh[v].nodes.length; g++) {
        const nx = next.get(cur);
        if (!nx) break;
        if (nx[0] === SNK) { tail = nx[1]; break; }
        if (inSeq.has(nx[0])) break;
        seq.push({ n: nx[0], w: nx[1] }); inSeq.add(nx[0]); cur = nx[0];
      }
      const rest = [];
      model.yCol[v].forEach(function (col, n) { if (x[col] > 0.5 && !inSeq.has(n)) rest.push(n); });
      rest.sort(function (a, b) { return x[model.tCol[v].get(a)] - x[model.tCol[v].get(b)]; });
      // (numerical noise only) place each leftover stop before the first stop with a later arrival time
      rest.forEach(function (n) {
        const tn = x[model.tCol[v].get(n)];
        let at = seq.length;
        for (let i = 0; i < seq.length; i++) if (x[model.tCol[v].get(seq[i].n)] > tn) { at = i; break; }
        seq.splice(at, 0, { n: n, w: -1 });
      });
      const visits = [];
      seq.forEach(function (it) {
        const n = it.n, jobs = [];
        (model.zAt[v].get(n) || []).forEach(function (e) {
          const c = e[0];
          if (taken[c] || !(x[e[1]] > 0.5)) return;
          taken[c] = 1;
          const ch = model.chunks[c];
          for (let k = 0; k < jobs.length; k++) if (jobs[k].job === ch.job) { jobs[k].qty += ch.size; return; }
          jobs.push({ job: ch.job, qty: ch.size });
        });
        if (it.w >= 0) visits.push({ node: it.w, jobs: [], waypoint: true });
        visits.push({ node: n, jobs: jobs });
      });
      if (tail >= 0) visits.push({ node: tail, jobs: [], waypoint: true });
      sol.routes[v].visits = visits;
    }
    // never deliver more than a job's quantity (float noise in chunk sums)
    const P2 = P, got = new F64(P2.nJ);
    sol.routes.forEach(function (r) { r.visits.forEach(function (vi) { vi.jobs.forEach(function (c) { got[c.job] += c.qty; }); }); });
    for (let j = 0; j < P2.nJ; j++) {
      let over = got[j] - P2.jQty[j];
      if (!(over > 0)) continue;
      for (let r = sol.routes.length - 1; r >= 0 && over > 0; r--) {
        const vs = sol.routes[r].visits;
        for (let s = vs.length - 1; s >= 0 && over > 0; s--) {
          vs[s].jobs.forEach(function (c) { if (c.job === j && over > 0) { const d = mmin(over, c.qty); c.qty -= d; over -= d; } });
        }
      }
    }
    // never load more than the capacity: HiGHS accepts rows within its feasibility tolerance (~1e-7 to
    // 1e-6 absolute), evaluate only 1e-9 x capacity, so tiny chunks (slivers a heuristic start split off)
    // can overfill a truck by a hair. Trim the excess from the largest chunks (it is deferred instead), so
    // no stop loses its delivery (an emptied stop or pinned point would change the plan, not just the qty).
    sol.routes.forEach(function (r) {
      const cap = P.vCap[r.vehicle];
      const items = [];
      let load = 0;
      r.visits.forEach(function (vi) { vi.jobs.forEach(function (c) { load += c.qty; items.push(c); }); });
      let over = load - cap;
      if (!(over > 0)) return;
      items.sort(function (a, b) { return b.qty - a.qty; });
      for (let i = 0; i < items.length && over > 0; i++) { const d = mmin(over, items[i].qty); items[i].qty -= d; over -= d; }
    });
    // a waypoint (an empty stop that makes a cheaper detour) stays; a delivery stop left empty goes
    sol.routes.forEach(function (r) {
      r.visits = r.visits.map(function (vi) { return { node: vi.node, jobs: vi.jobs.filter(function (c) { return c.qty > 0; }), way: !!vi.waypoint }; })
        .filter(function (vi) { return vi.way || vi.jobs.length > 0; })
        .map(function (vi) { return { node: vi.node, jobs: vi.jobs }; });
      // a route of waypoints only delivers nothing: drop it
      if (!r.visits.some(function (vi) { return vi.jobs.length > 0; })) r.visits = [];
    });
    return sol;
  };

  // ---- method -------------------------------------------------------------------------------------------
  function mipError(code, message) {
    if (typeof S.solverError === 'function') return S.solverError(code, message);
    const e = new Error(message); e.code = code; return e;
  }

  function warmPhase(instance, p, budgetSec, now, outerStop, forward) {
    const tabu = S.methods.tabu;
    const t0 = now();
    if (tabu && typeof tabu.run === 'function') {
      const tp = S.clampParams ? S.clampParams('tabu', { seed: p.seed }) : { seed: p.seed };
      tp.timeCapSec = budgetSec;                   // below the form minimum on purpose (tabu honors it)
      const res = tabu.run(instance, tp, {
        now: now,
        shouldStop: function () { return outerStop() || (now() - t0) / 1000 >= budgetSec; },
        onProgress: forward
      });
      return { solution: res.solution, from: 'tabu', evals: res.evals || 0 };
    }
    const rng = SRO.util.rng(p.seed);
    let sol = S.construct(instance, { rng: rng });
    const st = {};
    sol = S.localSearch(instance, sol, { rng: rng, now: now, timeLimitMs: budgetSec * 1000, stats: st });
    return { solution: sol, from: 'localsearch', evals: st.evals || 0 };
  }

  function run(instance, params, hooks) {
    hooks = hooks || {};
    const now = typeof hooks.now === 'function' ? hooks.now : defaultNow;
    const T0 = now();
    const elapsed = function () { return (now() - T0) / 1000; };
    const userStop = typeof hooks.shouldStop === 'function' ? hooks.shouldStop : function () { return false; };
    const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : null;
    const p = Object.assign(S.defaultParams ? S.defaultParams('mip') : {}, params || {});
    const seed = typeof p.seed === 'number' && isFinite(p.seed) ? mabs(mround(p.seed)) % 2147483647 : 0;
    let limit = typeof p.timeLimitSec === 'number' && p.timeLimitSec > 0 ? p.timeLimitSec : 300;
    if (typeof p.timeCapSec === 'number' && p.timeCapSec > 0) limit = mmin(limit, p.timeCapSec);
    const gapTarget = typeof p.mipGap === 'number' && p.mipGap >= 0 ? p.mipGap : 0.01;
    const warm = p.warmStart !== false;
    const H = highs;
    if (!H) throw mipError('mip-unavailable', 'The exact solver (HiGHS) is not loaded, so Exact (MIP) cannot run here. Pick another method.');

    let evals = 0, stopped = false;
    const history = [], warnings = [];
    let best = null, sentBest = null, lastReport = -INF, lastGap = null, nodes = 0, mipBest = INF, firstInc = null, lastFrac = 0, lastBound = null;
    const report = function (fraction, message, force) {
      if (!onProgress) return;
      const t = now();
      if (!force && t - lastReport < 200) return;
      lastReport = t;
      lastFrac = mmax(lastFrac, mmin(1, fraction));
      const msg = { fraction: lastFrac, bestCost: best ? best.total : null, elapsedSec: elapsed(), iteration: nodes, message: message };
      if (lastGap != null && isFinite(lastGap)) msg.gap = lastGap;          // HiGHS gap of its incumbent (model terms)
      if (lastBound != null && isFinite(lastBound)) msg.dualBound = lastBound;
      if (best && best.solution !== sentBest) { msg.best = best.solution; sentBest = best.solution; }
      onProgress(msg);
    };
    const consider = function (solution, values, source) {
      const e = S.evaluate(instance, solution, COST_ONLY);
      evals++;
      const better = !best || (e.feasible && !best.feasible) || (e.feasible === best.feasible && e.total < best.total - 1e-9 * mmax(1, mabs(best.total)));
      if (better) {
        best = { solution: solution, total: e.total, feasible: e.feasible, values: values, source: source };
        history.push({ t: elapsed(), best: e.total });
      }
      if (source === 'mip' && e.feasible && !(e.total >= mipBest)) mipBest = e.total;
      return better;
    };

    // 1. start plan
    let start = hooks.start || null, startFrom = start ? 'hooks' : null, warmSec = 0;
    if (!start && warm) {
      const budget = mmin(10, mmax(2, 0.1 * limit), 0.5 * limit);
      const res = warmPhase(instance, p, budget, now, userStop, function (q) {
        if (!onProgress) return;
        lastFrac = mmax(lastFrac, mmin(1, (q.fraction || 0) * budget / limit));
        const msg = Object.assign({}, q, { fraction: lastFrac, elapsedSec: elapsed(), message: 'Warm start: ' + (q.message || 'heuristic pass') });
        if (q.best) sentBest = q.best;
        lastReport = now();
        onProgress(msg);
      });
      start = res.solution; startFrom = res.from; evals += res.evals; warmSec = elapsed();
    }
    if (!start) { start = S.construct(instance); startFrom = 'construct'; }
    consider(start, null, 'start');
    const startTotal = best.total;
    report(elapsed() / limit, 'Start plan ready', true);
    if (userStop()) stopped = true;

    // 2. model
    const tb = now();
    const model = MIP.buildModel(instance, Object.assign({}, MIP.modelOptions, { start: warm ? start : null, reference: start }));
    const lp = MIP.toLP(model);
    // The start's column values describe the start plan with every delivery at the first visit of its node
    // (never costlier). Decode and score them: that plan, with its values, joins the candidates.
    if (warm && model.startValues && model.startExact) {
      const mapped = MIP.decode(model, model.startValues);
      const em = S.evaluate(instance, mapped, COST_ONLY);
      evals++;
      if (em.feasible && em.total <= best.total + 1e-9 * mmax(1, mabs(best.total))) {
        if (em.total < best.total - 1e-9 * mmax(1, mabs(best.total))) consider(mapped, model.startValues, 'start');
        else best.values = model.startValues;
      }
    }
    const buildSec = (now() - tb) / 1000;
    const extra = {
      status: 'Not run', statusCode: 0, mipGap: null, highsGap: null, dualBound: null, modelObjective: null,
      rows: model.stats.rows, cols: model.stats.cols, binaries: model.stats.binaries, nnz: model.stats.nnz,
      chunks: model.stats.chunks, lpBytes: lp.length, buildSec: buildSec, warmStartSec: warmSec,
      startFrom: startFrom, startTotal: startTotal, startAccepted: null, startExact: model.startExact,
      speedFactor: model.factors.speed, riskFactor: model.factors.risk, exactModel: model.exact, source: 'start', nodes: 0, solveSec: 0
    };

    // 3. HiGHS
    let stopReason = stopped ? 'stopped' : 'time';
    const remaining = limit - elapsed();
    if (!stopped && model.stats.binaries === 0) {
      // nothing to decide (no truck can take any load): every job is deferred, which the start already is
      const allDeferred = MIP.decode(model, new F64(model.cols.name.length).fill(0));
      const x = new F64(model.cols.name.length);
      if (model.oneCol >= 0) x[model.oneCol] = 1;
      model.uCol.forEach(function (c) { if (c >= 0) x[c] = 1; });
      model.pCol.forEach(function (c) { x[c] = 1; });
      consider(allDeferred, x, 'mip');
      if (best.solution === allDeferred || !best.values) best.values = x;
      extra.status = STATUS_NAMES[7]; extra.statusCode = 7;
      extra.modelObjective = extra.dualBound = MIP.objective(model, x);
      stopReason = 'optimal';
    } else if (!stopped && remaining > 0.25) {
      // A failure inside HiGHS itself (LP parse, wasm abort, out of memory) keeps the start plan: the
      // result says 'Solve error' (extra.error, warnings) instead of losing the warm-start work.
      // Errors in this file's own callbacks (decode / evaluate) still throw.
      const ts = now();
      let hm = null, cbError = null, timedOut = false;
      const highsFailed = function (e) {
        extra.status = 'Solve error'; extra.statusCode = 4;
        extra.error = String((e && e.message) || e);
        warnings.push('The exact solver (HiGHS) failed (' + extra.error + '); the plan shown is its start plan.');
        stopReason = 'converged';
      };
      try { hm = H.createModel({ format: 'lp', data: lp }); } catch (e) { highsFailed(e); }
      if (hm) try {
        const left = mmax(0.2, limit - elapsed());
        const o = { output_flag: false, time_limit: left, mip_rel_gap: gapTarget, random_seed: seed };
        for (const k in MIP.highsOptions) if (k !== 'threads' && Object.prototype.hasOwnProperty.call(MIP.highsOptions, k)) o[k] = MIP.highsOptions[k];
        hm.options.set(o);
        const nCols = hm.getDimensions().numCols;
        const toMine = new I32(nCols);
        const mineToH = new I32(model.cols.name.length).fill(-1);
        for (let i = 0; i < nCols; i++) {
          const k = model.colIndex.get(hm.getColName(i));
          if (k == null) throw new Error('MIP column ' + hm.getColName(i) + ' is not in the model.');
          toMine[i] = k; mineToH[k] = i;
        }
        if (warm && model.startValues) {
          const bad = MIP.checkValues(model, model.startValues, 1e-7);
          if (!bad.length) {
            const idx = [], val = [];
            for (let k = 0; k < mineToH.length; k++) if (mineToH[k] >= 0) { idx.push(mineToH[k]); val.push(model.startValues[k]); }
            const r = hm.setSolution({ indices: idx, values: val });
            extra.startAccepted = !!r && (r.status === 0 || r.status === 1 || r.status == null);
          } else {
            extra.startAccepted = false;
            extra.startProblem = bad.slice(0, 3).map(function (b) { return b.name; }).join(', ');
          }
        }
        const C = H.constants.callbackType;
        let incumbentObj = INF;
        const fromH = function (vec) {
          const x = new F64(model.cols.name.length);
          for (let i = 0; i < nCols; i++) x[toMine[i]] = vec[i];
          return x;
        };
        const gapText = function (g) { return g != null && isFinite(g) ? ', proven within ' + (100 * g).toFixed(1) + '%' : ''; };
        const cbs = {};
        cbs[C.mipImprovingSolution] = function (ev) {
          try {
            const d = ev.data;
            nodes = toNum(d.mip_node_count) || nodes;
            if (typeof d.objective_function_value === 'number' && d.objective_function_value < incumbentObj) incumbentObj = d.objective_function_value;
            if (firstInc === null) firstInc = { t: elapsed(), obj: d.objective_function_value };
            if (typeof d.mip_gap === 'number') lastGap = d.mip_gap;
            if (typeof d.mip_dual_bound === 'number') lastBound = d.mip_dual_bound;
            if (!d.mip_solution) return;
            const x = fromH(d.mip_solution);
            const sol = MIP.decode(model, x);
            if (consider(sol, x, 'mip')) report(elapsed() / limit, 'New best plan' + gapText(d.mip_gap), true);
          } catch (e) { cbError = cbError || e; }
        };
        cbs[C.mipInterrupt] = function (ev) {
          try {
            const d = ev.data;
            nodes = toNum(d.mip_node_count) || nodes;
            if (typeof d.mip_gap === 'number') lastGap = d.mip_gap;
            if (typeof d.mip_dual_bound === 'number') lastBound = d.mip_dual_bound;
            if (cbError) { ev.interrupt(); return; }           // a decode/evaluate error: stop now
            if (userStop()) { stopped = true; ev.interrupt(); return; }
            if (elapsed() > limit + 0.5) { timedOut = true; ev.interrupt(); return; }
            report(elapsed() / limit, 'Searching for a proof' + gapText(d.mip_gap));
          } catch (e) { cbError = cbError || e; }
        };
        let runError = null;
        try { hm.run(cbs); } catch (e) { runError = e; }
        if (cbError) throw cbError;
        if (runError) {
          highsFailed(runError);
          if (incumbentObj < INF) extra.modelObjective = incumbentObj;   // incumbents already decoded
        } else {
          let code = hm.getModelStatus();
          // our own deadline interrupt (HiGHS's time check lags behind on a busy machine) is a time limit
          if (code === 17 && timedOut && !stopped) code = 13;
          const info = function (n) { try { return toNum(hm.info.get(n)); } catch (e) { return null; } };
          extra.statusCode = code;
          extra.status = STATUS_NAMES[code] || String(code);
          extra.highsGap = info('mip_gap');
          extra.dualBound = info('mip_dual_bound');
          nodes = info('mip_node_count') || nodes;
          if (info('primal_solution_status') === 2) {
            const x = fromH(hm.getSolution().colValue);
            extra.modelObjective = hm.getObjectiveValue();
            consider(MIP.decode(model, x), x, 'mip');
          } else if (incumbentObj < INF) extra.modelObjective = incumbentObj;
          stopReason = code === 7 ? 'optimal' : stopped ? 'stopped' : code === 13 || code === 17 ? 'time' : 'converged';
        }
      } finally {
        extra.solveSec = (now() - ts) / 1000;
        try { hm.dispose(); } catch (e) { /* the module is already broken: nothing left to free */ }
      }
    }
    // proven gap of the returned plan against the model's dual bound
    extra.nodes = nodes;
    extra.source = best.source;
    extra.mipBestTotal = mipBest < INF ? mipBest : null;     // best evaluate total among the MIP's own incumbents
    if (firstInc) { extra.firstIncumbentSec = firstInc.t; extra.firstIncumbentObjective = firstInc.obj; }
    // HiGHS took the MIP start when its first incumbent has the start's model objective
    if (extra.startAccepted && firstInc && model.startValues) {
      const so = MIP.objective(model, model.startValues);
      extra.startUsed = mabs(firstInc.obj - so) <= 1e-6 * mmax(1, mabs(so));
    }
    const bound = extra.dualBound;
    if (best.values && typeof bound === 'number' && isFinite(bound)) {
      const mo = MIP.objective(model, best.values);
      extra.planModelObjective = mo;
      extra.mipGap = mmax(0, (mo - bound) / mmax(1e-9, mabs(mo)));
    } else if (typeof extra.highsGap === 'number' && isFinite(extra.highsGap)) extra.mipGap = extra.highsGap;
    if (extra.highsGap != null && !isFinite(extra.highsGap)) extra.highsGap = null;
    if (extra.dualBound != null && !isFinite(extra.dualBound)) extra.dualBound = null;
    // HiGHS reports 'Optimal' (7) as soon as its gap is within mip_rel_gap, so 7 with a gap left on the
    // returned plan is the gap target, not a proof of optimality
    if (stopReason === 'optimal' && !(extra.mipGap != null && extra.mipGap <= OPTIMAL_GAP)) {
      stopReason = 'gap'; extra.status = 'Within target gap';
    }
    const proof = {
      stopReason: PROOF_REASON[stopReason] || 'error', gap: extra.mipGap, dualBound: extra.dualBound,
      gapTarget: gapTarget, exactModel: !!model.exact
    };
    report(1, extra.status + (extra.mipGap != null ? (stopReason === 'optimal' ? '' : ', proven within ' + (100 * extra.mipGap).toFixed(1) + '% of the model\'s best') : ''), true);
    return {
      solution: best.solution, total: best.total, feasible: best.feasible, evals: evals, iterations: nodes,
      elapsedSec: elapsed(), stopReason: stopReason, history: history, extra: extra, proof: proof, warnings: warnings
    };
  }

  S.methods.mip = { key: 'mip', label: (S.METHOD_LABELS && S.METHOD_LABELS.mip) || 'Exact (MIP)', exact: true, run: run };
})(typeof self !== 'undefined' ? self : globalThis);
