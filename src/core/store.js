// App state store (DESIGN.md section 3): one JSON-serializable state object, changed only by
// dispatch(action). The reducer is pure: it never reads the wall clock, time comes from
// action fields (now / createdAt / simMin) or state.clock.simMin. Persistence goes through an
// adapter { load, save, exportJson, importJson }; every localStorage access is guarded.
//
// Actions are { type, ...fields } or { type, payload: { ...fields } } (both work). A dispatch
// returns { ok: true, ...extra } or { ok: false, error } (error is a plain-language sentence);
// the state is unchanged when ok is false. Subscribers run after every dispatch: fn(state, action, result).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.core = SRO.core || {};
  const store = SRO.core.store = SRO.core.store || {};
  const util = SRO.util;

  store.VERSION = 1;
  store.STORAGE_KEY = 'sro.v1';
  const ROLES = ['psg', 'planner'];
  const THEMES = ['dark', 'light', 'night'];
  const PLANNER_TABS = ['queue', 'plan', 'scenario', 'outputs', 'map'];
  const EDITABLE = ['submitted', 'planned', 'delayed'];            // not yet in an approved plan
  const PENDING = ['submitted', 'planned', 'delayed', 'partial'];   // still needs (some) delivery
  const ZONE_KINDS = ['closed', 'risk'];
  const TRUCK_TYPES = ['tanker', 'cargo'];
  const DEFAULT_CAPACITY = { tanker: 2500, cargo: 10 };
  const METHODS = ['tabu', 'sa', 'aco', 'mip'];
  // Truck colors come from SRO.data.scenario.truckColors only (DESIGN.md section 8b); entries are
  // { hex, name } or plain '#hex'. Without scenario.js (some Node tests) every truck gets one neutral
  // gray rather than a second palette.
  const NO_PALETTE_COLOR = '#7A8793';
  store.truckPalette = function () {
    const sc = SRO.data && SRO.data.scenario;
    const list = sc && Array.isArray(sc.truckColors) ? sc.truckColors : [];
    return list.map(function (c) { return typeof c === 'string' ? c : (c && c.hex) || null; }).filter(Boolean);
  };
  // Read-only alias kept for older callers.
  Object.defineProperty(store, 'TRUCK_COLORS', { get: function () { return store.truckPalette(); }, enumerable: true, configurable: true });

  // ---- small helpers -------------------------------------------------------------------------
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function clone(x) { return util.deepClone(x); }
  function num(x) { return typeof x === 'number' ? x : (typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN); }
  // A real finite number (the global isFinite(null) is true, which let null times through).
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function ok(state, extra) { return { state: state, result: Object.assign({ ok: true }, extra || {}) }; }
  function fail(state, error) { return { state: state, result: { ok: false, error: error } }; }

  // Field lookup across action.payload and the action itself; a scalar or array payload stands
  // in for the first key (dispatch({ type: 'role/set', payload: 'planner' })).
  function arg(action, keys) {
    keys = [].concat(keys);
    const p = action.payload;
    for (let k = 0; k < keys.length; k++) {
      if (isObj(p) && p[keys[k]] !== undefined) return p[keys[k]];
      if (action[keys[k]] !== undefined) return action[keys[k]];
    }
    if (p !== undefined && !isObj(p)) return p;
    return undefined;
  }
  // An object argument: action[key] / payload[key], else the payload object, else the action's own
  // fields. In the last two shapes 'now' is the action's time stamp (nowOf), not part of the
  // object, so it is left out (otherwise a submitted request or a truck would carry a 'now' field).
  function objArg(action, key) {
    const v = arg(action, key);
    if (isObj(v)) return v;
    if (isObj(action.payload)) return 'now' in action.payload ? without(action.payload, ['now']) : action.payload;
    const o = Object.assign({}, action);
    delete o.type; delete o.payload; delete o.now;
    return Object.keys(o).length ? o : null;
  }
  function without(obj, keys) { const o = Object.assign({}, obj); keys.forEach(function (k) { delete o[k]; }); return o; }
  function nowOf(state, action) {
    const t = num(arg(action, 'now'));
    return Math.floor(isFinite(t) ? t : (state.clock && state.clock.simMin) || 0);
  }
  function setIn(obj, path, value) {
    if (!path.length) return value;
    const k = path[0];
    const base = Array.isArray(obj) ? obj.slice() : Object.assign({}, obj || {});
    base[k] = setIn(base[k], path.slice(1), value);
    return base;
  }
  function assignIn(obj, path, fields) {
    let cur = obj;
    for (let i = 0; i < path.length; i++) cur = cur ? cur[path[i]] : undefined;
    return setIn(obj, path, Object.assign({}, cur || {}, fields));
  }
  function deepMerge(target, src) {
    if (!isObj(target) || !isObj(src)) return clone(src);
    const out = Object.assign({}, target);
    Object.keys(src).forEach(function (k) {
      const v = src[k];
      out[k] = isObj(v) && isObj(target[k]) ? deepMerge(target[k], v) : clone(v);
    });
    return out;
  }
  // Fill keys missing from `obj` with `defaults` (plain objects recursively; arrays/values kept).
  function fillDefaults(obj, defaults) {
    if (!isObj(obj) || !isObj(defaults)) return obj === undefined ? clone(defaults) : obj;
    const out = Object.assign({}, obj);
    Object.keys(defaults).forEach(function (k) {
      if (out[k] === undefined) out[k] = clone(defaults[k]);
      else if (isObj(out[k]) && isObj(defaults[k])) out[k] = fillDefaults(out[k], defaults[k]);
    });
    return out;
  }
  function ids(list) { return (list || []).map(function (x) { return x.id; }); }
  function mapById(list, id, fn) {
    let hit = false;
    const out = list.map(function (x) { if (x.id === id) { hit = true; return fn(x); } return x; });
    return hit ? out : null;
  }
  function windowOf(simMin) {
    const c = SRO.core.clock;
    if (c && c.windowOf) return c.windowOf(simMin);
    const start = Math.floor(simMin / 360) * 360;
    const m = ((start % 1440) + 1440) % 1440;
    const id = 'W-D' + (Math.floor(start / 1440) + 1) + '-' + util.pad(Math.floor(m / 60), 2) + util.pad(m % 60, 2);
    return { id: id, start: start, end: start + 360 };
  }
  function windowById(id, fallbackMin) {
    const c = SRO.core.clock;
    const w = c && c.parseWindowId ? c.parseWindowId(id) : null;
    if (w) return w;
    const f = windowOf(fallbackMin);
    return { id: id, start: f.start, end: f.end };
  }
  function ensureWindow(state, id, atMin) {
    if (!id || (state.windows || []).some(function (w) { return w.id === id; })) return state;
    const w = windowById(id, atMin);
    const list = (state.windows || []).concat([{ id: id, start: w.start, end: w.end, status: 'open', planIds: [], approvedPlanId: null }]);
    list.sort(function (a, b) { return a.start - b.start; });
    return Object.assign({}, state, { windows: list });
  }

  // ---- default state ---------------------------------------------------------------------------
  // Minimal skeleton; SRO.data.scenario.defaultState() supplies the real hubs, fleet and settings.
  function skeleton() {
    return {
      version: store.VERSION,
      ui: { role: 'psg', theme: 'dark', plannerTab: 'queue', psgTab: 'request', planRequested: false, planRequestReason: null, planRequestedAt: null, lastPlanId: null },
      clock: { simMin: 360, running: false, speed: 60 },
      profile: null,
      scenario: {
        hubs: [], fleet: [], zones: [],
        rally: { pinned: [], banned: [] },
        settings: {
          method: 'tabu', timeLimitSec: 300,
          weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },
          maxRallyPoints: 8, maxStops: 20,
          convoyFactor: 1.5, mpg: 2, serviceMin: 15, loadMin: 20,
          periods: [
            { name: 'Day', start: '0700', end: '1800', speed: 1.0, risk: 1.0 },
            { name: 'Dusk', start: '1800', end: '1930', speed: 0.9, risk: 1.2 },
            { name: 'Night', start: '1930', end: '0530', speed: 0.7, risk: 0.8 },
            { name: 'Dawn', start: '0530', end: '0700', speed: 0.9, risk: 1.2 }
          ],
          riskRatings: { Low: 1, Medium: 3, High: 6 },
          mobility: { mounted: { radiusMi: 50, costPerMi: 0.5 }, dismounted: { radiusMi: 5, costPerMi: 4 } },
          dailyUse: {},
          methodParams: { tabu: {}, sa: {}, aco: {}, mip: {} },
          sampleSeed: 20261005
        }
      },
      requests: [], windows: [], plans: [], snapshots: [], roadCache: {}
    };
  }

  // Window ids follow the clock ('W-D1-0600'). A window stored under another id (e.g. a seeded
  // 'W-001') whose start sits on a 6 h boundary is renamed, and requests/plans that point at it
  // follow, so one time span never gets two window entries.
  function canonicalWindows(s) {
    const c = SRO.core.clock;
    if (!c || !c.windowId || !Array.isArray(s.windows)) return s;
    const canonical = /^W-D-?\d+-\d{4}$/;
    const taken = {};
    s.windows.forEach(function (w) { if (w) taken[w.id] = true; });
    const rename = {};
    const windows = s.windows.map(function (w) {
      if (!w || canonical.test(w.id) || !isNum(w.start) || w.start % c.WINDOW_MIN !== 0) return w;
      const id = c.windowId(w.start);
      if (taken[id]) return w;
      taken[id] = true; rename[w.id] = id;
      return Object.assign({}, w, { id: id });
    });
    if (!Object.keys(rename).length) return s;
    const fix = function (x) { return x && rename[x.windowId] ? Object.assign({}, x, { windowId: rename[x.windowId] }) : x; };
    return Object.assign({}, s, { windows: windows, requests: (s.requests || []).map(fix), plans: (s.plans || []).map(fix) });
  }
  store.canonicalWindows = canonicalWindows;

  store.defaultState = function () {
    let s = null;
    const sc = SRO.data && SRO.data.scenario;
    if (sc && typeof sc.defaultState === 'function') {
      try { s = clone(sc.defaultState()); } catch (e) { s = null; }
    }
    return canonicalWindows(fillDefaults(s || {}, skeleton()));
  };

  // Loaded/imported state -> complete state: fill missing keys, canonical window ids, never
  // resume a running clock.
  function hydrate(loaded, defaults) {
    const s = canonicalWindows(fillDefaults(loaded, defaults || store.defaultState()));
    s.version = store.VERSION;
    s.clock = Object.assign({}, s.clock, { running: false });
    return s;
  }
  store.hydrate = hydrate;

  // ---- request helpers -------------------------------------------------------------------------
  function normalizeRequest(state, r0, id, now, source) {
    const settings = (state.scenario && state.scenario.settings) || {};
    const prof = state.profile || {};
    const mob = r0.mobility || prof.mobility || 'mounted';
    const mobSet = (settings.mobility || {})[mob];
    const radius = mob === 'fixed' ? 0 : (mobSet && isNum(mobSet.radiusMi) ? mobSet.radiusMi : null);
    const createdAt = isFinite(num(r0.createdAt)) ? Math.floor(num(r0.createdAt)) : now;
    const r = Object.assign({
      source: source,
      unitName: prof.unitName || '', designator: prof.designator || '',
      lat: prof.lat !== undefined ? prof.lat : null, lon: prof.lon !== undefined ? prof.lon : null,
      gridId: prof.gridId || null,
      mobility: mob, maxTravelMi: radius,
      desiredPickup: null,
      directOnly: mob === 'fixed', directReason: null, directReasonText: '',
      lines: [],
      urgencyRequested: 'Routine', urgency: null,
      hoursLeftComputed: null, hoursLeftReported: null,
      nlt: null, deadline: null,
      remarks: ''
    }, clone(without(r0, ['id', 'status', 'createdAt', 'windowId', 'locks', 'updated'])));
    r.id = id;
    r.source = r0.source || source;
    r.status = 'submitted';
    r.createdAt = createdAt;
    // The window that is open when the request enters the queue (the one whose plan will pick it
    // up). Sample requests carry back-dated createdAt stamps (up to 3 h before loading); using
    // createdAt here put the demo's 19 samples in the previous, already-closed window while the
    // user's own request went into the current one.
    r.windowId = windowOf(now).id;
    r.locks = Object.assign({ truckId: null, forceDirect: false }, isObj(r0.locks) ? r0.locks : {});
    r.updated = false;
    // Escalation (urgency.js): when the caller did not already decide the urgency, apply the
    // spec rule here so an Urgent request with < 24 h of supply always becomes Immediate.
    if (!r.urgency) escalateInto(r, r, createdAt, settings);
    if (!r.urgency) r.urgency = r.urgencyRequested || 'Routine';
    if (r.deadline === null || r.deadline === undefined) r.deadline = r.nlt;
    if (!r.gridId && isFinite(num(r.lat)) && isFinite(num(r.lon)) && SRO.core.geo && Array.isArray(SRO.data && SRO.data.grid)) {
      const g = SRO.core.geo.nearestGrid({ lat: num(r.lat), lon: num(r.lon) }, SRO.data.grid);
      if (g) r.gridId = g.id;
    }
    return r;
  }

  // Sets urgency / deadline / hours from SRO.core.urgency.escalate(src, atMin) on `dst` (when the
  // module is loaded). The deadline is only set when dst has none. Returns true when applied.
  function escalateInto(dst, src, atMin, settings, forceDeadline) {
    const U = SRO.core.urgency;
    if (!U || typeof U.escalate !== 'function') return false;
    try {
      const du = settings && isObj(settings.dailyUse) && Object.keys(settings.dailyUse).length ? settings.dailyUse : undefined;
      const e = U.escalate(src, atMin, { dailyUse: du });
      dst.urgency = e.urgency;
      if (forceDeadline || dst.deadline === null || dst.deadline === undefined) dst.deadline = e.deadline === undefined ? null : e.deadline;
      if (e.hoursLeftComputed !== null && e.hoursLeftComputed !== undefined) dst.hoursLeftComputed = e.hoursLeftComputed;
      dst.hoursLeftReported = e.hoursLeftReported;
      return true;
    } catch (err) { return false; }
  }

  function planRequestInfo(plan) {
    const info = {};   // requestId -> { delivered, deferred, firstArrive, lastArrive, depart, gridIds }
    function get(id) { return info[id] || (info[id] = { delivered: false, deferred: false, firstArrive: Infinity, lastArrive: -Infinity, depart: Infinity, gridIds: [] }); }
    ((plan && plan.routes) || []).forEach(function (rt) {
      (rt.stops || []).forEach(function (st) {
        (st.deliveries || []).forEach(function (d) {
          const x = get(d.requestId);
          x.delivered = true;
          // null / missing times must not count as minute 0 (that would mark the request
          // delivered on the next tick); a delivery without a numeric arrival never completes
          if (isNum(st.arrive) && st.arrive < x.firstArrive) x.firstArrive = st.arrive;
          if (isNum(st.arrive) && st.arrive > x.lastArrive) x.lastArrive = st.arrive;
          if (!isNum(st.arrive)) x.untimed = true;
          if (isNum(rt.depart) && rt.depart < x.depart) x.depart = rt.depart;
          if (x.gridIds.indexOf(st.gridId) < 0) x.gridIds.push(st.gridId);
        });
      });
    });
    ((plan && plan.deferred) || []).forEach(function (d) { get(d.requestId).deferred = true; });
    return info;
  }

  function hasPending(state) {
    return (state.requests || []).some(function (r) { return PENDING.indexOf(r.status) >= 0; });
  }

  // Status progression driven by the clock: trucks return, approved requests go en route and
  // get delivered as the planned times pass. Returns the same object when nothing changes.
  function progress(state, from, to) {
    let s = state;
    // window boundary crossed with work waiting -> ask the planner engine for a plan
    const c = SRO.core.clock;
    const crossed = c && c.boundariesBetween ? c.boundariesBetween(from, to) : [];
    if (crossed.length && hasPending(s)) {
      s = assignIn(s, ['ui'], { planRequested: true, planRequestReason: 'boundary', planRequestedAt: crossed[crossed.length - 1] });
    }
    // trucks
    let fleetChanged = false;
    const fleet = (s.scenario.fleet || []).map(function (t) {
      if (t.status === 'en_route' && isNum(t.availableAt) && t.availableAt <= to) { fleetChanged = true; return Object.assign({}, t, { status: 'available' }); }
      if (t.status === 'out' && isNum(t.outUntil) && t.outUntil <= to) { fleetChanged = true; return without(Object.assign({}, t, { status: 'available', availableAt: Math.max(t.availableAt || 0, t.outUntil) }), ['outUntil', 'outReason']); }
      return t;
    });
    if (fleetChanged) s = setIn(s, ['scenario', 'fleet'], fleet);
    // requests in approved plans
    const moving = (s.requests || []).some(function (r) { return r.status === 'approved' || r.status === 'en_route'; });
    if (moving) {
      const agg = {};
      (s.plans || []).forEach(function (p) {
        if (!p.approved || p.cancelled) return;
        const info = planRequestInfo(p);
        Object.keys(info).forEach(function (id) {
          if (!info[id].delivered) return;
          const a = agg[id] || (agg[id] = { depart: Infinity, lastArrive: -Infinity });
          a.depart = Math.min(a.depart, info[id].depart);
          a.lastArrive = info[id].untimed ? Infinity : Math.max(a.lastArrive, info[id].lastArrive);
        });
      });
      let changed = false;
      const reqs = s.requests.map(function (r) {
        const a = agg[r.id];
        if (!a || (r.status !== 'approved' && r.status !== 'en_route')) return r;
        let st = r.status;
        if (a.lastArrive > -Infinity && to >= a.lastArrive) st = 'delivered';
        else if (to >= a.depart) st = 'en_route';
        if (st === r.status) return r;
        changed = true;
        const n = Object.assign({}, r, { status: st });
        if (st === 'delivered') n.deliveredAt = Math.floor(a.lastArrive);
        return n;
      });
      if (changed) s = Object.assign({}, s, { requests: reqs });
    }
    return { state: s, crossed: crossed };
  }

  // ---- truck helpers ---------------------------------------------------------------------------
  function newTruck(state, t0, now) {
    const sc = state.scenario;
    const hub = (sc.hubs || []).find(function (h) { return h.id === t0.hubId; });
    const type = TRUCK_TYPES.indexOf(t0.type) >= 0 ? t0.type : 'cargo';
    let id = t0.id;
    if (!id || sc.fleet.some(function (t) { return t.id === id; })) {
      const prefix = (hub && hub.callsign) || t0.hubId;
      let max = 0;
      const re = new RegExp('^' + String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$');
      sc.fleet.forEach(function (t) { const m = re.exec(t.id); if (m) max = Math.max(max, parseInt(m[1], 10)); });
      id = prefix + '-' + (max + 1);
    }
    const palette = store.truckPalette();
    const used = sc.fleet.map(function (t) { return t.color; });
    const color = t0.color || palette.find(function (c) { return used.indexOf(c) < 0; }) ||
      (palette.length ? palette[sc.fleet.length % palette.length] : NO_PALETTE_COLOR);
    const hubMate = sc.fleet.find(function (t) { return t.hubId === t0.hubId && t.freq; });
    return Object.assign({}, clone(t0), {
      id: id, hubId: t0.hubId, type: type,
      capacity: num(t0.capacity) > 0 ? num(t0.capacity) : DEFAULT_CAPACITY[type],
      color: color,
      freq: t0.freq || (hubMate ? hubMate.freq : '45.250'),
      status: 'available',
      availableAt: isFinite(num(t0.availableAt)) ? num(t0.availableAt) : now
    });
  }

  function zoneProblem(z, ratings) {
    if (ZONE_KINDS.indexOf(z.kind) < 0) return 'A zone must be "closed" or "risk".';
    if (!isFinite(num(z.lat)) || !isFinite(num(z.lon))) return 'A zone needs a map location.';
    if (!(num(z.radiusMi) > 0)) return 'A zone needs a radius greater than 0 miles.';
    if (z.kind === 'risk' && !(z.rating in (ratings || {}))) return 'A risk zone needs a rating (' + Object.keys(ratings || {}).join(', ') + ').';
    return null;
  }

  function defaultMethodParams(state, method) {
    try {
      if (SRO.solver && typeof SRO.solver.defaultParams === 'function') {
        const p = SRO.solver.defaultParams(method, state.scenario.settings);
        if (isObj(p)) return clone(p);
      }
    } catch (e) { /* fall through */ }
    // no params.js: back to the scenario default (null there means "use the method defaults")
    const d = store.defaultState().scenario.settings.methodParams || {};
    return d[method] === undefined ? {} : clone(d[method]);
  }

  // ---- handlers -------------------------------------------------------------------------------
  const H = {};

  H['role/set'] = function (s, a) {
    const v = arg(a, ['role', 'value']);
    if (ROLES.indexOf(v) < 0) return fail(s, 'Role must be "psg" or "planner".');
    return ok(setIn(s, ['ui', 'role'], v));
  };
  H['theme/set'] = function (s, a) {
    const v = arg(a, ['theme', 'value']);
    if (THEMES.indexOf(v) < 0) return fail(s, 'Theme must be dark, light or night.');
    return ok(setIn(s, ['ui', 'theme'], v));
  };
  // { tab } sets the planner tab; { role: 'psg', tab } sets ui.psgTab.
  H['tab/set'] = function (s, a) {
    const v = arg(a, ['tab', 'value']);
    if (typeof v !== 'string' || !v) return fail(s, 'tab/set needs a tab name.');
    if (arg(a, 'role') === 'psg') return ok(setIn(s, ['ui', 'psgTab'], v));
    if (PLANNER_TABS.indexOf(v) < 0) return fail(s, 'Unknown planner tab "' + v + '".');
    return ok(setIn(s, ['ui', 'plannerTab'], v));
  };

  H['clock/start'] = function (s) { return ok(setIn(s, ['clock', 'running'], true)); };
  H['clock/pause'] = function (s) { return ok(setIn(s, ['clock', 'running'], false)); };
  H['clock/speed'] = function (s, a) {
    const v = num(arg(a, ['speed', 'value']));
    if (!(v > 0) || !isFinite(v)) return fail(s, 'Clock speed must be a positive number (1, 60 or 600).');
    return ok(setIn(s, ['clock', 'speed'], v));
  };
  // { simMin } (absolute) or { elapsedMs } (wall time at the current speed).
  H['clock/tick'] = function (s, a) {
    let to = num(arg(a, ['simMin', 'value']));
    if (!isFinite(to)) {
      const ms = num(arg(a, ['elapsedMs', 'realMs']));
      if (isFinite(ms) && SRO.core.clock) to = SRO.core.clock.advance(Object.assign({}, s.clock, { running: true }), ms);
    }
    if (!isFinite(to)) return fail(s, 'clock/tick needs simMin or elapsedMs.');
    const from = s.clock.simMin;
    const p = progress(setIn(s, ['clock', 'simMin'], to), from, to);
    return ok(p.state, { crossed: p.crossed });
  };

  H['profile/save'] = function (s, a) {
    const p = arg(a, 'profile');
    if (p === null) return ok(Object.assign({}, s, { profile: null }));
    const prof = isObj(p) ? p : objArg(a, 'profile');
    if (!prof) return fail(s, 'profile/save needs a profile.');
    return ok(Object.assign({}, s, { profile: Object.assign({}, s.profile || {}, clone(prof)) }));
  };

  H['request/submit'] = function (s, a) {
    const r0 = objArg(a, 'request');
    if (!r0) return fail(s, 'request/submit needs a request.');
    const now = nowOf(s, a);
    const id = util.nextId('R', ids(s.requests));
    const r = normalizeRequest(s, r0, id, now, 'user');
    const ns = ensureWindow(Object.assign({}, s, { requests: s.requests.concat([r]) }), r.windowId, r.createdAt);
    return ok(ns, { id: id });
  };

  H['request/edit'] = function (s, a) {
    const id = arg(a, ['id', 'requestId']);
    const r = s.requests.find(function (x) { return x.id === id; });
    if (!r) return fail(s, 'Request ' + id + ' was not found.');
    if (EDITABLE.indexOf(r.status) < 0) return fail(s, 'Request ' + id + ' is ' + r.status + ' and can no longer be changed.');
    let ch = arg(a, ['changes', 'patch']);
    if (!isObj(ch)) ch = without(objArg(a, 'request') || {}, ['id', 'requestId', 'now']);
    ch = clone(without(ch, ['id', 'status', 'createdAt', 'windowId', 'source', 'updated']));
    const n = Object.assign({}, r, ch);
    const tierChanged = 'urgencyRequested' in ch && ch.urgencyRequested !== r.urgencyRequested;
    const urgencyInputs = tierChanged || ['nlt', 'lines', 'hoursLeftReported'].some(function (k) { return k in ch; });
    // Re-run escalation when its inputs change (on hand re-reported now if lines / hours changed,
    // otherwise as of the original report), unless the caller set urgency or deadline itself.
    const reportAt = ('lines' in ch || 'hoursLeftReported' in ch) ? nowOf(s, a) : r.createdAt;
    if (!(urgencyInputs && !('urgency' in ch) && !('deadline' in ch) && escalateInto(n, n, reportAt, s.scenario && s.scenario.settings, true))) {
      if ('nlt' in ch && !('deadline' in ch)) {
        n.deadline = (r.deadline === r.nlt || !isNum(r.deadline)) ? n.nlt : Math.min(n.nlt, r.deadline);
      }
      if (tierChanged && !('urgency' in ch)) {
        n.urgency = n.urgencyRequested;
        // an old Immediate run-out deadline does not carry over to another tier
        if (!('deadline' in ch)) n.deadline = n.nlt;
      }
    }
    if (r.status === 'planned') n.status = 'submitted';      // the draft plan no longer matches
    n.editedAt = nowOf(s, a);
    return ok(Object.assign({}, s, { requests: mapById(s.requests, id, function () { return n; }) }), { id: id });
  };

  H['request/cancel'] = function (s, a) {
    const id = arg(a, ['id', 'requestId']);
    const r = s.requests.find(function (x) { return x.id === id; });
    if (!r) return fail(s, 'Request ' + id + ' was not found.');
    if (EDITABLE.indexOf(r.status) < 0) return fail(s, 'Request ' + id + ' is ' + r.status + ' and can no longer be cancelled.');
    const now = nowOf(s, a);
    return ok(Object.assign({}, s, { requests: mapById(s.requests, id, function (x) { return Object.assign({}, x, { status: 'cancelled', cancelledAt: now }); }) }), { id: id });
  };

  // { requests: [...] } adds sample requests (source 'sample'). By default it first removes
  // earlier samples that are still only 'submitted' ({ replace: false } keeps them). Without
  // requests it calls SRO.core.samples.generate(seed, ctx) (samples.js; pure and seeded) with
  // seed = action seed or settings.sampleSeed and count = action count or 19.
  H['samples/load'] = function (s, a) {
    let list = arg(a, 'requests');
    const replace = arg(a, 'replace') !== false;
    const now = nowOf(s, a);
    if (!Array.isArray(list)) {
      const gen = SRO.core.samples && SRO.core.samples.generate;
      if (typeof gen !== 'function') return fail(s, 'samples/load needs { requests }.');
      const set = s.scenario.settings || {};
      const seed = isFinite(num(arg(a, 'seed'))) ? num(arg(a, 'seed')) : set.sampleSeed;
      const count = num(arg(a, 'count')) > 0 ? num(arg(a, 'count')) : 19;
      try {
        const out = gen(seed, {
          nowMin: now,
          mobility: set.mobility,
          dailyUse: set.dailyUse && Object.keys(set.dailyUse).length ? set.dailyUse : undefined,
          existingIds: ids(s.requests),
          windowId: windowOf(now).id,
          excludeUnitNames: s.profile && s.profile.unitName ? [s.profile.unitName] : [],
          count: count
        });
        list = Array.isArray(out) ? out : (out && out.requests);
      } catch (e) { return fail(s, 'Sample generator failed: ' + e.message); }
      if (!Array.isArray(list)) return fail(s, 'Sample generator returned no requests.');
    }
    const allIds = ids(s.requests);
    const kept = replace ? s.requests.filter(function (r) { return !(r.source === 'sample' && r.status === 'submitted'); }) : s.requests.slice();
    const added = [];
    list.forEach(function (r0) {
      const id = util.nextId('R', allIds);
      allIds.push(id);
      added.push(normalizeRequest(s, Object.assign({}, r0, { source: 'sample' }), id, now, 'sample'));
    });
    let ns = Object.assign({}, s, { requests: kept.concat(added) });
    added.forEach(function (r) { ns = ensureWindow(ns, r.windowId, r.createdAt); });
    return ok(ns, { ids: ids(added) });
  };

  H['window/planNow'] = function (s, a) {
    return ok(assignIn(s, ['ui'], { planRequested: true, planRequestReason: 'manual', planRequestedAt: nowOf(s, a) }));
  };
  // Extra (not in DESIGN list): the planner engine clears the request without storing a plan.
  H['window/planHandled'] = function (s) {
    return ok(assignIn(s, ['ui'], { planRequested: false, planRequestReason: null }));
  };

  // { plan } stores a draft plan (replacing one with the same id). Plans are stored unapproved;
  // approval only happens through plan/approve. Pending requests it delivers become 'planned'.
  H['plan/store'] = function (s, a) {
    const p0 = objArg(a, 'plan');
    if (!p0) return fail(s, 'plan/store needs a plan.');
    const now = nowOf(s, a);
    const p = clone(p0);
    if (!p.id) p.id = util.nextId('P', ids(s.plans));
    if (!isNum(p.createdAt)) p.createdAt = now;
    if (!p.windowId) p.windowId = windowOf(p.createdAt).id;
    if (!p.name) p.name = 'Plan ' + p.id;
    p.approved = false;
    p.routes = p.routes || [];
    p.deferred = p.deferred || [];
    const exists = s.plans.some(function (x) { return x.id === p.id; });
    const plans = exists ? s.plans.map(function (x) { return x.id === p.id ? p : x; }) : s.plans.concat([p]);
    let ns = ensureWindow(Object.assign({}, s, { plans: plans }), p.windowId, p.createdAt);
    ns.windows = ns.windows.map(function (w) {
      if (w.id !== p.windowId) return w;
      const planIds = (w.planIds || []).indexOf(p.id) >= 0 ? w.planIds : (w.planIds || []).concat([p.id]);
      return Object.assign({}, w, { planIds: planIds, status: w.status === 'approved' ? 'approved' : 'planned' });
    });
    const info = planRequestInfo(p);
    let changed = false;
    const reqs = ns.requests.map(function (r) {
      if (info[r.id] && info[r.id].delivered && (r.status === 'submitted' || r.status === 'delayed')) { changed = true; return Object.assign({}, r, { status: 'planned' }); }
      return r;
    });
    if (changed) ns.requests = reqs;
    ns = assignIn(ns, ['ui'], { planRequested: false, planRequestReason: null, lastPlanId: p.id });
    return ok(ns, { id: p.id });
  };

  // { planId } approves a plan: it becomes the window's movement schedule, supersedes the
  // window's (or its parent's) earlier approved plan (not one listed in plan.builtOn, see below),
  // sets request statuses and sends trucks out.
  H['plan/approve'] = function (s, a) {
    const id = arg(a, ['planId', 'id']);
    const plan = s.plans.find(function (p) { return p.id === id; });
    if (!plan) return fail(s, 'Plan ' + id + ' was not found.');
    if (plan.approved) return ok(s, { id: id });
    const now = nowOf(s, a);
    // plan.builtOn (planner engine): approved plans that were live when this plan was made. Their
    // deliveries were left out of it (it covers only requests they left open), so they stay approved,
    // and so do re-plans of them. Without this, a second batch planned in the same window would
    // supersede the first batch's movement schedule.
    const builtOn = Array.isArray(plan.builtOn) ? plan.builtOn : [];
    function onTopOf(p) {
      for (let x = p, n = 0; x && n < 100; n++) {
        if (builtOn.indexOf(x.id) >= 0) return true;
        const pid = x.parentPlanId;
        x = pid ? s.plans.find(function (q) { return q.id === pid; }) : null;
      }
      return false;
    }
    const prev = s.plans.find(function (p) { return p.id !== id && p.approved && (p.id === plan.parentPlanId || (p.windowId === plan.windowId && !onTopOf(p))); }) || null;
    const plans = s.plans.map(function (p) {
      if (p.id === id) return Object.assign({}, p, { approved: true, approvedAt: now, superseded: false, supersededBy: null });
      if (prev && p.id === prev.id) return Object.assign({}, p, { approved: false, superseded: true, supersededBy: id });
      return p;
    });
    const info = planRequestInfo(plan);
    const prevInfo = prev ? planRequestInfo(prev) : null;
    const requests = s.requests.map(function (r) {
      const x = info[r.id];
      if (r.status === 'cancelled' || r.status === 'delivered') return r;
      let st = r.status;
      if (x && x.delivered && x.deferred) st = 'partial';
      else if (x && x.delivered) st = r.status === 'en_route' ? 'en_route' : 'approved';
      else if (x && x.deferred) st = 'delayed';
      else if (r.status === 'planned') st = 'submitted';
      const n = Object.assign({}, r, { status: st });
      if (x && x.delivered) {
        n.eta = isNum(x.firstArrive) ? x.firstArrive : null;
        n.planId = id;
        const px = prevInfo && prevInfo[r.id];
        if (px && px.delivered && (px.firstArrive !== x.firstArrive || px.gridIds.slice().sort().join() !== x.gridIds.slice().sort().join())) n.updated = true;
      }
      if (st === r.status && n.eta === r.eta && n.updated === r.updated && n.planId === r.planId) return r;
      return n;
    });
    const used = {};
    (plan.routes || []).forEach(function (rt) { if ((rt.stops || []).length) used[rt.truckId] = rt; });
    const fleet = s.scenario.fleet.map(function (t) {
      const rt = used[t.id];
      if (!rt || t.status === 'out') return t;
      return Object.assign({}, t, { status: 'en_route', availableAt: isNum(rt.returnAt) ? rt.returnAt : t.availableAt });
    });
    let ns = ensureWindow(Object.assign({}, s, { plans: plans, requests: requests }), plan.windowId, plan.createdAt);
    ns = setIn(ns, ['scenario', 'fleet'], fleet);
    ns.windows = ns.windows.map(function (w) {
      if (w.id !== plan.windowId) return w;
      const planIds = (w.planIds || []).indexOf(id) >= 0 ? w.planIds : (w.planIds || []).concat([id]);
      return Object.assign({}, w, { status: 'approved', approvedPlanId: id, planIds: planIds });
    });
    return ok(ns, { id: id, supersededPlanId: prev ? prev.id : null });
  };

  H['plan/rename'] = function (s, a) {
    const id = arg(a, ['planId', 'id']);
    const name = arg(a, ['name', 'value']);
    if (typeof name !== 'string' || !name.trim()) return fail(s, 'A plan name cannot be empty.');
    const plans = mapById(s.plans, id, function (p) { return Object.assign({}, p, { name: name.trim() }); });
    if (!plans) return fail(s, 'Plan ' + id + ' was not found.');
    return ok(Object.assign({}, s, { plans: plans }), { id: id });
  };

  H['truck/add'] = function (s, a) {
    const t0 = objArg(a, 'truck');
    if (!t0 || !t0.hubId) return fail(s, 'A truck needs a home hub.');
    if (!(s.scenario.hubs || []).some(function (h) { return h.id === t0.hubId; })) return fail(s, 'Hub ' + t0.hubId + ' was not found.');
    const t = newTruck(s, t0, nowOf(s, a));
    return ok(setIn(s, ['scenario', 'fleet'], s.scenario.fleet.concat([t])), { id: t.id });
  };
  H['truck/remove'] = function (s, a) {
    const id = arg(a, ['truckId', 'id']);
    if (!s.scenario.fleet.some(function (t) { return t.id === id; })) return fail(s, 'Truck ' + id + ' was not found.');
    let ns = setIn(s, ['scenario', 'fleet'], s.scenario.fleet.filter(function (t) { return t.id !== id; }));
    if (ns.requests.some(function (r) { return r.locks && r.locks.truckId === id; })) {
      ns = Object.assign({}, ns, { requests: ns.requests.map(function (r) { return r.locks && r.locks.truckId === id ? Object.assign({}, r, { locks: Object.assign({}, r.locks, { truckId: null }) }) : r; }) });
    }
    return ok(ns, { id: id });
  };
  // { truckId, until?, reason? } takes a truck out (blown tire, maintenance).
  H['truck/markOut'] = function (s, a) {
    const id = arg(a, ['truckId', 'id']);
    const until = num(arg(a, 'until'));
    const reason = arg(a, 'reason');
    const fleet = mapById(s.scenario.fleet, id, function (t) {
      const n = Object.assign({}, t, { status: 'out' });
      if (isFinite(until)) n.outUntil = until; else delete n.outUntil;
      if (typeof reason === 'string') n.outReason = reason;
      return n;
    });
    if (!fleet) return fail(s, 'Truck ' + id + ' was not found.');
    return ok(setIn(s, ['scenario', 'fleet'], fleet), { id: id });
  };
  H['truck/markAvailable'] = function (s, a) {
    const id = arg(a, ['truckId', 'id']);
    const now = nowOf(s, a);
    const fleet = mapById(s.scenario.fleet, id, function (t) {
      return without(Object.assign({}, t, { status: 'available', availableAt: now }), ['outUntil', 'outReason']);
    });
    if (!fleet) return fail(s, 'Truck ' + id + ' was not found.');
    return ok(setIn(s, ['scenario', 'fleet'], fleet), { id: id });
  };

  H['zone/add'] = function (s, a) {
    const z0 = objArg(a, 'zone');
    if (!z0) return fail(s, 'zone/add needs a zone.');
    const ratings = s.scenario.settings.riskRatings;
    const z = Object.assign({ kind: 'closed' }, clone(z0));
    if (z.kind === 'closed') z.rating = null;
    const bad = zoneProblem(z, ratings);
    if (bad) return fail(s, bad);
    z.id = z0.id && !s.scenario.zones.some(function (x) { return x.id === z0.id; }) ? z0.id : util.nextId('Z', ids(s.scenario.zones));
    z.lat = num(z.lat); z.lon = num(z.lon); z.radiusMi = num(z.radiusMi);
    if (!z.label) z.label = z.kind === 'closed' ? 'Closed road' : z.rating + ' risk';
    return ok(setIn(s, ['scenario', 'zones'], s.scenario.zones.concat([z])), { id: z.id });
  };
  H['zone/update'] = function (s, a) {
    const id = arg(a, ['id', 'zoneId']);
    const cur = s.scenario.zones.find(function (z) { return z.id === id; });
    if (!cur) return fail(s, 'Zone ' + id + ' was not found.');
    let ch = arg(a, ['changes', 'patch']);
    if (!isObj(ch)) ch = without(objArg(a, 'zone') || {}, ['id', 'zoneId']);
    const z = Object.assign({}, cur, clone(without(ch, ['id'])));
    if (z.kind === 'closed') z.rating = null;
    const bad = zoneProblem(z, s.scenario.settings.riskRatings);
    if (bad) return fail(s, bad);
    z.lat = num(z.lat); z.lon = num(z.lon); z.radiusMi = num(z.radiusMi);
    return ok(setIn(s, ['scenario', 'zones'], mapById(s.scenario.zones, id, function () { return z; })), { id: id });
  };
  H['zone/remove'] = function (s, a) {
    const id = arg(a, ['id', 'zoneId']);
    if (!s.scenario.zones.some(function (z) { return z.id === id; })) return fail(s, 'Zone ' + id + ' was not found.');
    return ok(setIn(s, ['scenario', 'zones'], s.scenario.zones.filter(function (z) { return z.id !== id; })), { id: id });
  };

  // rally/pin and rally/ban: { gridId, value? } (value false removes); pin and ban exclude each other.
  function rallySet(s, a, listKey, otherKey) {
    const g = arg(a, ['gridId', 'id']);
    if (typeof g !== 'string' || !g) return fail(s, 'Pick a grid point first.');
    const on = arg(a, 'value') !== false;
    const r = s.scenario.rally || { pinned: [], banned: [] };
    const list = (r[listKey] || []).filter(function (x) { return x !== g; });
    if (on) list.push(g);
    const other = on ? (r[otherKey] || []).filter(function (x) { return x !== g; }) : (r[otherKey] || []);
    const rally = {}; rally[listKey] = list; rally[otherKey] = other;
    return ok(setIn(s, ['scenario', 'rally'], Object.assign({}, r, rally)));
  }
  H['rally/pin'] = function (s, a) { return rallySet(s, a, 'pinned', 'banned'); };
  H['rally/ban'] = function (s, a) { return rallySet(s, a, 'banned', 'pinned'); };
  H['rally/clear'] = function (s, a) {
    const g = arg(a, ['gridId', 'id']);
    const r = s.scenario.rally || { pinned: [], banned: [] };
    if (typeof g !== 'string') return ok(setIn(s, ['scenario', 'rally'], Object.assign({}, r, { pinned: [], banned: [] })));
    const keep = function (x) { return x !== g; };
    return ok(setIn(s, ['scenario', 'rally'], Object.assign({}, r, { pinned: (r.pinned || []).filter(keep), banned: (r.banned || []).filter(keep) })));
  };

  // { changes } deep-merges into scenario.settings (objects merge, arrays replace);
  // { path: 'weights.fuel', value } sets one field.
  H['settings/update'] = function (s, a) {
    const path = arg(a, 'path');
    if (typeof path === 'string' && path) {
      return ok(setIn(s, ['scenario', 'settings'].concat(path.split('.')), clone(arg(a, 'value'))));
    }
    let ch = arg(a, ['changes', 'settings']);
    if (!isObj(ch)) ch = objArg(a, 'changes');
    if (!isObj(ch)) return fail(s, 'settings/update needs changes.');
    return ok(setIn(s, ['scenario', 'settings'], deepMerge(s.scenario.settings, ch)));
  };
  // { method } resets that method's knobs; no method resets all of them.
  H['settings/resetMethodParams'] = function (s, a) {
    const m = arg(a, ['method', 'value']);
    const cur = s.scenario.settings.methodParams || {};
    const methods = typeof m === 'string' && m ? [m] : Array.from(new Set(METHODS.concat(Object.keys(cur))));
    const mp = Object.assign({}, cur);
    methods.forEach(function (k) { mp[k] = defaultMethodParams(s, k); });
    return ok(setIn(s, ['scenario', 'settings', 'methodParams'], mp));
  };

  // { requestId, truckId?, forceDirect? } (truckId null clears the lock).
  H['request/lock'] = function (s, a) {
    const id = arg(a, ['requestId', 'id']);
    const truckId = arg(a, 'truckId');
    const forceDirect = arg(a, 'forceDirect');
    if (truckId && !s.scenario.fleet.some(function (t) { return t.id === truckId; })) return fail(s, 'Truck ' + truckId + ' was not found.');
    const reqs = mapById(s.requests, id, function (r) {
      const locks = Object.assign({ truckId: null, forceDirect: false }, r.locks);
      if (truckId !== undefined) locks.truckId = truckId || null;
      if (forceDirect !== undefined) locks.forceDirect = !!forceDirect;
      return Object.assign({}, r, { locks: locks });
    });
    if (!reqs) return fail(s, 'Request ' + id + ' was not found.');
    return ok(Object.assign({}, s, { requests: reqs }), { id: id });
  };

  // { name, planId? } (default: the most recent approved plan, else the last stored plan).
  H['snapshot/save'] = function (s, a) {
    let planId = arg(a, 'planId');
    if (!planId) {
      const approved = s.plans.filter(function (p) { return p.approved; });
      planId = approved.length ? approved[approved.length - 1].id : (s.ui.lastPlanId || (s.plans.length ? s.plans[s.plans.length - 1].id : null));
    }
    if (!planId || !s.plans.some(function (p) { return p.id === planId; })) return fail(s, 'There is no plan to save yet.');
    const now = nowOf(s, a);
    let name = arg(a, ['name', 'value']);
    if (typeof name !== 'string' || !name.trim()) name = 'Snapshot ' + (s.snapshots.length + 1);
    const snap = { id: util.nextId('S', ids(s.snapshots)), name: name.trim(), createdAt: now, planId: planId };
    const note = arg(a, 'note');
    if (typeof note === 'string') snap.note = note;
    return ok(Object.assign({}, s, { snapshots: s.snapshots.concat([snap]) }), { id: snap.id });
  };

  // { state } (object) or { json } (string, as written by exportJson).
  H['data/import'] = function (s, a) {
    let incoming = arg(a, ['state', 'json', 'value']);
    try {
      incoming = store.parseImport(incoming);
    } catch (e) { return fail(s, e.message); }
    return ok(hydrate(incoming, store.defaultState()));
  };
  // Fresh demo data; keeps the theme. { keepProfile: true } also keeps the unit profile.
  H['data/reset'] = function (s, a) {
    const fresh = store.defaultState();
    fresh.ui = Object.assign({}, fresh.ui, { theme: s.ui.theme });
    if (arg(a, 'keepProfile') === true) fresh.profile = s.profile;
    return ok(fresh);
  };
  // Extra (not in DESIGN list): runtime road path cache for roads.js. { key: 'A|B', value }.
  H['roadCache/put'] = function (s, a) {
    const key = arg(a, 'key');
    if (typeof key !== 'string' || !key) return fail(s, 'roadCache/put needs a key.');
    const rc = Object.assign({}, s.roadCache || {});
    const v = arg(a, 'value');
    if (v === null || v === undefined) delete rc[key]; else rc[key] = clone(v);
    return ok(Object.assign({}, s, { roadCache: rc }));
  };

  store.ACTIONS = Object.keys(H);

  // Pure reducer with result: (state, action) -> { state, result }.
  store.reduce = function (state, action) {
    if (!action || typeof action.type !== 'string') return fail(state, 'An action needs a type.');
    const h = H[action.type];
    if (!h) return fail(state, 'Unknown action "' + action.type + '".');
    return h(state, action);
  };
  // Pure reducer: (state, action) -> new state.
  store.reducer = function (state, action) { return store.reduce(state, action).state; };

  // ---- import / export ------------------------------------------------------------------------
  store.serialize = function (state) { return JSON.stringify(state, util.jsonReplacer); };
  store.deserialize = function (text) { return JSON.parse(text, util.jsonReviver); };
  store.exportJson = function (state) { return JSON.stringify(state, util.jsonReplacer, 2); };
  // Accepts a JSON string or object (raw state or { state }); checks the version. Throws Error
  // with a plain-language message.
  store.parseImport = function (input) {
    let obj = input;
    if (typeof input === 'string') {
      try { obj = store.deserialize(input); } catch (e) { throw new Error('This file is not valid JSON.'); }
    }
    if (isObj(obj) && isObj(obj.state) && !Array.isArray(obj.requests)) obj = obj.state;   // { state } envelope
    if (!isObj(obj) || !isObj(obj.scenario) || !Array.isArray(obj.requests)) throw new Error('This file is not a Supply Route Optimizer save.');
    if (obj.version !== store.VERSION) {
      throw new Error(obj.version === undefined ? 'This file has no data version; this app reads version ' + store.VERSION + '.'
        : 'This file is from data version ' + obj.version + '; this app reads version ' + store.VERSION + '.');
    }
    return clone(obj);
  };
  store.importJson = function (text) { return hydrate(store.parseImport(text), store.defaultState()); };

  // ---- persistence adapters -------------------------------------------------------------------
  // In-memory adapter (tests, and fallback when storage is unavailable).
  store.MemoryAdapter = function (initial) {
    let text = initial ? store.serialize(initial) : null;
    return {
      kind: 'memory',
      load: function () { try { return text ? store.deserialize(text) : null; } catch (e) { return null; } },
      save: function (state) { text = store.serialize(state); return true; },
      saveText: function (t) { text = t; return true; },
      clear: function () { text = null; },
      exportJson: store.exportJson,
      importJson: store.importJson
    };
  };

  // localStorage adapter (key 'sro.v1'). Every storage access is in try/catch; on any failure
  // (blocked storage, quota, private mode) the state lives in memory and the app keeps working.
  // opts: { key, storage } (storage defaults to the global localStorage).
  store.LocalStorageAdapter = function (opts) {
    const o = opts || {};
    const key = o.key || store.STORAGE_KEY;
    const mem = store.MemoryAdapter();
    function storage() {
      try {
        if (Object.prototype.hasOwnProperty.call(o, 'storage')) return o.storage || null;
        return root.localStorage || null;
      } catch (e) { return null; }
    }
    const adapter = {
      kind: 'localStorage', key: key, usingMemory: false, lastError: null,
      load: function () {
        // after a failed write (quota, blocked storage) the newest state is the in-memory copy;
        // storage may still hold an older one
        if (adapter.usingMemory) { const m = mem.load(); if (m) return m; }
        let text = null;
        try { const st = storage(); text = st ? st.getItem(key) : null; } catch (e) { adapter.lastError = e; text = null; }
        if (text === null || text === undefined) return mem.load();
        try {
          const s = store.deserialize(text);
          if (!isObj(s) || s.version !== store.VERSION) return mem.load();
          return s;
        } catch (e) { adapter.lastError = e; return mem.load(); }
      },
      save: function (state) {
        let text;
        try { text = store.serialize(state); } catch (e) { adapter.lastError = e; return false; }
        mem.saveText(text);
        try {
          const st = storage();
          if (!st) { adapter.usingMemory = true; return false; }
          st.setItem(key, text);
          adapter.usingMemory = false;
          return true;
        } catch (e) { adapter.lastError = e; adapter.usingMemory = true; return false; }
      },
      clear: function () {
        mem.clear();
        try { const st = storage(); if (st) st.removeItem(key); } catch (e) { adapter.lastError = e; }
      },
      exportJson: store.exportJson,
      importJson: store.importJson
    };
    return adapter;
  };

  // ---- store ------------------------------------------------------------------------------------
  // createStore({ adapter, initialState, saveThrottleMs, now })
  //   adapter: persistence adapter; omitted -> LocalStorageAdapter(); null -> no persistence.
  //   initialState: used when the adapter has nothing saved (default store.defaultState()).
  //   Ticks that only move the clock are saved at most every saveThrottleMs (default 2000) of
  //   wall time; every other change is saved at once. now() is the wall clock for that throttle.
  store.createStore = function (opts) {
    const o = opts || {};
    const adapter = o.adapter === undefined ? store.LocalStorageAdapter() : o.adapter;
    const throttle = isNum(o.saveThrottleMs) ? o.saveThrottleMs : 2000;
    const wall = o.now || function () { return Date.now(); };
    const defaults = o.initialState ? hydrate(clone(o.initialState), store.defaultState()) : store.defaultState();
    let loaded = null;
    if (adapter) { try { loaded = adapter.load(); } catch (e) { loaded = null; } }
    let state = loaded ? hydrate(loaded, defaults) : defaults;
    const listeners = [];
    let lastSave = -Infinity, dirty = false;

    function persist() {
      if (!adapter) return;
      try { adapter.save(state); } catch (e) { /* adapter already falls back to memory */ }
      lastSave = wall(); dirty = false;
    }

    function dispatch(action) {
      const prev = state;
      let out;
      try { out = store.reduce(state, action); } catch (e) { out = fail(state, 'Internal error: ' + e.message); }
      state = out.state;
      if (state !== prev) {
        const clockOnly = action && action.type === 'clock/tick' && state.requests === prev.requests &&
          state.scenario === prev.scenario && state.ui === prev.ui;
        if (clockOnly) { dirty = true; if (wall() - lastSave >= throttle) persist(); }
        else persist();
      }
      listeners.slice().forEach(function (fn) {
        try { fn(state, action, out.result); } catch (e) { if (root.console) root.console.error(e); }
      });
      return out.result;
    }

    return {
      getState: function () { return state; },
      dispatch: dispatch,
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
      },
      flush: function () { if (dirty) persist(); },
      exportJson: function () { return (adapter && adapter.exportJson ? adapter.exportJson : store.exportJson)(state); },
      importJson: function (text) { return dispatch({ type: 'data/import', json: text }); },
      adapter: adapter
    };
  };
})(typeof self !== 'undefined' ? self : globalThis);
