// Planner engine (DESIGN.md section 8b): connects the store, the road network and the solver worker.
// Views never build instances or talk to the worker themselves.
//
// PURE PART (no DOM, no worker; Node tests call these directly)
//   engine.buildInstance(state, { windowId, now, contingency, parentPlanId }) -> { instance, maps, warnings }
//       nodes = hubs + rally candidates (not banned; only those some platoon can reach, plus pinned)
//       + one direct node per request location that takes direct delivery; travel minutes, miles and
//       risk units from SRO.core.network.pointMatrix (OSM road matrix via SRO.core.roads.matrix, closed
//       zones applied), minutes x settings.convoyFactor; periods expanded for 72 h from now; one job per
//       request and load group (fuel / cargo, catalogHelpers.requestLoads); vehicles = fleet minus trucks
//       marked out. maps holds what decoding needs (node keys, per-line splits, road paths).
//       Candidates: fixed in place, directOnly or locks.forceDirect -> the direct node only; otherwise
//       rally nodes within the mobility radius in road miles from the platoon (nearest
//       MAX_RALLY_CANDIDATES, plus the desired pickup and pinned points in range), platoonCost =
//       one-way platoon miles x 2 (out and back) x mobility costPerMi, the desired pickup flagged hint.
//       A platoon with no rally point in range gets its direct node instead (warning), so every job has
//       a candidate; a closed road can still make it unreachable (the solver then defers it).
//       contingency: from the approved plan at `now`: delivered stops stay done, en-route trucks start
//       at their next stop (startNode, preloaded, capacity = what they still carry) with those jobs
//       locked to them; jobs of trucks marked out, not yet departed, or cut off go back to the pool
//       (a cut-off truck keeps its done stops, route.cutOff, returnAt null). A planner lock to a truck
//       already on the road holds only for its onboard load.
//       maps.builtOn = the approved plans live at build time; the Plan carries it as plan.builtOn and
//       store plan/approve does not supersede those (a second batch in a window keeps the first).
//   engine.decodePlan(build, result, meta) -> Plan (DESIGN.md section 3 schema plus per leg `path` =
//       encoded polyline (precision 5) of the road route and `source`, per stop `etaText`, and
//       plan.byRequest[requestId] = { truckId, stopSeq, nodeKind, gridId, lat, lon, label, eta, etaText,
//       qtyByLine, deferredQty, stopsBefore, ... } for the platoon sergeant views). qtyByLine counts
//       every delivery in the plan (done stops of a re-plan too), so qtyByLine + deferredQty = what
//       the plan covers per line. plan.warnings notes a plan above settings.maxStops.
//   engine.contingencyStart(build) -> solution | null   (the adjusted old plan, a warm start)
//   engine.shouldPlan(state) -> bool   (the trigger rule for automatic planning; replaceable)
//   engine.pendingRequests(state), engine.activePlan(state), engine.legCoords(leg), engine.mapRoutes(plan)
//
// RUNTIME PART
//   engine.init(store, { forceMain, warm }) (boot.js calls it). The solver worker is created lazily
//       (and warmed up 1.5 s after init) from #highs-js + #worker-src as a Blob URL worker and
//       initialized with #highs-wasm-gz (protocol: src/solver/worker-main.js). If no worker can start,
//       the heuristics run on the main thread (the page freezes while they run; Exact (MIP) is off).
//   engine.status() -> { phase: 'idle' | 'preparing' | 'estimating' | 'running' | 'done' | 'error' |
//       'cancelled', kind, method, methods, methodIndex, fraction, bestCost, elapsedSec, message,
//       history: [{ t, best }], error, highsReady, mode, planId, planIds }
//   engine.subscribe(fn) -> unsubscribe     fn(status) on every change. Progress is NOT dispatched to
//       the store (that would write localStorage every 250 ms); only finished plans are.
//   engine.estimate(method | [methods], params?) -> Promise<{ seconds, low, high, basis }>
//   engine.run({ method, params, windowId, timeCapSec }) -> Promise<Plan>
//   engine.compare(methods, { params, timeCapSec }) -> Promise<Plan[]>  one stored Plan per method
//   engine.cancel() -> Promise<Plan | Plan[] | null>  terminates the worker, stores the best plan so far
//       with cancelled: true, restarts the worker on next use
//   engine.replan({ reason, method }) -> Promise<Plan>  contingency re-plan (parentPlanId set)
//   Automatic planning: when the store sets ui.planRequested (reason 'boundary' at 0000/0600/1200/1800,
//   or 'manual' from window/planNow) and shouldPlan(state) holds, the engine runs settings.method and
//   stores the plan unapproved.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.core = SRO.core || {};
  const E = SRO.core.engine = SRO.core.engine || {};

  E.MAX_RALLY_CANDIDATES = 8;
  E.PENDING = ['submitted', 'planned', 'delayed', 'partial'];
  E.HORIZON_HOURS = 72;
  E.PATH_PRECISION = 5;
  E.WARM_DELAY_MS = 1500;
  E.GROUPS = ['fuel', 'cargo'];

  const INF = Infinity;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  // numbers stored in plans: 2 decimals for leg times, miles, risk units and cost keep localStorage
  // small; stop and route times stay exact (a re-plan continues en-route trucks from them, and the
  // store compares ETAs exactly when it flags changed requests)
  function rd(x) { return isNum(x) ? Math.round(x * 100) / 100 : x; }
  function rdCost(c) { const o = {}; Object.keys(c || {}).forEach(function (k) { o[k] = rd(c[k]); }); return o; }
  function num(x, d) { const v = typeof x === 'number' ? x : (typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN); return isFinite(v) ? v : d; }
  function clone(x) { return SRO.util.deepClone(x); }
  function S() { return SRO.solver; }
  function fmt() { return SRO.core.format; }
  function geo() { return SRO.core.geo; }
  function wallNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function userError(msg, code) { const e = new Error(msg); e.code = code || 'engine'; e.userFacing = true; return e; }

  // ---- small domain helpers ---------------------------------------------------------------------
  E.pendingRequests = function (state) {
    return ((state && state.requests) || []).filter(function (r) { return r && E.PENDING.indexOf(r.status) >= 0; });
  };
  function approvedPlans(state) {
    return ((state && state.plans) || []).filter(function (p) { return p && p.approved && !p.superseded; });
  }
  function planTime(p) { return num(p.approvedAt, num(p.createdAt, 0)); }
  // The most recently approved plan (the current movement schedule), or null.
  E.activePlan = function (state) {
    let best = null;
    approvedPlans(state).forEach(function (p) { if (!best || planTime(p) >= planTime(best)) best = p; });
    return best;
  };
  E.shouldPlan = function (state) {
    const ui = (state && state.ui) || {};
    if (!ui.planRequested) return false;
    if (ui.planRequestReason !== 'boundary' && ui.planRequestReason !== 'manual') return false;
    return E.pendingRequests(state).length > 0;
  };

  function tierOf(r) {
    const U = SRO.core.urgency;
    const t = U && U.tierIndex ? U.tierIndex(r.urgency) : ['Routine', 'Priority', 'Urgent', 'Immediate'].indexOf(r.urgency);
    return t >= 0 ? t : 0;
  }
  function classRankOf(r) {
    const U = SRO.core.urgency;
    const k = U && U.requestClassRank ? U.requestClassRank(r) : 0;
    return Math.max(0, Math.min(4, k));
  }
  function hardOf(r) {
    const U = SRO.core.urgency;
    return U && U.isHardDeadline ? !!U.isHardDeadline(r.urgency) : (r.urgency === 'Urgent' || r.urgency === 'Immediate');
  }
  function validLoc(r) { return r && isNum(num(r.lat, NaN)) && isNum(num(r.lon, NaN)); }
  function palette() {
    const sc = SRO.data && SRO.data.scenario;
    return ((sc && sc.truckColors) || []).map(function (c) { return typeof c === 'string' ? c : c && c.hex; }).filter(Boolean);
  }
  function truckTypeLabel(type) {
    const tt = SRO.data && SRO.data.scenario && SRO.data.scenario.truckTypes;
    return (tt && tt[type] && tt[type].label) || (type === 'tanker' ? 'Fuel tanker' : 'Cargo truck');
  }
  function roundLine(x, lineQty) {
    if (Math.abs(lineQty - Math.round(lineQty)) < 1e-9) return Math.round(x + 1e-9);
    return Math.round(x * 10 + 1e-9) / 10;
  }

  // Lines of one load group of a request: [{ lineIdx, qty, unit, classId, itemId, option, load }],
  // load = the line's exact load in truck units (gallons or pallets, before rounding up).
  function groupLines(r, group) {
    const CH = SRO.data.catalogHelpers;
    const out = [];
    (r.lines || []).forEach(function (line, idx) {
      const l = CH.lineToLoad(line);
      if (!l || l.group !== group) return;
      const spec = CH.spec(line.itemId, line.option);
      out.push({ lineIdx: idx, qty: num(line.qty, 0), unit: line.unit || (spec && spec.unit) || '', classId: line.classId,
        itemId: line.itemId, option: line.option || null, load: num(l.exact, l.qty) });
    });
    return out;
  }

  // Deferred load units of a request and group in the plan that last handled it (for 'partial').
  function deferredRemainder(state, r, group) {
    let plan = null;
    approvedPlans(state).forEach(function (p) {
      const hit = (p.deferred || []).some(function (d) { return d.requestId === r.id; }) ||
        (p.byRequest && p.byRequest[r.id]);
      if (hit && (!plan || planTime(p) >= planTime(plan))) plan = p;
    });
    if (!plan) return null;
    let q = 0, seen = false;
    (plan.deferred || []).forEach(function (d) {
      if (d.requestId !== r.id || (d.group && d.group !== group)) return;
      seen = true; q += num(d.loadQty, 0);
    });
    if (seen) return q;
    // delivered in full in that plan (or this group was never in it)
    return planDeliveredLoad(plan, r.id, group) > 0 ? 0 : null;
  }
  function planDeliveredLoad(plan, requestId, group) {
    let q = 0;
    ((plan && plan.routes) || []).forEach(function (rt) {
      (rt.stops || []).forEach(function (st) {
        (st.deliveries || []).forEach(function (d) { if (d.requestId === requestId && d.group === group) q += num(d.loadQty, 0); });
      });
    });
    return q;
  }

  // ---- contingency analysis -------------------------------------------------------------------------
  // What the approved plan looks like at minute `now`.
  // -> { parent, trucks: { id: { kind: 'enroute' | 'returning' | 'waiting' | 'finished' | 'out', route,
  //      nextIdx, startKey, availableAt, carried } }, done: { 'rid|group': load }, pool: { 'rid|group': load },
  //      locked: [{ truckId, requestId, group, qty }], base: { 'rid|group': load }, requestIds: [...] }
  function contingencyBase(state, now, parentId) {
    const parent = parentId ? (state.plans || []).find(function (p) { return p.id === parentId; }) : E.activePlan(state);
    if (!parent) throw userError('There is no approved plan to re-plan. Approve a plan first.', 'no-parent');
    const fleet = {};
    (state.scenario.fleet || []).forEach(function (t) { fleet[t.id] = t; });
    const out = { parent: parent, trucks: {}, done: {}, pool: {}, locked: [], base: {}, requestIds: [] };
    function add(map, k, q) { map[k] = (map[k] || 0) + q; }
    function seeReq(id) { if (out.requestIds.indexOf(id) < 0) out.requestIds.push(id); }
    (parent.routes || []).forEach(function (rt) {
      const t = fleet[rt.truckId];
      const stops = rt.stops || [];
      const departed = isNum(rt.depart) && rt.depart <= now;
      let nextIdx = -1;
      for (let k = 0; k < stops.length; k++) { if (!(isNum(stops[k].arrive) && stops[k].arrive <= now)) { nextIdx = k; break; } }
      let kind;
      if (!t || t.status === 'out') kind = 'out';
      else if (!departed) kind = 'waiting';
      else if (isNum(rt.returnAt) && rt.returnAt <= now) kind = 'finished';
      else if (nextIdx < 0) kind = 'returning';
      else kind = 'enroute';
      const info = { kind: kind, route: rt, nextIdx: nextIdx, startKey: null, availableAt: null, carried: 0 };
      if (kind === 'enroute') { info.startKey = stops[nextIdx].nodeKey; info.availableAt = stops[nextIdx].arrive; }
      if (kind === 'returning' || kind === 'finished') info.availableAt = rt.returnAt;
      if (kind === 'waiting') info.availableAt = now;
      out.trucks[rt.truckId] = info;
      const lockedHere = {};
      stops.forEach(function (st, k) {
        const reached = departed && isNum(st.arrive) && st.arrive <= now;
        (st.deliveries || []).forEach(function (d) {
          if (!d || !d.requestId) return;
          const g = d.group || 'cargo';
          const key = d.requestId + '|' + g;
          const q = num(d.loadQty, 0);
          seeReq(d.requestId);
          add(out.base, key, q);
          if (reached) add(out.done, key, q);
          else if (kind === 'enroute' && k >= nextIdx) add(lockedHere, key, q);
          else add(out.pool, key, q);
        });
      });
      Object.keys(lockedHere).forEach(function (key) {
        const p = key.split('|');
        out.locked.push({ truckId: rt.truckId, requestId: p[0], group: p[1], qty: lockedHere[key] });
        info.carried += lockedHere[key];
      });
    });
    (parent.deferred || []).forEach(function (d) {
      if (!d || !d.requestId) return;
      const key = d.requestId + '|' + (d.group || 'cargo');
      seeReq(d.requestId);
      add(out.base, key, num(d.loadQty, 0));
      add(out.pool, key, num(d.loadQty, 0));
    });
    return out;
  }

  // ---- instance building ------------------------------------------------------------------------------
  E.buildInstance = function (state, opts) {
    const o = opts || {};
    const Sv = S();
    const sc = state.scenario || {};
    const set = sc.settings || {};
    const clock = SRO.core.clock;
    const now = Math.floor(isNum(o.now) ? o.now : num(state.clock && state.clock.simMin, 0));
    const windowId = o.windowId || (clock && clock.windowOf ? clock.windowOf(now).id : null);
    const warnings = [];
    const cont = o.contingency ? contingencyBase(state, now, o.parentPlanId) : null;
    const reqById = {};
    (state.requests || []).forEach(function (r) { reqById[r.id] = r; });

    // -- job specs --
    const specs = [];
    function pushSpec(r, group, qty, lockedTruck, origin) {
      if (!(qty > 1e-9)) return;
      const lines = groupLines(r, group);
      const full = SRO.data.catalogHelpers.requestLoads(r.lines)[group];
      const fullQty = full ? full.qty : qty;
      specs.push({ request: r, group: group, qty: qty, fullQty: fullQty, unit: group === 'fuel' ? 'gal' : 'pallet',
        lines: lines, lockedTruck: lockedTruck, origin: origin });
    }
    const contReq = {};
    if (cont) {
      cont.requestIds.forEach(function (rid) {
        const r = reqById[rid];
        if (!r || r.status === 'cancelled' || r.status === 'delivered') return;
        if (!validLoc(r)) { warnings.push(rid + ' has no location; it is left out.'); return; }
        contReq[rid] = true;
        E.GROUPS.forEach(function (g) {
          const key = rid + '|' + g;
          if (!cont.base[key]) return;
          let lockedSum = 0;
          cont.locked.forEach(function (c) { if (c.requestId === rid && c.group === g) lockedSum += c.qty; });
          const poolQty = Math.max(0, cont.base[key] - (cont.done[key] || 0) - lockedSum);
          pushSpec(r, g, poolQty, (r.locks && r.locks.truckId) || null, 'pool');
          cont.locked.forEach(function (c) { if (c.requestId === rid && c.group === g) pushSpec(r, g, c.qty, c.truckId, 'onboard'); });
        });
      });
    }
    E.pendingRequests(state).forEach(function (r) {
      if (contReq[r.id]) return;
      if (cont && cont.requestIds.indexOf(r.id) >= 0) return;
      if (!validLoc(r)) { warnings.push(r.id + ' has no location; it is left out.'); return; }
      const loads = SRO.data.catalogHelpers.requestLoads(r.lines);
      let any = false;
      E.GROUPS.forEach(function (g) {
        const L = loads[g];
        if (!L || !(L.qty > 0)) return;
        let qty = L.qty;
        if (r.status === 'partial') { const rem = deferredRemainder(state, r, g); if (rem !== null) qty = Math.min(qty, rem); }
        if (qty > 1e-9) any = true;
        pushSpec(r, g, qty, (r.locks && r.locks.truckId) || null, 'pool');
      });
      if (!any && !(loads.fuel || loads.cargo)) warnings.push(r.id + ' has no supplies the trucks can carry; it is left out.');
    });

    // -- points: hubs, rally pool, direct --
    const grid = (SRO.data && SRO.data.grid) || [];
    const gridById = {};
    grid.forEach(function (g) { gridById[g.id] = g; });
    const rally = sc.rally || {};
    const banned = {}; (rally.banned || []).forEach(function (g) { banned[g] = true; });
    const pinnedIds = (rally.pinned || []).filter(function (g) { return !banned[g] && gridById[g]; });
    const pinned = {}; pinnedIds.forEach(function (g) { pinned[g] = true; });

    const pts = [], pnodes = [];
    function addPoint(node, pt) { pnodes.push(node); pts.push(pt); return pts.length - 1; }
    const hubPt = {};
    (sc.hubs || []).forEach(function (h) {
      const g = gridById[h.gridId];
      const lat = num(h.lat, g ? g.lat : NaN), lon = num(h.lon, g ? g.lon : NaN);
      if (!isNum(lat) || !isNum(lon)) { warnings.push('Hub ' + (h.name || h.id) + ' has no location; its trucks are left out.'); return; }
      hubPt[h.id] = addPoint({ key: 'hub:' + h.id, kind: 'hub', gridId: h.gridId || null, lat: lat, lon: lon, label: h.name || h.id, hubId: h.id },
        { lat: lat, lon: lon, gridId: h.gridId || null, onGrid: !!g && g.lat === lat && g.lon === lon });
    });

    const mobSet = set.mobility || {};
    function mobilityOf(r) {
      const mob = r.mobility || 'mounted';
      const ms = mobSet[mob] || {};
      const forced = mob === 'fixed' || !!r.directOnly || !!(r.locks && r.locks.forceDirect);
      const radius = mob === 'fixed' ? 0 : (isNum(r.maxTravelMi) ? r.maxTravelMi : num(ms.radiusMi, mob === 'dismounted' ? 5 : 50));
      return { mob: mob, forced: forced, radius: radius, perMi: num(ms.costPerMi, mob === 'dismounted' ? 4 : 0.5) };
    }
    const reqs = [];
    const reqSeen = {};
    specs.forEach(function (s) { if (!reqSeen[s.request.id]) { reqSeen[s.request.id] = true; reqs.push(s.request); } });
    // rally pool: candidate grid points some platoon could reach (straight line within its radius; the
    // road distance is never shorter), plus pinned points
    const G = geo();
    const rallyIds = [];
    grid.forEach(function (g) {
      if (banned[g.id] || !(g.rallyCandidate || pinned[g.id])) return;
      if (g.kind === 'hub' && !pinned[g.id]) return;
      const near = pinned[g.id] || reqs.some(function (r) {
        const m = mobilityOf(r);
        return !m.forced && m.radius > 0 && G.haversineMi(r, g) <= m.radius + 0.25;
      });
      if (near) rallyIds.push(g.id);
    });
    const rallyPt = {};
    rallyIds.forEach(function (id) {
      const g = gridById[id];
      rallyPt[id] = addPoint({ key: 'rally:' + id, kind: 'rally', gridId: id, lat: g.lat, lon: g.lon, label: g.name || id },
        { lat: g.lat, lon: g.lon, gridId: id, onGrid: true });
    });
    const directPt = {};
    reqs.forEach(function (r) {
      directPt[r.id] = addPoint({ key: 'direct:' + r.id, kind: 'direct', gridId: r.gridId || null, lat: num(r.lat), lon: num(r.lon),
        label: r.unitName || r.designator || r.id, requestId: r.id },
        { lat: num(r.lat), lon: num(r.lon), gridId: r.gridId || null, onGrid: false });
    });

    // -- travel matrix (base minutes; road graph, closures applied) --
    const N = SRO.core.network;
    // (let: addLatePoint below swaps in a bigger matrix; network caches its results, so never mutate one)
    let pm = pts.length ? N.pointMatrix(pts, { zones: sc.zones || [], riskRatings: set.riskRatings }) :
      { n: 0, source: 'none', counts: {}, minutes: [], miles: [], riskUnits: [], path: function () { return null; }, gridPath: function () { return []; }, elapsedMs: 0 };

    // -- candidates per spec (in point indexes) --
    const maxC = Math.max(1, E.MAX_RALLY_CANDIDATES | 0);
    const candByReq = {};
    reqs.forEach(function (r) {
      const m = mobilityOf(r);
      const d = directPt[r.id];
      const direct = { p: d, platoonMiles: 0, platoonCost: 0, hint: false };
      if (m.forced) { candByReq[r.id] = { list: [direct], fallback: false, mob: m }; return; }
      const hintId = r.desiredPickup && r.desiredPickup.gridId ? r.desiredPickup.gridId : null;
      const inRange = [];
      rallyIds.forEach(function (id) {
        const k = rallyPt[id];
        const mi = pm.miles[d][k], back = pm.miles[k][d];
        if (!(mi < INF) || !(back < INF) || mi > m.radius + 1e-6) return;
        inRange.push({ p: k, gridId: id, platoonMiles: mi, platoonCost: mi * 2 * m.perMi, hint: id === hintId });
      });
      inRange.sort(function (a, b) { return a.platoonMiles - b.platoonMiles || a.p - b.p; });
      const keep = inRange.filter(function (c, i) { return i < maxC || c.hint || pinned[c.gridId]; });
      if (hintId && !keep.some(function (c) { return c.hint; })) {
        warnings.push(r.id + ': the requested pickup point is not a usable rally point within ' + m.radius + ' mi by road; the solver picks another.');
      }
      if (!keep.length) {
        const reach = Object.keys(hubPt).some(function (h) { return pm.minutes[hubPt[h]][d] < INF && pm.minutes[d][hubPt[h]] < INF; });
        warnings.push(r.id + ' (' + (r.unitName || r.designator || r.id) + '): no rally point within ' + m.radius + ' mi by road, so it is delivered direct' +
          (reach ? '.' : ', but no road from a hub reaches it (closed road), so it waits for the next window.'));
        candByReq[r.id] = { list: [direct], fallback: true, mob: m };
        return;
      }
      candByReq[r.id] = { list: keep, fallback: false, mob: m };
    });

    // -- vehicles (fleet minus trucks out; contingency adjusts en-route trucks) --
    const pal = palette();
    const fleet = sc.fleet || [];
    const vspecs = [];
    fleet.forEach(function (t, i) {
      if (!t || t.status === 'out') return;
      if (hubPt[t.hubId] === undefined) { warnings.push('Truck ' + t.id + ' has no home hub on the map; it is left out.'); return; }
      const v = { truck: t, id: t.id, type: t.type === 'tanker' ? 'tanker' : 'cargo', capacity: num(t.capacity, t.type === 'tanker' ? 2500 : 10),
        hubP: hubPt[t.hubId], availableAt: isNum(t.availableAt) ? t.availableAt : now,
        color: t.color || (pal.length ? pal[i % pal.length] : null), startP: null, preloaded: false, contKind: null };
      if (cont && cont.trucks[t.id]) {
        const ti = cont.trucks[t.id];
        v.contKind = ti.kind;
        if (ti.kind === 'waiting') v.availableAt = now;
        else if (ti.kind === 'returning' || ti.kind === 'finished') v.availableAt = num(ti.availableAt, v.availableAt);
        else if (ti.kind === 'enroute') {
          v.availableAt = num(ti.availableAt, now);
          v.preloaded = true;
          v.capacity = ti.carried;
          v.startKey = ti.startKey;
        }
      }
      vspecs.push(v);
    });
    // start points of en-route trucks: the node of their next stop
    const keyToP = {};
    pnodes.forEach(function (n, p) { keyToP[n.key] = p; });
    vspecs.forEach(function (v) {
      if (!v.startKey) return;
      let p = keyToP[v.startKey];
      if (p === undefined) {
        // a rally point no longer in the pool (or a direct node of a request that left): add it
        const ti = cont.trucks[v.id], st = ti.route.stops[ti.nextIdx];
        p = addLatePoint(st);
      }
      v.startP = p;
    });
    function addLatePoint(st) {
      // rare: rebuild the matrix with one more point (the stop the truck is driving to)
      const node = { key: st.nodeKey, kind: st.kind === 'direct' ? 'direct' : 'rally', gridId: st.gridId || null, lat: st.lat, lon: st.lon, label: st.label || st.nodeKey };
      const p = addPoint(node, { lat: st.lat, lon: st.lon, gridId: st.gridId || null, onGrid: st.kind === 'rally' && !!gridById[st.gridId] });
      keyToP[node.key] = p;
      pm = N.pointMatrix(pts, { zones: sc.zones || [], riskRatings: set.riskRatings });
      return p;
    }
    // trucks cut off by closures (no road from their next stop home) drop out; their loads go back
    if (cont) {
      vspecs.slice().forEach(function (v) {
        if (v.startP == null) return;
        if (pm.minutes[v.startP][v.hubP] < INF) return;
        warnings.push('Truck ' + v.id + ' is cut off by a closed road; its remaining loads go back to the pool.');
        vspecs.splice(vspecs.indexOf(v), 1);
        specs.forEach(function (s) { if (s.origin === 'onboard' && s.lockedTruck === v.id) { s.lockedTruck = null; s.origin = 'pool'; } });
      });
    }

    // -- locks: only to a truck in this plan that can carry the load --
    const vById = {};
    vspecs.forEach(function (v) { vById[v.id] = v; });
    specs.forEach(function (s) {
      if (!s.lockedTruck) return;
      const v = vById[s.lockedTruck];
      const want = s.group === 'fuel' ? 'tanker' : 'cargo';
      // a truck already on the road carries only what is on board, so a planner lock to it cannot
      // take more load this trip (it would only make the solver defer the rest)
      if (v && v.type === want && (s.origin === 'onboard' || !v.preloaded)) return;
      if (s.origin === 'onboard') { s.origin = 'pool'; s.lockedTruck = null; return; }
      if (!v) warnings.push(s.request.id + ' is locked to truck ' + s.lockedTruck + ', which is not available; the lock is ignored for this plan.');
      else if (v.preloaded && v.type === want) warnings.push(s.request.id + ' is locked to truck ' + s.lockedTruck + ', which is already on the road; the rest of the request may go on another truck.');
      s.lockedTruck = null;
    });
    // onboard loads at a stop the truck can no longer reach go back to the pool
    if (cont) {
      specs.forEach(function (s) {
        if (s.origin !== 'onboard') return;
        const v = vById[s.lockedTruck];
        const cl = candByReq[s.request.id].list;
        const ok = cl.some(function (c) { return pm.minutes[v.startP][c.p] < INF && pm.minutes[c.p][v.hubP] < INF; });
        if (!ok) { s.origin = 'pool'; s.lockedTruck = null; warnings.push(s.request.id + ': truck ' + v.id + ' can no longer reach the pickup point; the load goes back to the pool.'); }
      });
      // an en-route truck carries only its own onboard loads. One left with nothing it can still
      // deliver keeps a token capacity (validateInstance needs > 0; no job fits in it): the solver
      // leaves it unused and the decoder sends it from its next stop straight home.
      vspecs.forEach(function (v) {
        if (!v.preloaded) return;
        let c = 0;
        specs.forEach(function (s) { if (s.origin === 'onboard' && s.lockedTruck === v.id) c += s.qty; });
        v.capacity = c > 1e-9 ? c : 1e-9;
      });
    }

    // -- final node list: hubs, used rally points, pinned, direct nodes in use, truck start nodes --
    const used = new Uint8Array(pts.length);
    pnodes.forEach(function (n, p) { if (n.kind === 'hub') used[p] = 1; if (n.kind === 'rally' && pinned[n.gridId]) used[p] = 1; });
    specs.forEach(function (s) { candByReq[s.request.id].list.forEach(function (c) { used[c.p] = 1; }); });
    vspecs.forEach(function (v) { if (v.startP != null) used[v.startP] = 1; });
    const pointIndex = [], nodeOfP = new Int32Array(pts.length).fill(-1);
    for (let p = 0; p < pts.length; p++) if (used[p]) { nodeOfP[p] = pointIndex.length; pointIndex.push(p); }
    const nN = pointIndex.length;
    const convoy = num(set.convoyFactor, 1.5) > 0 ? num(set.convoyFactor, 1.5) : 1.5;
    const minutes = [], miles = [], riskUnits = [];
    for (let a = 0; a < nN; a++) {
      const pa = pointIndex[a];
      const mr = new Array(nN), ml = new Array(nN), rk = new Array(nN);
      for (let b = 0; b < nN; b++) {
        const pb = pointIndex[b];
        const t = pm.minutes[pa][pb];
        mr[b] = t < INF ? t * convoy : INF;
        ml[b] = pm.miles[pa][pb];
        rk[b] = t < INF ? pm.riskUnits[pa][pb] : INF;
        if (!(ml[b] < INF)) { mr[b] = INF; ml[b] = INF; rk[b] = INF; }
      }
      minutes.push(mr); miles.push(ml); riskUnits.push(rk);
    }
    const nodes = pointIndex.map(function (p) { return Object.assign({}, pnodes[p]); });

    // -- vehicles --
    const vehicles = vspecs.map(function (v) {
      const out = { id: v.id, type: v.type, capacity: v.capacity, hubNode: nodeOfP[v.hubP], availableAt: v.availableAt, color: v.color };
      if (v.startP != null) { out.startNode = nodeOfP[v.startP]; out.preloaded = true; }
      return out;
    });

    // -- jobs --
    const jobs = [], jobMaps = [];
    specs.forEach(function (s) {
      const r = s.request;
      const cr = candByReq[r.id];
      const id = r.id + '/' + s.group + (s.origin === 'onboard' ? '@' + s.lockedTruck : '');
      const deadline = isNum(r.deadline) ? r.deadline : (isNum(r.nlt) ? r.nlt : null);
      jobs.push({
        id: id, requestId: r.id, lineIdxs: s.lines.map(function (l) { return l.lineIdx; }), group: s.group,
        qty: Math.round(s.qty * 1e6) / 1e6, unit: s.unit, tier: tierOf(r), classRank: classRankOf(r),
        deadline: deadline, hardDeadline: hardOf(r),
        candidates: cr.list.map(function (c) { return { node: nodeOfP[c.p], platoonMiles: c.platoonMiles, platoonCost: c.platoonCost, hint: !!c.hint }; }),
        lockedTruck: s.lockedTruck || null
      });
      const share = s.fullQty > 0 ? s.qty / s.fullQty : 1;
      jobMaps.push({
        id: id, requestId: r.id, group: s.group, unit: s.unit, qty: s.qty, origin: s.origin, lockedTruck: s.lockedTruck || null,
        directFallback: cr.fallback,
        lines: s.lines.map(function (l) { return Object.assign({}, l, { qty: l.qty * share }); })
      });
    });

    // -- the rest of the instance --
    const w = set.weights || {};
    const weights = { fuel: num(w.fuel, 3), distance: num(w.distance, 3), risk: num(w.risk, 5), simplicity: num(w.simplicity, 2) };
    let maxRally = Math.max(0, Math.round(num(set.maxRallyPoints, 8)));
    let pinnedNodes = pinnedIds.map(function (g) { return nodeOfP[rallyPt[g]]; }).filter(function (n) { return n >= 0; });
    if (pinnedNodes.length > maxRally) {
      warnings.push('More rally points are pinned (' + pinnedNodes.length + ') than the limit (' + maxRally + '); only the first ' + maxRally + ' are kept.');
      pinnedNodes = pinnedNodes.slice(0, maxRally);
    }
    const penalties = clone(set.penalties && typeof set.penalties === 'object' ? Object.assign({}, Sv.DEFAULT_PENALTIES, set.penalties) : Sv.DEFAULT_PENALTIES);
    const instance = {
      startMin: now,
      nodes: nodes,
      minutes: minutes, miles: miles, riskUnits: riskUnits,
      gridPaths: {},
      periods: Sv.expandPeriods(set.periods, now, E.HORIZON_HOURS),
      vehicles: vehicles,
      jobs: jobs,
      weights: weights,
      params: {
        mpg: num(set.mpg, 2) > 0 ? num(set.mpg, 2) : 2, serviceMin: Math.max(0, num(set.serviceMin, 15)), loadMin: Math.max(0, num(set.loadMin, 20)),
        maxRallyPoints: maxRally, pinnedRally: pinnedNodes, bannedRally: []
      },
      penalties: penalties,
      fixed: cont ? {
        parentPlanId: cont.parent.id, atMin: now,
        enRoute: vehicles.filter(function (v) { return v.preloaded; }).map(function (v) { return { truckId: v.id, startNode: v.startNode, availableAt: v.availableAt }; }),
        delivered: Object.keys(cont.done).map(function (k) { const p = k.split('|'); return { requestId: p[0], group: p[1], qty: cont.done[k] }; })
      } : null
    };

    // -- prefix (contingency): the part of each old trip already driven, so delivered stops stay on the
    //    plan as done. En route: done stops + legs up to the stop it is driving to; returning or
    //    finished: the whole old trip; out, or en route but cut off by a closure: done stops and the
    //    legs to them (it stops there; its remaining loads went back to the pool above).
    const prefix = {};
    if (cont) {
      Object.keys(cont.trucks).forEach(function (tid) {
        const ti = cont.trucks[tid];
        const rt = ti.route;
        const nStops = (rt.stops || []).length, nLegs = (rt.legs || []).length;
        let nDone, nL, kind = ti.kind;
        if (ti.kind === 'enroute' && !vById[tid]) {
          kind = 'cutoff';
          nDone = ti.nextIdx; nL = nDone;
          if (!nDone) return;
        } else if (ti.kind === 'enroute') {
          nDone = ti.nextIdx; nL = nDone + 1;
        } else if (ti.kind === 'returning' || ti.kind === 'finished') {
          nDone = nStops; nL = nLegs;
        } else if (ti.kind === 'out') {
          if (!(isNum(rt.depart) && rt.depart <= now)) return;
          nDone = ti.nextIdx < 0 ? nStops : ti.nextIdx; nL = nDone;
          if (!nDone) return;
        } else return;
        prefix[tid] = {
          kind: kind, loadStart: rt.loadStart, depart: rt.depart, returnAt: rt.returnAt,
          stops: (rt.stops || []).slice(0, nDone).map(function (st) { return Object.assign(clone(st), { done: true }); }),
          legs: (rt.legs || []).slice(0, nL).map(function (l) { return clone(l); }),
          parentRoute: rt
        };
      });
    }

    const nodeIndex = {};
    nodes.forEach(function (n, i) { nodeIndex[n.key] = i; });
    const maps = {
      now: now, windowId: windowId, contingency: !!cont, parentPlanId: cont ? cont.parent.id : null,
      // approved plans this one was built on top of (their deliveries were left out of it), so that
      // approving it does not supersede them (store plan/approve reads plan.builtOn)
      builtOn: approvedPlans(state).map(function (p) { return p.id; }),
      nodes: nodes, nodeIndex: nodeIndex, pointIndex: pointIndex,
      jobs: jobMaps,
      vehicles: vspecs.map(function (v) { return { truckId: v.id, hubId: v.truck.hubId, type: v.type, color: v.color, freq: v.truck.freq || null, contKind: v.contKind }; }),
      vehicleIndex: (function () { const m = {}; vspecs.forEach(function (v, i) { m[v.id] = i; }); return m; })(),
      requests: (function () { const m = {}; reqs.forEach(function (r) { m[r.id] = r; }); return m; })(),
      prefix: prefix,
      network: { source: pm.source, counts: pm.counts, elapsedMs: pm.elapsedMs },
      convoyFactor: convoy,
      maxStops: Math.max(1, Math.round(num(set.maxStops, 20))),
      path: function (i, j) { return pm.path(pointIndex[i], pointIndex[j]); },
      gridPath: function (i, j) { return pm.gridPath(pointIndex[i], pointIndex[j]); }
    };
    const problems = Sv.validateInstance ? Sv.validateInstance(instance) : [];
    problems.forEach(function (p) { if (!/is ignored\.$/.test(p)) warnings.push('Plan input problem: ' + p); });
    return { instance: instance, maps: maps, warnings: warnings };
  };

  // ---- warm start for a contingency re-plan: the old plan adjusted to the new instance --------------
  E.contingencyStart = function (build) {
    const inst = build.instance, maps = build.maps, Sv = S();
    if (!maps.contingency || !inst.fixed) return null;
    const routes = inst.vehicles.map(function (v, vi) { return { vehicle: vi, visits: [] }; });
    const left = inst.jobs.map(function (j) { return j.qty; });
    const jobByKey = {};
    inst.jobs.forEach(function (j, idx) {
      const m = maps.jobs[idx];
      jobByKey[m.requestId + '|' + m.group + '|' + (m.origin === 'onboard' ? m.lockedTruck : '')] = idx;
    });
    const parentPlan = build.parentPlan;
    if (!parentPlan) return null;
    (parentPlan.routes || []).forEach(function (rt) {
      const vi = maps.vehicleIndex[rt.truckId];
      if (vi === undefined) return;
      const v = inst.vehicles[vi];
      const stops = rt.stops || [];
      let from = 0;
      if (v.preloaded) {
        from = stops.findIndex(function (st) { return st.nodeKey === maps.nodes[v.startNode].key && !(st.arrive <= maps.now); });
        if (from < 0) return;
      } else if (maps.vehicles[vi].contKind !== 'waiting') return;
      for (let k = from; k < stops.length; k++) {
        const st = stops[k];
        const node = maps.nodeIndex[st.nodeKey];
        if (node === undefined) continue;
        const chunks = {};
        (st.deliveries || []).forEach(function (d) { const key = d.requestId + '|' + d.group; chunks[key] = (chunks[key] || 0) + num(d.loadQty, 0); });
        const jobs = [];
        Object.keys(chunks).forEach(function (key) {
          let j = jobByKey[key + '|' + rt.truckId];
          if (j === undefined) j = jobByKey[key + '|'];
          if (j === undefined || !(left[j] > 1e-9)) return;
          if (!Sv.isCandidate(inst, j, node)) return;
          if (inst.jobs[j].lockedTruck && inst.jobs[j].lockedTruck !== v.id) return;
          if ((inst.jobs[j].group === 'fuel') !== (v.type === 'tanker')) return;
          const q = Math.min(left[j], chunks[key]);
          left[j] -= q;
          jobs.push({ job: j, qty: q });
        });
        if (jobs.length) routes[vi].visits.push({ node: node, jobs: jobs });
      }
    });
    const sol = { routes: routes };
    const ev = Sv.evaluate(inst, sol, { costOnly: true });
    return ev.feasible ? sol : null;
  };

  // ---- en-route trucks carry only what is on board ---------------------------------------------------
  // The solver contract has no "this truck may only carry its locked jobs" rule, so a search can put a
  // pool job on a preloaded (en-route) truck and leave part of its onboard load behind, which cannot
  // happen on the road. This repair (applied to every contingency solution before decoding):
  // takes pool chunks off preloaded trucks, puts any onboard load the solver dropped back on its truck
  // (at a stop that is already a candidate, else the cheapest insertion in minutes), then tries to
  // place each removed pool chunk on another truck of the right type with spare room (kept only when
  // the plan total gets better). -> the same solution object when nothing had to change.
  E.fixPreloaded = function (build, sol) {
    const inst = build.instance, maps = build.maps, Sv = S();
    if (!sol || !Array.isArray(sol.routes) || !inst.vehicles.some(function (v) { return v.preloaded; })) return sol;
    let changed = false;
    const routes = sol.routes.map(function (r) {
      return { vehicle: r.vehicle, visits: (r.visits || []).map(function (vs) { return { node: vs.node, jobs: (vs.jobs || []).map(function (c) { return { job: c.job, qty: c.qty }; }) }; }) };
    });
    function own(v, j) { const jm = maps.jobs[j]; return jm.origin === 'onboard' && jm.lockedTruck === v.id; }
    const removed = [];
    routes.forEach(function (route) {
      const v = inst.vehicles[route.vehicle];
      if (!v || !v.preloaded) return;
      route.visits.forEach(function (vs) {
        vs.jobs = vs.jobs.filter(function (c) {
          if (own(v, c.job)) return true;
          if (c.qty > 1e-9) removed.push({ job: c.job, qty: c.qty });
          changed = true;
          return false;
        });
      });
      const n0 = route.visits.length;
      route.visits = route.visits.filter(function (vs) { return vs.jobs.length; });
      if (route.visits.length !== n0) changed = true;
    });
    const M = inst.minutes;
    function cheapestInsert(route, j) {
      const v = inst.vehicles[route.vehicle];
      const start = v.startNode != null ? v.startNode : v.hubNode;
      let best = null;
      (inst.jobs[j].candidates || []).forEach(function (c) {
        for (let k = 0; k <= route.visits.length; k++) {
          const a = k === 0 ? start : route.visits[k - 1].node;
          const b = k === route.visits.length ? v.hubNode : route.visits[k].node;
          const d = M[a][c.node] + M[c.node][b] - M[a][b];
          if (isFinite(d) && (!best || d < best.d)) best = { d: d, k: k, node: c.node };
        }
      });
      return best;
    }
    function addTo(route, j, q, allowInsert) {
      const vs = route.visits.find(function (x) { return Sv.isCandidate(inst, j, x.node); });
      if (vs) {
        const c = vs.jobs.find(function (x) { return x.job === j; });
        if (c) c.qty += q; else vs.jobs.push({ job: j, qty: q });
        return true;
      }
      if (!allowInsert) return false;
      const ins = cheapestInsert(route, j);
      if (!ins) return false;
      route.visits.splice(ins.k, 0, { node: ins.node, jobs: [{ job: j, qty: q }] });
      return true;
    }
    // onboard loads left behind go back on their truck
    const got = new Float64Array(inst.jobs.length);
    routes.forEach(function (r) { r.visits.forEach(function (vs) { vs.jobs.forEach(function (c) { got[c.job] += c.qty; }); }); });
    inst.jobs.forEach(function (jb, j) {
      const jm = maps.jobs[j];
      if (jm.origin !== 'onboard') return;
      const miss = jb.qty - got[j];
      if (!(miss > 1e-6)) return;
      const vi = maps.vehicleIndex[jm.lockedTruck];
      if (vi === undefined) return;
      let route = routes.find(function (r) { return r.vehicle === vi; });
      if (!route) { route = { vehicle: vi, visits: [] }; routes.push(route); }
      if (addTo(route, j, miss, true)) changed = true;
    });
    if (!changed) return sol;
    let cur = { routes: routes.filter(function (r) { return r.visits.length; }) };
    // removed pool chunks: another truck of the right type with room, when that lowers the total
    if (removed.length) {
      let curTotal = Sv.evaluate(inst, cur, { costOnly: true }).total;
      removed.forEach(function (ch) {
        const jb = inst.jobs[ch.job];
        const tries = [];
        inst.vehicles.forEach(function (v, vi) {
          if (v.preloaded || !Sv.vehicleCompatible(v, jb)) return;
          const route = cur.routes.find(function (r) { return r.vehicle === vi; }) || { vehicle: vi, visits: [] };
          let load = 0;
          route.visits.forEach(function (vs) { vs.jobs.forEach(function (c) { load += c.qty; }); });
          if (load + ch.qty > v.capacity + 1e-9) return;
          const hit = route.visits.some(function (vs) { return Sv.isCandidate(inst, ch.job, vs.node); });
          const ins = hit ? { d: 0 } : cheapestInsert(route, ch.job);
          if (ins) tries.push({ vi: vi, d: ins.d });
        });
        tries.sort(function (a, b) { return a.d - b.d; });
        for (let t = 0; t < Math.min(3, tries.length); t++) {
          const trial = { routes: cur.routes.map(function (r) { return { vehicle: r.vehicle, visits: r.visits.map(function (vs) { return { node: vs.node, jobs: vs.jobs.map(function (c) { return { job: c.job, qty: c.qty }; }) }; }) }; }) };
          let route = trial.routes.find(function (r) { return r.vehicle === tries[t].vi; });
          if (!route) { route = { vehicle: tries[t].vi, visits: [] }; trial.routes.push(route); }
          if (!addTo(route, ch.job, ch.qty, true)) continue;
          const ev = Sv.evaluate(inst, trial, { costOnly: true });
          if (ev.feasible && ev.total < curTotal - 1e-9) { cur = trial; curTotal = ev.total; break; }
        }
      });
    }
    return cur;
  };

  // ---- plan decoding -------------------------------------------------------------------------------
  function encodePath(coords) {
    if (!coords || coords.length < 2) return '';
    return geo().encodePolyline(coords, E.PATH_PRECISION);
  }
  function periodName(inst, idx) {
    const p = inst.periods && inst.periods[idx];
    return p ? (p.name || null) : null;
  }
  // per-line split of a chunk of a job: the chunk covers load units [from, from + q) of the job
  function splitLines(jm, from, q) {
    const Q = jm.qty;
    if (!(Q > 0)) return [];
    const a = Math.max(0, Math.min(1, from / Q)), b = Math.max(0, Math.min(1, (from + q) / Q));
    let loadSum = 0;
    jm.lines.forEach(function (l) { loadSum += l.load > 0 ? l.load : 0; });
    return jm.lines.map(function (l) {
      const qa = roundLine(l.qty * a, l.qty), qb = roundLine(l.qty * b, l.qty);
      const share = loadSum > 0 ? (l.load > 0 ? l.load : 0) / loadSum : 1 / jm.lines.length;
      return {
        requestId: jm.requestId, lineIdx: l.lineIdx, qty: Math.max(0, Math.round((qb - qa) * 1e6) / 1e6), unit: l.unit,
        classId: l.classId, itemId: l.itemId, option: l.option, group: jm.group,
        loadQty: Math.round(q * share * 1e6) / 1e6, loadUnit: jm.unit, jobId: jm.id
      };
    }).filter(function (x) { return x.qty > 0 || x.loadQty > 1e-9; });
  }

  function legFrom(inst, maps, l) {
    const p = maps.path(l.from, l.to) || { coords: null, source: 'straight', approximate: true };
    const leg = {
      fromKey: maps.nodes[l.from].key, toKey: maps.nodes[l.to].key,
      gridPath: maps.gridPath(l.from, l.to),
      depart: rd(l.depart), arrive: rd(l.arrive), miles: rd(l.miles), riskUnits: rd(l.riskUnits),
      period: periodName(inst, l.periodIdx),
      path: encodePath(p.coords), source: p.source || 'osm-roads'
    };
    if (p.approximate) leg.approximate = true;
    if (l.unreachable || p.unreachable) leg.unreachable = true;
    return leg;
  }

  // result: a solve() result ({ solution, evaluation?, explain?, elapsedSec, extra, params, ... }) or
  // { solution } (e.g. the best plan kept on Cancel). meta: { method, label, params, runtimeSec,
  // cancelled, name, compareId, reason, warnings }.
  E.decodePlan = function (build, result, meta) {
    const Sv = S(), F = fmt();
    const inst = build.instance, maps = build.maps, m = meta || {};
    const res = result || {};
    const sol0 = res.solution || { routes: [] };
    const sol = maps.contingency ? E.fixPreloaded(build, sol0) : sol0;
    const ev = sol === sol0 && res.evaluation && Array.isArray(res.evaluation.routes) && Array.isArray(res.evaluation.deferred) ? res.evaluation : Sv.evaluate(inst, sol);
    const explain = Array.isArray(res.explain) && res.evaluation === ev ? res.explain : Sv.explainDeferred(inst, ev);
    const now = maps.now;
    const deliveredSoFar = new Float64Array(inst.jobs.length);

    // routes the solver used
    const byVeh = {};
    ev.routes.forEach(function (r) { byVeh[r.vehicle] = r; });
    const routes = [];
    inst.vehicles.forEach(function (v, vi) {
      const r = byVeh[vi];
      const vm = maps.vehicles[vi];
      const pre = maps.prefix[v.id];
      if (!r && !pre) return;
      const stops = [], legs = [];
      if (pre) {
        pre.stops.forEach(function (st) { stops.push(clone(st)); });
        pre.legs.forEach(function (l) { legs.push(clone(l)); });
      }
      let miles = 0, gallons = 0, riskUnits = 0, cost = { fuel: 0, distance: 0, risk: 0, simplicity: 0, platoon: 0, lateness: 0, total: 0 };
      if (r) {
        miles = r.miles; gallons = r.gallons; riskUnits = r.riskUnits; cost = rdCost(r.cost);
        r.legs.forEach(function (l) {
          if (l.from === l.to && !(l.miles > 0)) return;              // en-route truck already at its next stop
          legs.push(legFrom(inst, maps, l));
        });
        r.stops.forEach(function (s) {
          const node = maps.nodes[s.node];
          const deliveries = [], pickups = [], seenReq = {};
          s.jobs.forEach(function (c) {
            const jm = maps.jobs[c.job];
            splitLines(jm, deliveredSoFar[c.job], c.qty).forEach(function (d) { deliveries.push(d); });
            deliveredSoFar[c.job] += c.qty;
            if (!seenReq[jm.requestId] && c.qty > 0) {
              seenReq[jm.requestId] = true;
              const cand = (inst.jobs[c.job].candidates || []).find(function (x) { return x.node === s.node; });
              const rq = maps.requests[jm.requestId] || {};
              pickups.push({ requestId: jm.requestId, platoonMiles: cand ? rd(cand.platoonMiles) : 0, unitName: rq.unitName || '', designator: rq.designator || '' });
            }
          });
          stops.push({
            seq: 0, nodeKey: node.key, kind: node.kind === 'hub' ? 'rally' : node.kind, gridId: node.gridId, lat: node.lat, lon: node.lon, label: node.label,
            arrive: s.arrive, depart: s.depart, period: periodName(inst, s.periodIdx),
            etaText: F ? F.dayTime(s.arrive, now) : null,
            deliveries: deliveries, pickups: pickups
          });
        });
      } else if (pre && pre.kind === 'enroute') {
        // the truck carries nothing it can still deliver: it drives on to its next stop, then home
        const t = v.availableAt;
        const tm = Sv.legTiming(inst, t, v.startNode, v.hubNode);
        if (tm.arrive < INF) {
          legs.push(legFrom(inst, maps, { from: v.startNode, to: v.hubNode, depart: t, arrive: tm.arrive, miles: tm.miles, riskUnits: tm.riskUnits, periodIdx: tm.periodIdx }));
          miles = tm.miles; gallons = tm.miles / (inst.params.mpg || 2); riskUnits = tm.riskUnits;
        }
      }
      stops.forEach(function (st, k) { st.seq = k + 1; });
      const lastLeg = legs[legs.length - 1];
      const route = {
        truckId: v.id, type: v.type, typeLabel: truckTypeLabel(v.type), color: v.color || vm.color || null, freq: vm.freq, hubId: vm.hubId,
        loadStart: pre ? pre.loadStart : (r ? r.loadStart : null),
        depart: pre ? pre.depart : (r ? r.depart : null),
        returnAt: r ? r.returnAt : (lastLeg ? lastLeg.arrive : (pre ? pre.returnAt : null)),
        stops: stops, legs: legs,
        miles: rd(miles), gallons: rd(gallons), riskUnits: rd(riskUnits), load: r ? Math.round(r.load * 1e6) / 1e6 : 0, capacity: Math.round(v.capacity * 1e6) / 1e6,
        cost: cost
      };
      if (pre) { route.continued = true; route.startKey = v.startNode != null ? maps.nodes[v.startNode].key : null; route.preloaded = !!v.preloaded; route.stopsDone = pre.stops.length; }
      routes.push(route);
    });
    // trucks of the old plan that are not in this instance (marked out, or cut off by a closure while
    // en route): their done stops stay. A cut-off truck's return time is unknown (null), so approving
    // the plan keeps the truck's old availableAt instead of making it available at once.
    Object.keys(maps.prefix).forEach(function (tid) {
      if (maps.vehicleIndex[tid] !== undefined) return;
      const pre = maps.prefix[tid];
      const pr = pre.parentRoute;
      const lastLeg = pre.legs[pre.legs.length - 1];
      routes.push(Object.assign(clone(pr), { stops: clone(pre.stops), legs: clone(pre.legs), continued: true, stopsDone: pre.stops.length,
        out: pre.kind === 'out', cutOff: pre.kind === 'cutoff', returning: pre.kind === 'returning',
        returnAt: pre.kind === 'out' ? (lastLeg ? lastLeg.arrive : null) : pre.kind === 'cutoff' ? null : pr.returnAt,
        miles: 0, gallons: 0, riskUnits: 0, cost: { fuel: 0, distance: 0, risk: 0, simplicity: 0, platoon: 0, lateness: 0, total: 0 } }));
    });

    // deferred, per line
    const deferred = [];
    explain.forEach(function (x) {
      const jm = maps.jobs[x.job];
      const from = Math.max(0, jm.qty - x.qty);
      splitLines(jm, from, x.qty).forEach(function (d) {
        deferred.push(Object.assign(d, { reason: x.reason, detail: x.detail || null, note: x.note || '' }));
      });
    });
    // late
    const late = (ev.late || []).map(function (x) {
      return { requestId: maps.jobs[x.job].requestId, jobId: maps.jobs[x.job].id, minutesLate: Math.round(x.minutesLate), hard: (ev.hardLate || []).indexOf(x.job) >= 0 };
    });

    // byRequest index for the platoon sergeant views
    const byRequest = {};
    function entryFor(rid) {
      if (!byRequest[rid]) {
        byRequest[rid] = { requestId: rid, truckId: null, truckColor: null, truckFreq: null, truckType: null, stopSeq: null, nodeKind: null, nodeKey: null,
          gridId: null, lat: null, lon: null, label: null, eta: null, etaText: null, platoonMiles: null, stopsBefore: null,
          qtyByLine: {}, deferredQty: {}, deferReason: null, deferNote: null, minutesLate: 0, status: 'planned', stops: [] };
      }
      return byRequest[rid];
    }
    // qtyByLine counts every delivery of the request in this plan, done stops of a re-plan included,
    // so qtyByLine + deferredQty = what the plan covers per line ('40 of 60 at F; 20 more next window')
    routes.forEach(function (rt) {
      rt.stops.forEach(function (st, k) {
        st.deliveries.forEach(function (d) {
          const e = entryFor(d.requestId);
          e.qtyByLine[d.lineIdx] = Math.round(((e.qtyByLine[d.lineIdx] || 0) + d.qty) * 1e6) / 1e6;
          let s = e.stops.find(function (x) { return x.truckId === rt.truckId && x.stopSeq === st.seq; });
          if (!s) {
            const pk = st.pickups.find(function (p) { return p.requestId === d.requestId; });
            s = { truckId: rt.truckId, stopSeq: st.seq, nodeKind: st.kind, nodeKey: st.nodeKey, gridId: st.gridId, lat: st.lat, lon: st.lon, label: st.label,
              eta: st.arrive, etaText: st.etaText, done: !!st.done, stopsBefore: rt.stops.slice(0, k).filter(function (x) { return !x.done; }).length,
              platoonMiles: pk ? pk.platoonMiles : 0 };
            e.stops.push(s);
          }
        });
      });
    });
    deferred.forEach(function (d) {
      const e = entryFor(d.requestId);
      e.deferredQty[d.lineIdx] = Math.round(((e.deferredQty[d.lineIdx] || 0) + d.qty) * 1e6) / 1e6;
      if (!e.deferReason) { e.deferReason = d.reason; e.deferNote = d.note; }
    });
    late.forEach(function (x) { const e = entryFor(x.requestId); e.minutesLate = Math.max(e.minutesLate, x.minutesLate); });
    const truckOf = {};
    routes.forEach(function (rt) { truckOf[rt.truckId] = rt; });
    Object.keys(byRequest).forEach(function (rid) {
      const e = byRequest[rid];
      e.stops.sort(function (a, b) { return (a.done - b.done) || (a.eta - b.eta); });
      const p = e.stops[0];
      if (p) {
        const rt = truckOf[p.truckId];
        Object.assign(e, { truckId: p.truckId, truckColor: rt.color, truckFreq: rt.freq, truckType: rt.type, stopSeq: p.stopSeq, nodeKind: p.nodeKind,
          nodeKey: p.nodeKey, gridId: p.gridId, lat: p.lat, lon: p.lon, label: p.label, eta: p.eta, etaText: p.etaText, platoonMiles: p.platoonMiles,
          stopsBefore: p.stopsBefore });
      }
      const hasDef = Object.keys(e.deferredQty).some(function (k) { return e.deferredQty[k] > 0; });
      e.status = !p ? 'deferred' : hasDef ? 'partial' : 'planned';
    });

    // requests counted in this plan
    const reqIds = {};
    maps.jobs.forEach(function (j) { reqIds[j.requestId] = true; });
    const delayed = {};
    deferred.forEach(function (d) { delayed[d.requestId] = true; });
    const lateReq = {};
    late.forEach(function (x) { lateReq[x.requestId] = true; });
    const ex = res.extra || {};
    const runtimeSec = isNum(m.runtimeSec) ? m.runtimeSec : (isNum(res.elapsedSec) ? res.elapsedSec : (isNum(res.wallSec) ? res.wallSec : null));
    const label = m.label || res.label || (Sv.METHOD_LABELS && Sv.METHOD_LABELS[m.method]) || m.method || 'Plan';
    const plan = {
      windowId: maps.windowId,
      name: m.name || ((maps.contingency ? 'Re-plan, ' : '') + label + ', ' + (F ? F.dtg(now) : now)),
      method: m.method || res.method || null,
      methodLabel: label,
      params: m.params || res.params || null,
      createdAt: now,
      runtimeSec: rd(runtimeSec),
      mipGap: typeof ex.mipGap === 'number' ? ex.mipGap : null,
      mipStatus: ex.status != null ? ex.status : null,
      stopReason: m.cancelled ? 'cancelled' : (res.stopReason || null),
      cancelled: !!m.cancelled,
      parentPlanId: maps.parentPlanId || null,
      builtOn: (maps.builtOn || []).slice(),
      replanReason: maps.contingency ? (m.reason || null) : null,
      compareId: m.compareId || null,
      rallyPoints: (ev.rallyNodes || []).map(function (n) { return maps.nodes[n].gridId; }),
      routes: routes,
      deferred: deferred,
      late: late,
      cost: rdCost(Object.assign({ total: ev.total }, ev.cost)),
      stats: {
        requests: Object.keys(reqIds).length, jobs: inst.jobs.length,
        stops: ev.stats ? ev.stats.stops : 0, trucksUsed: ev.stats ? ev.stats.trucksUsed : 0,
        miles: ev.stats ? rd(ev.stats.miles) : 0, gallons: ev.stats ? rd(ev.stats.gallons) : 0, riskUnits: ev.stats ? rd(ev.stats.riskUnits) : 0,
        late: Object.keys(lateReq).length, delayed: Object.keys(delayed).length, hardLate: (ev.hardLate || []).length,
        rallyPoints: (ev.rallyNodes || []).length, violations: (ev.violations || []).length, feasible: !!ev.feasible,
        runtimeSec: rd(runtimeSec)
      },
      network: { source: maps.network.source, counts: maps.network.counts, convoyFactor: maps.convoyFactor },
      warnings: (build.warnings || []).concat(Array.isArray(res.warnings) ? res.warnings : []).concat(m.warnings || [])
        .concat(sol !== sol0 ? ['Loads were moved so that trucks already on the road carry only what is on board.'] : [])
        .concat(ev.stats && maps.maxStops && ev.stats.stops > maps.maxStops ? ['This plan has ' + ev.stats.stops + ' stops, more than the ' + maps.maxStops + '-stop guide for one window.'] : []),
      byRequest: byRequest,
      approved: false
    };
    if (maps.contingency && build.parentPlan && build.parentPlan.byRequest) plan.changes = E.planChanges(build.parentPlan, plan);
    return plan;
  };

  // Requests whose truck, pickup point or ETA differ between two plans (before/after view).
  E.planChanges = function (before, after) {
    const out = [];
    const a = (before && before.byRequest) || {}, b = (after && after.byRequest) || {};
    const ids = Object.keys(a).concat(Object.keys(b).filter(function (k) { return !a[k]; }));
    // every stop of the request (done ones too), as truck@node and as truck@node@minute
    function sig(e, withEta) {
      return (e.stops || []).map(function (s) { return s.truckId + '@' + s.nodeKey + (withEta ? '@' + Math.round(num(s.eta, -1)) : ''); }).sort().join('|');
    }
    function short(e) { return e ? { truckId: e.truckId, gridId: e.gridId, label: e.label, eta: e.eta, status: e.status } : null; }
    ids.forEach(function (rid) {
      const x = a[rid], y = b[rid];
      let kind = null;
      if (x && !y) kind = 'dropped';
      else if (!x && y) kind = 'added';
      else if (x.status !== y.status && (y.status === 'deferred' || x.status === 'deferred')) kind = y.status === 'deferred' ? 'delayed' : 'restored';
      else if (sig(x, false) !== sig(y, false)) kind = 'moved';
      else if (sig(x, true) !== sig(y, true)) kind = 'eta';
      else if (x.status !== y.status) kind = y.status === 'partial' ? 'delayed' : 'restored';
      if (kind) out.push({ requestId: rid, kind: kind, before: short(x), after: short(y) });
    });
    return out;
  };

  // ---- helpers for views ---------------------------------------------------------------------------
  const coordMemo = typeof WeakMap === 'function' ? new WeakMap() : null;
  E.legCoords = function (leg) {
    if (!leg) return null;
    if (Array.isArray(leg.coords)) return leg.coords;
    if (Array.isArray(leg.path)) return leg.path;
    if (typeof leg.path !== 'string' || !leg.path) return null;
    if (coordMemo && coordMemo.has(leg)) return coordMemo.get(leg);
    const c = geo().decodePolyline(leg.path, E.PATH_PRECISION);
    if (coordMemo) coordMemo.set(leg, c);
    return c;
  };
  // Plan routes in the shape SRO.ui.map setRoutes / truckPosition read (decoded coords per leg).
  E.mapRoutes = function (plan) {
    return ((plan && plan.routes) || []).map(function (rt) {
      return {
        truckId: rt.truckId, color: rt.color, type: rt.type, depart: rt.depart, returnAt: rt.returnAt,
        legs: (rt.legs || []).map(function (l) {
          return { coords: E.legCoords(l), source: l.source, approximate: !!l.approximate, depart: l.depart, arrive: l.arrive, fromKey: l.fromKey, toKey: l.toKey };
        }),
        stops: (rt.stops || []).map(function (s) { return { lat: s.lat, lon: s.lon, seq: s.seq, label: s.label, done: !!s.done, arrive: s.arrive, kind: s.kind }; })
      };
    });
  };
  // The plan entry a platoon sergeant view shows for a request: from the approved plan that serves it,
  // else the newest draft plan. -> { plan, entry } or null.
  E.requestPlan = function (state, requestId) {
    let best = null;
    ((state && state.plans) || []).forEach(function (p) {
      if (!p || !p.byRequest || !p.byRequest[requestId] || p.superseded) return;
      const score = (p.approved ? 2e9 : 0) + num(p.approvedAt, num(p.createdAt, 0));
      if (!best || score >= best.score) best = { plan: p, entry: p.byRequest[requestId], score: score };
    });
    return best ? { plan: best.plan, entry: best.entry } : null;
  };

  // ==== runtime: status, worker client, jobs ========================================================
  const rt = {
    store: null, unsub: null, opts: {}, listeners: [], client: null, job: null, buildCache: null, autoKey: null, jobSeq: 0,
    status: { phase: 'idle', kind: null, method: null, methods: null, methodIndex: null, fraction: 0, bestCost: null, elapsedSec: 0,
      message: '', history: [], error: null, highsReady: null, mode: null, planId: null, planIds: [] }
  };

  E.status = function () {
    const s = Object.assign({}, rt.status);
    s.history = rt.status.history.slice();
    s.planIds = rt.status.planIds.slice();
    if (rt.client) { s.highsReady = rt.client.highs; s.mode = rt.client.mode; }
    return s;
  };
  E.subscribe = function (fn) {
    if (typeof fn !== 'function') return function () {};
    rt.listeners.push(fn);
    return function () { const i = rt.listeners.indexOf(fn); if (i >= 0) rt.listeners.splice(i, 1); };
  };
  function notify() {
    const s = E.status();
    rt.listeners.slice().forEach(function (fn) { try { fn(s); } catch (e) { if (root.console) root.console.error(e); } });
  }
  function setStatus(patch) { Object.assign(rt.status, patch); notify(); }

  function getStore() {
    if (!rt.store) throw userError('The planner engine is not started (engine.init(store) was not called).', 'no-store');
    return rt.store;
  }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---- worker client ----
  function createClient(opts) {
    const c = { mode: null, worker: null, url: null, ready: null, highs: null, highsError: null, methods: null, handlers: {}, seq: 0 };
    function route(m) {
      if (!m) return;
      if (m.type === 'ready') return;
      const h = c.handlers[m.id];
      if (!h) return;
      if (m.type === 'progress') { if (h.onProgress) h.onProgress(m); }
      else if (m.type === 'method-done') { if (h.onMethodDone) h.onMethodDone(m.row); }
      else if (m.type === 'done') { delete c.handlers[m.id]; h.resolve(m.result); }
      else if (m.type === 'error') { delete c.handlers[m.id]; const e = new Error(m.message || 'The solver stopped with an error.'); e.code = m.code; h.reject(e); }
    }
    function failAll(msg) {
      const hs = c.handlers; c.handlers = {};
      Object.keys(hs).forEach(function (k) { const e = new Error(msg); e.code = 'worker-failed'; hs[k].reject(e); });
    }
    function startMain() {
      c.mode = 'main';
      const doc = root.document;
      const Sv = S() || {};
      const loaded = Sv.worker && typeof Sv.worker.handle === 'function' && Sv.methods && Object.keys(Sv.methods).length;
      if (!loaded && doc) {
        const ws = doc.getElementById('worker-src');
        if (ws) {
          const s = doc.createElement('script');
          s.textContent = ws.textContent;
          (doc.head || doc.documentElement).appendChild(s);
        }
      }
      if (S() && S().setHighsStatus && S().runtime && S().runtime.highs !== true) {
        S().setHighsStatus(false, 'Exact (MIP) needs a background worker, which this browser did not allow.');
      }
      c.highs = !!(S() && S().runtime && S().runtime.highs === true);
      c.methods = S() && S().listMethods ? S().listMethods() : null;
    }
    c.start = function () {
      if (c.ready) return c.ready;
      c.ready = new Promise(function (resolve) {
        const doc = root.document;
        const ws = doc && doc.getElementById ? doc.getElementById('worker-src') : null;
        let w = null;
        if (!opts.forceMain && ws && typeof root.Worker === 'function' && typeof root.Blob === 'function' && root.URL && root.URL.createObjectURL) {
          try {
            const hj = doc.getElementById('highs-js');
            const src = (hj ? hj.textContent + '\n;\n' : '') + ws.textContent;
            c.url = root.URL.createObjectURL(new root.Blob([src], { type: 'text/javascript' }));
            w = new root.Worker(c.url);
          } catch (e) { w = null; }
        }
        if (!w) { startMain(); resolve(c); return; }
        c.mode = 'worker'; c.worker = w;
        let settled = false;
        const timer = setTimeout(function () { if (!settled) { settled = true; c.highs = false; resolve(c); notify(); } }, 30000);
        w.onmessage = function (e) {
          const m = e.data;
          if (m && m.type === 'ready') {
            c.highs = !!m.highs; c.highsError = m.error || null; c.methods = m.methods || null;
            if (!settled) { settled = true; clearTimeout(timer); resolve(c); }
            notify();
            return;
          }
          route(m);
        };
        w.onerror = function (e) {
          if (e && e.preventDefault) e.preventDefault();
          if (!settled) {
            settled = true; clearTimeout(timer);
            try { w.terminate(); } catch (x) { /* already gone */ }
            c.worker = null;
            startMain(); resolve(c); notify();
            return;
          }
          failAll('The solver stopped unexpectedly' + (e && e.message ? ' (' + e.message + ')' : '') + '.');
          c.terminate();
        };
        const wz = doc.getElementById('highs-wasm-gz');
        w.postMessage({ type: 'init', wasmGzB64: wz ? wz.textContent : null });
      });
      return c.ready;
    };
    c.request = function (msg, hooks) {
      const h = hooks || {};
      return c.start().then(function () {
        return new Promise(function (resolve, reject) {
          const id = 'q' + (++c.seq);
          msg.id = id;
          c.handlers[id] = { resolve: resolve, reject: reject, onProgress: h.onProgress, onMethodDone: h.onMethodDone };
          if (c.mode === 'worker' && c.worker) {
            try { c.worker.postMessage(msg); } catch (e) { delete c.handlers[id]; reject(e); }
          } else {
            // main thread: give the page a moment to paint the 'running' state first
            setTimeout(function () {
              if (!c.handlers[id]) return;                 // cancelled before it started
              const W = S() && S().worker;
              if (!W || typeof W.handle !== 'function') {
                delete c.handlers[id];
                reject(userError('The solver is not part of this build.', 'no-solver'));
                return;
              }
              Promise.resolve(W.handle(msg, route)).catch(function (e) { route({ type: 'error', id: id, message: e && e.message }); });
            }, 30);
          }
        });
      });
    };
    c.busy = function () { return Object.keys(c.handlers).length > 0; };
    c.terminate = function () {
      if (c.worker) { try { c.worker.terminate(); } catch (e) { /* gone */ } }
      if (c.url && root.URL && root.URL.revokeObjectURL) { try { root.URL.revokeObjectURL(c.url); } catch (e) { /* ignore */ } }
      c.worker = null; c.url = null; c.ready = null;
      if (c.mode === 'worker') c.mode = null;
      const hs = c.handlers; c.handlers = {};
      Object.keys(hs).forEach(function (k) { const e = new Error('Stopped.'); e.code = 'cancelled'; hs[k].reject(e); });
    };
    return c;
  }
  function client() { return rt.client || (rt.client = createClient(rt.opts || {})); }

  // ---- inputs ----
  function solverSettings(state) {
    const set = state.scenario.settings || {};
    return { timeLimitSec: num(set.timeLimitSec, 300), methodParams: clone(set.methodParams || {}), method: set.method };
  }
  function paramsFor(state, method, o) {
    const set = state.scenario.settings || {};
    const base = (o && o.params && (o.params[method] || (typeof o.params === 'object' && !Array.isArray(o.params) && !o.params.tabu && !o.params.sa && !o.params.aco && !o.params.mip ? o.params : null))) ||
      (set.methodParams && set.methodParams[method]) || {};
    const p = Object.assign({}, base);
    if (o && isNum(o.timeCapSec)) { p.timeCapSec = o.timeCapSec; if (method === 'mip') p.timeLimitSec = o.timeCapSec; }
    return p;
  }
  function getBuild(state, o) {
    const key = [state.requests, state.scenario, state.plans, Math.floor(num(state.clock && state.clock.simMin, 0)), !!o.contingency, o.windowId || '', o.parentPlanId || ''];
    const c = rt.buildCache;
    if (c && c.key.length === key.length && c.key.every(function (x, i) { return x === key[i]; })) return c.value;
    const value = E.buildInstance(state, { contingency: !!o.contingency, windowId: o.windowId, parentPlanId: o.parentPlanId });
    if (o.contingency) {
      const pid = value.maps.parentPlanId;
      value.parentPlan = (state.plans || []).find(function (p) { return p.id === pid; }) || null;
    }
    rt.buildCache = { key: key, value: value };
    return value;
  }
  function storePlan(plan) {
    const store = getStore();
    const res = store.dispatch({ type: 'plan/store', plan: plan, now: plan.createdAt });
    if (!res || !res.ok) throw userError((res && res.error) || 'The plan could not be saved.', 'store');
    const stored = (store.getState().plans || []).find(function (p) { return p.id === res.id; });
    return stored || Object.assign({}, plan, { id: res.id });
  }
  function labelOf(method) { const Sv = S(); return (Sv && Sv.METHOD_LABELS && Sv.METHOD_LABELS[method]) || method; }
  function summary(plan) {
    const st = plan.stats || {};
    const parts = [st.trucksUsed + ' truck' + (st.trucksUsed === 1 ? '' : 's'), st.stops + ' stop' + (st.stops === 1 ? '' : 's')];
    if (st.delayed) parts.push(st.delayed + ' request' + (st.delayed === 1 ? '' : 's') + ' delayed');
    if (st.late) parts.push(st.late + ' late');
    return parts.join(', ');
  }

  // ---- jobs (run / compare / replan) ----
  function startJob(spec) {
    if (rt.job) {
      if (rt.job.kind === spec.kind && (spec.kind !== 'compare')) return rt.job.promise;
      return Promise.reject(userError('The solver is already running. Wait for it to finish or cancel it.', 'busy'));
    }
    const store = getStore();
    const job = { id: ++rt.jobSeq, kind: spec.kind, methods: spec.methods, method: spec.methods[0], best: null, bestCost: null, bestMethod: null,
      history: [], plans: [], rows: [], started: wallNow(), cancelled: false, done: false, reason: spec.reason || null, auto: spec.auto || null,
      compareId: null, params: {} };
    rt.job = job;
    setStatus({ phase: 'preparing', kind: spec.kind, method: job.method, methods: spec.kind === 'compare' ? spec.methods.slice() : null, methodIndex: spec.kind === 'compare' ? 0 : null,
      fraction: 0, bestCost: null, elapsedSec: 0, message: 'Routing on the road network...', history: [], error: null, planId: null, planIds: [] });

    function elapsed() { return (wallNow() - job.started) / 1000; }
    function onProgress(p) {
      if (job.cancelled || job.done) return;
      if (p.best) { job.best = p.best; job.bestMethod = p.method || job.method; }
      if (typeof p.bestCost === 'number' && isFinite(p.bestCost) && (job.bestCost === null || p.bestCost < job.bestCost - 1e-9)) {
        job.bestCost = p.bestCost;
        job.history.push({ t: Math.round(elapsed() * 100) / 100, best: p.bestCost });
      }
      setStatus({
        phase: 'running', method: p.method || job.method, methodIndex: typeof p.methodIndex === 'number' ? p.methodIndex : rt.status.methodIndex,
        fraction: typeof p.fraction === 'number' ? Math.max(0, Math.min(1, p.fraction)) : rt.status.fraction,
        bestCost: typeof p.bestCost === 'number' ? p.bestCost : rt.status.bestCost,
        elapsedSec: elapsed(), message: (p.method ? labelOf(p.method) + ': ' : '') + (p.message || 'Searching'),
        history: job.history.slice()
      });
    }

    job.promise = delay(20).then(function () {
      const state = store.getState();
      const build = getBuild(state, { contingency: spec.kind === 'replan', windowId: spec.windowId, parentPlanId: spec.parentPlanId });
      job.build = build;
      if (!build.instance.jobs.length) {
        throw userError(spec.kind === 'replan' ? 'Nothing is left to deliver in the approved plan.' : 'No requests are waiting for a plan.', 'no-requests');
      }
      const problems = S().validateInstance(build.instance).filter(function (p) { return !/is ignored\.$/.test(p); });
      if (problems.length) throw userError('The plan inputs have a problem: ' + problems[0], 'bad-instance');
      if (job.cancelled) throw userError('Stopped.', 'cancelled');
      setStatus({ phase: 'running', message: 'Starting ' + labelOf(job.method) + '...', elapsedSec: elapsed() });
      const settings = solverSettings(state);
      const c = client();
      // the knobs each method runs with (clamped as the solver does), kept for a plan stored on Cancel
      spec.methods.forEach(function (mth) {
        const p = paramsFor(state, mth, spec);
        try { job.params[mth] = S().clampParams ? S().clampParams(mth, p, settings) : p; } catch (e) { job.params[mth] = p; }
      });
      if (spec.kind === 'compare') {
        job.compareId = 'C' + Math.round(build.maps.now) + '-' + job.id + '-' + Date.now().toString(36);
        const params = {};
        spec.methods.forEach(function (mth) { params[mth] = paramsFor(state, mth, spec); });
        return c.request({ type: 'compare', instance: build.instance, methods: spec.methods.slice(), params: params, settings: settings }, {
          onProgress: onProgress,
          onMethodDone: function (row) {
            if (job.cancelled) return;
            job.rows.push(row);
            // its best plan is stored below; Cancel keeps only a later method's progress best
            if (row && job.bestMethod === row.method) { job.best = null; job.bestMethod = null; }
            if (!row || !row.result || row.error) return;
            const plan = storePlan(E.decodePlan(build, row.result, { method: row.method, label: row.label, compareId: job.compareId, name: 'Compare, ' + row.label + ', ' + fmt().dtg(build.maps.now) }));
            job.plans.push(plan);
            setStatus({ planIds: job.plans.map(function (p) { return p.id; }) });
          }
        }).then(function (table) {
          job.table = table;
          return job.plans;
        });
      }
      const method = job.method;
      const msg = { type: 'solve', instance: build.instance, method: method, params: paramsFor(state, method, spec), settings: settings };
      if (spec.kind === 'replan') {
        const start = E.contingencyStart(build);
        if (start) msg.start = start;
      }
      return c.request(msg, { onProgress: onProgress }).then(function (result) {
        const plan = storePlan(E.decodePlan(build, result, { method: method, label: result.label, params: result.params, reason: spec.reason }));
        job.plans.push(plan);
        return plan;
      });
    }).then(function (out) {
      job.done = true;
      rt.job = null;
      const plans = job.plans;
      const last = plans[plans.length - 1] || null;
      const failed = (job.rows || []).filter(function (r) { return r && r.error; });
      setStatus({ phase: 'done', fraction: 1, elapsedSec: elapsed(), planId: last ? last.id : null, planIds: plans.map(function (p) { return p.id; }),
        message: spec.kind === 'compare'
          ? 'Compared ' + plans.length + ' method' + (plans.length === 1 ? '' : 's') + '.' + (failed.length ? ' ' + failed.map(function (r) { return r.label + ': ' + r.error; }).join(' ') : '')
          : (last ? 'Plan ready: ' + summary(last) + '.' : 'Done.') });
      if (job.auto === 'boundary' && last && SRO.ui && typeof SRO.ui.toast === 'function') {
        try { SRO.ui.toast('New plan for the ' + windowText(last.windowId) + ' window: ' + summary(last) + '. Review and approve it.', 'info', { timeout: 8000 }); } catch (e) { /* no UI */ }
      }
      return out;
    }, function (err) {
      if (job.cancelled) return finishCancelled(job);
      job.done = true;
      rt.job = null;
      setStatus({ phase: 'error', error: (err && err.message) || String(err), message: (err && err.message) || 'The solver stopped with an error.', elapsedSec: elapsed() });
      throw err;
    });
    return job.promise;
  }
  function windowText(windowId) {
    const c = SRO.core.clock, F = fmt();
    const w = c && c.parseWindowId ? c.parseWindowId(windowId) : null;
    return w && F ? F.windowLabel(w.start, w.end) : String(windowId || '');
  }

  // Cancel: the plan found so far is kept (stored with cancelled: true).
  function finishCancelled(job) {
    job.done = true;
    rt.job = null;
    const elapsedSec = (wallNow() - job.started) / 1000;
    let out = null;
    try {
      if (job.build && job.best) {
        const method = job.bestMethod || job.method;
        const plan = storePlan(E.decodePlan(job.build, { solution: job.best }, {
          method: method, label: labelOf(method), cancelled: true, compareId: job.compareId, reason: job.reason, runtimeSec: elapsedSec,
          params: job.params[method] || null,
          name: (job.kind === 'compare' ? 'Compare, ' : '') + labelOf(method) + ' (stopped), ' + fmt().dtg(job.build.maps.now)
        }));
        job.plans.push(plan);
      }
      out = job.kind === 'compare' ? job.plans : (job.plans[job.plans.length - 1] || null);
    } catch (e) {
      setStatus({ phase: 'error', error: e.message, message: e.message, elapsedSec: elapsedSec });
      return out;
    }
    const last = job.plans[job.plans.length - 1] || null;
    setStatus({ phase: 'cancelled', elapsedSec: elapsedSec, planId: last ? last.id : null, planIds: job.plans.map(function (p) { return p.id; }),
      message: last ? 'Stopped. Kept the best plan found so far: ' + summary(last) + '.' : 'Stopped before a plan was found.' });
    return out;
  }

  E.run = function (opts) {
    const o = opts || {};
    const state = getStore().getState();
    const method = o.method || state.scenario.settings.method || 'tabu';
    return startJob({ kind: 'run', methods: [method], params: o.params, timeCapSec: o.timeCapSec, windowId: o.windowId, auto: o.auto });
  };
  E.compare = function (methods, opts) {
    const o = opts || {};
    const list = [];
    (Array.isArray(methods) ? methods : [methods]).forEach(function (m) { if (m && list.indexOf(m) < 0) list.push(m); });
    if (!list.length) return Promise.reject(userError('Pick at least one method to compare.', 'no-methods'));
    return startJob({ kind: 'compare', methods: list, params: o.params, timeCapSec: o.timeCapSec, windowId: o.windowId });
  };
  E.replan = function (opts) {
    const o = opts || {};
    const state = getStore().getState();
    const method = o.method || state.scenario.settings.method || 'tabu';
    return startJob({ kind: 'replan', methods: [method], params: o.params, timeCapSec: o.timeCapSec, reason: o.reason || null, parentPlanId: o.parentPlanId });
  };
  E.cancel = function () {
    const job = rt.job;
    if (!job) return Promise.resolve(null);
    job.cancelled = true;
    const c = rt.client;
    if (c) {
      const wasWorker = c.mode === 'worker';
      c.terminate();                    // rejects the pending request -> finishCancelled
      if (wasWorker && rt.opts.warm !== false) setTimeout(function () { if (!rt.job) client().start(); }, 50);
    }
    return job.promise;
  };
  E.busy = function () { return !!rt.job; };

  E.estimate = function (method, params) {
    let state;
    try { state = getStore().getState(); } catch (e) { return Promise.reject(e); }
    const multi = Array.isArray(method);
    const methods = multi ? method : [method || state.scenario.settings.method || 'tabu'];
    let build;
    try { build = getBuild(state, {}); } catch (e) { return Promise.reject(e); }
    if (!build.instance.jobs.length) return Promise.resolve({ seconds: 0, low: 0, high: 0, basis: 'No requests are waiting for a plan.' });
    const settings = solverSettings(state);
    const pBy = {};
    methods.forEach(function (m) { pBy[m] = Object.assign({}, (settings.methodParams && settings.methodParams[m]) || {}, multi ? ((params && params[m]) || {}) : (params || {})); });
    const prev = rt.status.phase;
    const Sv = S();
    function local() {
      if (multi) return Sv.estimateMany(build.instance, methods, pBy, settings, {});
      return Sv.estimate(build.instance, methods[0], pBy[methods[0]], settings, {});
    }
    if (rt.job || !root.document) {
      try { return Promise.resolve(local()); } catch (e) { return Promise.reject(e); }
    }
    const c = client();
    if (prev === 'idle' || prev === 'done' || prev === 'error' || prev === 'cancelled') setStatus({ phase: 'estimating', message: 'Estimating run time...' });
    return c.request({ type: 'estimate', instance: build.instance, method: multi ? methods : methods[0], params: multi ? pBy : pBy[methods[0]], settings: settings }, {})
      .then(function (r) {
        if (rt.status.phase === 'estimating') setStatus({ phase: prev === 'estimating' ? 'idle' : prev, message: rt.status.message === 'Estimating run time...' ? '' : rt.status.message });
        return r;
      }, function (e) {
        if (rt.status.phase === 'estimating') setStatus({ phase: prev, message: '' });
        if (e && e.code === 'cancelled') return local();
        throw e;
      });
  };

  // Methods the picker can offer, with availability (Exact (MIP) needs HiGHS in the worker).
  E.methods = function () {
    const c = rt.client;
    if (c && c.methods) return c.methods.slice();
    const Sv = S();
    const keys = (Sv && Sv.METHOD_KEYS) || ['tabu', 'sa', 'aco', 'mip'];
    return keys.map(function (k) { return { key: k, label: labelOf(k), available: k !== 'mip' || !!(c && c.highs), reason: null, default: k === 'tabu', exact: k === 'mip' }; });
  };

  // ---- store wiring ----
  function onState(state) {
    if (!state || rt.job) return;
    const ui = state.ui || {};
    if (!ui.planRequested) { rt.autoKey = null; return; }
    const key = String(ui.planRequestReason) + '@' + String(ui.planRequestedAt);
    if (rt.autoKey === key) return;
    rt.autoKey = key;
    const store = rt.store;
    if (!E.shouldPlan(state)) {
      setTimeout(function () { if (store.getState().ui.planRequested) store.dispatch({ type: 'window/planHandled' }); }, 0);
      return;
    }
    const reason = ui.planRequestReason;
    setTimeout(function () {
      if (rt.job) return;
      E.run({ method: state.scenario.settings.method, auto: reason }).catch(function (e) {
        if (store.getState().ui.planRequested) store.dispatch({ type: 'window/planHandled' });
        if (reason === 'boundary' && SRO.ui && typeof SRO.ui.toast === 'function' && !(e && e.code === 'no-requests')) {
          try { SRO.ui.toast('The automatic plan failed: ' + ((e && e.message) || e), 'error'); } catch (x) { /* no UI */ }
        }
      });
    }, 0);
  }

  E.init = function (store, opts) {
    if (!store || typeof store.getState !== 'function') throw new Error('engine.init needs the store');
    if (rt.store === store) return E;
    if (rt.unsub) rt.unsub();
    rt.store = store;
    rt.opts = opts || {};
    rt.buildCache = null;
    rt.autoKey = null;
    rt.unsub = store.subscribe(function (state) { onState(state); });
    if (rt.opts.warm !== false && root.document) {
      setTimeout(function () { if (!rt.job) client().start(); }, num(rt.opts.warmDelayMs, E.WARM_DELAY_MS));
    }
    setTimeout(function () { onState(store.getState()); }, 0);
    return E;
  };
  // Tests: forget the store and the worker.
  E._reset = function () {
    if (rt.unsub) rt.unsub();
    if (rt.client) rt.client.terminate();
    rt.store = null; rt.unsub = null; rt.client = null; rt.job = null; rt.buildCache = null; rt.autoKey = null; rt.listeners.length = 0;
    rt.status = { phase: 'idle', kind: null, method: null, methods: null, methodIndex: null, fraction: 0, bestCost: null, elapsedSec: 0, message: '', history: [], error: null, highsReady: null, mode: null, planId: null, planIds: [] };
  };
})(typeof self !== 'undefined' ? self : globalThis);
