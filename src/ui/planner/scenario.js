// Planner Scenario tab (right panel): fleet per hub (add / remove trucks, mark out / back), closed and
// risk zones drawn on the planner map, drop points (max count, pin / ban), the visible settings, the
// Advanced section (travel factors, time-of-day table, risk ratings, mobility radii, daily use rates and
// SOLVER TUNING built from SRO.solver.PARAMS) and the "Re-plan now" banner after a contingency.
// Sources: spec-answers.md Sections 3-5 (Fleet, Road network, Risk, Time of day, Rally points,
// Contingency, Planner settings, Solver tuning); DESIGN.md sections 3, 7 (Method parameters), 8, 8b.
//
// PLANNER MAP PROTOCOL (zone drawing, no edits to the map owner's file)
//   The view that owns the planner map makes its SRO.ui.map instance findable in any one of these ways
//   (checked in this order by findPlannerMap):
//     SRO.ui.emit('planner:map', mapInstance) when created, SRO.ui.emit('planner:map', null) on destroy
//     SRO.ui.plannerMap = mapInstance  (or a function returning it)
//     answer SRO.ui.emit('planner:map:want', { reply: function (mapInstance) {} })
//     keep the instance on its view object (any own property holding an object with enableZoneDrawing)
//   When nothing answers, or the map is hidden and cannot be shown, drawing happens on a map in a dialog.
//   When no view registered the planner 'map' tab by boot, this file registers a basic one (hubs, zones,
//   drop points, platoons, routes and trucks of the current plan) that follows the protocol.
//   Events emitted: 'planner:zone-drawing' { active, kind, rating }; 'planner:focus' { lat, lon,
//   radiusMi } (show a zone); 'planner:params' { method, params } after a solver tuning change.
//
// Engine (DESIGN.md 8b, SRO.core.engine): status(), subscribe(fn), estimate(method, params),
// replan({ reason }), cancel(). Every call is guarded; the tab works without the engine.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const ui = SRO.ui = SRO.ui || {};
  if (typeof ui.registerView !== 'function' || typeof ui.h !== 'function') return;
  const doc = root.document;
  const h = ui.h;
  const icon = ui.icon;

  const SVG_OPEN = '<svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
  const ICONS = {
    ban: SVG_OPEN + '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>',
    zone: SVG_OPEN + '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3 2.6"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg>',
    closed: SVG_OPEN + '<circle cx="12" cy="12" r="8.5"/><path d="M7.5 16.5l9-9M5.6 12.4l6.8-6.8M11.6 18.4l6.8-6.8"/></svg>',
    locate: SVG_OPEN + '<circle cx="12" cy="12" r="6"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>'
  };

  const WEIGHTS = [
    { key: 'fuel', label: 'Fuel', help: 'Gallons the trucks burn (truck miles divided by mpg). Raise it to favor fuel-light routes.' },
    { key: 'distance', label: 'Distance', help: 'Truck miles, plus the miles platoons travel to their pickup point. Raise it to cut total driving.' },
    { key: 'risk', label: 'Risk', help: 'Miles driven inside risk zones, times the zone rating and the time-of-day risk factor. Raise it to steer around risk.' },
    { key: 'simplicity', label: 'Simplicity', help: 'Fewer stops per truck and fewer trucks on the road. Raise it for simpler plans.' }
  ];
  const METHOD_HELP = {
    tabu: 'Balanced. Usually 5-30 s on a full window.',
    sa: 'Thorough. Usually 1-3 min on a full window.',
    aco: 'Ant colony. Builds many trial plans and learns from the best ones.',
    mip: 'Exact model. Starts from a quick heuristic plan, runs up to the time limit and reports how close to the best possible plan it is.'
  };
  const METHOD_SHORT = { tabu: 'Tabu', sa: 'Annealing', aco: 'Ant colony', mip: 'MIP' };
  const OUT_REASONS = [
    { id: 'flat', label: 'Flat tire' },
    { id: 'maint', label: 'Maintenance' },
    { id: 'other', label: 'Other' }
  ];
  const BACK_OPTIONS = [0, 2, 4, 6, 12, 24];      // hours; 0 = not known
  const MAX_PER_TYPE = 6;
  const RATINGS = ['Low', 'Medium', 'High'];
  const SUBTABS = [
    { id: 'fleet', label: 'Fleet', icon: 'truck' },
    { id: 'zones', label: 'Zones', icon: ICONS.zone },
    { id: 'rally', label: 'Drop points', icon: 'pin' },
    { id: 'settings', label: 'Settings', icon: 'sliders' }
  ];
  // settings changes that do not call for a re-plan of an approved plan
  const NON_CONTINGENCY_SETTINGS = ['method', 'methodParams', 'timeLimitSec', 'sampleSeed', 'maxStops'];

  // ==== small helpers ==============================================================================
  function F() { return SRO.core.format; }
  function engine() { return (SRO.core && SRO.core.engine) || null; }
  function solver() { return SRO.solver || {}; }
  function appStore() { return SRO.app && SRO.app.store; }
  function getState() { const s = appStore(); return s ? s.getState() : null; }
  function dispatch(a) { const s = appStore(); return s ? s.dispatch(a) : { ok: false, error: 'The app is not started yet.' }; }
  function act(a, okMsg) {
    const r = dispatch(a);
    if (!r || !r.ok) { ui.toast((r && r.error) || 'That change did not go through.', 'error'); return null; }
    if (okMsg) ui.toast(okMsg, 'success');
    return r;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }
  function num(x) { return typeof x === 'number' ? x : (typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function dtg(m) { return F().dtg(m); }
  function hhmm(m) { return m === 1440 ? '2400' : F().time24(m); }
  function mgrs(lat, lon) { return F().mgrs(lat, lon) || F().NA; }
  function grid() { return (SRO.data && SRO.data.grid) || []; }
  function gridById(id) { return grid().find(function (g) { return g.id === id; }) || null; }
  function shortName(name) { return String(name || '').replace(/\s*\(.*\)\s*$/, ''); }
  function same(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function eqVal(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    return a === b;
  }
  function showVal(v) {
    if (v === true) return 'on';
    if (v === false) return 'off';
    if (typeof v === 'number') return String(Number(v.toPrecision(12)));
    return String(v);
  }
  function afterFrames(n, fn) {
    const step = function () { if (--n <= 0) fn(); else (root.requestAnimationFrame || setTimeout)(step); };
    (root.requestAnimationFrame || setTimeout)(step);
  }
  function cssEsc(s) { return root.CSS && root.CSS.escape ? root.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
  function scenarioDefaults() {
    const sc = SRO.data && SRO.data.scenario;
    try { return sc && sc.defaultSettings ? sc.defaultSettings() : {}; } catch (e) { return {}; }
  }
  function truckTypeInfo(type) {
    const T = (SRO.data && SRO.data.scenario && SRO.data.scenario.truckTypes) || {};
    return T[type] || { label: type === 'tanker' ? 'Fuel tanker' : 'Cargo truck', capacity: type === 'tanker' ? 2500 : 10 };
  }
  function capacityText(t) {
    return t.type === 'tanker' ? F().gallons(t.capacity) : F().qty(t.capacity, t.capacity === 1 ? 'pallet' : 'pallets');
  }
  function truckNo(id) { const m = /-(\d+)$/.exec(String(id)); return m ? parseInt(m[1], 10) : 0; }
  function hubOf(st, hubId) { return (st.scenario.hubs || []).find(function (x) { return x.id === hubId; }) || null; }
  function nearestPlaceName(lat, lon) {
    const G = SRO.core.geo;
    const g = G && G.nearestGrid ? G.nearestGrid({ lat: lat, lon: lon }, grid()) : null;
    return g ? shortName(g.name) : null;
  }

  // Swap a container's content, keeping keyboard focus on the element with the same data-fk.
  function swap(el, content) {
    const active = doc.activeElement;
    const fk = active && el.contains(active) ? active.getAttribute('data-fk') : null;
    let sel = null;
    if (fk) { try { if (typeof active.selectionStart === 'number') sel = [active.selectionStart, active.selectionEnd]; } catch (e) { sel = null; } }
    ui.clear(el);
    [].concat(content).forEach(function (n) { if (n) el.appendChild(n); });
    if (fk) {
      const n = el.querySelector('[data-fk="' + cssEsc(fk) + '"]');
      if (n) { try { n.focus({ preventScroll: true }); if (sel && n.setSelectionRange) n.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not selectable */ } }
    }
  }

  // A part of the view rebuilt only when its dependencies (compared by identity) change.
  function block(cls, deps, build) {
    const el = h('div.' + cls);
    let last = null;
    return {
      el: el,
      render: function (st, force) {
        const d = deps(st);
        if (!force && last && same(d, last)) return false;
        last = d;
        swap(el, build(st));
        return true;
      },
      reset: function () { last = null; }
    };
  }

  function changedMark(isChanged, dflt) {
    if (!isChanged) return null;
    return h('span.sc-changed', { title: 'Changed from the default' }, h('span.sc-dot', { 'aria-hidden': 'true' }), 'default: ' + dflt);
  }

  // Number field: commits on change when valid; invalid input shows an inline error and is not saved.
  function numField(o) {
    const id = 'sc-f-' + o.fk;
    const err = h('div.field-error', { hidden: true });
    const input = h('input.input.num', {
      id: id, type: 'number', inputmode: 'decimal', 'data-fk': o.fk,
      min: o.min, max: o.max, step: o.step || 'any', value: showVal(o.value),
      'aria-describedby': o.help ? id + '-help' : null,
      onChange: function () {
        const v = num(input.value);
        const bad = !isFinite(v) || (isNum(o.min) && v < o.min) || (isNum(o.max) && v > o.max) || (o.int && Math.round(v) !== v);
        if (bad) {
          err.hidden = false;
          err.textContent = o.label + ' must be ' + (o.int ? 'a whole number ' : 'a number ') + 'from ' + showVal(o.min) + ' to ' + showVal(o.max) + (o.unit ? ' ' + o.unit : '') + '.';
          field.classList.add('is-invalid');
          input.setAttribute('aria-invalid', 'true');
          return;
        }
        err.hidden = true;
        field.classList.remove('is-invalid');
        input.removeAttribute('aria-invalid');
        if (!eqVal(v, o.value)) o.onCommit(v);
      }
    });
    const changed = o.def !== undefined && !eqVal(o.value, o.def);
    const field = h('div.field.sc-num', { 'data-field': o.fk },
      h('label.field-label', { htmlFor: id }, o.label, o.unit ? h('span.field-opt', ' (' + o.unit + ')') : null),
      h('div.hstack.sc-num-row', input, changedMark(changed, showVal(o.def))),
      err,
      o.help ? h('div.field-help', { id: id + '-help' }, o.help) : null);
    return field;
  }

  // Count stepper (trucks per type, max rally points). onSet(n) gets the wanted count.
  function counter(o) {
    const id = 'sc-c-' + o.fk;
    const input = h('input', {
      id: id, type: 'number', inputmode: 'numeric', min: o.min, max: o.max, step: 1, value: String(o.value), 'data-fk': o.fk,
      'aria-label': o.ariaLabel || o.label,
      onChange: function () {
        const v = Math.round(num(input.value));
        if (!isFinite(v)) { input.value = String(o.value); return; }
        const c = Math.max(o.min, Math.min(o.max, v));
        input.value = String(c);
        if (c !== o.value) o.onSet(c);
      }
    });
    const minus = h('button', { type: 'button', 'aria-label': 'Fewer: ' + (o.ariaLabel || o.label), 'data-fk': o.fk + '-minus', disabled: o.value <= o.min, onClick: function () { o.onSet(o.value - 1); } }, '\u2212');
    const plus = h('button', { type: 'button', 'aria-label': 'More: ' + (o.ariaLabel || o.label), 'data-fk': o.fk + '-plus', disabled: o.value >= o.max, onClick: function () { o.onSet(o.value + 1); } }, '+');
    return h('div.sc-counter', { 'data-counter': o.fk },
      o.label ? h('label.sc-counter-label', { htmlFor: id }, o.label) : null,
      h('div.stepper.sc-stepper', minus, input, plus));
  }

  // ==== plans and contingency ======================================================================
  function approvedPlans(st) {
    return (st.plans || []).filter(function (p) { return p.approved && !p.superseded && !p.cancelled; });
  }
  function routeHasStops(r) { return r && (r.stops || []).length > 0; }
  // The newest approved plan with a truck still out (or not yet left): the one a contingency changes.
  function activePlan(st) {
    const now = st.clock.simMin;
    const list = approvedPlans(st).filter(function (p) {
      return (p.routes || []).some(function (r) { return routeHasStops(r) && (!isNum(r.returnAt) || r.returnAt > now); });
    });
    list.sort(function (a, b) { return (b.approvedAt || b.createdAt || 0) - (a.approvedAt || a.createdAt || 0); });
    return list[0] || null;
  }
  function routeOf(plan, truckId) {
    return plan ? (plan.routes || []).find(function (r) { return r.truckId === truckId && routeHasStops(r); }) || null : null;
  }
  function legCoords(leg, route) {
    const G = SRO.core.geo;
    if (leg && typeof leg.path === 'string' && leg.path && G && G.decodePolyline) { try { return G.decodePolyline(leg.path); } catch (e) { /* fall through */ } }
    if (leg && Array.isArray(leg.path) && leg.path.length) return leg.path;
    if (leg && Array.isArray(leg.coords) && leg.coords.length) return leg.coords;
    const pts = [];
    (route.stops || []).forEach(function (s) { if (isNum(s.lat) && isNum(s.lon)) pts.push([s.lat, s.lon]); });
    return pts;
  }
  function zoneCrossesPlan(zone, plan, now) {
    const G = SRO.core.geo;
    if (!G || !G.polylineIntersectsCircle) return false;
    const circle = { lat: num(zone.lat), lon: num(zone.lon), radiusMi: num(zone.radiusMi) };
    return (plan.routes || []).some(function (r) {
      if (!routeHasStops(r)) return false;
      const legs = r.legs && r.legs.length ? r.legs : [{}];
      return legs.some(function (l) {
        // only legs not started yet: a re-plan keeps an en-route truck's current leg (it starts the
        // truck at the stop it is driving to), so a closure on a leg already driven or under way is
        // something a re-plan cannot change, and flagging it would ask for re-plans forever
        if ((isNum(l.depart) && l.depart <= now) || (isNum(l.arrive) && l.arrive <= now)) return false;
        const c = legCoords(l, r);
        return c.length > 1 && G.polylineIntersectsCircle(c, circle);
      });
    });
  }

  // Session log of contingency changes made after the active plan was approved (lost on reload; the
  // banner also derives the lasting ones, trucks out and zones crossing routes, from the state).
  const changeLog = { items: [], version: 0, replanned: null };
  function logChange(planId, key, text) {
    changeLog.items = changeLog.items.filter(function (x) { return !(x.planId === planId && x.key === key); });
    changeLog.items.push({ planId: planId, key: key, text: text });
    changeLog.version++;
  }
  function describeAction(prev, st, a) {
    const p = a.payload && typeof a.payload === 'object' ? a.payload : {};
    const pick = function (k) { return p[k] !== undefined ? p[k] : a[k]; };
    const tid = pick('truckId') || pick('id');
    switch (a.type) {
      case 'truck/markOut': return { key: 'truck:' + tid, text: tid + ' marked out' + (pick('reason') ? ' (' + String(pick('reason')).toLowerCase() + ')' : '') };
      case 'truck/markAvailable': return { key: 'truck:' + tid, text: tid + ' back in service' };
      case 'truck/remove': return { key: 'truck:' + tid, text: tid + ' removed from the fleet' };
      case 'truck/add': {
        const added = st.scenario.fleet[st.scenario.fleet.length - 1];
        return added ? { key: 'truck:' + added.id, text: added.id + ' added (' + truckTypeInfo(added.type).label.toLowerCase() + ')' } : null;
      }
      case 'zone/add': {
        const z = st.scenario.zones[st.scenario.zones.length - 1];
        return z ? { key: 'zone:' + z.id, text: (z.kind === 'closed' ? 'Closed zone' : z.rating + ' risk zone') + ' added: ' + (z.label || z.id) } : null;
      }
      case 'zone/update': return { key: 'zone:' + (pick('id') || pick('zoneId')), text: 'Zone ' + ((st.scenario.zones.find(function (z) { return z.id === (pick('id') || pick('zoneId')); }) || {}).label || '') + ' changed' };
      case 'zone/remove': {
        const z = (prev.scenario.zones || []).find(function (x) { return x.id === (pick('id') || pick('zoneId')); });
        return { key: 'zone:' + (pick('id') || pick('zoneId')), text: 'Zone removed' + (z && z.label ? ': ' + z.label : '') };
      }
      case 'rally/pin': case 'rally/ban': case 'rally/clear': {
        const g = gridById(pick('gridId') || pick('id'));
        const what = a.type === 'rally/clear' ? 'pin / ban cleared' : (a.type === 'rally/pin' ? 'pinned' : 'banned');
        return { key: 'rally:' + (g ? g.id : 'all'), text: (g ? 'Drop point ' + shortName(g.name) : 'All drop points') + ' ' + (pick('value') === false ? 'released' : what) };
      }
      case 'request/lock': return { key: 'lock:' + (pick('requestId') || pick('id')), text: 'Request ' + (pick('requestId') || pick('id')) + ' locked or forced direct' };
      case 'settings/update': {
        const a0 = prev.scenario.settings, b0 = st.scenario.settings;
        const keys = Object.keys(b0).filter(function (k) { return a0[k] !== b0[k] && NON_CONTINGENCY_SETTINGS.indexOf(k) < 0; });
        if (!keys.length) return null;
        const names = { weights: 'cost weights', maxRallyPoints: 'max drop points', periods: 'time-of-day table', riskRatings: 'risk ratings', mobility: 'mobility radii', dailyUse: 'daily use rates', convoyFactor: 'convoy speed factor', mpg: 'fuel burn', serviceMin: 'stop service time', loadMin: 'hub load time' };
        return { key: 'settings:' + keys.join(','), text: 'Changed ' + keys.map(function (k) { return names[k] || k; }).join(', ') };
      }
      default: return null;
    }
  }
  function watchStore(app) {
    if (!app || !app.store || watchStore.done) return;
    watchStore.done = true;
    let prev = app.store.getState();
    app.store.subscribe(function (st, a, result) {
      const before = prev;
      prev = st;
      if (!a || !result || result.ok === false || st === before) return;
      if (a.type === 'plan/approve' || a.type === 'data/import' || a.type === 'data/reset') {
        changeLog.items = []; changeLog.replanned = null; changeLog.version++;
        return;
      }
      const plan = activePlan(before);
      if (!plan) return;
      if (a.type === 'plan/store') {
        const stored = st.plans.find(function (p) { return p.id === result.id; });
        if (stored && stored.parentPlanId) { changeLog.replanned = { planId: stored.id, parentId: stored.parentPlanId, at: changeLog.version }; changeLog.version++; }
        return;
      }
      const d = describeAction(before, st, a);
      if (d) logChange(plan.id, d.key, d.text);
    });
  }
  ui.onBoot(watchStore);

  // Everything that changed since the active plan was approved: [{ key, text }].
  function contingencyReasons(st, plan) {
    if (!plan) return [];
    const now = st.clock.simMin;
    const out = [];
    const seen = {};
    function add(key, text) { if (seen[key]) return; seen[key] = true; out.push({ key: key, text: text }); }
    (plan.routes || []).forEach(function (r) {
      if (!routeHasStops(r) || (isNum(r.returnAt) && r.returnAt <= now)) return;
      const t = (st.scenario.fleet || []).find(function (x) { return x.id === r.truckId; });
      const left = (r.stops || []).filter(function (s) { return !isNum(s.arrive) || s.arrive > now; }).length;
      if (!t) add('truck:' + r.truckId, r.truckId + ' was removed but has ' + left + ' stop' + (left === 1 ? '' : 's') + ' left on the plan');
      else if (t.status === 'out') add('truck:' + r.truckId, r.truckId + ' is out' + (t.outReason ? ' (' + String(t.outReason).toLowerCase() + ')' : '') + ' with ' + left + ' stop' + (left === 1 ? '' : 's') + ' left on the plan');
    });
    // a closed zone the plan's remaining legs drive through (the plan routed around every closed zone
    // that existed when it was made); risk zones the plan accepted are not flagged, new ones come from
    // the session log
    (st.scenario.zones || []).forEach(function (z) {
      if (z.kind === 'closed' && zoneCrossesPlan(z, plan, now)) add('zone:' + z.id, 'Closed zone ' + (z.label || z.id) + ' blocks a route still to be driven');
    });
    changeLog.items.forEach(function (x) { if (x.planId === plan.id) add(x.key, x.text); });
    return out;
  }

  // ==== planner map discovery =======================================================================
  let announcedMap = null;
  ui.on('planner:map', function (m) { announcedMap = m || null; });
  function liveMap(m) {
    return !!(m && typeof m.enableZoneDrawing === 'function' && m.el && m.el.isConnected !== false && m.el.classList && m.el.classList.contains('sro-map'));
  }
  function scanForMap(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 2) return null;
    if (liveMap(obj)) return obj;
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      let v;
      try { v = obj[keys[i]]; } catch (e) { continue; }
      if (v && typeof v === 'object' && !v.nodeType && v !== obj) {
        if (liveMap(v)) return v;
        if (depth < 2 && !Array.isArray(v)) { const w = scanForMap(v, depth + 1); if (w) return w; }
      }
    }
    return null;
  }
  function findPlannerMap() {
    if (liveMap(announcedMap)) return announcedMap;
    let m = ui.plannerMap;
    if (typeof m === 'function') { try { m = m(); } catch (e) { m = null; } }
    if (liveMap(m)) return m;
    let got = null;
    ui.emit('planner:map:want', { reply: function (x) { if (!got && liveMap(x)) got = x; } });
    if (got) return got;
    const e = ui.plannerTabs && ui.plannerTabs.get ? ui.plannerTabs.get('map') : null;
    return scanForMap(e && e.view, 0) || scanForMap(ui.views && ui.views.map, 0);
  }
  function mapVisible(m) { return !!(m && m.el && m.el.offsetWidth > 0 && m.el.offsetHeight > 0); }
  function mapTabRegistered() { return !!(ui.plannerTabs && ui.plannerTabs.has && ui.plannerTabs.has('map')); }

  // ==== zone drawing ===============================================================================
  let drawing = null;            // { kind, rating, cancel(), switched, where: 'map' | 'dialog' }
  let riskRating = 'Medium';

  function zoneLabelFor(z) {
    const near = nearestPlaceName(z.lat, z.lon);
    return (z.kind === 'closed' ? 'Closed road' : z.rating + ' risk') + (near ? ' near ' + near : '');
  }
  function addDrawnZone(z) {
    const r = act({ type: 'zone/add', zone: { kind: z.kind, rating: z.kind === 'risk' ? z.rating : null, lat: z.lat, lon: z.lon, radiusMi: z.radiusMi, label: zoneLabelFor(z) } });
    if (r) ui.toast((z.kind === 'closed' ? 'Closed zone' : z.rating + ' risk zone') + ' added, ' + F().miles(z.radiusMi) + ' radius.', 'success');
  }
  function endDrawing(returnToScenario) {
    const d = drawing;
    drawing = null;
    ui.emit('planner:zone-drawing', { active: false, kind: d && d.kind, rating: d && d.rating });
    if (d && d.switched && returnToScenario !== false && ui.plannerTabs) ui.plannerTabs.show('scenario');
    rerender();
  }
  function startDrawing(kind, rating) {
    if (drawing) drawing.cancel();
    if (!SRO.ui.map || typeof SRO.ui.map.create !== 'function') { ui.toast('The map is not available, so zones cannot be drawn.', 'error'); return; }
    let m = findPlannerMap();
    const switched = !mapVisible(m) && mapTabRegistered() && !ui.isWide();
    if (switched) ui.plannerTabs.show('map');
    afterFrames(switched ? 3 : 1, function () {
      m = findPlannerMap();
      if (!mapVisible(m)) {
        if (switched) ui.plannerTabs.show('scenario');
        drawInDialog(kind, rating);
        return;
      }
      const session = m.enableZoneDrawing({
        kind: kind, rating: rating,
        onDone: function (z) { addDrawnZone(z); endDrawing(true); },
        onCancel: function () { endDrawing(true); }
      });
      drawing = { kind: kind, rating: rating, switched: switched, where: 'map', cancel: function () { if (session && session.cancel) session.cancel(); } };
      ui.emit('planner:zone-drawing', { active: true, kind: kind, rating: rating });
      rerender();
    });
  }
  function drawInDialog(kind, rating) {
    let mapApi = null, done = false;
    const st0 = getState();
    const handle = ui.modal.open({
      title: kind === 'closed' ? 'Draw a closed zone' : 'Draw a ' + rating.toLowerCase() + ' risk zone',
      size: 'xl',
      body: function (el) {
        const box = h('div.sc-draw-map');
        el.appendChild(h('p.modal-text', 'Tap the center of the zone, then drag or tap its edge.'));
        el.appendChild(box);
        afterFrames(1, function () {
          if (handle.closed) return;
          try {
            mapApi = SRO.ui.map.create(box, { theme: st0.ui.theme });
            mapApi.setHubs(st0.scenario.hubs || []);
            mapApi.setZones(st0.scenario.zones || []);
            mapApi.setRally(rallyMapPoints(st0, null));
            const sess = mapApi.enableZoneDrawing({
              kind: kind, rating: rating,
              onDone: function (z) { done = true; addDrawnZone(z); handle.close(); },
              onCancel: function () { if (!done) handle.close(); }
            });
            drawing = { kind: kind, rating: rating, switched: false, where: 'dialog', cancel: function () { if (sess && sess.cancel) sess.cancel(); } };
            rerender();
          } catch (e) {
            el.appendChild(h('div.notice.notice-error', icon('alert'), 'The map could not start: ' + e.message));
          }
        });
      },
      actions: [{ label: 'Cancel', kind: 'secondary' }],
      onClose: function () {
        if (mapApi) { try { mapApi.destroy(); } catch (e) { /* already gone */ } }
        mapApi = null;
        if (drawing && drawing.where === 'dialog') { drawing = null; rerender(); }
      }
    });
  }
  function focusZone(z) {
    const m = findPlannerMap();
    ui.emit('planner:focus', { lat: z.lat, lon: z.lon, radiusMi: z.radiusMi, zoneId: z.id });
    if (!m || !SRO.core.geo) return;
    if (!mapVisible(m) && mapTabRegistered() && !ui.isWide()) ui.plannerTabs.show('map');
    afterFrames(2, function () {
      const G = SRO.core.geo;
      const pts = [0, 90, 180, 270].map(function (b) { return G.destination({ lat: z.lat, lon: z.lon }, b, z.radiusMi); });
      try { m.fitTo(pts); } catch (e) { /* map gone */ }
    });
  }

  // ==== drop points ===============================================================================
  function rallyCandidates() { return grid().filter(function (g) { return g.rallyCandidate; }); }
  function usedRally(st) {
    const p = activePlan(st) || (st.ui.lastPlanId ? st.plans.find(function (x) { return x.id === st.ui.lastPlanId; }) : null);
    return (p && p.rallyPoints) || [];
  }
  function rallyMapPoints(st, used) {
    const r = st.scenario.rally || {};
    const u = used || usedRally(st);
    return rallyCandidates().map(function (g) {
      return { id: g.id, gridId: g.id, lat: g.lat, lon: g.lon, name: g.name, pinned: (r.pinned || []).indexOf(g.id) >= 0, banned: (r.banned || []).indexOf(g.id) >= 0, used: u.indexOf(g.id) >= 0 };
    });
  }
  function rallyState(st, id) {
    const r = st.scenario.rally || {};
    return (r.pinned || []).indexOf(id) >= 0 ? 'pinned' : (r.banned || []).indexOf(id) >= 0 ? 'banned' : 'open';
  }
  function setRally(id, what) {
    const g = gridById(id);
    const name = g ? shortName(g.name) : id;
    if (what === 'pin') act({ type: 'rally/pin', gridId: id }, name + ' pinned: the optimizer will use it.');
    else if (what === 'ban') act({ type: 'rally/ban', gridId: id }, name + ' banned: the optimizer will not use it.');
    else act({ type: 'rally/clear', gridId: id }, name + ': the optimizer decides again.');
  }
  // Pin / Ban / Clear dialog for one point (used by map clicks).
  function rallyDialog(id) {
    const st = getState();
    const g = gridById(id);
    if (!st || !g) return;
    const s = rallyState(st, id);
    ui.modal.open({
      title: shortName(g.name),
      size: 'sm',
      body: function (el) {
        el.appendChild(h('dl.kv', h('dt', 'MGRS'), h('dd.num', mgrs(g.lat, g.lon)), h('dt', 'Region'), h('dd', cap(g.region)),
          h('dt', 'Now'), h('dd', s === 'pinned' ? 'Pinned: always used' : s === 'banned' ? 'Banned: never used' : 'The optimizer decides')));
      },
      actions: [
        s !== 'open' ? { label: 'Clear', kind: 'secondary', id: 'rally-clear', onClick: function () { setRally(id, 'clear'); } } : null,
        s !== 'banned' ? { label: 'Ban', kind: 'secondary', id: 'rally-ban', icon: ICONS.ban, onClick: function () { setRally(id, 'ban'); } } : null,
        s !== 'pinned' ? { label: 'Pin', kind: 'primary', id: 'rally-pin', icon: 'pin', onClick: function () { setRally(id, 'pin'); } } : null
      ]
    });
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  // ==== fleet actions ===============================================================================
  function trucksAt(st, hubId, type) {
    return (st.scenario.fleet || []).filter(function (t) { return t.hubId === hubId && t.type === type; });
  }
  function addTruck(hubId, type) {
    const st = getState();
    if (trucksAt(st, hubId, type).length >= MAX_PER_TYPE) { ui.toast('Up to ' + MAX_PER_TYPE + ' trucks of one type per hub in this prototype.', 'warn'); return false; }
    const r = act({ type: 'truck/add', truck: { hubId: hubId, type: type } });
    return !!r;
  }
  function pickRemovable(st, hubId, type) {
    const plan = activePlan(st);
    const score = function (t) {
      if (t.status === 'en_route') return 0;
      if (routeOf(plan, t.id)) return 1;
      if (t.status === 'out') return 2;
      return 3;
    };
    const list = trucksAt(st, hubId, type).slice().sort(function (a, b) { return score(b) - score(a) || truckNo(b.id) - truckNo(a.id); });
    return list[0] || null;
  }
  function removeTruck(t, ask) {
    const st = getState();
    const plan = activePlan(st);
    const busy = t.status === 'en_route' || !!routeOf(plan, t.id);
    const run = function () {
      const r = act({ type: 'truck/remove', truckId: t.id });
      if (r) ui.toast(t.id + ' removed from the fleet.' + (busy ? ' Press Re-plan now to reassign its stops.' : ''), busy ? 'warn' : 'success');
      return !!r;
    };
    if (!busy && !ask) return Promise.resolve(run());
    return ui.confirm({
      title: 'Remove ' + t.id + '?',
      text: busy ? t.id + ' is on the road or on the approved plan. Removing it sends its remaining stops back to the pool; press Re-plan now afterwards.' : t.id + ' (' + truckTypeInfo(t.type).label.toLowerCase() + ') leaves the fleet of ' + ((hubOf(st, t.hubId) || {}).name || t.hubId) + '.',
      okLabel: 'Remove', danger: true
    }).then(function (yes) { return yes ? run() : false; });
  }
  // Add or remove trucks of one type at one hub until there are n.
  function setTruckCount(hubId, type, n) {
    let st = getState();
    let have = trucksAt(st, hubId, type).length;
    n = Math.max(0, Math.min(MAX_PER_TYPE, n));
    if (n > have) { while (have < n) { if (!addTruck(hubId, type)) break; have++; } return; }
    if (n < have) {
      const t = pickRemovable(st, hubId, type);
      if (!t) return;
      removeTruck(t, false).then(function (okd) {
        st = getState();
        if (okd && trucksAt(st, hubId, type).length > n) setTruckCount(hubId, type, n);
      });
    }
  }
  function markOutDialog(t) {
    const st = getState();
    const plan = activePlan(st);
    const busy = t.status === 'en_route' || !!routeOf(plan, t.id);
    let reason = 'flat', back = 0;
    let other = null, backHelp = null;
    ui.modal.open({
      title: 'Mark ' + t.id + ' out of service',
      size: 'sm',
      initialFocus: '[data-reason="flat"]',
      body: function (el) {
        const chips = h('div.chip-group', { role: 'radiogroup', 'aria-label': 'Reason' }, OUT_REASONS.map(function (r) {
          return h('button.chip', {
            type: 'button', role: 'radio', 'data-reason': r.id, 'aria-pressed': String(r.id === reason), 'aria-checked': String(r.id === reason),
            onClick: function (ev) {
              reason = r.id;
              chips.querySelectorAll('.chip').forEach(function (c) { const on = c.getAttribute('data-reason') === reason; c.setAttribute('aria-pressed', String(on)); c.setAttribute('aria-checked', String(on)); });
              other.hidden = reason !== 'other';
              if (reason === 'other') other.querySelector('input').focus();
              ev.preventDefault();
            }
          }, r.label);
        }));
        other = h('div.field', { hidden: true },
          h('label.field-label', { htmlFor: 'sc-out-other' }, 'What happened ', h('span.field-opt', '(optional)')),
          h('input.input#sc-out-other', { type: 'text', maxlength: 80, placeholder: 'e.g. engine warning light' }));
        const sel = h('select.select#sc-out-back', {
          onChange: function () { back = num(sel.value); backHelp.textContent = back ? 'Back in service ' + dtg(st.clock.simMin + back * 60) + '.' : 'Stays out until you mark it available.'; }
        }, BACK_OPTIONS.map(function (b) { return h('option', { value: String(b) }, b ? 'In ' + b + ' hours' : 'Not known'); }));
        backHelp = h('div.field-help', 'Stays out until you mark it available.');
        el.appendChild(h('div.field', h('div.field-label', 'Reason'), chips));
        el.appendChild(other);
        el.appendChild(h('div.field', h('label.field-label', { htmlFor: 'sc-out-back' }, 'Expected back'), sel, backHelp));
        if (busy) el.appendChild(h('div.notice.notice-warn', icon('alert'), h('div', t.id + ' is on the approved plan. Its remaining stops go back to the pool; press ', h('strong', 'Re-plan now'), ' to reassign them.')));
      },
      actions: [
        { label: 'Cancel', kind: 'secondary' },
        {
          label: 'Mark out', kind: 'danger', id: 'mark-out',
          onClick: function (hd) {
            const base = OUT_REASONS.find(function (r) { return r.id === reason; }).label;
            const extra = reason === 'other' ? (hd.el.querySelector('#sc-out-other').value || '').trim() : '';
            const a = { type: 'truck/markOut', truckId: t.id, reason: extra ? base + ': ' + extra : base };
            if (back) a.until = st.clock.simMin + back * 60;
            const r = act(a);
            if (!r) return false;
            ui.toast(t.id + ' marked out (' + a.reason.toLowerCase() + ').' + (busy ? ' Press Re-plan now to reassign its stops.' : ''), busy ? 'warn' : 'success');
            return undefined;
          }
        }
      ]
    });
  }

  // ==== settings actions ============================================================================
  function updateSettings(changes) { return act({ type: 'settings/update', changes: changes }); }
  function setTimeLimit(v) {
    const st = getState();
    const s = st.scenario.settings;
    const old = s.timeLimitSec;
    const mp = {};
    // knobs that still follow the time limit (stored value equal to the old limit) keep following it
    Object.keys(s.methodParams || {}).forEach(function (m) {
      const p = s.methodParams[m];
      if (!p || typeof p !== 'object') return;
      const ch = {};
      ['timeCapSec', 'timeLimitSec'].forEach(function (k) { if (p[k] === old) ch[k] = v; });
      if (Object.keys(ch).length) mp[m] = ch;
    });
    const changes = { timeLimitSec: v };
    if (Object.keys(mp).length) changes.methodParams = mp;
    updateSettings(changes);
  }
  function commitKnob(method, key, raw) {
    const S = solver();
    const st = getState();
    const settings = st.scenario.settings;
    const stored = Object.assign({}, ((settings.methodParams || {})[method]) || {});
    stored[key] = raw;
    const clamped = S.clampParams(method, stored, settings);
    const out = {};
    Object.keys(stored).forEach(function (k) { if (Object.prototype.hasOwnProperty.call(clamped, k)) out[k] = clamped[k]; });
    const spec = S.paramSpec ? S.paramSpec(method, key) : null;
    if (spec && spec.type !== 'bool' && isNum(num(raw)) && !eqVal(clamped[key], num(raw))) {
      ui.toast(spec.label + ' kept within ' + showVal(spec.min) + '-' + showVal(spec.max) + ': set to ' + showVal(clamped[key]) + '.', 'warn');
    }
    const mp = {}; mp[method] = out;
    const r = updateSettings({ methodParams: mp });
    if (r) { ui.emit('planner:params', { method: method, params: clamped }); scheduleEstimate(); }
  }
  function resetMethod(method) {
    const r = act({ type: 'settings/resetMethodParams', method: method }, (solver().METHOD_LABELS || {})[method] + ' settings back to defaults.');
    if (r) { ui.emit('planner:params', { method: method, params: solver().defaultParams(method, getState().scenario.settings) }); scheduleEstimate(); }
  }

  // ---- time-of-day validation -------------------------------------------------------------------
  // rows: [{ name, start, end, speed, risk }] -> { ok, errors: [text], segments: [{ i, s, e }] }
  function validatePeriods(rows) {
    const C = SRO.core.clock;
    const errors = [];
    const cover = [];
    for (let m = 0; m < 1440; m++) cover.push([]);
    const segments = [];
    rows.forEach(function (p, i) {
      const name = p.name || 'Row ' + (i + 1);
      const s = C.parseHHMM(p.start), e = C.parseHHMM(p.end);
      if (!isFinite(s)) errors.push(name + ': start must be a 24-hour time such as 0700.');
      if (!isFinite(e)) errors.push(name + ': end must be a 24-hour time such as 1800.');
      const sp = num(p.speed), rk = num(p.risk);
      if (!(sp >= 0.1 && sp <= 2)) errors.push(name + ': speed factor must be from 0.1 to 2.');
      if (!(rk >= 0 && rk <= 5)) errors.push(name + ': risk factor must be from 0 to 5.');
      if (!isFinite(s) || !isFinite(e)) return;
      const ss = s % 1440, ee = e % 1440;
      if (ss === ee) { errors.push(name + ': start and end are the same time.'); return; }
      for (let m = ss; m !== ee; m = (m + 1) % 1440) cover[m].push(i);
      if (ss < ee) segments.push({ i: i, s: ss, e: ee });
      else { segments.push({ i: i, s: ss, e: 1440 }); if (ee > 0) segments.push({ i: i, s: 0, e: ee }); }
    });
    // runs of minutes that are uncovered or covered twice
    const runs = [];
    let cur = null;
    for (let m = 0; m < 1440; m++) {
      const c = cover[m];
      const key = c.length === 1 ? null : c.length === 0 ? 'gap' : 'over:' + c.join(',');
      if (cur && cur.key === key) { cur.e = m + 1; continue; }
      if (cur && cur.key) runs.push(cur);
      cur = key ? { key: key, s: m, e: m + 1, rows: c.slice() } : null;
      if (!key) cur = { key: null };
    }
    if (cur && cur.key) runs.push(cur);
    // merge a run that wraps midnight
    if (runs.length > 1 && runs[0].s === 0 && runs[runs.length - 1].e === 1440 && runs[0].key === runs[runs.length - 1].key) {
      const last = runs.pop();
      runs[0] = { key: last.key, s: last.s, e: runs[0].e, rows: last.rows, wrap: true };
    }
    runs.forEach(function (r) {
      const span = hhmm(r.s) + '-' + hhmm(r.e);
      if (r.key === 'gap') errors.push('No period covers ' + span + '. The table must cover all 24 hours.');
      else errors.push(r.rows.map(function (i) { return rows[i].name || 'Row ' + (i + 1); }).join(' and ') + ' overlap ' + span + '.');
    });
    return { ok: errors.length === 0, errors: errors, segments: segments };
  }
  ui.validatePeriods = validatePeriods;          // exposed for tests and other views

  // ==== estimate ====================================================================================
  const est = { key: null, state: 'idle', text: '', timer: null, seq: 0 };
  function estimateKey(st, method) {
    const S = solver();
    const p = S.clampParams ? S.clampParams(method, (st.scenario.settings.methodParams || {})[method], st.scenario.settings) : {};
    return method + '|' + JSON.stringify(p) + '|' + (st.requests || []).length + '|' + (st.scenario.fleet || []).length + '|' + (st.scenario.zones || []).length;
  }
  function secText(s) {
    if (!isNum(s)) return F().NA;
    if (s < 90) return Math.max(1, Math.round(s)) + ' s';
    return F().duration(s / 60);
  }
  function paintEstimate() {
    const el = viewRoot && viewRoot.querySelector('.sc-estimate');
    if (!el) return;
    el.setAttribute('data-state', est.state);
    el.querySelector('.sc-estimate-text').textContent = est.text;
  }
  function scheduleEstimate(immediate) {
    clearTimeout(est.timer);
    est.timer = setTimeout(runEstimate, immediate ? 0 : 450);
  }
  function runEstimate() {
    const st = getState();
    if (!st || !viewRoot || !viewRoot.querySelector('.sc-estimate')) return;
    const method = tuneMethod || st.scenario.settings.method || 'tabu';
    const key = estimateKey(st, method);
    if (key === est.key && est.state !== 'idle') { paintEstimate(); return; }
    est.key = key;
    const E = engine();
    const label = (solver().METHOD_LABELS || {})[method] || method;
    if (!E || typeof E.estimate !== 'function') {
      est.state = 'none'; est.text = 'Run-time estimate needs the planner engine, which is not loaded.';
      paintEstimate();
      return;
    }
    const params = solver().clampParams(method, (st.scenario.settings.methodParams || {})[method], st.scenario.settings);
    const mySeq = ++est.seq;
    est.state = 'loading'; est.text = 'Estimating run time for ' + label + '...';
    paintEstimate();
    let p;
    try { p = Promise.resolve(E.estimate(method, params)); } catch (e) { p = Promise.reject(e); }
    p.then(function (r) {
      if (mySeq !== est.seq) return;
      if (!r || !isNum(r.seconds)) { est.state = 'none'; est.text = 'No estimate for this window yet.'; paintEstimate(); return; }
      est.state = 'ok';
      if (r.seconds <= 0) { est.text = r.basis ? String(r.basis) : 'Nothing is waiting for a plan in this window.'; paintEstimate(); return; }
      const range = isNum(r.low) && isNum(r.high) && r.high > r.low ? ' (' + secText(r.low) + ' to ' + secText(r.high) + ')' : '';
      est.text = (method === 'mip' ? 'Runs up to about ' : 'About ') + secText(r.seconds) + range + ' on the current window' + (r.basis ? '. ' + String(r.basis).replace(/\.$/, '') + '.' : '.');
      paintEstimate();
      ui.emit('planner:estimate', { method: method, params: params, estimate: r });
    }, function (err) {
      if (mySeq !== est.seq) return;
      est.state = 'none';
      est.text = 'No estimate: ' + String((err && err.message) || err || 'nothing to plan in this window').replace(/\.$/, '') + '.';
      paintEstimate();
    });
  }

  // ==== view state ==================================================================================
  let viewRoot = null;
  let viewCtx = null;
  let subtab = 'fleet';
  let tuneMethod = null;
  let rallyFilter = 'all';
  let periodsDraft = null;
  let advOpen = false;
  let replanning = false;
  let bannerMin = false;          // the planner folded the re-plan banner to its title and button
  let bannerSeen = 0;             // reasons shown when it was folded; a new one unfolds it again
  let engineUnsub = null;
  let engineTick = 0;
  const blocks = {};

  function rerender() {
    const st = getState();
    if (viewRoot && st && viewCtx && viewCtx.visible !== false) renderAll(st, true);
  }

  function hookEngine() {
    const E = engine();
    if (engineUnsub || !E || typeof E.subscribe !== 'function') return;
    try {
      engineUnsub = E.subscribe(function () {
        engineTick++;
        if (viewRoot && blocks.banner) { const st = getState(); if (st) blocks.banner.render(st); }
      }) || function () {};
    } catch (e) { engineUnsub = null; }
  }

  // ==== re-plan banner ==============================================================================
  function engineStatus() {
    const E = engine();
    try { return E && typeof E.status === 'function' ? E.status() || {} : {}; } catch (e) { return {}; }
  }
  function doReplan(reasons) {
    const E = engine();
    if (!E || typeof E.replan !== 'function') { ui.toast('Re-planning needs the planner engine, which is not loaded.', 'error'); return; }
    replanning = true;
    rerender();
    let p;
    const reason = reasons.map(function (r) { return r.text; }).join('; ') || 'Planner re-plan';
    try { p = Promise.resolve(E.replan({ reason: reason })); } catch (e) { p = Promise.reject(e); }
    p.then(function (plan) {
      replanning = false;
      rerender();
      if (plan && plan.id) {
        ui.toast('Re-plan ready: review and approve it in the Plan tab.', 'success', { action: { label: 'Open Plan', onClick: function () { ui.plannerTabs.show('plan'); } } });
        ui.plannerTabs.show('plan');
      }
    }, function (err) {
      replanning = false;
      rerender();
      ui.toast('Re-plan failed: ' + ((err && err.message) || err), 'error');
    });
  }
  function buildBanner(st) {
    const plan = activePlan(st);
    if (!plan) return null;
    const reasons = contingencyReasons(st, plan);
    const replanned = changeLog.replanned && changeLog.replanned.parentId === plan.id ? st.plans.find(function (p) { return p.id === changeLog.replanned.planId && !p.approved; }) : null;
    const draftChild = replanned || (st.plans || []).filter(function (p) { return p.parentPlanId === plan.id && !p.approved && !p.superseded; }).pop();
    const es = engineStatus();
    const busy = replanning && ['preparing', 'estimating', 'running'].indexOf(es.phase) >= 0;
    if (!reasons.length && !draftChild && !replanning) return null;
    const E = engine();
    const canReplan = !!(E && typeof E.replan === 'function');
    const approvedAt = isNum(plan.approvedAt) ? plan.approvedAt : plan.createdAt;
    if (bannerMin && reasons.length > bannerSeen) bannerMin = false;
    const folded = bannerMin && !busy && !replanning;
    const head = h('div.sc-replan-head', icon('alert'), h('div.grow',
      h('div.sc-replan-title', reasons.length ? 'Changed since the approved plan' : 'Re-plan waiting for review'),
      h('div.small.muted', folded && reasons.length ? plural(reasons.length, 'change') + ' to ' + (plan.name || plan.id) : (plan.name || plan.id) + ', approved ' + dtg(approvedAt))),
      h('button.btn.btn-sm.btn-icon.btn-ghost.sc-replan-fold', {
        type: 'button', 'aria-expanded': String(!folded), 'aria-label': folded ? 'Show what changed' : 'Hide details', title: folded ? 'Show what changed' : 'Hide details', 'data-fk': 'replan-fold',
        onClick: function () { bannerMin = !folded; bannerSeen = reasons.length; rerender(); }
      }, icon('chevronDown')));
    const SHOW = reasons.length > 4 ? 3 : 4;
    const list = reasons.length ? h('ul.sc-replan-list', reasons.slice(0, SHOW).map(function (r) { return h('li', r.text); }),
      reasons.length > SHOW ? h('li.muted', { title: reasons.slice(SHOW).map(function (r) { return r.text; }).join('\n') }, '+' + (reasons.length - SHOW) + ' more') : null) : null;
    const explain = h('p.sc-replan-explain',
      h('strong', 'Kept: '), 'stops already made and loads already on the road. ',
      h('strong', 'Moves: '), 'stops on trucks that are out or cut off by a closed road go to other trucks or drop points. Platoons see new times only after you approve.');
    let actions;
    if (busy || replanning) {
      const frac = isNum(es.fraction) ? Math.max(0, Math.min(1, es.fraction)) : null;
      actions = h('div.vstack-sm',
        h('div.progress' + (frac === null ? '.is-indeterminate' : ''), h('div.progress-bar', { style: frac === null ? null : { width: Math.round(frac * 100) + '%' } })),
        h('div.progress-meta', h('span', es.message || 'Re-planning...'), h('span', isNum(es.elapsedSec) ? secText(es.elapsedSec) : '')),
        h('div.form-actions', h('button.btn.btn-secondary.btn-sm', { type: 'button', onClick: function () { const E2 = engine(); if (E2 && E2.cancel) E2.cancel(); } }, 'Cancel')));
    } else {
      // once a re-plan is stored, reviewing it is the next step; re-planning again stays possible
      const review = draftChild ? h('button.btn.sc-review-btn' + (reasons.length ? '.btn-primary.btn-lg' : '.btn-secondary'), {
        type: 'button', 'data-fk': 'replan-review',
        onClick: function () { ui.emit('planner:plan-selected', { planId: draftChild.id, source: 'scenario' }); ui.plannerTabs.show('plan'); }
      }, icon('route'), 'Review re-plan') : null;
      actions = h('div.sc-replan-actions',
        review,
        reasons.length ? h('button.btn.sc-replan-btn' + (draftChild ? '.btn-secondary' : '.btn-primary.btn-lg'), {
          type: 'button', disabled: !canReplan, 'data-fk': 'replan-now',
          onClick: function () { doReplan(reasons); }
        }, icon('refresh'), draftChild ? 'Re-plan again' : 'Re-plan now') : null,
        !canReplan ? h('div.field-help', 'Re-planning needs the planner engine, which is not loaded.') : null);
    }
    if (folded) return h('section.card.sc-replan.is-folded', { role: 'region', 'aria-label': 'Re-plan', 'data-reasons': String(reasons.length) }, head, actions);
    return h('section.card.sc-replan', { role: 'region', 'aria-label': 'Re-plan', 'data-reasons': String(reasons.length) },
      head, list, reasons.length ? explain : h('p.sc-replan-explain', 'A re-plan of ' + (plan.name || plan.id) + ' is stored. Review it in the Plan tab and approve it to update platoons.'), actions);
  }

  // ==== fleet panel ================================================================================
  function statusInfo(st, t) {
    if (t.status === 'out') {
      return { cls: 'badge-danger', text: 'Out', sub: (t.outReason ? t.outReason : 'Out of service') + (isNum(t.outUntil) ? ', back about ' + dtg(t.outUntil) : '') };
    }
    if (t.status === 'en_route') return { cls: 'badge-info', text: 'En route', sub: 'Back at ' + dtg(t.availableAt) };
    if (isNum(t.availableAt) && t.availableAt > st.clock.simMin) return { cls: 'badge-warn', text: 'Returning', sub: 'Free at ' + dtg(t.availableAt) };
    return { cls: 'badge-ok', text: 'Available', sub: null };
  }
  function truckRow(st, t, plan) {
    const s = statusInfo(st, t);
    const onPlan = routeOf(plan, t.id);
    return h('li.list-row.sc-truck', { 'data-truck': t.id, 'data-status': t.status },
      h('span.truck-chip', { style: { '--truck': t.color } }, t.id),
      h('div.list-row-main',
        h('div.list-row-title', truckTypeInfo(t.type).label, h('span.faint', ' \u00b7 ' + capacityText(t))),
        h('div.list-row-sub', h('span.badge.sc-status.' + s.cls, s.text), ' ',
          s.sub ? h('span.sc-status-sub', s.sub) : null),
        h('div.sc-truck-meta', h('span.faint.sc-freq', 'Freq ' + (t.freq || F().NA)),
          onPlan ? h('span.sc-onplan', ' \u00b7 on approved plan') : null)),
      h('div.sc-truck-actions',
        t.status === 'out'
          ? h('button.btn.btn-sm.btn-secondary', { type: 'button', 'data-fk': 'avail-' + t.id, 'data-act': 'available', onClick: function () { act({ type: 'truck/markAvailable', truckId: t.id }, t.id + ' is available again.'); } }, icon('check'), 'Mark available')
          : h('button.btn.btn-sm.btn-secondary', { type: 'button', 'data-fk': 'out-' + t.id, 'data-act': 'out', onClick: function () { markOutDialog(t); } }, icon('alert'), 'Mark out'),
        h('button.btn.btn-sm.btn-icon.btn-ghost', { type: 'button', 'aria-label': 'Remove ' + t.id, title: 'Remove ' + t.id, 'data-fk': 'rm-' + t.id, 'data-act': 'remove', onClick: function () { removeTruck(t, true); } }, icon('trash'))));
  }
  function hubCounts(st, hub, compact) {
    return ['tanker', 'cargo'].map(function (type) {
      const n = trucksAt(st, hub.id, type).length;
      const label = type === 'tanker' ? 'Tankers' : 'Cargo';
      return counter({
        fk: (compact ? 'set-' : 'fl-') + hub.id + '-' + type, label: label,
        ariaLabel: (type === 'tanker' ? 'Fuel tankers' : 'Cargo trucks') + ' at ' + hub.name,
        value: n, min: 0, max: MAX_PER_TYPE,
        onSet: function (v) { setTruckCount(hub.id, type, v); }
      });
    });
  }
  function buildFleet(st) {
    const plan = activePlan(st);
    const fleet = st.scenario.fleet || [];
    const out = fleet.filter(function (t) { return t.status === 'out'; }).length;
    const enr = fleet.filter(function (t) { return t.status === 'en_route'; }).length;
    const intro = h('p.sc-intro.muted', fleet.length + ' truck' + (fleet.length === 1 ? '' : 's') + ': ' + (fleet.length - out - enr) + ' available, ' + enr + ' en route, ' + out + ' out. ' +
      'Fuel tankers carry bulk Class III (Fuel), ' + F().gallons(truckTypeInfo('tanker').capacity) + '; cargo trucks carry everything else, ' + truckTypeInfo('cargo').capacity + ' pallets.');
    const cards = (st.scenario.hubs || []).map(function (hub) {
      const trucks = fleet.filter(function (t) { return t.hubId === hub.id; }).sort(function (a, b) { return truckNo(a.id) - truckNo(b.id); });
      const g = gridById(hub.gridId) || hub;
      return h('section.card.sc-hub', { 'data-hub': hub.id },
        h('div.sc-hub-head',
          h('div.grow', h('h3.card-title', hub.name), h('div.card-sub.num', (hub.callsign ? hub.callsign + ' \u00b7 ' : '') + mgrs(g.lat, g.lon))),
          h('div.sc-hub-counts', hubCounts(st, hub, false))),
        trucks.length ? h('ul.list.list-dense.sc-trucks', trucks.map(function (t) { return truckRow(st, t, plan); }))
          : h('p.sc-none.muted', 'No trucks at this hub. Use the steppers to add one.'));
    });
    return [intro].concat(cards);
  }

  // ==== zones panel =================================================================================
  function zoneRow(st, z) {
    const ratings = Object.keys(st.scenario.settings.riskRatings || { Low: 1, Medium: 3, High: 6 });
    const rid = 'sc-zr-' + z.id;
    const radius = h('input.input.num.sc-zone-radius', {
      id: rid, type: 'number', min: 0.5, max: 60, step: 0.5, value: showVal(z.radiusMi), inputmode: 'decimal', 'data-fk': 'zr-' + z.id,
      onChange: function () {
        const v = num(radius.value);
        if (!(v >= 0.5 && v <= 60)) { ui.toast('Radius must be from 0.5 to 60 miles.', 'error'); radius.value = showVal(z.radiusMi); return; }
        act({ type: 'zone/update', id: z.id, changes: { radiusMi: Math.round(v * 10) / 10 } });
      }
    });
    const label = h('input.input.sc-zone-label', {
      type: 'text', value: z.label || '', maxlength: 60, 'aria-label': 'Zone name', 'data-fk': 'zl-' + z.id,
      onChange: function () { const v = label.value.trim(); if (v && v !== z.label) act({ type: 'zone/update', id: z.id, changes: { label: v } }); else label.value = z.label || ''; }
    });
    const rating = z.kind === 'risk' ? h('select.select.sc-zone-rating', {
      'aria-label': 'Risk rating', 'data-fk': 'zt-' + z.id,
      onChange: function (e) { act({ type: 'zone/update', id: z.id, changes: { rating: e.target.value } }); }
    }, ratings.map(function (r) { return h('option', { value: r, selected: r === z.rating }, r + ' (x' + st.scenario.settings.riskRatings[r] + ')'); })) : null;
    return h('li.sc-zone', { 'data-zone': z.id, 'data-kind': z.kind, 'data-rating': z.rating || '' },
      h('span.sc-zone-sw', { 'aria-hidden': 'true' }),
      h('div.sc-zone-main',
        h('div.sc-zone-top', h('span.badge.' + (z.kind === 'closed' ? 'badge-danger' : 'badge-warn'), z.kind === 'closed' ? 'Closed' : (z.rating || 'Medium') + ' risk'), label),
        h('div.sc-zone-sub.small.muted.num', 'Center ' + mgrs(z.lat, z.lon)),
        h('div.sc-zone-edit',
          h('label.sc-inline', { htmlFor: rid }, 'Radius', radius, h('span.muted', 'mi')),
          rating)),
      h('div.sc-zone-actions',
        h('button.btn.btn-sm.btn-icon.btn-ghost', { type: 'button', 'aria-label': 'Show ' + (z.label || z.id) + ' on the map', title: 'Show on map', onClick: function () { focusZone(z); } }, icon(ICONS.locate)),
        h('button.btn.btn-sm.btn-icon.btn-ghost', {
          type: 'button', 'aria-label': 'Remove ' + (z.label || z.id), title: 'Remove', 'data-act': 'remove-zone',
          onClick: function () {
            const copy = clone(z);
            if (act({ type: 'zone/remove', id: z.id })) {
              ui.toast('Zone removed: ' + (z.label || z.id) + '.', 'info', { action: { label: 'Undo', onClick: function () { act({ type: 'zone/add', zone: copy }); } } });
            }
          }
        }, icon('trash'))));
  }
  function buildZones(st) {
    const zones = st.scenario.zones || [];
    const closed = zones.filter(function (z) { return z.kind === 'closed'; });
    const risk = zones.filter(function (z) { return z.kind !== 'closed'; });
    const drawNote = drawing ? h('div.notice.notice-info.sc-drawing', { role: 'status' }, icon(ICONS.zone),
      h('div.grow', 'Drawing a ' + (drawing.kind === 'closed' ? 'closed zone' : drawing.rating.toLowerCase() + ' risk zone') + (drawing.where === 'dialog' ? ' in the map dialog.' : ' on the map: tap the center, then drag or tap the edge.')),
      h('button.btn.btn-sm.btn-secondary', { type: 'button', onClick: function () { if (drawing) drawing.cancel(); } }, 'Cancel')) : null;
    const tools = h('div.sc-zone-tools',
      h('button.btn.btn-secondary.sc-add-closed', { type: 'button', 'data-fk': 'add-closed', disabled: !!drawing, onClick: function () { startDrawing('closed', null); } }, icon(ICONS.closed), 'Add closed zone'),
      h('div.sc-risk-add',
        h('button.btn.btn-secondary.sc-add-risk', { type: 'button', 'data-fk': 'add-risk', disabled: !!drawing, onClick: function () { startDrawing('risk', riskRating); } }, icon(ICONS.zone), 'Add risk zone'),
        h('div.seg.sc-rating-seg', { role: 'group', 'aria-label': 'Rating for the new risk zone' }, RATINGS.map(function (r) {
          return h('button', { type: 'button', 'aria-pressed': String(r === riskRating), 'data-rating': r, onClick: function () { riskRating = r; rerender(); } }, r);
        }))));
    const help = h('p.field-help', 'Closed: trucks never drive through it; the optimizer routes around it on real roads. Risk: each mile inside adds the rating (Low ' +
      st.scenario.settings.riskRatings.Low + ', Medium ' + st.scenario.settings.riskRatings.Medium + ', High ' + st.scenario.settings.riskRatings.High + ') times the time-of-day risk factor to the risk cost.');
    const lists = zones.length ? [
      h('div.section-head', h('span.caps', 'Closed zones (' + closed.length + ')')),
      closed.length ? h('ul.sc-zones', closed.map(function (z) { return zoneRow(st, z); })) : h('p.sc-none.muted', 'None.'),
      h('div.section-head', h('span.caps', 'Risk zones (' + risk.length + ')')),
      risk.length ? h('ul.sc-zones', risk.map(function (z) { return zoneRow(st, z); })) : h('p.sc-none.muted', 'None.')
    ] : [h('div.empty.sc-empty', h('div.empty-icon', icon(ICONS.zone)), h('p.empty-title', 'No zones'), h('p.empty-text', 'Draw a closed zone for a road that is out, or a risk zone where trucks should spend fewer miles.'))];
    return [drawNote, tools, help].concat(lists);
  }

  // ==== drop points panel ==========================================================================
  function maxRallyCounter(st, fk) {
    return counter({
      fk: fk, label: 'Max drop points per window', value: st.scenario.settings.maxRallyPoints, min: 1, max: 20,
      onSet: function (v) { updateSettings({ maxRallyPoints: v }); }
    });
  }
  function buildRally(st) {
    const r = st.scenario.rally || { pinned: [], banned: [] };
    const used = usedRally(st);
    const all = rallyCandidates();
    const max = st.scenario.settings.maxRallyPoints;
    const filters = [['all', 'All'], ['pinned', 'Pinned'], ['banned', 'Banned'], ['north', 'North'], ['central', 'Central'], ['south', 'South'], ['east', 'East']];
    const list = all.filter(function (g) {
      const s = rallyState(st, g.id);
      return rallyFilter === 'all' || rallyFilter === s || rallyFilter === g.region;
    });
    const dflt = scenarioDefaults().maxRallyPoints;
    const head = h('div.card.sc-rally-head',
      h('div.hstack.wrap.sc-rally-max', maxRallyCounter(st, 'rally-max'), changedMark(dflt !== undefined && max !== dflt, dflt)),
      h('p.field-help', 'The optimizer picks which candidate points become drop points each window and which platoons use them, within each platoon\'s mobility radius. Pinned points are always used and count toward the maximum; banned points are never used.'),
      (r.pinned || []).length > max ? h('div.notice.notice-warn', icon('alert'), 'More points are pinned (' + r.pinned.length + ') than the maximum (' + max + '). Unpin some or raise the maximum.') : null,
      h('div.hstack.wrap.spread',
        h('span.small.muted', (r.pinned || []).length + ' pinned, ' + (r.banned || []).length + ' banned, ' + all.length + ' candidates' + (used.length ? ', ' + used.length + ' used in the current plan' : '')),
        ((r.pinned || []).length || (r.banned || []).length) ? h('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: function () { act({ type: 'rally/clear' }, 'All pins and bans cleared.'); } }, 'Clear all') : null));
    const chips = h('div.chip-group.sc-rally-filter', { role: 'group', 'aria-label': 'Filter drop points' }, filters.map(function (f) {
      return h('button.chip', { type: 'button', 'aria-pressed': String(rallyFilter === f[0]), onClick: function () { rallyFilter = f[0]; blocks.rally.render(getState(), true); } }, f[1]);
    }));
    const rows = list.map(function (g) {
      const s = rallyState(st, g.id);
      const isUsed = used.indexOf(g.id) >= 0;
      return h('li.list-row.sc-rally', { 'data-grid': g.id, 'data-state': s },
        h('div.list-row-main',
          h('div.list-row-title', shortName(g.name)),
          h('div.list-row-sub.num', h('span.sc-nowrap', mgrs(g.lat, g.lon)), h('span.sc-nowrap', '\u00b7 ' + cap(g.region)),
            s !== 'open' ? h('span.badge.' + (s === 'pinned' ? 'badge-accent' : 'badge-danger') + '.sc-rally-badge', s === 'pinned' ? 'Pinned' : 'Banned') : null,
            isUsed ? h('span.badge.badge-ok.sc-rally-badge', 'In plan') : null)),
        h('div.seg.sc-rally-seg', { role: 'group', 'aria-label': 'Drop point ' + shortName(g.name) },
          h('button', { type: 'button', 'aria-pressed': String(s === 'pinned'), 'data-act': 'pin', 'data-fk': 'pin-' + g.id, title: 'Always use this point', onClick: function () { setRally(g.id, s === 'pinned' ? 'clear' : 'pin'); } }, icon('pin'), h('span', 'Pin')),
          h('button', { type: 'button', 'aria-pressed': String(s === 'banned'), 'data-act': 'ban', 'data-fk': 'ban-' + g.id, title: 'Never use this point', onClick: function () { setRally(g.id, s === 'banned' ? 'clear' : 'ban'); } }, icon(ICONS.ban), h('span', 'Ban')),
          h('button', { type: 'button', 'aria-pressed': 'false', 'data-act': 'clear', 'data-fk': 'clr-' + g.id, disabled: s === 'open', title: 'Let the optimizer decide', onClick: function () { setRally(g.id, 'clear'); } }, h('span', 'Clear'))));
    });
    return [head, chips, rows.length ? h('ul.list.sc-rally-list', rows) : h('p.sc-none.muted', 'No drop points match this filter.')];
  }

  // ==== settings panel ==============================================================================
  function buildOptimizer(st) {
    const s = st.scenario.settings;
    const S = solver();
    const labels = S.METHOD_LABELS || { tabu: 'Tabu search', sa: 'Simulated annealing', aco: 'Ant colony', mip: 'Exact (MIP)' };
    const keys = S.METHOD_KEYS || Object.keys(labels);
    const sel = h('select.select#sc-method', {
      'data-fk': 'method',
      onChange: function () { updateSettings({ method: sel.value }); tuneMethod = null; scheduleEstimate(); }
    }, keys.map(function (k) { return h('option', { value: k, selected: k === s.method }, labels[k]); }));
    const d = scenarioDefaults();
    return h('section.card.sc-card',
      h('div.card-header', h('h3.card-title', 'Optimizer')),
      h('div.form-grid',
        h('div.field', h('label.field-label', { htmlFor: 'sc-method' }, 'Method'), sel, h('div.field-help', METHOD_HELP[s.method] || '')),
        numField({ fk: 'timeLimit', label: 'Time limit', unit: 'seconds', value: s.timeLimitSec, def: d.timeLimitSec, min: 5, max: 1800, step: 5, int: true,
          help: 'Longest any method may run (' + F().duration(s.timeLimitSec / 60) + '). Each method stops earlier when its own steps run out; Exact (MIP) usually uses all of it.',
          onCommit: setTimeLimit })));
  }
  function buildWeights(st) {
    const w = st.scenario.settings.weights || {};
    const d = scenarioDefaults().weights || { fuel: 3, distance: 3, risk: 5, simplicity: 2 };
    const changed = WEIGHTS.some(function (x) { return w[x.key] !== d[x.key]; });
    return h('section.card.sc-card',
      h('div.card-header', h('div', h('h3.card-title', 'Cost weights'), h('div.card-sub', '0 ignores a term, 10 weighs it most. Late or missed deliveries always cost more than any of these.')),
        changed ? h('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: function () { updateSettings({ weights: clone(d) }); } }, 'Reset') : null),
      h('div.vstack', WEIGHTS.map(function (x) {
        const id = 'sc-w-' + x.key;
        const out = h('output.sc-weight-val.num', { htmlFor: id }, String(w[x.key]));
        const range = h('input.range', {
          id: id, type: 'range', min: 0, max: 10, step: 1, value: String(w[x.key]), 'data-fk': 'w-' + x.key, 'data-weight': x.key,
          'aria-describedby': id + '-help',
          onInput: function () { out.textContent = range.value; },
          onChange: function () { const ch = {}; ch[x.key] = Math.round(num(range.value)); updateSettings({ weights: ch }); }
        });
        return h('div.sc-weight', { 'data-weight': x.key },
          h('div.sc-weight-head', h('label.field-label', { htmlFor: id }, x.label), changedMark(w[x.key] !== d[x.key], d[x.key]), out),
          range,
          h('div.field-help', { id: id + '-help' }, x.help));
      })));
  }
  function buildFleetShortcut(st) {
    const hubs = st.scenario.hubs || [];
    return h('section.card.sc-card',
      h('div.card-header', h('div', h('h3.card-title', 'Trucks per hub'), h('div.card-sub', 'Take trucks out of the count for maintenance; mark single trucks out in the Fleet tab.'))),
      h('div.sc-hubgrid', { role: 'group', 'aria-label': 'Trucks per hub' },
        hubs.map(function (hub) {
          const c = hubCounts(st, hub, true);
          return h('div.sc-hubgrid-row', { 'data-hub': hub.id }, h('span.sc-hubgrid-name', hub.name), c[0], c[1]);
        })));
  }
  function buildRallyShortcut(st) {
    const d = scenarioDefaults().maxRallyPoints;
    return h('section.card.sc-card',
      h('div.card-header', h('div', h('h3.card-title', 'Drop points'), h('div.card-sub', 'Pin or ban single points in the Drop points tab.'))),
      h('div.hstack.wrap', maxRallyCounter(st, 'set-rally-max'), changedMark(d !== undefined && st.scenario.settings.maxRallyPoints !== d, d)));
  }

  // ---- advanced -----------------------------------------------------------------------------------
  function advCard(title, sub, body, extra) {
    return h('section.sc-adv-card', h('div.section-head', h('div', h('h4.sc-adv-title', title), sub ? h('div.small.muted', sub) : null), extra || null), body);
  }
  function buildTravel(st) {
    const s = st.scenario.settings, d = scenarioDefaults();
    return advCard('Travel and timing', null, h('div.form-grid',
      numField({ fk: 'convoy', label: 'Convoy speed factor', value: s.convoyFactor, def: d.convoyFactor, min: 1, max: 3, step: 0.05, help: 'Road travel time is multiplied by this for a convoy.', onCommit: function (v) { updateSettings({ convoyFactor: v }); } }),
      numField({ fk: 'mpg', label: 'Fuel burn', unit: 'mpg', value: s.mpg, def: d.mpg, min: 0.5, max: 10, step: 0.1, help: 'Miles per gallon per truck; gallons = miles / mpg.', onCommit: function (v) { updateSettings({ mpg: v }); } }),
      numField({ fk: 'service', label: 'Stop service time', unit: 'min', value: s.serviceMin, def: d.serviceMin, min: 0, max: 120, step: 1, int: true, help: 'Time spent at each stop to hand over supplies.', onCommit: function (v) { updateSettings({ serviceMin: v }); } }),
      numField({ fk: 'load', label: 'Hub load time', unit: 'min', value: s.loadMin, def: d.loadMin, min: 0, max: 240, step: 1, int: true, help: 'Time to load a truck at its hub before it leaves.', onCommit: function (v) { updateSettings({ loadMin: v }); } })));
  }
  function periodBar(rows, v) {
    const colors = ['--sc-p0', '--sc-p1', '--sc-p2', '--sc-p3', '--sc-p4', '--sc-p5'];
    const bar = h('div.sc-pbar', { 'aria-hidden': 'true' });
    v.segments.forEach(function (sg) {
      bar.appendChild(h('span.sc-pbar-seg', { style: { left: (sg.s / 14.4) + '%', width: ((sg.e - sg.s) / 14.4) + '%', background: 'var(' + colors[sg.i % colors.length] + ')' }, title: rows[sg.i].name }, (sg.e - sg.s) >= 120 ? rows[sg.i].name : ''));
    });
    const ticks = h('div.sc-pbar-ticks', { 'aria-hidden': 'true' }, ['0000', '0600', '1200', '1800', '2400'].map(function (t) { return h('span', t); }));
    return h('div.sc-pbar-wrap', bar, ticks);
  }
  function buildPeriods(st) {
    const saved = st.scenario.settings.periods || [];
    const rows = periodsDraft || clone(saved);
    const v = validatePeriods(rows);
    const dirty = !!periodsDraft && JSON.stringify(periodsDraft) !== JSON.stringify(saved);
    const status = h('div.sc-pstatus', { role: 'status', 'aria-live': 'polite' });
    const barHost = h('div');
    const saveBtn = h('button.btn.btn-primary.btn-sm', { type: 'button', 'data-fk': 'periods-save', disabled: !v.ok || !dirty, onClick: savePeriods }, 'Save table');
    function paintStatus(vv) {
      ui.clear(status);
      if (vv.ok) status.appendChild(h('div.field-help.text-ok', icon('check'), ' Covers all 24 hours with no overlap.'));
      else status.appendChild(h('ul.sc-perrors', vv.errors.map(function (e) { return h('li.field-error', icon('alert'), h('span', e)); })));
      ui.clear(barHost).appendChild(periodBar(rows, vv));
    }
    function onEdit() {
      periodsDraft = rows;
      const vv = validatePeriods(rows);
      paintStatus(vv);
      saveBtn.disabled = !vv.ok || JSON.stringify(rows) === JSON.stringify(saved);
      table.classList.toggle('is-invalid', !vv.ok);
    }
    function savePeriods() {
      const vv = validatePeriods(rows);
      if (!vv.ok) { ui.toast('Fix the time-of-day table first: ' + vv.errors[0], 'error'); return; }
      const clean = rows.map(function (p) {
        const C = SRO.core.clock;
        return { name: p.name, start: hhmm(C.parseHHMM(p.start) % 1440), end: hhmm(C.parseHHMM(p.end) === 1440 ? 1440 : C.parseHHMM(p.end) % 1440), speed: num(p.speed), risk: num(p.risk) };
      });
      periodsDraft = null;
      updateSettings({ periods: clean });
      ui.toast('Time-of-day table saved.', 'success');
    }
    const cell = function (p, i, key, attrs) {
      return h('input.input.num.sc-pinput', Object.assign({
        value: String(p[key]), 'data-fk': 'p-' + i + '-' + key, 'data-period': String(i), 'data-key': key,
        'aria-label': (p.name || 'Row ' + (i + 1)) + ' ' + ({ start: 'start time', end: 'end time', speed: 'speed factor', risk: 'risk factor' })[key],
        onInput: function (e) { rows[i][key] = key === 'speed' || key === 'risk' ? e.target.value : e.target.value.trim(); onEdit(); }
      }, attrs));
    };
    const table = h('table.table.table-compact.sc-ptable' + (v.ok ? '' : '.is-invalid'),
      h('thead', h('tr', h('th', 'Period'), h('th', 'Start'), h('th', 'End'), h('th.num', 'Speed x'), h('th.num', 'Risk x'))),
      h('tbody', rows.map(function (p, i) {
        return h('tr', { 'data-period': String(i) },
          h('td', p.name),
          h('td', cell(p, i, 'start', { type: 'text', inputmode: 'numeric', maxlength: 5, placeholder: 'HHMM' })),
          h('td', cell(p, i, 'end', { type: 'text', inputmode: 'numeric', maxlength: 5, placeholder: 'HHMM' })),
          h('td.num', cell(p, i, 'speed', { type: 'number', inputmode: 'decimal', min: 0.1, max: 2, step: 0.05 })),
          h('td.num', cell(p, i, 'risk', { type: 'number', inputmode: 'decimal', min: 0, max: 5, step: 0.05 })));
      })));
    paintStatus(v);
    const dflt = (scenarioDefaults().periods) || [];
    const isDefault = JSON.stringify(saved) === JSON.stringify(dflt);
    return advCard('Time of day', 'Each leg is timed and risk-weighted by the period it is driven in. Travel minutes = road minutes / speed factor.', h('div.vstack-sm',
      h('div.table-wrap.sc-ptable-wrap', table),
      barHost, status,
      h('div.form-actions',
        dirty ? h('button.btn.btn-ghost.btn-sm', { type: 'button', onClick: function () { periodsDraft = null; blocks.periods.render(getState(), true); } }, 'Discard changes') : null,
        !isDefault ? h('button.btn.btn-secondary.btn-sm', { type: 'button', onClick: function () { periodsDraft = null; updateSettings({ periods: clone(dflt) }); ui.toast('Time-of-day table back to defaults.', 'success'); } }, 'Reset to defaults') : null,
        saveBtn)));
  }
  function buildRisk(st) {
    const r = st.scenario.settings.riskRatings || {}, d = scenarioDefaults().riskRatings || {};
    return advCard('Risk ratings', 'Risk units added per mile driven inside a zone of that rating.', h('div.form-grid',
      Object.keys(r).map(function (k) {
        return numField({ fk: 'risk-' + k, label: k, value: r[k], def: d[k], min: 0, max: 50, step: 0.5, onCommit: function (v) { const ch = {}; ch[k] = v; updateSettings({ riskRatings: ch }); } });
      })));
  }
  function buildMobility(st) {
    const m = st.scenario.settings.mobility || {}, d = scenarioDefaults().mobility || {};
    const f = function (mode, key, label, unit, min, max, step, help) {
      return numField({ fk: 'mob-' + mode + '-' + key, label: label, unit: unit, value: (m[mode] || {})[key], def: (d[mode] || {})[key], min: min, max: max, step: step, help: help,
        onCommit: function (v) { const ch = {}; ch[mode] = {}; ch[mode][key] = v; updateSettings({ mobility: ch }); } });
    };
    return advCard('Platoon mobility', 'How far a platoon may travel to a drop point. Fixed-in-place platoons always get direct delivery.', h('div.form-grid',
      f('mounted', 'radiusMi', 'Mounted radius', 'mi', 1, 150, 1, 'Pickup within this many miles is a preference.'),
      f('mounted', 'costPerMi', 'Mounted cost per mile', null, 0, 20, 0.1, 'Counted in the distance term for the platoon\'s own trip.'),
      f('dismounted', 'radiusMi', 'Dismounted radius', 'mi', 0.5, 30, 0.5, 'On foot: pickup within this many miles.'),
      f('dismounted', 'costPerMi', 'Dismounted cost per mile', null, 0, 50, 0.1, 'Walking miles cost more than driving miles.')));
  }
  function dailyUseRows() {
    const cat = SRO.data && SRO.data.catalog;
    const H = SRO.data && SRO.data.catalogHelpers;
    if (!cat || !H) return [];
    const rows = [];
    cat.items.forEach(function (it) {
      if (it.dailyUse !== null && it.dailyUse !== undefined) rows.push({ key: it.id, classId: it.classId, label: it.name, unit: it.unit, def: it.dailyUse });
      it.options.forEach(function (o) { if (o.dailyUse !== undefined) rows.push({ key: it.id + ':' + o.id, classId: it.classId, label: it.name + ': ' + o.label, unit: it.unit, def: o.dailyUse }); });
    });
    return rows;
  }
  function buildDailyUse(st) {
    const table = st.scenario.settings.dailyUse || {};
    const rows = dailyUseRows();
    const H = SRO.data && SRO.data.catalogHelpers;
    const classes = (SRO.data && SRO.data.catalog && SRO.data.catalog.classes) || [];
    const changedAny = rows.some(function (r) { return isNum(table[r.key]) && !eqVal(table[r.key], r.def); });
    const groups = classes.map(function (c) {
      const list = rows.filter(function (r) { return r.classId === c.id; });
      if (!list.length) return null;
      return h('tbody', { 'data-class': c.id },
        h('tr.sc-du-class', h('th', { colspan: 3, scope: 'colgroup' }, c.label)),
        list.map(function (r) {
          const v = isNum(table[r.key]) ? table[r.key] : r.def;
          const id = 'sc-du-' + r.key.replace(/[^a-z0-9]+/gi, '-');
          const input = h('input.input.num.sc-du-input', {
            id: id, type: 'number', min: 0, max: 100000, step: 'any', value: showVal(v), inputmode: 'decimal', 'data-fk': 'du-' + r.key,
            onChange: function () {
              const x = num(input.value);
              if (!(x >= 0 && x <= 100000)) { ui.toast('A daily use rate must be from 0 to 100,000.', 'error'); input.value = showVal(v); return; }
              const ch = {}; ch[r.key] = x;
              updateSettings({ dailyUse: ch });
            }
          });
          const unitLabel = H && H.unitLabel ? H.unitLabel(r.unit, 2) : r.unit;
          return h('tr', { 'data-key': r.key },
            h('td', h('label', { htmlFor: id }, r.label), changedMark(!eqVal(v, r.def), showVal(r.def))),
            h('td.num', input),
            h('td.muted', unitLabel + '/day'));
        }));
    });
    return advCard('Daily use rates', 'Notional use per platoon per day. Drives hours of supply for Urgent requests and the "more than 5x daily use" warning.',
      h('div.vstack-sm',
        h('div.table-wrap.sc-du-wrap', h('table.table.table-compact.sc-du', h('thead', h('tr', h('th', 'Item'), h('th.num', 'Rate'), h('th', 'Unit'))), groups)),
        changedAny ? h('div.form-actions', h('button.btn.btn-secondary.btn-sm', { type: 'button', onClick: function () {
          const H2 = SRO.data.catalogHelpers;
          updateSettings({ dailyUse: H2.defaultDailyUse() });
          ui.toast('Daily use rates back to the catalog values.', 'success');
        } }, 'Reset rates')) : null));
  }

  // ---- solver tuning --------------------------------------------------------------------------------
  function sliderSpec(e) {
    if ((e.type !== 'int' && e.type !== 'float') || e.key === 'seed' || !isNum(e.min) || !isNum(e.max) || !(e.max > e.min)) return null;
    const snap = function (v) {
      if (e.type === 'int') return Math.round(v);
      if (e.scale === 'log') return Number(v.toPrecision(3));
      const dec = String(e.step || 0.01).indexOf('.') >= 0 ? String(e.step).split('.')[1].length : 0;
      return Number(v.toFixed(Math.min(8, dec)));
    };
    if (e.scale === 'log') {
      const off = e.min <= 0 ? 1 : 0;
      const a = Math.log(e.min + off), b = Math.log(e.max + off);
      return {
        min: 0, max: 1000, step: 1,
        toPos: function (v) { return Math.round((Math.log(Math.max(e.min, Math.min(e.max, v)) + off) - a) / (b - a) * 1000); },
        fromPos: function (p) { return snap(Math.exp(a + (b - a) * p / 1000) - off); }
      };
    }
    return { min: e.min, max: e.max, step: e.step || (e.type === 'int' ? 1 : 0.01), toPos: function (v) { return v; }, fromPos: function (p) { return snap(num(p)); } };
  }
  function knobRow(method, e, value, dflt) {
    const id = 'sc-k-' + method + '-' + e.key;
    const changed = !eqVal(value, dflt);
    let control;
    if (e.type === 'bool') {
      control = h('input.switch', {
        id: id, type: 'checkbox', checked: !!value, role: 'switch', 'data-fk': 'k-' + method + '-' + e.key,
        onChange: function (ev) { commitKnob(method, e.key, !!ev.target.checked); }
      });
    } else if (e.type === 'select') {
      control = h('select.select', { id: id, 'data-fk': 'k-' + method + '-' + e.key, onChange: function (ev) { commitKnob(method, e.key, ev.target.value); } },
        (e.options || []).map(function (o) { const v = o && typeof o === 'object' ? o.value : o; return h('option', { value: v, selected: v === value }, o && typeof o === 'object' ? o.label : String(o)); }));
    } else {
      const err = h('div.field-error', { hidden: true });
      const input = h('input.input.num.sc-knob-num', {
        id: id, type: 'number', inputmode: e.type === 'int' ? 'numeric' : 'decimal', min: e.min, max: e.max, step: e.step || 'any', value: showVal(value),
        'data-fk': 'k-' + method + '-' + e.key,
        onChange: function () {
          const raw = input.value.trim();
          if (raw === '' || !isFinite(Number(raw))) { err.hidden = false; err.textContent = 'Enter a number from ' + showVal(e.min) + ' to ' + showVal(e.max) + '.'; return; }
          err.hidden = true;
          commitKnob(method, e.key, Number(raw));
        }
      });
      const sp = sliderSpec(e);
      const slider = sp ? h('input.range.sc-knob-range', {
        type: 'range', min: sp.min, max: sp.max, step: sp.step, value: String(sp.toPos(value)), 'aria-label': e.label + ' slider', 'data-fk': 'kr-' + method + '-' + e.key,
        onInput: function (ev) { input.value = showVal(sp.fromPos(num(ev.target.value))); },
        onChange: function (ev) { commitKnob(method, e.key, sp.fromPos(num(ev.target.value))); }
      }) : null;
      control = h('div.sc-knob-ctl', input, slider);
      control.appendChild(err);
    }
    const hint = e.offValue !== undefined ? ' ' + showVal(e.offValue) + (e.key === 'startTemp' ? ' = automatic.' : ' = off.') : '';
    const rng = e.type === 'int' || e.type === 'float' ? ' Range ' + showVal(e.min) + ' to ' + showVal(e.max) + '.' : '';
    return h('div.sc-knob', { 'data-knob': e.key, 'data-type': e.type, 'data-changed': String(changed) },
      h('div.sc-knob-head', h('label.field-label', { htmlFor: id }, e.label), changedMark(changed, showVal(dflt)), e.type === 'bool' ? control : null),
      e.type === 'bool' ? null : control,
      h('div.field-help', e.help + rng + hint));
  }
  function methodChanged(st, m) {
    const S = solver();
    const s = st.scenario.settings;
    const cur = S.clampParams(m, (s.methodParams || {})[m], s), d = S.defaultParams(m, s);
    return Object.keys(d).some(function (k) { return !eqVal(cur[k], d[k]); });
  }
  function buildTuning(st) {
    const S = solver();
    if (!S.PARAMS || !S.clampParams) return advCard('Solver tuning', null, h('p.muted', 'The solver settings module is not loaded.'));
    const s = st.scenario.settings;
    const keys = (S.METHOD_KEYS || Object.keys(S.PARAMS)).filter(function (k) { return S.PARAMS[k]; });
    const method = keys.indexOf(tuneMethod) >= 0 ? tuneMethod : (keys.indexOf(s.method) >= 0 ? s.method : keys[0]);
    const labels = S.METHOD_LABELS || {};
    const cur = S.clampParams(method, (s.methodParams || {})[method], s);
    const defs = S.defaultParams(method, s);
    const anyChanged = Object.keys(defs).some(function (k) { return !eqVal(cur[k], defs[k]); });
    const seg = h('div.seg.seg-block.sc-tune-seg', { role: 'tablist', 'aria-label': 'Method to tune' }, keys.map(function (k) {
      return h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(k === method), 'data-method': k, title: labels[k] || k,
        onClick: function () { tuneMethod = k; blocks.tuning.render(getState(), true); scheduleEstimate(true); }
      }, h('span', METHOD_SHORT[k] || labels[k] || k), methodChanged(st, k) ? h('span.sc-dot', { title: 'Has changed settings' }) : null);
    }));
    const panel = h('div.sc-tune-panel', { role: 'tabpanel', 'data-method': method, 'aria-label': (labels[method] || method) + ' settings' },
      h('div.sc-tune-head',
        h('div.grow', h('div.sc-tune-name', labels[method] || method), h('div.small.muted', method === s.method ? 'Selected method. Compare mode also uses these settings.' : 'Not the selected method; Compare mode uses these settings.')),
        h('button.btn.btn-sm.btn-secondary.sc-tune-reset', { type: 'button', disabled: !anyChanged, 'data-fk': 'tune-reset-' + method, onClick: function () { resetMethod(method); } }, icon('refresh'), 'Reset to defaults')),
      S.PARAMS[method].map(function (e) { return knobRow(method, e, cur[e.key], defs[e.key]); }),
      h('div.sc-estimate', { 'data-state': est.state, role: 'status', 'aria-live': 'polite' }, icon('clock'), h('span.sc-estimate-text', est.text || 'Run-time estimate appears here.'),
        h('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: function () { est.key = null; scheduleEstimate(true); } }, 'Refresh')));
    return advCard('Solver tuning', 'Every tunable setting of each method, with its default. Settings are saved with the scenario and with every plan, so a plan can be reproduced.', h('div.vstack-sm', seg, panel));
  }
  function buildAdvancedShell() {
    const d = h('details.sc-adv', {
      open: advOpen,
      onToggle: function () { advOpen = d.open; if (advOpen) { const st = getState(); if (st) renderAll(st, false); scheduleEstimate(true); } }
    }, h('summary.sc-adv-summary', icon('gear'), h('span.grow', 'Advanced settings'), h('span.small.muted', 'change with care')));
    if (advOpen) d.setAttribute('open', '');
    return d;
  }

  // ==== view ======================================================================================
  function settingsOf(st) { return st.scenario.settings; }
  function makeBlocks() {
    blocks.banner = block('sc-banner', function (st) {
      const p = activePlan(st);
      return [p ? p.id : null, st.plans, st.scenario.fleet, st.scenario.zones, st.scenario.rally, st.requests, changeLog.version, replanning, engineTick, p ? Math.floor(st.clock.simMin / 5) : 0];
    }, buildBanner);
    blocks.fleet = block('sc-fleet.vstack', function (st) { const p = activePlan(st); return [st.scenario.fleet, st.scenario.hubs, p ? p.id : null]; }, buildFleet);
    blocks.zones = block('sc-zones-panel.vstack', function (st) { return [st.scenario.zones, settingsOf(st).riskRatings, drawing, riskRating]; }, buildZones);
    blocks.rally = block('sc-rally-panel.vstack', function (st) { return [st.scenario.rally, settingsOf(st).maxRallyPoints, st.plans, st.ui.lastPlanId, rallyFilter]; }, buildRally);
    blocks.optimizer = block('sc-b-opt', function (st) { const s = settingsOf(st); return [s.method, s.timeLimitSec]; }, buildOptimizer);
    blocks.weights = block('sc-b-w', function (st) { return [settingsOf(st).weights]; }, buildWeights);
    blocks.counts = block('sc-b-counts', function (st) { return [st.scenario.fleet, st.scenario.hubs]; }, buildFleetShortcut);
    blocks.rallyMax = block('sc-b-rmax', function (st) { return [settingsOf(st).maxRallyPoints]; }, buildRallyShortcut);
    blocks.travel = block('sc-b-travel', function (st) { const s = settingsOf(st); return [s.convoyFactor, s.mpg, s.serviceMin, s.loadMin]; }, buildTravel);
    blocks.periods = block('sc-b-periods', function (st) { return [settingsOf(st).periods]; }, buildPeriods);
    blocks.risk = block('sc-b-risk', function (st) { return [settingsOf(st).riskRatings]; }, buildRisk);
    blocks.mobility = block('sc-b-mob', function (st) { return [settingsOf(st).mobility]; }, buildMobility);
    blocks.dailyUse = block('sc-b-du', function (st) { return [settingsOf(st).dailyUse]; }, buildDailyUse);
    blocks.tuning = block('sc-b-tune', function (st) { const s = settingsOf(st); return [s.methodParams, s.timeLimitSec, s.method, tuneMethod]; }, buildTuning);
  }
  const PANEL_BLOCKS = {
    fleet: ['fleet'],
    zones: ['zones'],
    rally: ['rally'],
    settings: ['optimizer', 'weights', 'counts', 'rallyMax']
  };
  const ADV_BLOCKS = ['travel', 'periods', 'risk', 'mobility', 'dailyUse', 'tuning'];
  let panels = {};
  let tabBtns = {};
  let advEl = null;

  function renderAll(st, force) {
    hookEngine();
    blocks.banner.render(st, force);
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== subtab; });
    Object.keys(tabBtns).forEach(function (k) { tabBtns[k].setAttribute('aria-selected', String(k === subtab)); tabBtns[k].tabIndex = k === subtab ? 0 : -1; });
    (PANEL_BLOCKS[subtab] || []).forEach(function (k) { blocks[k].render(st, force); });
    if (subtab === 'settings' && advOpen) ADV_BLOCKS.forEach(function (k) { blocks[k].render(st, force); });
    if (subtab === 'settings' && advOpen) scheduleEstimateIfStale(st);
  }
  function scheduleEstimateIfStale(st) {
    const method = tuneMethod || st.scenario.settings.method || 'tabu';
    if (estimateKey(st, method) !== est.key) scheduleEstimate();
  }
  function selectSubtab(id, focus) {
    subtab = id;
    const st = getState();
    if (st) renderAll(st, false);
    if (focus && tabBtns[id]) tabBtns[id].focus();
    if (viewRoot) viewRoot.setAttribute('data-subtab', id);
  }

  const view = {
    label: 'Scenario',
    icon: 'sliders',
    mount: function (el, ctx) {
      viewCtx = ctx;
      makeBlocks();
      const tabs = h('div.tabs.sc-tabs', { role: 'tablist', 'aria-label': 'Scenario sections' }, SUBTABS.map(function (t, i) {
        return (tabBtns[t.id] = h('button.tab', {
          type: 'button', role: 'tab', id: 'sc-tab-' + t.id, 'data-subtab': t.id, 'aria-controls': 'sc-panel-' + t.id, 'aria-selected': String(t.id === subtab),
          onClick: function () { selectSubtab(t.id); },
          onKeydown: function (e) {
            const k = e.key;
            if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Home' && k !== 'End') return;
            e.preventDefault();
            const n = SUBTABS.length;
            const j = k === 'Home' ? 0 : k === 'End' ? n - 1 : (i + (k === 'ArrowRight' ? 1 : -1) + n) % n;
            selectSubtab(SUBTABS[j].id, true);
          }
        }, icon(t.icon), h('span', t.label)));
      }));
      panels = {};
      SUBTABS.forEach(function (t) {
        panels[t.id] = h('div.sc-panel', { id: 'sc-panel-' + t.id, role: 'tabpanel', 'aria-labelledby': 'sc-tab-' + t.id, 'data-panel': t.id, hidden: t.id !== subtab });
        (PANEL_BLOCKS[t.id] || []).forEach(function (k) { panels[t.id].appendChild(blocks[k].el); });
      });
      advEl = buildAdvancedShell();
      const advBody = h('div.sc-adv-body.vstack');
      ADV_BLOCKS.forEach(function (k) { advBody.appendChild(blocks[k].el); });
      advEl.appendChild(advBody);
      panels.settings.appendChild(advEl);
      viewRoot = h('div.sc.vstack', { 'data-subtab': subtab }, blocks.banner.el, tabs, SUBTABS.map(function (t) { return panels[t.id]; }));
      el.appendChild(viewRoot);
    },
    update: function (st, ctx) {
      viewCtx = ctx;
      if (!viewRoot) return;
      if (ctx.clockOnly) { blocks.banner.render(st); if (subtab === 'fleet') blocks.fleet.render(st); return; }
      renderAll(st, false);
    },
    onShow: function () { const st = getState(); if (st && viewRoot) renderAll(st, false); },
    unmount: function () {
      if (engineUnsub) { try { engineUnsub(); } catch (e) { /* engine gone */ } engineUnsub = null; }
      viewRoot = null;
    },
    badge: function (st) {
      const p = activePlan(st);
      if (!p) return null;
      const n = contingencyReasons(st, p).length;
      return n ? { text: '!', alert: true } : null;
    }
  };
  ui.registerView('scenario', view);

  // public helpers for other planner views and tests
  ui.scenario = {
    findPlannerMap: findPlannerMap,
    startZoneDrawing: startDrawing,
    rallyDialog: rallyDialog,
    activePlan: activePlan,
    contingencyReasons: contingencyReasons,
    validatePeriods: validatePeriods,
    show: function (sub) { if (SUBTABS.some(function (t) { return t.id === sub; })) { subtab = sub; if (viewRoot) selectSubtab(sub); } ui.plannerTabs.show('scenario'); }
  };

  // ==== fallback planner map (only when no other view registered the 'map' tab) ====================
  function planForMap(st) {
    const a = activePlan(st);
    if (a) return a;
    const id = st.ui.lastPlanId;
    return (id && st.plans.find(function (p) { return p.id === id; })) || null;
  }
  function routesForMap(plan) {
    if (!plan) return [];
    return (plan.routes || []).filter(routeHasStops).map(function (r) {
      const legs = (r.legs || []).map(function (l) { return { coords: legCoords(l, r), depart: l.depart, arrive: l.arrive }; }).filter(function (l) { return l.coords.length > 1; });
      return {
        truckId: r.truckId, color: r.color, legs: legs, depart: r.depart, returnAt: r.returnAt, type: r.type,
        stops: (r.stops || []).map(function (s) { return { lat: s.lat, lon: s.lon, seq: s.seq, label: s.label }; })
      };
    });
  }
  const fallbackMap = {
    label: 'Map', icon: 'map', region: 'center', order: 10,
    mount: function (el, ctx) {
      this.box = h('div.map-fill.sc-fallback-map');
      el.appendChild(this.box);
      this.last = {};
      if (!SRO.ui.map || typeof SRO.ui.map.create !== 'function') { el.appendChild(h('div.notice.notice-error', icon('alert'), 'The map module is not loaded.')); return; }
      try { this.m = SRO.ui.map.create(this.box, { theme: ctx.state.ui.theme }); } catch (e) {
        el.appendChild(h('div.notice.notice-error', icon('alert'), 'The map could not start: ' + e.message));
        this.m = null;
        return;
      }
      const self = this;
      ui.plannerMap = this.m;
      ui.emit('planner:map', this.m);
      this.m.on('click:rally', function (e) { if (e && e.point) rallyDialog(e.point.gridId || e.point.id); });
      this.offFocus = ui.on('planner:focus', function (z) {
        if (!self.m || !z || !SRO.core.geo) return;
        const G = SRO.core.geo;
        self.m.fitTo([0, 90, 180, 270].map(function (b) { return G.destination({ lat: z.lat, lon: z.lon }, b, z.radiusMi || 1); }));
      });
      this.offWant = ui.on('planner:map:want', function (q) { if (q && typeof q.reply === 'function' && self.m) q.reply(self.m); });
    },
    update: function (st) {
      const m = this.m;
      if (!m) return;
      const L = this.last;
      if (L.hubs !== st.scenario.hubs) { L.hubs = st.scenario.hubs; m.setHubs(st.scenario.hubs || []); }
      if (L.zones !== st.scenario.zones) { L.zones = st.scenario.zones; m.setZones(st.scenario.zones || []); }
      const plan = planForMap(st);
      if (L.rally !== st.scenario.rally || L.plan !== plan) { L.rally = st.scenario.rally; m.setRally(rallyMapPoints(st, (plan && plan.rallyPoints) || [])); }
      if (L.requests !== st.requests) {
        L.requests = st.requests;
        m.setPlatoons((st.requests || []).filter(function (r) { return r.status !== 'cancelled' && r.status !== 'delivered'; }));
      }
      if (L.plan !== plan) { L.plan = plan; L.routes = routesForMap(plan); m.setRoutes(L.routes); }
      const now = st.clock.simMin;
      const trucks = [];
      (L.routes || []).forEach(function (r) {
        if (!plan || !plan.approved || !(now >= r.depart && now <= r.returnAt)) return;
        const pos = SRO.ui.map.truckPosition(r, now);
        if (pos) trucks.push({ id: r.truckId, color: r.color, lat: pos.lat, lon: pos.lon, heading: pos.heading, label: r.truckId, type: r.type });
      });
      const key = trucks.map(function (t) { return t.id + t.lat.toFixed(4) + t.lon.toFixed(4); }).join('|');
      if (key !== L.trucks) { L.trucks = key; m.setTrucks(trucks); }
    },
    unmount: function () {
      if (this.offFocus) this.offFocus();
      if (this.offWant) this.offWant();
      if (this.m) {
        if (ui.plannerMap === this.m) ui.plannerMap = null;
        try { this.m.destroy(); } catch (e) { /* gone */ }
        ui.emit('planner:map', null);
        this.m = null;
      }
    }
  };
  ui.onBoot(function () {
    if (ui.plannerTabs && !ui.plannerTabs.has('map')) ui.registerView('map', fallbackMap);
  });
})(typeof self !== 'undefined' ? self : globalThis);
