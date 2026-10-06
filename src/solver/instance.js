// Solver instance helpers (DESIGN.md section 7): defaults, a cached "prepared" view of an instance
// used by evaluate/construct/moves, validation, candidate lookups, period expansion and a seeded
// synthetic instance generator for tests and the run-time estimator.
//
// Pure JS: no DOM, runs in the solver Web Worker, on the main thread and in Node tests.
//
// Prepared view: SRO.solver.prepare(instance) flattens matrices and per-job/per-vehicle data into
// typed arrays and caches them (WeakMap keyed by the instance object). The cache is rebuilt when the
// instance's top-level arrays/objects are replaced, when params.pinnedRally / params.bannedRally or a
// penalties array is replaced, or when a weight / key param (mpg, serviceMin, loadMin, maxRallyPoints)
// changes; call SRO.solver.prepare.invalidate(instance) after any other in-place edit (a job, vehicle,
// period or matrix cell). Hot paths call prepare() on every evaluate, so the check stays O(1).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};
  // Local aliases: global lookups are slow inside Node vm contexts (tests) and cost nothing here.
  const INF = Infinity, mmax = Math.max, mmin = Math.min, mabs = Math.abs, mceil = Math.ceil, mfloor = Math.floor, mround = Math.round;
  const isArray = Array.isArray, F64 = Float64Array, I32 = Int32Array, U8 = Uint8Array;

  // ---- constants --------------------------------------------------------------------------------
  S.VIOLATION_PENALTY = 1e7;
  S.TIER_NAMES = ['Routine', 'Priority', 'Urgent', 'Immediate'];
  S.GROUP_TYPE = { fuel: 'tanker', cargo: 'cargo' };          // load group -> vehicle type
  S.DEFAULT_WEIGHTS = { fuel: 3, distance: 3, risk: 5, simplicity: 2 };
  S.DEFAULT_PENALTIES = {
    latePerMin: [1, 3, 50, 500],
    defer: [200, 600, 5000, 50000],
    classFactor: [1.0, 0.9, 0.85, 0.8, 0.6]
  };
  S.DEFAULT_PERIOD_TABLE = [
    { name: 'Day', start: '0700', end: '1800', speed: 1.0, risk: 1.0 },
    { name: 'Dusk', start: '1800', end: '1930', speed: 0.9, risk: 1.2 },
    { name: 'Night', start: '1930', end: '0530', speed: 0.7, risk: 0.8 },
    { name: 'Dawn', start: '0530', end: '0700', speed: 0.9, risk: 1.2 }
  ];

  function num(x, d) { return typeof x === 'number' && x === x ? x : d; }
  function isInt(x) { return typeof x === 'number' && (x | 0) === x; }

  // ---- prepared (flattened, cached) view ----------------------------------------------------------
  const cache = typeof WeakMap === 'function' ? new WeakMap() : null;

  function flatMatrix(m, n, missing) {
    const out = new F64(n * n);
    for (let i = 0; i < n; i++) {
      const row = m && m[i];
      for (let j = 0; j < n; j++) {
        let x = row ? row[j] : undefined;
        if (typeof x !== 'number' || x !== x) x = (i === j ? 0 : missing);
        out[i * n + j] = x;
      }
    }
    return out;
  }

  function fresh(P, inst) {
    const w = inst.weights || S.DEFAULT_WEIGHTS, pa = inst.params || {}, pen = inst.penalties || {};
    return P.ref.nodes === inst.nodes && P.ref.vehicles === inst.vehicles && P.ref.jobs === inst.jobs &&
      P.ref.minutes === inst.minutes && P.ref.miles === inst.miles && P.ref.riskUnits === inst.riskUnits &&
      P.ref.periods === inst.periods && P.ref.penalties === inst.penalties && P.ref.params === inst.params &&
      P.ref.weights === inst.weights && P.startMin === inst.startMin &&
      // arrays replaced inside params / penalties (e.g. inst.params.bannedRally = [...]) also rebuild
      P.ref.banned === pa.bannedRally && P.ref.pinned === pa.pinnedRally &&
      P.ref.late === pen.latePerMin && P.ref.defer === pen.defer && P.ref.cf === pen.classFactor &&
      P.nN === (inst.nodes ? inst.nodes.length : 0) && P.nV === (inst.vehicles ? inst.vehicles.length : 0) &&
      P.nJ === (inst.jobs ? inst.jobs.length : 0) && P.nP === (inst.periods ? inst.periods.length : 0) &&
      P.wF === num(w.fuel, 0) && P.wD === num(w.distance, 0) && P.wR === num(w.risk, 0) && P.wS === num(w.simplicity, 0) &&
      P.serviceMin === num(pa.serviceMin, 15) && P.loadMin === num(pa.loadMin, 20) && P.mpgRaw === pa.mpg &&
      P.maxRallyRaw === pa.maxRallyPoints;
  }

  function build(inst) {
    const nodes = inst.nodes || [], vehicles = inst.vehicles || [], jobs = inst.jobs || [], periods = inst.periods || [];
    const nN = nodes.length, nV = vehicles.length, nJ = jobs.length, nP = periods.length;
    const w = inst.weights || S.DEFAULT_WEIGHTS;
    const pa = inst.params || {};
    const pen = inst.penalties || S.DEFAULT_PENALTIES;
    const late = pen.latePerMin || S.DEFAULT_PENALTIES.latePerMin;
    const defer = pen.defer || S.DEFAULT_PENALTIES.defer;
    const cf = pen.classFactor || S.DEFAULT_PENALTIES.classFactor;
    const startMin = num(inst.startMin, 0);
    const P = {
      ref: { nodes: inst.nodes, vehicles: inst.vehicles, jobs: inst.jobs, minutes: inst.minutes, miles: inst.miles,
        riskUnits: inst.riskUnits, periods: inst.periods, penalties: inst.penalties, params: inst.params, weights: inst.weights,
        banned: pa.bannedRally, pinned: pa.pinnedRally,
        late: inst.penalties ? inst.penalties.latePerMin : undefined, defer: inst.penalties ? inst.penalties.defer : undefined,
        cf: inst.penalties ? inst.penalties.classFactor : undefined },
      startMin: inst.startMin, nN: nN, nV: nV, nJ: nJ, nP: nP,
      wF: num(w.fuel, 0), wD: num(w.distance, 0), wR: num(w.risk, 0), wS: num(w.simplicity, 0),
      serviceMin: num(pa.serviceMin, 15), loadMin: num(pa.loadMin, 20), mpgRaw: pa.mpg, maxRallyRaw: pa.maxRallyPoints,
      invMpg: num(pa.mpg, 2) > 0 ? 1 / num(pa.mpg, 2) : 0,
      maxRally: typeof pa.maxRallyPoints === 'number' && pa.maxRallyPoints >= 0 ? pa.maxRallyPoints : INF,
      minutes: flatMatrix(inst.minutes, nN, INF),
      miles: flatMatrix(inst.miles, nN, 0),
      risk: flatMatrix(inst.riskUnits, nN, 0)
    };
    // nodes
    P.isRally = new U8(nN); P.banned = new U8(nN); P.pinned = new U8(nN);
    for (let i = 0; i < nN; i++) if (nodes[i] && nodes[i].kind === 'rally') P.isRally[i] = 1;
    (pa.bannedRally || []).forEach(function (n) { if (isInt(n) && n >= 0 && n < nN) P.banned[n] = 1; });
    (pa.pinnedRally || []).forEach(function (n) { if (isInt(n) && n >= 0 && n < nN) P.pinned[n] = 1; });
    // periods
    P.pStart = new F64(nP); P.pEnd = new F64(nP); P.pSpeed = new F64(nP); P.pRisk = new F64(nP);
    for (let i = 0; i < nP; i++) {
      const p = periods[i] || {};
      P.pStart[i] = num(p.startMin, 0); P.pEnd[i] = num(p.endMin, P.pStart[i]);
      const sp = num(p.speed, 1); P.pSpeed[i] = sp > 0 ? sp : 1;
      P.pRisk[i] = num(p.risk, 1);
    }
    P.pFirst = nP ? P.pStart[0] : 0; P.pLastEnd = nP ? P.pEnd[nP - 1] : 0; P.pSpan = P.pLastEnd - P.pFirst;
    // vehicles
    P.vFuel = new U8(nV); P.vCap = new F64(nV); P.vHub = new I32(nV); P.vStart = new I32(nV);
    P.vT0 = new F64(nV); P.vLoadStart = new F64(nV);
    P.vehIndex = Object.create(null);
    for (let v = 0; v < nV; v++) {
      const ve = vehicles[v] || {};
      P.vFuel[v] = ve.type === 'tanker' ? 1 : 0;
      P.vCap[v] = num(ve.capacity, 0);
      const hub = isInt(ve.hubNode) && ve.hubNode >= 0 && ve.hubNode < nN ? ve.hubNode : 0;
      P.vHub[v] = hub;
      P.vStart[v] = isInt(ve.startNode) && ve.startNode >= 0 && ve.startNode < nN ? ve.startNode : hub;
      const ready = mmax(startMin, num(ve.availableAt, startMin));
      P.vLoadStart[v] = ready;
      P.vT0[v] = ready + (ve.preloaded ? 0 : P.loadMin);
      if (ve.id != null && !(ve.id in P.vehIndex)) P.vehIndex[ve.id] = v;
    }
    // jobs
    P.jFuel = new U8(nJ); P.jQty = new F64(nJ); P.jInvQty = new F64(nJ); P.jEps = new F64(nJ);
    P.jTier = new I32(nJ); P.jClass = new I32(nJ); P.jDeadline = new F64(nJ); P.jHard = new U8(nJ);
    P.jLateW = new F64(nJ); P.jDeferW = new F64(nJ); P.jReq = new I32(nJ); P.jLockV = new I32(nJ);
    P.cand = new I32(nJ * nN).fill(-1); P.candCost = new F64(nJ * nN);
    P.jCandNodes = new Array(nJ);
    const reqIndex = Object.create(null); let nReq = 0;
    for (let j = 0; j < nJ; j++) {
      const jb = jobs[j] || {};
      P.jFuel[j] = jb.group === 'fuel' ? 1 : 0;
      // a negative quantity (invalid; validateInstance reports it) is treated as 0 so the empty plan
      // stays violation-free
      const q = mmax(0, num(jb.qty, 0)); P.jQty[j] = q; P.jInvQty[j] = q > 0 ? 1 / q : 0; P.jEps[j] = 1e-9 * mmax(1, mabs(q));
      const tier = isInt(jb.tier) ? mmax(0, mmin(late.length - 1, jb.tier)) : 0;
      const cr = isInt(jb.classRank) ? mmax(0, mmin(cf.length - 1, jb.classRank)) : 0;
      P.jTier[j] = tier; P.jClass[j] = cr;
      P.jDeadline[j] = typeof jb.deadline === 'number' && jb.deadline === jb.deadline ? jb.deadline : INF;
      // Immediate (tier 3) deadlines are always hard (DESIGN section 7); hardDeadline can add others (Urgent)
      P.jHard[j] = jb.hardDeadline || jb.tier === 3 ? 1 : 0;
      P.jLateW[j] = num(late[tier], 0);
      P.jDeferW[j] = num(defer[tier], 0) * num(cf[cr], 1);
      const rk = jb.requestId != null ? String(jb.requestId) : '\u0000job' + j;
      if (!(rk in reqIndex)) reqIndex[rk] = nReq++;
      P.jReq[j] = reqIndex[rk];
      if (jb.lockedTruck == null) P.jLockV[j] = -1;
      else P.jLockV[j] = (jb.lockedTruck in P.vehIndex) ? P.vehIndex[jb.lockedTruck] : -2;   // -2: locked to a truck not in the instance
      const list = [];
      const cands = jb.candidates || [];
      for (let c = 0; c < cands.length; c++) {
        const cd = cands[c]; if (!cd) continue;
        const n = cd.node;
        if (!isInt(n) || n < 0 || n >= nN || P.banned[n]) continue;
        const k = j * nN + n;
        if (P.cand[k] >= 0) continue;                  // duplicate node: first wins
        P.cand[k] = c; P.candCost[k] = num(cd.platoonCost, 0);
        list.push(n);
      }
      P.jCandNodes[j] = I32.from(list);
    }
    P.nReq = nReq;
    // scratch for evaluate (epoch-stamped so nothing is cleared per call)
    P.epoch = 0;
    P.delivered = new F64(nJ);
    P.vehStamp = new I32(nV);
    P.rallyStamp = new I32(nN);
    P.pairStamp = new I32(mmax(1, nReq * nN));
    return P;
  }

  S.prepare = function (inst) {
    if (!inst) throw new Error('SRO.solver.prepare: no instance');
    if (cache) {
      const P = cache.get(inst);
      if (P && fresh(P, inst)) return P;
      const Q = build(inst); cache.set(inst, Q); return Q;
    }
    if (inst.__prepared && fresh(inst.__prepared, inst)) return inst.__prepared;
    const Q = build(inst);
    try { Object.defineProperty(inst, '__prepared', { value: Q, writable: true, configurable: true, enumerable: false }); } catch (e) { /* frozen */ }
    return Q;
  };
  S.prepare.invalidate = function (inst) {
    if (cache) cache.delete(inst); else if (inst && inst.__prepared) inst.__prepared = null;
  };

  // Index into instance.periods for minute t (the period containing t; the table repeats daily when it
  // covers at least 24 h, so times past either end wrap by whole days). -1 when there are no periods.
  S.periodIndex = function (P, t) {
    const n = P.nP;
    if (n === 0) return -1;
    const st = P.pStart;
    if (!(t >= st[0] && t < P.pLastEnd)) {
      if (t !== t || t === INF || t === -INF) return t === -INF ? 0 : n - 1;
      if (P.pSpan >= 1440) {
        if (t >= P.pLastEnd) t -= 1440 * mceil((t - P.pLastEnd + 1e-9) / 1440);
        else t += 1440 * mceil((st[0] - t) / 1440);
      }
      if (t < st[0]) return 0;
    }
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (st[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  };
  S.periodAt = function (instance, t) { return S.periodIndex(S.prepare(instance), t); };

  // ---- small public helpers -----------------------------------------------------------------------
  S.typeCompatible = function (vehicle, job) {
    return !!vehicle && !!job && S.GROUP_TYPE[job.group] === vehicle.type;
  };
  // Right vehicle type for the job's load group and, if the job is locked, the locked truck.
  S.vehicleCompatible = function (vehicle, job) {
    return S.typeCompatible(vehicle, job) && (job.lockedTruck == null || job.lockedTruck === vehicle.id);
  };
  S.jobsByGroup = function (instance) {
    const out = { fuel: [], cargo: [] };
    (instance.jobs || []).forEach(function (j, i) { (out[j.group] || (out[j.group] = [])).push(i); });
    return out;
  };
  S.vehiclesByType = function (instance) {
    const out = { tanker: [], cargo: [] };
    (instance.vehicles || []).forEach(function (v, i) { (out[v.type] || (out[v.type] = [])).push(i); });
    return out;
  };
  // Vehicle indexes that may carry job j (type + lock).
  S.compatibleVehicles = function (instance, j) {
    const job = instance.jobs[j], out = [];
    (instance.vehicles || []).forEach(function (v, i) { if (S.vehicleCompatible(v, job)) out.push(i); });
    return out;
  };
  // Allowed delivery nodes for job j (banned rally nodes and bad indexes removed), in candidate order.
  S.candidateNodes = function (instance, j) { return Array.from(S.prepare(instance).jCandNodes[j] || []); };
  // The candidate object of job j at node, or null when node is not an allowed candidate.
  S.candidateAt = function (instance, j, node) {
    const P = S.prepare(instance);
    if (!(j >= 0 && j < P.nJ) || !(node >= 0 && node < P.nN)) return null;
    const c = P.cand[j * P.nN + node];
    return c >= 0 ? instance.jobs[j].candidates[c] : null;
  };
  S.isCandidate = function (instance, j, node) { return S.candidateAt(instance, j, node) !== null; };
  // Nodes allowed for every job in jobIdxs.
  S.commonCandidates = function (instance, jobIdxs) {
    const P = S.prepare(instance);
    if (!jobIdxs || !jobIdxs.length) return [];
    const first = P.jCandNodes[jobIdxs[0]] || [];
    const out = [];
    for (let a = 0; a < first.length; a++) {
      const n = first[a]; let ok = true;
      for (let b = 1; b < jobIdxs.length && ok; b++) if (P.cand[jobIdxs[b] * P.nN + n] < 0) ok = false;
      if (ok) out.push(n);
    }
    return out;
  };
  // Minute vehicle v leaves its start node: max(startMin, availableAt) + (preloaded ? 0 : loadMin).
  S.vehicleStartTime = function (instance, v) { return S.prepare(instance).vT0[v]; };

  // ---- solutions --------------------------------------------------------------------------------
  S.emptySolution = function (instance) {
    const routes = [];
    for (let v = 0; v < (instance.vehicles || []).length; v++) routes.push({ vehicle: v, visits: [] });
    return { routes: routes };
  };
  S.cloneSolution = function (sol) {
    return {
      routes: ((sol && sol.routes) || []).map(function (r) {
        return { vehicle: r.vehicle, visits: (r.visits || []).map(function (v) {
          return { node: v.node, jobs: (v.jobs || []).map(function (c) { return { job: c.job, qty: c.qty }; }) };
        }) };
      })
    };
  };
  // True when routes[i].vehicle === i for every vehicle (the shape construct/moves keep).
  S.isNormalized = function (instance, sol) {
    const nV = (instance.vehicles || []).length, routes = (sol && sol.routes) || [];
    if (routes.length !== nV) return false;
    for (let i = 0; i < nV; i++) if (!routes[i] || routes[i].vehicle !== i || !isArray(routes[i].visits)) return false;
    return true;
  };
  // One route per vehicle in vehicle order (routes of a repeated vehicle are concatenated). Drops
  // chunks/visits with bad indexes, zero / negative / non-finite quantities (a zero chunk delivers
  // nothing, so dropping it never raises the cost) and merges repeated chunks of a
  // job inside one visit. Keeps empty visits (dropping one could change the schedule).
  S.normalize = function (instance, sol) {
    const P = S.prepare(instance);
    const out = S.emptySolution(instance);
    const routes = (sol && sol.routes) || [];
    for (let r = 0; r < routes.length; r++) {
      const rt = routes[r];
      if (!rt || !isInt(rt.vehicle) || rt.vehicle < 0 || rt.vehicle >= P.nV) continue;
      const dst = out.routes[rt.vehicle].visits;
      const visits = rt.visits || [];
      for (let s = 0; s < visits.length; s++) {
        const vi = visits[s];
        if (!vi || !isInt(vi.node) || vi.node < 0 || vi.node >= P.nN) continue;
        const jobs = [];
        (vi.jobs || []).forEach(function (c) {
          if (!c || !isInt(c.job) || c.job < 0 || c.job >= P.nJ) return;
          if (!(typeof c.qty === 'number' && c.qty > 0 && c.qty < INF)) return;
          for (let k = 0; k < jobs.length; k++) if (jobs[k].job === c.job) { jobs[k].qty += c.qty; return; }
          jobs.push({ job: c.job, qty: c.qty });
        });
        dst.push({ node: vi.node, jobs: jobs });
      }
    }
    return out;
  };

  // ---- periods ----------------------------------------------------------------------------------
  function hhmm(s) {
    if (typeof s === 'number') return s;
    const m = /^(\d{1,2}):?(\d{2})$/.exec(String(s || '').trim());
    if (!m) return NaN;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  // Expands a daily table [{ name, start: 'HHMM', end: 'HHMM', speed, risk }] into sorted, non-overlapping
  // absolute periods [{ startMin, endMin, speed, risk, name }] covering [day start of fromMin, fromMin + hours].
  // Overnight rows (end <= start) wrap past midnight. Gaps in the table stay gaps.
  S.expandPeriods = function (table, fromMin, hours) {
    table = table && table.length ? table : S.DEFAULT_PERIOD_TABLE;
    const from = num(fromMin, 0), h = num(hours, 72);
    const d0 = mfloor(from / 1440) * 1440;
    const until = from + h * 60;
    const segs = [];
    for (let day = d0 - 1440; day < until; day += 1440) {
      for (let i = 0; i < table.length; i++) {
        const row = table[i];
        const a = hhmm(row.start), b = hhmm(row.end);
        if (!(a >= 0) || !(b >= 0)) continue;
        const s = day + a, e = day + (b > a ? b : b + 1440);
        segs.push({ startMin: s, endMin: e, speed: num(row.speed, 1), risk: num(row.risk, 1), name: row.name || ('P' + i) });
      }
    }
    segs.sort(function (x, y) { return x.startMin - y.startMin; });
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (out.length && s.startMin < out[out.length - 1].endMin) out[out.length - 1].endMin = s.startMin;   // trim overlap
      if (out.length && out[out.length - 1].endMin <= out[out.length - 1].startMin) out.pop();
      out.push(s);
    }
    // clip to [d0, until rounded up to a whole day]
    const end = d0 + mceil((until - d0) / 1440) * 1440;
    return out.filter(function (p) { return p.endMin > d0 && p.startMin < end; }).map(function (p) {
      return { startMin: mmax(p.startMin, d0), endMin: mmin(p.endMin, end), speed: p.speed, risk: p.risk, name: p.name };
    });
  };

  // ---- validation --------------------------------------------------------------------------------
  // Returns a list of plain-language problems (empty when the instance is usable).
  S.validateInstance = function (inst) {
    const out = [];
    if (!inst || typeof inst !== 'object') return ['The instance is missing.'];
    const nodes = inst.nodes, vehicles = inst.vehicles, jobs = inst.jobs;
    if (!isArray(nodes)) out.push('nodes must be an array.');
    if (!isArray(vehicles)) out.push('vehicles must be an array.');
    if (!isArray(jobs)) out.push('jobs must be an array.');
    if (out.length) return out;
    const nN = nodes.length;
    if (typeof inst.startMin !== 'number' || !(inst.startMin === inst.startMin)) out.push('startMin must be a number.');
    ['minutes', 'miles', 'riskUnits'].forEach(function (key) {
      const m = inst[key];
      if (!isArray(m) || m.length !== nN) { out.push(key + ' must be a ' + nN + ' x ' + nN + ' matrix.'); return; }
      for (let i = 0; i < nN; i++) {
        if (!isArray(m[i]) || m[i].length !== nN) { out.push(key + ' row ' + i + ' must have ' + nN + ' entries.'); return; }
        for (let j = 0; j < nN; j++) {
          const x = m[i][j];
          if (typeof x !== 'number' || x !== x || x < 0) { out.push(key + '[' + i + '][' + j + '] must be a number >= 0 (or INF).'); return; }
        }
      }
    });
    nodes.forEach(function (n, i) {
      if (!n || ['hub', 'rally', 'direct'].indexOf(n.kind) < 0) out.push('Node ' + i + ' needs kind "hub", "rally" or "direct".');
    });
    const periods = inst.periods || [];
    if (!isArray(periods)) out.push('periods must be an array.');
    else periods.forEach(function (p, i) {
      if (!p || typeof p.startMin !== 'number' || typeof p.endMin !== 'number' || !(p.endMin > p.startMin)) out.push('Period ' + i + ' needs startMin < endMin.');
      else if (i > 0 && periods[i - 1] && p.startMin < periods[i - 1].endMin) out.push('Period ' + i + ' overlaps or is out of order with period ' + (i - 1) + '.');
      if (p && !(p.speed > 0)) out.push('Period ' + i + ' speed factor must be greater than 0.');
      if (p && !(p.risk >= 0)) out.push('Period ' + i + ' risk factor must be 0 or more.');
    });
    const ids = Object.create(null);
    vehicles.forEach(function (v, i) {
      if (!v) { out.push('Vehicle ' + i + ' is missing.'); return; }
      if (v.type !== 'tanker' && v.type !== 'cargo') out.push('Vehicle ' + (v.id || i) + ' type must be "tanker" or "cargo".');
      if (!(v.capacity > 0)) out.push('Vehicle ' + (v.id || i) + ' needs a capacity greater than 0.');
      if (!isInt(v.hubNode) || v.hubNode < 0 || v.hubNode >= nN) out.push('Vehicle ' + (v.id || i) + ' hubNode is not a node index.');
      if (v.startNode != null && (!isInt(v.startNode) || v.startNode < 0 || v.startNode >= nN)) out.push('Vehicle ' + (v.id || i) + ' startNode is not a node index.');
      if (v.availableAt != null && !(typeof v.availableAt === 'number' && v.availableAt > -INF && v.availableAt < INF)) out.push('Vehicle ' + (v.id || i) + ' availableAt must be a minute number (leave a truck that is out of the plan off the vehicle list).');
      if (v.id != null) { if (ids[v.id]) out.push('Vehicle id ' + v.id + ' is used twice.'); ids[v.id] = v; }
    });
    const params = inst.params || {};
    const banned = new Set(params.bannedRally || []), pinned = params.pinnedRally || [];
    const late = (inst.penalties && inst.penalties.latePerMin) || S.DEFAULT_PENALTIES.latePerMin;
    const cf = (inst.penalties && inst.penalties.classFactor) || S.DEFAULT_PENALTIES.classFactor;
    const jobIds = Object.create(null);
    jobs.forEach(function (jb, i) {
      if (!jb) { out.push('Job ' + i + ' is missing.'); return; }
      const name = 'Job ' + (jb.id || i);
      if (jb.group !== 'fuel' && jb.group !== 'cargo') out.push(name + ' group must be "fuel" or "cargo".');
      if (!(typeof jb.qty === 'number' && jb.qty > 0 && jb.qty < INF)) out.push(name + ' quantity must be greater than 0.');
      if (!isInt(jb.tier) || jb.tier < 0 || jb.tier >= late.length) out.push(name + ' tier must be 0-' + (late.length - 1) + '.');
      if (!isInt(jb.classRank) || jb.classRank < 0 || jb.classRank >= cf.length) out.push(name + ' classRank must be 0-' + (cf.length - 1) + '.');
      if (jb.deadline != null && typeof jb.deadline !== 'number') out.push(name + ' deadline must be a minute number.');
      if (!isArray(jb.candidates)) out.push(name + ' needs a candidates list.');
      else jb.candidates.forEach(function (c) {
        if (!c || !isInt(c.node) || c.node < 0 || c.node >= nN) out.push(name + ' has a candidate that is not a node index.');
        else if (banned.has(c.node)) out.push(name + ' lists banned rally node ' + c.node + ' as a candidate; it is ignored.');
        if (c && c.platoonCost != null && !(c.platoonCost >= 0)) out.push(name + ' has a candidate with a negative or invalid platoonCost.');
      });
      if (jb.lockedTruck != null) {
        const v = ids[jb.lockedTruck];
        if (!v) out.push(name + ' is locked to truck ' + jb.lockedTruck + ', which is not in this plan.');
        else if (!S.typeCompatible(v, jb)) out.push(name + ' is locked to truck ' + jb.lockedTruck + ', which cannot carry this load.');
      }
      if (jb.id != null) { if (jobIds[jb.id]) out.push('Job id ' + jb.id + ' is used twice.'); jobIds[jb.id] = true; }
    });
    const w = inst.weights || {};
    ['fuel', 'distance', 'risk', 'simplicity'].forEach(function (k) {
      if (!(typeof w[k] === 'number' && w[k] >= 0)) out.push('weights.' + k + ' must be a number 0 or more.');
    });
    if (!(params.mpg > 0)) out.push('params.mpg must be greater than 0.');
    if (!(params.serviceMin >= 0)) out.push('params.serviceMin must be 0 or more.');
    if (!(params.loadMin >= 0)) out.push('params.loadMin must be 0 or more.');
    if (params.maxRallyPoints != null && !(params.maxRallyPoints >= 0)) out.push('params.maxRallyPoints must be 0 or more.');
    pinned.forEach(function (n) {
      if (!isInt(n) || n < 0 || n >= nN || nodes[n].kind !== 'rally') out.push('Pinned rally point ' + n + ' is not a rally node.');
      if (banned.has(n)) out.push('Rally node ' + n + ' is both pinned and banned.');
    });
    if (params.maxRallyPoints != null && pinned.length > params.maxRallyPoints) out.push('More rally points are pinned (' + pinned.length + ') than the limit (' + params.maxRallyPoints + ').');
    const pen = inst.penalties;
    if (pen) {
      if (!isArray(pen.latePerMin) || pen.latePerMin.length < 4) out.push('penalties.latePerMin needs 4 values (one per tier).');
      if (!isArray(pen.defer) || pen.defer.length < 4) out.push('penalties.defer needs 4 values (one per tier).');
      if (!isArray(pen.classFactor) || pen.classFactor.length < 5) out.push('penalties.classFactor needs 5 values (one per class).');
    }
    return out;
  };

  // ---- synthetic instances -----------------------------------------------------------------------
  // Length of segment a-b inside the circle (cx, cy, r), same units as the coordinates.
  function segInCircle(ax, ay, bx, by, cx, cy, r) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    if (L2 === 0) return 0;
    const fx = ax - cx, fy = ay - cy;
    const b = fx * dx + fy * dy, c = fx * fx + fy * fy - r * r;
    const disc = b * b - L2 * c;
    if (disc <= 0) return 0;
    const s = Math.sqrt(disc);
    const t1 = mmax(0, (-b - s) / L2), t2 = mmin(1, (-b + s) / L2);
    return t2 > t1 ? (t2 - t1) * Math.sqrt(L2) : 0;
  }
  S._segInCircle = segInCircle;

  const TEST_COLORS = ['#2F6FE0', '#0F9488', '#3F9A2E', '#8E5AD8', '#C9359A', '#A86B2A', '#1C9BC7', '#7E8C1C'];

  // Seeded random instance: hubs, rally points and platoons at random points in a size x size mile
  // square, travel at `mph` (minutes = miles x roadFactor / mph x 60), risk circles, optional closed
  // circles (pairs whose straight line crosses one are unreachable), mixed tiers/classes, deadlines.
  S.makeTestInstance = function (seed, opts) {
    const o = Object.assign({
      nJobs: 12, nVehicles: 4, nRally: 6, nHubs: 2, size: 100, mph: 40, roadFactor: 1.2, startMin: 360,
      fuelShare: 0.35, twoJobShare: 0.2, directShare: 0.5, fixedShare: 0.1, dismountedShare: 0.25,
      maxCandidates: 4, noCandidateShare: 0, riskZones: 2, closedZones: 0, maxRallyPoints: 8,
      noSplit: false, fuelQty: [200, 3000], cargoQty: [1, 12], lateAvailableShare: 0.2,
      locked: 0, pinned: 0, banned: 0, tankers: null, capacity: { tanker: 2500, cargo: 10 },
      deadlineMin: 60, deadlineMax: 720, tierWeights: [0.4, 0.33, 0.18, 0.09],
      serviceMin: 15, loadMin: 20, mpg: 2, weights: null, penalties: null, periodTable: null, flatPeriods: false
    }, opts || {});
    const rng = SRO.util.rng(seed);
    const U = function (a, b) { return a + (b - a) * rng(); };
    const nodes = [], pts = [];
    for (let h = 0; h < o.nHubs; h++) {
      nodes.push({ key: 'hub:H' + h, kind: 'hub', gridId: 'H' + h, lat: null, lon: null, label: 'Hub ' + String.fromCharCode(65 + h) });
      pts.push([U(5, o.size - 5), U(5, o.size - 5)]);
    }
    const rallyNodes = [];
    for (let r = 0; r < o.nRally; r++) {
      rallyNodes.push(nodes.length);
      nodes.push({ key: 'rally:P' + r, kind: 'rally', gridId: 'P' + r, lat: null, lon: null, label: 'Rally ' + (r + 1) });
      pts.push([U(0, o.size), U(0, o.size)]);
    }
    // vehicles (types fixed before jobs so noSplit can respect capacities)
    const nV = o.nVehicles;
    let nTank;
    if (o.tankers != null) nTank = mmax(0, mmin(nV, o.tankers));
    else {
      nTank = mround(nV * o.fuelShare);
      if (nV >= 2) nTank = mmax(1, mmin(nV - 1, nTank));
      else nTank = o.fuelShare >= 0.5 ? nV : 0;
    }
    // the first nTank vehicles are tankers; hubs are assigned round-robin
    const vehicles = [];
    for (let v = 0; v < nV; v++) {
      const type = v < nTank ? 'tanker' : 'cargo';
      vehicles.push({
        id: 'V' + v, type: type, capacity: o.capacity[type], hubNode: v % mmax(1, o.nHubs),
        availableAt: rng() < o.lateAvailableShare ? o.startMin + rng.int(120) : o.startMin,
        color: TEST_COLORS[v % TEST_COLORS.length]
      });
    }
    const jobs = [];
    let rq = 0;
    while (jobs.length < o.nJobs) {
      const room = o.nJobs - jobs.length;
      const both = room >= 2 && rng() < o.twoJobShare;
      const groups = both ? ['fuel', 'cargo'] : [rng() < o.fuelShare ? 'fuel' : 'cargo'];
      const x = rng(), mob = x < o.fixedShare ? 'fixed' : x < o.fixedShare + o.dismountedShare ? 'dismounted' : 'mounted';
      const p = [U(0, o.size), U(0, o.size)];
      const dnode = nodes.length;
      nodes.push({ key: 'direct:R' + rq, kind: 'direct', gridId: null, lat: null, lon: null, label: 'Platoon ' + (rq + 1) });
      pts.push(p);
      const radius = mob === 'dismounted' ? 5 : 50, perMi = mob === 'dismounted' ? 4 : 0.5;
      const cands = [];
      const noCand = rng() < o.noCandidateShare;
      if (!noCand) {
        if (mob === 'fixed' || rng() < o.directShare) cands.push({ node: dnode, platoonMiles: 0, platoonCost: 0, hint: false });
        if (mob !== 'fixed') {
          const near = rallyNodes.map(function (n) {
            const d = Math.hypot(pts[n][0] - p[0], pts[n][1] - p[1]) * 1.3;
            return { n: n, d: d };
          }).filter(function (e) { return e.d <= radius; }).sort(function (a, b) { return a.d - b.d; }).slice(0, o.maxCandidates);
          near.forEach(function (e) { cands.push({ node: e.n, platoonMiles: e.d, platoonCost: e.d * perMi, hint: false }); });
        }
        if (!cands.length) cands.push({ node: dnode, platoonMiles: 0, platoonCost: 0, hint: false });
        if (cands.length > 1 && rng() < 0.3) cands[rng.int(cands.length)].hint = true;
      }
      const tierW = o.tierWeights;
      groups.forEach(function (g) {
        let u = rng(), tier = 0;
        for (let t = 0, acc = 0; t < tierW.length; t++) { acc += tierW[t]; if (u < acc) { tier = t; break; } tier = t; }
        let qty;
        if (g === 'fuel') {
          const hi = o.noSplit ? mmin(o.fuelQty[1], o.capacity.tanker) : o.fuelQty[1];
          qty = mmax(50, mround(U(o.fuelQty[0], hi) / 50) * 50);
          if (o.noSplit) qty = mmin(qty, o.capacity.tanker);
        } else {
          const hi = o.noSplit ? mmin(o.cargoQty[1], o.capacity.cargo) : o.cargoQty[1];
          qty = rng() < 0.5 ? mmax(1, mround(U(o.cargoQty[0], hi))) : mmax(0.1, mround(U(o.cargoQty[0], hi) * 10) / 10);
          if (o.noSplit) qty = mmin(qty, o.capacity.cargo);
        }
        const span = tier === 3 ? mmin(o.deadlineMax, 240) : o.deadlineMax;
        const deadline = o.startMin + o.deadlineMin + rng.int(mmax(1, span - o.deadlineMin));
        jobs.push({
          id: 'J' + jobs.length, requestId: 'R-' + (rq + 1), lineIdxs: [0], group: g, qty: qty, unit: g === 'fuel' ? 'gal' : 'pallet',
          tier: tier, classRank: g === 'fuel' ? 0 : rng.int(5), deadline: deadline, hardDeadline: tier === 3,
          candidates: cands.map(function (c) { return Object.assign({}, c); }), lockedTruck: null
        });
      });
      rq++;
    }
    // matrices
    const n = nodes.length;
    const zones = [];
    for (let z = 0; z < o.riskZones; z++) zones.push({ x: U(0, o.size), y: U(0, o.size), r: U(8, 20), rating: [1, 3, 6][rng.int(3)] });
    const closed = [];
    for (let z = 0; z < o.closedZones; z++) closed.push({ x: U(0, o.size), y: U(0, o.size), r: U(4, 12) });
    const minutes = [], miles = [], riskUnits = [];
    for (let i = 0; i < n; i++) { minutes.push(new Array(n)); miles.push(new Array(n)); riskUnits.push(new Array(n)); }
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        if (i === j) { minutes[i][j] = 0; miles[i][j] = 0; riskUnits[i][j] = 0; continue; }
        const a = pts[i], b = pts[j];
        let blocked = false;
        for (let c = 0; c < closed.length && !blocked; c++) if (segInCircle(a[0], a[1], b[0], b[1], closed[c].x, closed[c].y, closed[c].r) > 0) blocked = true;
        const mi = Math.hypot(a[0] - b[0], a[1] - b[1]) * o.roadFactor;
        let rk = 0;
        for (let c = 0; c < zones.length; c++) rk += segInCircle(a[0], a[1], b[0], b[1], zones[c].x, zones[c].y, zones[c].r) * o.roadFactor * zones[c].rating;
        const mn = blocked ? INF : mi / o.mph * 60;
        minutes[i][j] = minutes[j][i] = mn;
        miles[i][j] = miles[j][i] = blocked ? INF : mi;
        riskUnits[i][j] = riskUnits[j][i] = blocked ? 0 : rk;
      }
    }
    // locks, pins, bans
    for (let k = 0; k < o.locked && jobs.length; k++) {
      const j = jobs[rng.int(jobs.length)];
      const ok = vehicles.filter(function (v) { return S.typeCompatible(v, j); });
      if (ok.length) j.lockedTruck = ok[rng.int(ok.length)].id;
    }
    const shuffledRally = rng.shuffle(rallyNodes.slice());
    const bannedRally = shuffledRally.slice(0, mmin(o.banned, shuffledRally.length));
    const pinnedRally = shuffledRally.slice(bannedRally.length, bannedRally.length + mmin(o.pinned, shuffledRally.length - bannedRally.length));
    if (bannedRally.length) jobs.forEach(function (j) { j.candidates = j.candidates.filter(function (c) { return bannedRally.indexOf(c.node) < 0; }); });
    const periods = o.flatPeriods ? [{ startMin: mfloor(o.startMin / 1440) * 1440, endMin: mfloor(o.startMin / 1440) * 1440 + 4 * 1440, speed: 1, risk: 1, name: 'Flat' }]
      : S.expandPeriods(o.periodTable || S.DEFAULT_PERIOD_TABLE, o.startMin, 72);
    return {
      startMin: o.startMin,
      nodes: nodes,
      minutes: minutes, miles: miles, riskUnits: riskUnits,
      gridPaths: {},
      periods: periods,
      vehicles: vehicles,
      jobs: jobs,
      weights: Object.assign({}, o.weights || S.DEFAULT_WEIGHTS),
      params: { mpg: o.mpg, serviceMin: o.serviceMin, loadMin: o.loadMin, maxRallyPoints: o.maxRallyPoints, pinnedRally: pinnedRally, bannedRally: bannedRally },
      penalties: JSON.parse(JSON.stringify(o.penalties || S.DEFAULT_PENALTIES)),
      fixed: null,
      _test: { seed: seed, points: pts }
    };
  };
})(typeof self !== 'undefined' ? self : globalThis);
