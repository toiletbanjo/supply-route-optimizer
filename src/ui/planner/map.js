// Planner map (center panel) and the small shared kit the planner Queue / Plan / Route detail views use.
//
// SRO.ui.plannerKit (K) - UI-only helpers; domain data always comes from the store state:
//   K.sel = { requestId, truckId, planId, routeOpen, focusSeq, source }   view selection (not persisted)
//   K.select(patch) / K.onSelect(fn(sel, prev)) -> off   selection changes (views re-render themselves)
//   K.focusRequest(id, source)   select a request and ask the map / queue to bring it into view
//   K.viewedPlan(state)          plan shown in Plan, Route detail and on the map: K.sel.planId if set,
//                                else ui.lastPlanId, else the newest approved plan, else the newest plan
//   K.queueRequests(state)       requests of the current window (+ carried-over open ones), most pressing
//                                first (SRO.core.urgency.compareRequests)
//   K.planIndex(plan)            { byRequest: { id: { stops, deferred, minutesLate } }, byTruck }
//   K.legCoords(route, state)    timed legs with road coordinates (decoded leg.path, else road graph)
//   K.routeLoad(route, state)    { used, capacity, unit, pct }
//   K.previousPlan(state, plan), K.diffPlans(before, after, state) -> moved stops per request
//   K.engine()                   SRO.core.engine when it has run() (DESIGN.md 8b), else null
//   formatting passthroughs to SRO.core.format (dtg, miles, gallons, num, classLabel, mgrs) + K.secs
//   K.map()                      the planner map component (SRO.ui.map instance) or null. Follows the
//                                planner-map protocol in scenario.js: SRO.ui.plannerMap() returns it,
//                                'planner:map' is emitted on create / destroy, 'planner:map:want' is
//                                answered, 'planner:focus' fits the map, rally clicks open
//                                SRO.ui.scenario.rallyDialog (pin / ban); 'planner:plan-selected' from
//                                other views selects that plan here.
//
// Map view ('planner/map', center): hubs, platoons on urgency rings, rally points the viewed plan uses
// (candidates faint, pinned / banned marked), zones, the viewed plan's routes in truck colors along
// their road paths, trucks moving on the demo clock (SRO.ui.map.truckPosition), legend (truck and
// urgency colors) and the note 'Road lines and times from OpenStreetMap road data'. Click a route or a
// truck -> Route detail; click a platoon -> its request in the Queue.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const ui = SRO.ui = SRO.ui || {};
  const K = ui.plannerKit = ui.plannerKit || {};

  const OPEN = ['submitted', 'planned', 'delayed', 'partial'];
  K.OPEN_STATUSES = OPEN;
  K.STATUS_LABELS = {
    submitted: 'Submitted', planned: 'Planned', approved: 'Approved', en_route: 'En route',
    delivered: 'Delivered', partial: 'Partial', delayed: 'Delayed', cancelled: 'Cancelled'
  };
  K.MOBILITY_LABELS = { mounted: 'Mounted', dismounted: 'Dismounted', fixed: 'Fixed in place' };
  K.URGENCY = ['Routine', 'Priority', 'Urgent', 'Immediate'];
  K.REASON_LABELS = {
    capacity: 'Trucks full', time: 'Not in time', 'closed-road': 'Road closed',
    'no-truck': 'No truck available', radius: 'Outside travel radius'
  };
  K.REASON_TEXT = {
    capacity: 'Every truck that could carry it was already full.',
    time: 'No truck could get there before the deadline.',
    'closed-road': 'Closed roads cut off every pickup point a truck could reach.',
    'no-truck': 'No truck of the right type is available (out of service, or locked to another truck).',
    radius: 'No usable pickup point lies inside the platoon\'s travel radius.'
  };
  K.METHOD_KEYS = ['tabu', 'sa', 'aco', 'mip'];

  // ---- selection ---------------------------------------------------------------------------------
  K.sel = K.sel || { requestId: null, truckId: null, planId: null, routeOpen: false, focusSeq: 0, source: null };
  const selFns = [];
  K.select = function (patch) {
    const prev = Object.assign({}, K.sel);
    Object.assign(K.sel, patch || {});
    const changed = Object.keys(patch || {}).some(function (k) { return prev[k] !== K.sel[k]; });
    if (!changed) return false;
    selFns.slice().forEach(function (fn) {
      try { fn(K.sel, prev); } catch (e) { if (root.console) root.console.error('[planner] selection listener failed', e); }
    });
    return true;
  };
  K.onSelect = function (fn) {
    selFns.push(fn);
    return function () { const i = selFns.indexOf(fn); if (i >= 0) selFns.splice(i, 1); };
  };
  // show a plan in the planner views and tell the others (Outputs listens to 'planner:plan-selected').
  // The planner's pick wins over a plan stored just before it (Compare stores one plan per method, the
  // last of them not the cheapest): the current ui.lastPlanId counts as seen, so the next
  // K.viewedPlan does not hand the view to that stored plan.
  K.showPlan = function (planId) {
    const st = SRO.app && SRO.app.store && SRO.app.store.getState();
    if (planId && st) K._seenLastPlanId = (st.ui || {}).lastPlanId;
    const changed = K.select({ planId: planId || null });
    if (planId && ui.emit) ui.emit('planner:plan-selected', { planId: planId, source: 'plan' });
    return changed;
  };
  K.focusRequest = function (id, source) {
    return K.select({ requestId: id, source: source || null, focusSeq: (K.sel.focusSeq || 0) + 1 });
  };

  // ---- formatting (format.js is the formatter; these are short names) ----------------------------
  function F() { return SRO.core.format; }
  K.dtg = function (m) { return F().dtg(m); };
  K.time = function (m) { return F().time24(m); };
  K.miles = function (x) { return F().miles(x); };
  K.gallons = function (x) { return F().gallons(x); };
  K.num = function (x, d) { return F().number(x, d || 0); };
  K.qty = function (q, unit) { return F().qty(q, unit); };
  // a radius or travel limit: '50 mi', '12.5 mi' (no '.0' on whole miles)
  K.radius = function (x) { return K.isNum(x) ? F().qty(Math.round(x * 10) / 10, 'mi') : F().NA; };
  K.classLabel = function (c) { return F().classLabel(c); };
  K.mgrs = function (lat, lon) { return F().mgrs(lat, lon, 5); };
  K.duration = function (min) { return F().duration(min); };
  K.windowLabel = function (w) { return F().windowLabel(w); };
  // run times are seconds, which format.duration (whole minutes) cannot show
  K.secs = function (s) {
    if (typeof s !== 'number' || !isFinite(s)) return 'n/a';
    if (s > 0 && s < 0.05) return '<0.1 s';
    if (s < 10) return (Math.round(s * 10) / 10).toFixed(1) + ' s';
    if (s < 90) return Math.round(s) + ' s';
    const m = Math.floor(Math.round(s) / 60), r = Math.round(s) % 60;
    return m + ' min' + (r ? ' ' + r + ' s' : '');
  };
  K.isNum = function (x) { return typeof x === 'number' && isFinite(x); };
  K.urgClass = function (u) { return 'urg-' + String(u || 'Routine').toLowerCase(); };
  K.methodLabel = function (m) {
    const L = (SRO.solver && SRO.solver.METHOD_LABELS) || { tabu: 'Tabu search', sa: 'Simulated annealing', aco: 'Ant colony', mip: 'Exact (MIP)' };
    return L[m] || String(m || 'Unknown method');
  };
  K.truckTypeLabel = function (type) {
    const T = SRO.data && SRO.data.scenario && SRO.data.scenario.truckTypes;
    return (T && T[type] && T[type].label) || (type === 'tanker' ? 'Fuel tanker' : 'Cargo truck');
  };
  // r: a deferred entry { reason, detail } or a reason code. 'capacity' covers three cases in the
  // solver's explanation (detail): trucks full, the rally point limit, or cheaper next window.
  K.DETAIL_LABELS = { 'trucks-full': 'Trucks full', 'rally-limit': 'Rally point limit', cost: 'Cheaper next window' };
  K.reasonLabel = function (r) {
    const code = r && typeof r === 'object' ? r.reason : r;
    const detail = r && typeof r === 'object' ? r.detail : null;
    if (code === 'capacity' && detail && K.DETAIL_LABELS[detail]) return K.DETAIL_LABELS[detail];
    return K.REASON_LABELS[code] || 'Not planned';
  };
  K.reasonText = function (d) { return (d && d.note) || K.REASON_TEXT[d && d.reason] || 'It did not fit in this window.'; };

  // ---- lookups -----------------------------------------------------------------------------------
  let gridSrc = null, gridMap = null;
  K.grid = function (id) {
    const g = SRO.data && SRO.data.grid;
    if (g !== gridSrc) { gridSrc = g; gridMap = new Map(); (g || []).forEach(function (p) { gridMap.set(p.id, p); }); }
    return (id && gridMap.get(id)) || null;
  };
  K.gridName = function (id) {
    const g = K.grid(id);
    return g ? String(g.name || g.id).replace(/\s*\((?:notional[^)]*|Fwy[^)]*|Hwy[^)]*)\)\s*$/i, '') : (id || '');
  };
  let reqSrc = null, reqMap = null;
  K.request = function (state, id) {
    if (state.requests !== reqSrc) { reqSrc = state.requests; reqMap = new Map(); (reqSrc || []).forEach(function (r) { reqMap.set(r.id, r); }); }
    return reqMap.get(id) || null;
  };
  K.truck = function (state, id) { return ((state.scenario && state.scenario.fleet) || []).find(function (t) { return t.id === id; }) || null; };
  K.hub = function (state, id) { return ((state.scenario && state.scenario.hubs) || []).find(function (x) { return x.id === id; }) || null; };
  K.hubOfTruck = function (state, truckId, route) {
    const t = K.truck(state, truckId);
    const hubId = (route && route.hubId) || (t && t.hubId);
    return hubId ? K.hub(state, hubId) : null;
  };
  K.truckColor = function (state, truckId, route) {
    if (route && route.color) return route.color;
    const t = K.truck(state, truckId);
    return (t && t.color) || '#2F6FE0';
  };
  K.engine = function () {
    const e = SRO.core && SRO.core.engine;
    return e && typeof e.run === 'function' ? e : null;
  };
  K.currentWindow = function (state) {
    const C = SRO.core.clock;
    return C.windowOf(state.clock.simMin);
  };
  K.planWindow = function (plan) {
    const C = SRO.core.clock;
    return (plan && C.parseWindowId(plan.windowId)) || (plan && K.isNum(plan.createdAt) ? C.windowOf(plan.createdAt) : null);
  };

  // ---- requests ----------------------------------------------------------------------------------
  let qCache = { reqs: null, win: null, out: [] };
  K.queueRequests = function (state) {
    const w = K.currentWindow(state);
    if (qCache.reqs === state.requests && qCache.win === w.id) return qCache.out;
    const cmp = SRO.core.urgency && SRO.core.urgency.compareRequests;
    const out = (state.requests || []).filter(function (r) {
      return r.status !== 'cancelled' && (r.windowId === w.id || OPEN.indexOf(r.status) >= 0);
    });
    if (cmp) out.sort(cmp);
    qCache = { reqs: state.requests, win: w.id, out: out };
    return out;
  };
  K.requestClasses = function (r) {
    const order = (SRO.data.catalogHelpers && SRO.data.catalogHelpers.CLASS_ORDER) || ['III', 'I', 'V', 'VIII', 'IX'];
    const seen = {};
    (r.lines || []).forEach(function (l) { if (l && l.classId) seen[l.classId] = true; });
    return order.filter(function (c) { return seen[c]; }).concat(Object.keys(seen).filter(function (c) { return order.indexOf(c) < 0; }));
  };
  // 'MREs, Mixed menus: 32 cases'; 'Diesel / JP-8: 500 gal' (option JP-8 left out: the name says it)
  K.lineText = function (line, qtyOverride) {
    const CH = SRO.data.catalogHelpers;
    const it = CH && CH.itemById(line.itemId);
    const name = it ? it.name : (line.itemId || 'Item');
    let opt = '';
    if (it && it.freeText) opt = line.option || '';
    else if (it) { const o = CH.optionById(line.itemId, line.option); opt = o ? o.label : (line.option || ''); }
    const q = qtyOverride !== undefined ? qtyOverride : line.qty;
    const unit = CH && CH.unitLabel ? CH.unitLabel(line.unit || (it && it.unit), q) : (line.unit || '');
    // the option only when it adds something ('Diesel / JP-8' already says JP-8)
    const nl = name.toLowerCase(), ol = opt.toLowerCase();
    const optText = opt && ol !== nl && !(ol.length >= 3 && nl.indexOf(ol) >= 0) ? ', ' + opt : '';
    return name + optText + ': ' + K.qty(q, unit);
  };
  K.lineUnit = function (line, qty) {
    const CH = SRO.data.catalogHelpers;
    const it = CH && CH.itemById(line.itemId);
    return CH && CH.unitLabel ? CH.unitLabel(line.unit || (it && it.unit), qty) : (line.unit || '');
  };
  K.pickupText = function (state, r) {
    if (r.mobility === 'fixed' || r.directOnly || (r.locks && r.locks.forceDirect)) return 'Direct delivery';
    if (r.desiredPickup) {
      const g = r.desiredPickup.gridId ? K.grid(r.desiredPickup.gridId) : null;
      return g ? K.gridName(g.id) : 'Own pick (map point)';
    }
    return 'Solver picks';
  };

  // ---- plans -------------------------------------------------------------------------------------
  K.viewedPlan = function (state) {
    const plans = state.plans || [];
    if (!plans.length) return null;
    const byId = function (id) { return id ? plans.find(function (p) { return p.id === id; }) || null : null; };
    // a plan stored after the planner picked one (automatic window plan, re-plan from Scenario) takes over
    const lastId = state.ui && state.ui.lastPlanId;
    if (lastId !== K._seenLastPlanId) {
      const first = K._seenLastPlanId === undefined;
      K._seenLastPlanId = lastId;
      if (!first && lastId && K.sel.planId && K.sel.planId !== lastId && byId(lastId)) K.sel.planId = null;
    }
    const sel = byId(K.sel.planId);
    if (sel) return sel;
    const last = byId(state.ui && state.ui.lastPlanId);
    if (last) return last;
    for (let i = plans.length - 1; i >= 0; i--) if (plans[i].approved) return plans[i];
    return plans[plans.length - 1];
  };
  K.plansForPicker = function (state, plan) {
    const w = K.currentWindow(state);
    const list = (state.plans || []).filter(function (p) {
      return p === plan || p.windowId === w.id || p.windowId === (plan && plan.windowId) || (p.approved && !p.superseded);
    });
    return list.slice(-30).reverse();
  };
  K.planStatus = function (plan) {
    if (!plan) return { key: 'none', label: 'No plan' };
    if (plan.approved) return { key: 'approved', label: 'Approved' };
    if (plan.superseded) return { key: 'superseded', label: 'Replaced' };
    if (plan.cancelled) return { key: 'cancelled', label: 'Draft (stopped early)' };
    return { key: 'draft', label: 'Draft' };
  };
  K.usedRoutes = function (plan) { return ((plan && plan.routes) || []).filter(function (r) { return (r.stops || []).length > 0; }); };
  // A re-plan keeps the done stops of a truck that was marked out of service or cut off by a closed
  // road (route.out / route.cutOff): it is in the plan's routes but does not drive on.
  K.isStoppedRoute = function (r) { return !!(r && (r.out || r.cutOff)); };
  K.activeRoutes = function (plan) { return K.usedRoutes(plan).filter(function (r) { return !K.isStoppedRoute(r); }); };
  K.doneStops = function (r) { return ((r && r.stops) || []).filter(function (s) { return s.done; }).length; };
  // Whole-trip miles and gallons of a route. In a re-plan the solver's route.miles / gallons cover only
  // the re-planned part (from the truck's next stop on), while the route's legs, stops and times cover
  // the whole trip; cards and Route detail show the whole trip (sum of the legs).
  K.routeTrip = function (route, state) {
    const legs = (route && route.legs) || [];
    if (!route || !(route.continued || route.out || route.cutOff) || !legs.length) {
      return { miles: route ? route.miles : null, gallons: route ? route.gallons : null, replannedMiles: null };
    }
    const miles = legs.reduce(function (a, l) { return a + (K.isNum(l.miles) ? l.miles : 0); }, 0);
    const mpg = (state && state.scenario && state.scenario.settings && state.scenario.settings.mpg) || 2;
    return { miles: miles, gallons: miles / mpg, replannedMiles: K.isNum(route.miles) ? route.miles : null };
  };

  // For each leg of a route, the index of the stop it arrives at, or -1 (the drive back to the hub, or
  // a re-plan's turn-back leg to a 'pos:<truck>' point). Legs and stops are in time order and match
  // by node key (leg.toKey = stop.nodeKey); legs without keys pair up with stops by position.
  K.legStops = function (route) {
    const legs = (route && route.legs) || [], stops = (route && route.stops) || [];
    const keyed = legs.every(function (l) { return l && l.toKey; }) && stops.every(function (st) { return st && st.nodeKey; });
    if (!keyed) return legs.map(function (l, i) { return i < stops.length ? i : -1; });
    let s = 0;
    return legs.map(function (l) {
      if (s < stops.length && l.toKey === stops[s].nodeKey && !l.turnedBack) return s++;
      return -1;
    });
  };
  // The turn-back of a re-plan: a truck driving into a newly closed road turned where it was and
  // was routed on from that point. -> null or { legIndex, leg, lat, lon, at, nextStop }
  K.turnBack = function (route) {
    const legs = (route && route.legs) || [];
    const i = legs.findIndex(function (l) { return l && l.turnedBack; });
    if (i < 0) return null;
    const leg = legs[i];
    let pt = null;
    try {
      const c = typeof leg.path === 'string' && leg.path ? SRO.core.geo.decodePolyline(leg.path, 5) : Array.isArray(leg.coords) ? leg.coords : null;
      if (c && c.length) pt = c[c.length - 1];
    } catch (e) { pt = null; }
    const ix = K.legStops(route);
    let next = null;
    for (let j = i + 1; j < legs.length; j++) if (ix[j] >= 0) { next = route.stops[ix[j]]; break; }
    return { legIndex: i, leg: leg, lat: pt ? pt[0] : null, lon: pt ? pt[1] : null, at: leg.arrive, nextStop: next };
  };

  const indexCache = new WeakMap();
  K.planIndex = function (plan) {
    if (!plan) return { byRequest: {}, byTruck: {} };
    const key = plan.routes || plan;
    const hit = indexCache.get(key);
    if (hit && hit.deferred === plan.deferred && hit.late === plan.late) return hit.value;
    const byRequest = {}, byTruck = {};
    function get(id) { return byRequest[id] || (byRequest[id] = { stops: [], deferred: [], minutesLate: 0 }); }
    (plan.routes || []).forEach(function (rt) {
      byTruck[rt.truckId] = rt;
      (rt.stops || []).forEach(function (st, si) {
        const per = {};
        (st.deliveries || []).forEach(function (d) {
          const x = per[d.requestId] || (per[d.requestId] = {
            truckId: rt.truckId, color: rt.color, seq: st.seq !== undefined ? st.seq : si + 1, stopIndex: si,
            gridId: st.gridId, label: st.label, kind: st.kind, lat: st.lat, lon: st.lon,
            arrive: st.arrive, depart: st.depart, lines: [], platoonMiles: null
          });
          x.lines.push({ lineIdx: d.lineIdx, qty: d.qty, unit: d.unit, classId: d.classId });
        });
        (st.pickups || []).forEach(function (p) { if (per[p.requestId]) per[p.requestId].platoonMiles = p.platoonMiles; });
        Object.keys(per).forEach(function (id) { get(id).stops.push(per[id]); });
      });
    });
    (plan.deferred || []).forEach(function (d) { get(d.requestId).deferred.push(d); });
    (plan.late || []).forEach(function (l) { get(l.requestId).minutesLate = Math.max(get(l.requestId).minutesLate, l.minutesLate || 0); });
    const value = { byRequest: byRequest, byTruck: byTruck };
    indexCache.set(key, { deferred: plan.deferred, late: plan.late, value: value });
    return value;
  };
  // Requests with deferred quantity, in plan order: [{ requestId, items: [deferred...] }]
  K.delayedRequests = function (plan) {
    const out = [], seen = {};
    ((plan && plan.deferred) || []).forEach(function (d) {
      if (!seen[d.requestId]) { seen[d.requestId] = { requestId: d.requestId, items: [] }; out.push(seen[d.requestId]); }
      seen[d.requestId].items.push(d);
    });
    return out;
  };

  K.periodName = function (p, atMin, settings) {
    if (typeof p === 'string' && p) return p;
    const periods = (settings && settings.periods) || null;
    if (typeof p === 'number' && periods && periods[p]) return periods[p].name;
    if (p && typeof p === 'object' && p.name) return p.name;
    if (!K.isNum(atMin)) return '';
    const per = SRO.core.clock.periodAt(atMin, periods || undefined);
    return per ? per.name : '';
  };

  // Truck load as share of the truck's capacity, over the whole trip. Capacity is the fleet truck's
  // (a re-plan gives a truck already on the road a route.capacity of only what is still on board).
  // Load: the deliveries' load units (d.loadQty, gallons or pallets) when the engine gives them, done
  // stops included; else route.load; else deliveries converted with the catalog (palletsPerUnit).
  K.routeLoad = function (route, state) {
    const t = K.truck(state, route.truckId) || {};
    const type = route.type || t.type || 'cargo';
    const T = SRO.data.scenario && SRO.data.scenario.truckTypes;
    const cap = t.capacity || (T && T[type] && T[type].capacity) || route.capacity || (type === 'tanker' ? 2500 : 10);
    const dels = [];
    (route.stops || []).forEach(function (st) { (st.deliveries || []).forEach(function (d) { dels.push(d); }); });
    const exact = dels.length > 0 && dels.every(function (d) { return K.isNum(d.loadQty); });
    let used = exact ? dels.reduce(function (a, d) { return a + d.loadQty; }, 0) : K.isNum(route.load) ? route.load : 0;
    if (!exact && !K.isNum(route.load)) {
      const CH = SRO.data.catalogHelpers;
      (route.stops || []).forEach(function (st) {
        (st.deliveries || []).forEach(function (d) {
          const q = +d.qty || 0;
          if (type === 'tanker') { used += q; return; }
          if (d.unit === 'pallet' || d.unit === 'pallets') { used += q; return; }
          const r = K.request(state, d.requestId);
          const line = r && r.lines && r.lines[d.lineIdx];
          const spec = line && CH ? CH.spec(line.itemId, line.option) : null;
          if (spec && K.isNum(spec.palletsPerUnit)) used += q * spec.palletsPerUnit;
        });
      });
    }
    return { used: used, capacity: cap, unit: type === 'tanker' ? 'gal' : 'pallets', pct: cap > 0 ? Math.round(100 * used / cap) : 0 };
  };

  // Legs with drawable coordinates: leg.coords, or leg.path (encoded polyline, precision 5, or an array),
  // else the road graph between the route's points (hub -> stops -> hub). Cached per route object.
  const legCache = new WeakMap();
  K.legCoords = function (route, state) {
    const zones = (state.scenario && state.scenario.zones) || [];
    const hit = legCache.get(route);
    if (hit && hit.zones === zones) return hit.legs;
    const geo = SRO.core.geo, roads = SRO.core.roads;
    const hub = K.hubOfTruck(state, route.truckId, route);
    const stops = route.stops || [];
    const pts = [];
    if (hub) pts.push({ lat: hub.lat, lon: hub.lon, label: hub.name });
    stops.forEach(function (s) { pts.push({ lat: s.lat, lon: s.lon, label: s.label }); });
    if (hub) pts.push({ lat: hub.lat, lon: hub.lon, label: hub.name });
    // a leg with no path is drawn between the points it joins: by stop when the legs carry node keys
    // (a re-plan's turn-back leg is not one leg per stop), else by position
    const ix = K.legStops(route);
    let legs = (route.legs || []).map(function (l, i0) {
      const i = ix[i0] >= 0 ? ix[i0] : (i0 === (route.legs || []).length - 1 ? stops.length : i0);
      let coords = null, approx = false, source = l.source || null;
      if (Array.isArray(l.coords) && l.coords.length >= 2) coords = l.coords;
      else if (typeof l.path === 'string' && l.path) { try { coords = geo.decodePolyline(l.path, 5); } catch (e) { coords = null; } }
      else if (Array.isArray(l.path) && l.path.length >= 2) coords = l.path;
      if ((!coords || coords.length < 2) && pts[i] && pts[i + 1] && roads && roads.path) {
        try {
          const p = roads.path(pts[i], pts[i + 1], zones);
          coords = p.coords; approx = !!p.approximate; source = p.source;
        } catch (e) { coords = null; }
      }
      if ((!coords || coords.length < 2) && pts[i] && pts[i + 1]) { coords = [[pts[i].lat, pts[i].lon], [pts[i + 1].lat, pts[i + 1].lon]]; approx = true; source = 'straight'; }
      return { coords: coords || [], depart: l.depart, arrive: l.arrive, miles: l.miles, approximate: approx || !!l.approximate || l.offRoad === true && source === 'straight', source: source, period: l.period, riskUnits: l.riskUnits };
    });
    if (!legs.length && stops.length && pts.length >= 2 && roads && roads.path) {
      // no legs from the engine: draw hub -> stops -> hub on roads, times from the stops
      legs = [];
      for (let i = 1; i < pts.length; i++) {
        let p = null;
        try { p = roads.path(pts[i - 1], pts[i], zones); } catch (e) { p = null; }
        const dep = i === 1 ? route.depart : stops[i - 2].depart;
        const arr = i - 1 < stops.length ? stops[i - 1].arrive : route.returnAt;
        legs.push({ coords: p ? p.coords : [[pts[i - 1].lat, pts[i - 1].lon], [pts[i].lat, pts[i].lon]], depart: dep, arrive: arr, approximate: !p || !!p.approximate, source: p ? p.source : 'straight' });
      }
    }
    legCache.set(route, { zones: zones, legs: legs });
    return legs;
  };

  // The plan this one should be compared with: the plan it re-planned (contingency), else the
  // window's approved plan, else the newest earlier plan of the same window.
  K.previousPlan = function (state, plan) {
    if (!plan) return null;
    const plans = state.plans || [];
    if (plan.parentPlanId) { const p = plans.find(function (x) { return x.id === plan.parentPlanId; }); if (p) return p; }
    const same = plans.filter(function (p) { return p.id !== plan.id && p.windowId === plan.windowId; });
    const appr = same.filter(function (p) { return p.approved; });
    if (appr.length && !plan.approved) return appr[appr.length - 1];
    const idx = plans.indexOf(plan);
    const earlier = same.filter(function (p) { return plans.indexOf(p) < idx; });
    return earlier.length ? earlier[earlier.length - 1] : null;
  };

  // Per-request differences between two plans: [{ requestId, kind: 'moved' | 'retimed' | 'delayed' |
  // 'added' | 'more' | 'less', before, after }] where before / after = { truckId, label, gridId, eta,
  // deferredQty } (null when the request was not in that plan).
  function placeOf(ix) {
    if (!ix) return null;
    const stops = ix.stops.slice().sort(function (a, b) { return (a.arrive || 0) - (b.arrive || 0); });
    const s = stops[0];
    const deferredQty = ix.deferred.reduce(function (a, d) { return a + (+d.qty || 0); }, 0);
    return {
      delivered: stops.length > 0, truckIds: stops.map(function (x) { return x.truckId; }).sort().join(','),
      where: stops.map(function (x) { return x.gridId || (x.lat + ',' + x.lon); }).sort().join(','),
      truckId: s ? s.truckId : null, color: s ? s.color : null, label: s ? s.label : null, seq: s ? s.seq : null,
      eta: s ? s.arrive : null, stops: stops.length, deferredQty: deferredQty,
      list: stops.map(function (x) { return { truckId: x.truckId, color: x.color, seq: x.seq, label: x.label, eta: x.arrive }; })
    };
  }
  K.diffPlans = function (before, after) {
    const a = K.planIndex(before).byRequest, b = K.planIndex(after).byRequest;
    const ids = Object.keys(Object.assign({}, a, b));
    const out = [];
    ids.forEach(function (id) {
      const x = placeOf(a[id]), y = placeOf(b[id]);
      let kind = null;
      if (!x && y) kind = y.delivered ? 'added' : 'delayed';
      else if (x && !y) {
        // a request the later plan does not cover at all: only a change when it re-plans the earlier
        // plan (a plan of the leftover requests leaves the approved ones to the approved plan)
        if (after && before && after.parentPlanId === before.id) kind = 'removed';
      }
      else if (x.delivered && !y.delivered) kind = 'delayed';
      else if (!x.delivered && y.delivered) kind = 'added';
      else if (x.delivered && (x.truckIds !== y.truckIds || x.where !== y.where)) kind = 'moved';
      else if (x.delivered && K.isNum(x.eta) && K.isNum(y.eta) && Math.abs(x.eta - y.eta) >= 1) kind = 'retimed';
      else if (x.deferredQty !== y.deferredQty) kind = y.deferredQty > x.deferredQty ? 'less' : 'more';
      if (kind) out.push({ requestId: id, kind: kind, before: x, after: y });
    });
    const order = { moved: 0, delayed: 1, added: 2, less: 3, more: 4, retimed: 5, removed: 6 };
    out.sort(function (p, q) { return order[p.kind] - order[q.kind] || (p.requestId < q.requestId ? -1 : 1); });
    return out;
  };

  K.map = function () { return K._map || null; };
  // Scenario's planner-map protocol (scenario.js header): plannerMap may be a function returning the map
  const plannerMapFn = function () { return K.map(); };
  plannerMapFn.get = plannerMapFn;
  ui.plannerMap = plannerMapFn;
  // other planner views (Outputs) pick a plan: show it here too
  if (ui.on) {
    ui.on('planner:plan-selected', function (e) {
      if (e && e.planId && e.source !== 'plan') K.select({ planId: e.planId });
    });
  }

  // ==== map view ===================================================================================
  const h = function () { return ui.h.apply(null, arguments); };
  const RALLY_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

  function rallyPoints(state, plan) {
    const grid = (SRO.data && SRO.data.grid) || [];
    const rally = (state.scenario && state.scenario.rally) || { pinned: [], banned: [] };
    const used = (plan && plan.rallyPoints) || [];
    const dismountedAt = {};
    if (plan) {
      const settings = state.scenario.settings || {};
      const ring = (settings.mobility && settings.mobility.dismounted && settings.mobility.dismounted.radiusMi) || 5;
      (plan.routes || []).forEach(function (rt) {
        (rt.stops || []).forEach(function (st) {
          if (st.kind !== 'rally' || !st.gridId) return;
          (st.deliveries || []).forEach(function (d) {
            const r = K.request(state, d.requestId);
            if (r && r.mobility === 'dismounted') dismountedAt[st.gridId] = ring;
          });
        });
      });
    }
    const out = [];
    grid.forEach(function (g) {
      const ui0 = used.indexOf(g.id);
      const pinned = (rally.pinned || []).indexOf(g.id) >= 0, banned = (rally.banned || []).indexOf(g.id) >= 0;
      if (ui0 < 0 && !g.rallyCandidate && !pinned && !banned) return;
      if (g.kind === 'hub') return;
      out.push({
        id: g.id, gridId: g.id, lat: g.lat, lon: g.lon, name: K.gridName(g.id),
        label: ui0 >= 0 ? (RALLY_LETTERS[ui0] || String(ui0 + 1)) : '',
        used: ui0 >= 0, pinned: pinned, banned: banned, walkRingMi: dismountedAt[g.id] || 0
      });
    });
    return out;
  }
  K.rallyLetter = function (plan, gridId) {
    const i = ((plan && plan.rallyPoints) || []).indexOf(gridId);
    return i >= 0 ? (RALLY_LETTERS[i] || String(i + 1)) : '';
  };

  function routesFor(state, plan) {
    return K.usedRoutes(plan).map(function (rt) {
      const t = K.truck(state, rt.truckId);
      const legs = K.legCoords(rt, state);
      return {
        truckId: rt.truckId, color: K.truckColor(state, rt.truckId, rt), legs: legs,
        label: rt.truckId + ' (' + K.truckTypeLabel(rt.type || (t && t.type)) + ')',
        summary: (rt.stops || []).length + ' stops, ' + K.miles(K.routeTrip(rt, state).miles) +
          (K.isStoppedRoute(rt) ? ', ' + (rt.out ? 'out of service' : 'cut off by a closed road') : ', back ' + K.dtg(rt.returnAt)) +
          (K.turnBack(rt) ? '; turned back from a closed road at ' + K.time(K.turnBack(rt).at) : ''),
        stops: (rt.stops || []).map(function (s, i) { return { lat: s.lat, lon: s.lon, seq: s.seq !== undefined ? s.seq : i + 1, label: s.label }; })
      };
    });
  }

  // Trucks moving now: routes of approved, current plans (a draft is not a movement order), at the
  // demo clock time. Trucks parked at a hub (the hub symbol is there) and trucks marked out of service
  // are not drawn.
  function trucksAt(state, plan) {
    const sim = state.clock.simMin;
    const chosen = new Map();
    const plans = (state.plans || []).filter(function (p) { return p.approved && !p.superseded; });
    if (plan && plan.approved && !plan.superseded && plans.indexOf(plan) < 0) plans.push(plan);
    plans.forEach(function (p) {
      K.usedRoutes(p).forEach(function (rt) {
        if (K.isNum(rt.depart) && K.isNum(rt.returnAt) && sim >= rt.depart && sim <= rt.returnAt) chosen.set(rt.truckId, rt);
      });
    });
    const out = [];
    chosen.forEach(function (rt, id) {
      if ((K.truck(state, id) || {}).status === 'out') return;
      const legs = K.legCoords(rt, state);
      const pos = SRO.ui.map.truckPosition({ legs: legs, depart: rt.depart, returnAt: rt.returnAt }, sim);
      if (!pos || pos.status === 'at-hub' || pos.status === 'returned') return;
      const t = K.truck(state, id) || {};
      let status = pos.status === 'en-route' ? 'En route' : 'At stop';
      const stops = rt.stops || [];
      // legIndex counts legs, not stops (a re-plan's turn-back leg ends at no stop)
      const ix = K.legStops(rt);
      const stopAfter = function (li) { for (let j = Math.max(0, li); j < ix.length; j++) if (ix[j] >= 0) return ix[j]; return stops.length; };
      const nextIdx = pos.status === 'en-route' ? stopAfter(pos.legIndex) : stopAfter(pos.legIndex + 1);
      const atIdx = pos.legIndex >= 0 ? ix[pos.legIndex] : -1;
      if (pos.status === 'en-route' && nextIdx < stops.length) status += ' to stop ' + (nextIdx + 1) + ', ETA ' + K.dtg(stops[nextIdx].arrive);
      else if (pos.status === 'en-route') status += ' back to hub, ETA ' + K.dtg(rt.returnAt);
      else if (atIdx >= 0 && stops[atIdx]) status = 'At stop ' + (atIdx + 1) + ' (' + (stops[atIdx].label || '') + ')';
      else if (pos.legIndex >= 0 && rt.legs[pos.legIndex] && rt.legs[pos.legIndex].turnedBack) status = 'Turned back from a closed road';
      out.push({ id: id, color: K.truckColor(state, id, rt), type: rt.type || t.type, lat: pos.lat, lon: pos.lon, heading: pos.status === 'en-route' ? pos.heading : null, status: status });
    });
    return out;
  }

  const MapView = {
    label: 'Map', icon: 'map', region: 'center', order: 10,

    mount: function (el, ctx) {
      const self = this;
      self.ctx = ctx;
      self.el = el;
      self.last = {};
      el.classList.add('pm');
      self.box = h('div.map-fill.pm-map', { 'data-testid': 'planner-map' });
      el.appendChild(self.box);
      try {
        self.m = SRO.ui.map.create(self.box, { theme: root.document.documentElement.getAttribute('data-theme') || 'dark' });
      } catch (e) {
        self.m = null;
        el.appendChild(h('div.notice.notice-error.pm-error', ui.icon('alert'), h('div', h('strong', 'The map could not load. '), h('span.muted', String(e && e.message || e)))));
        return;
      }
      K._map = self.m;
      ui.emit('planner:map', self.m);
      self.offWant = ui.on('planner:map:want', function (q) { if (q && typeof q.reply === 'function' && self.m) q.reply(self.m); });
      self.offFocus = ui.on('planner:focus', function (z) {
        if (!self.m || !z || !K.isNum(z.lat) || !K.isNum(z.lon)) return;
        if (!self.hasSize()) { self.pendingFocus = z; return; }       // hidden tab: fit when shown
        self.focus(z);
      });
      self.m.on('click:rally', function (e) {
        const id = e && e.point && (e.point.gridId || e.point.id);
        if (id && ui.scenario && typeof ui.scenario.rallyDialog === 'function') ui.scenario.rallyDialog(id);
      });
      self.m.on('click:route', function (e) { self.openRoute(e.truckId); });
      self.m.on('click:truck', function (e) { if (K.planIndex(K.viewedPlan(ctx.getState())).byTruck[e.id]) self.openRoute(e.id); });
      self.m.on('click:platoon', function (e) {
        K.focusRequest(e.id, 'map');
        ctx.show('queue');
      });
      self.m.on('click:map', function () { if (K.sel.requestId) K.select({ requestId: null, source: 'map' }); });
      self.buildLegend();
      self.offSel = K.onSelect(function () { self.render(ctx.getState(), false); });
      self.offTheme = ui.on('theme', function () { self.last.legendKey = null; self.render(ctx.getState(), false); });
      try { root.dispatchEvent(new root.CustomEvent('sro:planner-map', { detail: self.m })); } catch (e) { /* old browsers */ }
    },

    openRoute: function (truckId) {
      if (!truckId) return;
      K.select({ truckId: truckId });
      this.ctx.show('route');
    },

    update: function (state, ctx) {
      this.ctx = ctx;
      this.render(state, ctx.clockOnly);
    },

    hasSize: function () {
      const sz = this.m && this.m.leaflet && this.m.leaflet.getSize();
      return !!(sz && sz.x > 0 && sz.y > 0 && this.box.clientWidth > 0);
    },

    focus: function (z) {
      const G = SRO.core.geo;
      this.m.fitTo([0, 90, 180, 270].map(function (b) { return G.destination({ lat: z.lat, lon: z.lon }, b, z.radiusMi || 1); }));
    },

    // On small screens the map is a tab. While it is hidden it has no size, and redraws then (theme
    // change, new routes) can shift the view; put back the view the planner left, or apply a focus
    // asked for while hidden.
    onHide: function () {
      const l = this.m && this.m.leaflet;
      if (!l) return;
      if (l.getSize().x > 0) this.savedView = { c: l.getCenter(), z: l.getZoom() };
      // Leaflet keeps a map inside maxBounds after every move; with no size that pulls the view off
      // Taiwan, so the limit is lifted while hidden and set again on show
      if (l.options.maxBounds) { this.savedMaxBounds = l.options.maxBounds; l.setMaxBounds(null); }
    },

    onShow: function () {
      if (!this.m) return;
      const self = this, saved = this.savedView, pending = this.pendingFocus, bounds = this.savedMaxBounds;
      this.savedView = null;
      this.pendingFocus = null;
      this.savedMaxBounds = null;
      this.m.invalidateSize();
      // after the map's own resize handling (next frame), stop any pan it started while it had no
      // size and put the view back
      const raf = root.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
      raf(function () {
        raf(function () {
          const m = self.m, l = m && m.leaflet;
          if (!l) return;
          if (!self.hasSize()) { if (bounds && !l.options.maxBounds) self.savedMaxBounds = bounds; return; }
          l.invalidateSize({ pan: false });
          l.stop();
          if (pending) self.focus(pending);
          else if (saved) l.setView(saved.c, saved.z, { animate: false });
          if (bounds && !l.options.maxBounds) l.setMaxBounds(bounds);
          self.render(self.ctx.getState(), false);
        });
      });
    },

    unmount: function () {
      ['offSel', 'offTheme', 'offWant', 'offFocus'].forEach(function (k2) { if (this[k2]) this[k2](); }, this);
      if (this.m) { try { this.m.destroy(); } catch (e) { /* already gone */ } }
      if (K._map === this.m) { K._map = null; ui.emit('planner:map', null); }
      this.m = null;
    },

    render: function (state, clockOnly) {
      const m = this.m;
      if (!m || !state) return;
      const last = this.last;
      const plan = K.viewedPlan(state);
      if (!clockOnly) {
        const sc = state.scenario || {};
        if (sc.zones !== last.zones) { m.setZones(sc.zones || []); last.zones = sc.zones; }
        if (sc.hubs !== last.hubs) { m.setHubs(sc.hubs || []); last.hubs = sc.hubs; }
        const reqs = K.queueRequests(state).filter(function (r) { return r.status !== 'delivered' && K.isNum(r.lat) && K.isNum(r.lon); });
        if (reqs !== last.reqs || K.sel.requestId !== last.selReq) {
          m.setPlatoons(reqs, { selectedId: K.sel.requestId });
          last.reqs = reqs; last.selReq = K.sel.requestId;
        }
        const rallyKey = [plan && plan.id, plan && plan.rallyPoints, sc.rally, plan && plan.routes];
        if (!same(rallyKey, last.rallyKey)) { m.setRally(rallyPoints(state, plan)); last.rallyKey = rallyKey; }
        const hi = K.sel.routeOpen ? K.sel.truckId : null;
        const routeKey = [plan && plan.routes, sc.zones, sc.fleet, hi];
        if (!same(routeKey, last.routeKey)) {
          m.setRoutes(routesFor(state, plan), { highlightTruckId: hi });
          this.drawTurnBacks(state, plan);
          last.routeKey = routeKey;
        }
        const legendKey = [plan && plan.routes, sc.fleet];
        if (!same(legendKey, last.legendKey)) { this.fillLegend(state, plan); last.legendKey = legendKey; }
      }
      m.setTrucks(trucksAt(state, plan));
      // bring a platoon picked in the queue into view (once the map has a size)
      if (K.sel.focusSeq !== last.focusSeq && K.sel.source === 'queue' && K.sel.requestId) {
        const sz = m.leaflet.getSize();
        const r = K.request(state, K.sel.requestId);
        if (sz.x > 0 && sz.y > 0 && r && K.isNum(r.lat)) {
          last.focusSeq = K.sel.focusSeq;
          const ll = [r.lat, r.lon];
          if (!m.leaflet.getBounds().pad(-0.12).contains(ll)) m.leaflet.panTo(ll, { animate: true });
        }
      } else if (K.sel.focusSeq !== last.focusSeq && K.sel.source !== 'queue') last.focusSeq = K.sel.focusSeq;
    },

    // A truck of a re-plan that drove into a newly closed road: its route shows the part it drove
    // (the turn-back leg, solid like any driven road) ending at a marker where it turned and was
    // routed on from. The marker sits in the map's stop pane, in the truck's colour.
    drawTurnBacks: function (state, plan) {
      const L = root.L, lm = this.m && this.m.leaflet;
      if (!L || !lm) return;
      if (!this.turnLayer) this.turnLayer = L.layerGroup().addTo(lm);
      this.turnLayer.clearLayers();
      const self = this;
      K.usedRoutes(plan).forEach(function (rt) {
        const tb = K.turnBack(rt);
        if (!tb || !K.isNum(tb.lat) || !K.isNum(tb.lon)) return;
        const color = K.truckColor(state, rt.truckId, rt);
        const tipText = rt.truckId + ' turned back here at ' + K.dtg(tb.at) + ': the road ahead is closed. Re-routed from this point' +
          (tb.nextStop ? ' to ' + (tb.nextStop.label || 'its next stop') : '') + '.';
        const mk = L.marker([tb.lat, tb.lon], {
          pane: 'sro-stops', keyboard: false, zIndexOffset: 1200, title: tipText, alt: tipText,
          icon: L.divIcon({ className: 'pm-turn-icon', iconSize: [24, 24], iconAnchor: [12, 12],
            html: '<div class="pm-turn" style="--truck:' + color + '" data-truck="' + String(rt.truckId).replace(/[^\w-]/g, '') + '">' +
              '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' })
        }).addTo(self.turnLayer);
        mk.on('click', function () { self.openRoute(rt.truckId); });
      });
    },

    // ---- legend (Leaflet control, bottom right: open sea east of Taiwan) ----------------------------------------------------
    buildLegend: function () {
      const self = this;
      const L = root.L;
      const narrow = function () { return (self.box.clientWidth || root.innerWidth) < 640; };
      self.legendOpen = !narrow();
      const Legend = L.Control.extend({
        options: { position: 'bottomright' },
        onAdd: function () {
          const div = L.DomUtil.create('div', 'pm-legend leaflet-control');
          L.DomEvent.disableClickPropagation(div);
          L.DomEvent.disableScrollPropagation(div);
          self.legendToggle = h('button.pm-legend-toggle', {
            type: 'button', 'aria-expanded': String(self.legendOpen), 'aria-controls': 'pm-legend-body',
            onClick: function () { self.setLegendOpen(!self.legendOpen); }
          }, ui.icon('layers'), h('span', 'Legend'), ui.icon('chevronDown', { cls: 'pm-legend-chev' }));
          self.legendBody = h('div.pm-legend-body#pm-legend-body');
          self.legendNote = h('div.pm-legend-note', 'Road lines and times from OpenStreetMap road data');
          div.appendChild(self.legendToggle);
          div.appendChild(self.legendBody);
          div.appendChild(self.legendNote);
          self.legendEl = div;
          return div;
        }
      });
      self.legend = new Legend().addTo(self.m.leaflet);
      self.setLegendOpen(self.legendOpen);
    },
    setLegendOpen: function (open) {
      this.legendOpen = !!open;
      if (!this.legendEl) return;
      this.legendEl.classList.toggle('is-open', this.legendOpen);
      this.legendToggle.setAttribute('aria-expanded', String(this.legendOpen));
      this.legendBody.hidden = !this.legendOpen;
    },
    fillLegend: function (state, plan) {
      const body = this.legendBody;
      if (!body) return;
      ui.clear(body);
      const routes = K.usedRoutes(plan);
      const trucks = h('div.pm-legend-sec', h('div.pm-legend-h', plan ? 'Trucks in plan' : 'Trucks'));
      if (routes.length) {
        // grouped by type so each row only needs the color and the callsign
        [['tanker', 'Fuel tankers'], ['cargo', 'Cargo trucks']].forEach(function (g) {
          const list = routes.filter(function (rt) {
            const type = rt.type || (K.truck(state, rt.truckId) || {}).type;
            return g[0] === 'tanker' ? type === 'tanker' : type !== 'tanker';
          });
          if (!list.length) return;
          const grid = h('div.pm-legend-trucks');
          list.forEach(function (rt) {
            grid.appendChild(h('div.pm-legend-row', { title: rt.truckId + ', ' + K.truckTypeLabel(rt.type || g[0]) },
              h('span.truck-line', { style: { '--truck': K.truckColor(state, rt.truckId, rt) } }),
              h('span.pm-legend-call', rt.truckId)));
          });
          trucks.appendChild(h('div.pm-legend-type', g[1]));
          trucks.appendChild(grid);
        });
      } else {
        trucks.appendChild(h('div.pm-legend-empty', 'No plan yet: routes appear here after Plan now.'));
      }
      body.appendChild(trucks);
      const urg = h('div.pm-legend-sec', h('div.pm-legend-h', 'Urgency ring'));
      const ugrid = h('div.pm-legend-urg');
      K.URGENCY.forEach(function (u) { ugrid.appendChild(h('div.pm-legend-row', h('span.urg-dot', { 'data-urgency': u }), h('span', u))); });
      urg.appendChild(ugrid);
      body.appendChild(urg);
      const S = SRO.ui.symbols;
      const sym = function (sidc, label, extra) {
        let svg = '';
        try { svg = S.svg(sidc, Object.assign({ size: 13, label: label }, extra || {})); } catch (e) { svg = ''; }
        return h('div.pm-legend-row', h('span.pm-legend-sym', { html: svg }), h('span', label));
      };
      body.appendChild(h('div.pm-legend-sec', h('div.pm-legend-h', 'Map'),
        h('div.pm-legend-sym-grid',
          sym(S.SIDC.hub, 'Hub', { infoFields: false }),
          sym(S.SIDC.rally, 'Rally point', { infoFields: false }),
          h('div.pm-legend-row', h('span.pm-legend-zone.is-closed'), h('span', 'Closed zone')),
          h('div.pm-legend-row', h('span.pm-legend-zone.is-risk'), h('span', 'Risk zone')),
          routes.some(function (rt) { return K.turnBack(rt); })
            ? h('div.pm-legend-row', { 'data-testid': 'legend-turnback' }, h('span.pm-turn.pm-turn-sm', { html: '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' }), h('span', 'Turned back (road closed ahead)'))
            : null),
        h('div.pm-legend-hint', 'Faint rally points are candidates the plan does not use.')));
    }
  };

  function same(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  if (ui.registerView) ui.registerView('planner/map', MapView);
})(typeof self !== 'undefined' ? self : globalThis);
