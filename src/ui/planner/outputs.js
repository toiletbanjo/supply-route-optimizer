// Planner Outputs tab (right panel): movement table per truck (print and CSV), pickup notices per
// platoon (print), snapshots (save, open, compare to previous), history of approved plans by window,
// and data export / import / demo reset. Sources: spec-answers.md Section 6 (Outputs and handoff,
// Save/reload, History) and Section 4 (Contingency: before/after comparison shows moved stops);
// DESIGN.md sections 3 (Plan, snapshots), 8 and 8b (plan.byRequest).
//
// Reads plans exactly as stored (routes / stops / legs / deliveries / deferred / cost / stats); any
// plan in state can be shown. Events: emits 'planner:plan-selected' { planId, source } when the
// planner opens a snapshot or a history entry, so a map or plan view may follow it.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const ui = SRO.ui = SRO.ui || {};
  if (typeof ui.registerView !== 'function' || typeof ui.h !== 'function') return;
  const doc = root.document;
  const h = ui.h;
  const icon = ui.icon;

  const SUBTABS = [
    { id: 'movement', label: 'Movement', icon: 'truck' },
    { id: 'notices', label: 'Notices', icon: 'doc' },
    { id: 'snapshots', label: 'Snapshots', icon: 'layers' },
    { id: 'history', label: 'History', icon: 'clock' },
    { id: 'data', label: 'Data', icon: 'download' }
  ];
  const COST_ROWS = [
    ['total', 'Total cost'], ['fuel', 'Fuel'], ['distance', 'Distance'], ['risk', 'Risk'], ['simplicity', 'Simplicity'],
    ['platoon', 'Platoon travel'], ['lateness', 'Late deliveries'], ['deferral', 'Deferred to next window']
  ];
  const STAT_ROWS = [
    ['requests', 'Requests', 0], ['stops', 'Stops', 0], ['trucksUsed', 'Trucks used', 0], ['miles', 'Miles', 1],
    ['gallons', 'Fuel (gal)', 0], ['riskUnits', 'Risk units', 1], ['late', 'Late requests', 0], ['delayed', 'Delayed requests', 0], ['runtimeSec', 'Solver run time (s)', 1]
  ];
  const LOWER_IS_BETTER = { late: true, delayed: true, miles: true, gallons: true, riskUnits: true };
  const STATUS_ORDER = ['delivered', 'en_route', 'approved', 'partial', 'planned', 'submitted', 'delayed', 'cancelled'];
  const STATUS_TEXT = { delivered: 'delivered', en_route: 'en route', approved: 'approved', partial: 'partial', planned: 'planned', submitted: 'submitted', delayed: 'delayed', cancelled: 'cancelled' };
  const FOOTER = 'Notional data for a class prototype; not a system of record. Times are local (zone H, UTC+8).';

  // ==== helpers ===================================================================================
  function F() { return SRO.core.format; }
  function appStore() { return SRO.app && SRO.app.store; }
  function getState() { const s = appStore(); return s ? s.getState() : null; }
  function dispatch(a) { const s = appStore(); return s ? s.dispatch(a) : { ok: false, error: 'The app is not started yet.' }; }
  function num(x) { return typeof x === 'number' ? x : (typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function dtg(m) { return isNum(m) ? F().dtg(m) : ''; }
  function t24(m) { return isNum(m) ? F().time24(m) : ''; }
  function mgrs(lat, lon) { return isNum(num(lat)) && isNum(num(lon)) ? F().mgrs(num(lat), num(lon)) : ''; }
  function grid() { return (SRO.data && SRO.data.grid) || []; }
  function gridById(id) { return id ? grid().find(function (g) { return g.id === id; }) || null : null; }
  function shortName(name) { return String(name || '').replace(/\s*\(.*\)\s*$/, ''); }
  function cats() { return (SRO.data && SRO.data.catalogHelpers) || null; }
  function methodLabel(m) { const L = (SRO.solver && SRO.solver.METHOD_LABELS) || {}; return L[m] || (m ? String(m) : 'Unknown method'); }
  function reqById(st, id) { return (st.requests || []).find(function (r) { return r.id === id; }) || null; }
  function truckById(st, id) { return (st.scenario.fleet || []).find(function (t) { return t.id === id; }) || null; }
  function unitWord(unit, qty) { const H = cats(); return H && H.unitLabel ? H.unitLabel(unit, qty) : unit; }
  function qtyText(q, unit) { return F().qty(q, unitWord(unit, q)); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }
  function windowOf(st, id) {
    const w = (st.windows || []).find(function (x) { return x.id === id; });
    if (w) return w;
    const C = SRO.core.clock;
    return C && C.parseWindowId ? C.parseWindowId(id) : null;
  }
  function windowText(st, id) { const w = windowOf(st, id); return w ? F().windowLabel(w) : (id || ''); }
  function cssEsc(s) { return root.CSS && root.CSS.escape ? root.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
  function act(a, okMsg) {
    const r = dispatch(a);
    if (!r || !r.ok) { ui.toast((r && r.error) || 'That did not work.', 'error'); return null; }
    if (okMsg) ui.toast(okMsg, 'success');
    return r;
  }
  function hubForTruck(st, truckId, route) {
    const t = truckById(st, truckId);
    const hubs = st.scenario.hubs || [];
    if (t) { const hb = hubs.find(function (x) { return x.id === t.hubId; }); if (hb) return hb; }
    if (route && route.hubId) { const hb = hubs.find(function (x) { return x.id === route.hubId; }); if (hb) return hb; }
    const prefix = String(truckId || '').replace(/-\d+$/, '');
    return hubs.find(function (x) { return x.callsign === prefix; }) || null;
  }
  function hubPoint(hub) { const g = hub ? gridById(hub.gridId) : null; return g || hub || {}; }
  function truckTypeLabel(type) {
    const T = (SRO.data && SRO.data.scenario && SRO.data.scenario.truckTypes) || {};
    return (T[type] && T[type].label) || (type === 'tanker' ? 'Fuel tanker' : type === 'cargo' ? 'Cargo truck' : 'Truck');
  }
  function stopLabel(s) {
    if (s.label) return s.label;
    const g = gridById(s.gridId);
    return g ? shortName(g.name) : (s.kind === 'direct' ? 'Direct delivery' : 'Stop');
  }
  function swap(el, content) {
    const active = doc.activeElement;
    const fk = active && el.contains(active) ? active.getAttribute('data-fk') : null;
    ui.clear(el);
    [].concat(content).forEach(function (n) { if (n) el.appendChild(n); });
    if (fk) { const n = el.querySelector('[data-fk="' + cssEsc(fk) + '"]'); if (n) { try { n.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }
  }
  function same(a, b) { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  function block(cls, deps, build) {
    const el = h('div.' + cls);
    let last = null;
    return { el: el, render: function (st, force) { const d = deps(st); if (!force && last && same(d, last)) return; last = d; swap(el, build(st)); } };
  }

  // ==== plans ======================================================================================
  function planStatus(p) {
    if (p.cancelled) return { text: 'Stopped early', cls: 'badge-warn' };
    if (p.approved) return { text: 'Approved', cls: 'badge-ok' };
    if (p.superseded) return { text: 'Replaced', cls: '' };
    return { text: 'Draft', cls: 'badge-info' };
  }
  function byNewest(a, b) { return (b.approvedAt || b.createdAt || 0) - (a.approvedAt || a.createdAt || 0) || String(b.id).localeCompare(String(a.id)); }
  function autoPlan(st) {
    const appr = (st.plans || []).filter(function (p) { return p.approved && !p.superseded; }).sort(byNewest);
    if (appr.length) return appr[0];
    const last = st.ui.lastPlanId && st.plans.find(function (p) { return p.id === st.ui.lastPlanId; });
    if (last) return last;
    return (st.plans || []).slice().sort(byNewest)[0] || null;
  }
  let selectedPlanId = null;
  function currentPlan(st) {
    if (selectedPlanId) { const p = (st.plans || []).find(function (x) { return x.id === selectedPlanId; }); if (p) return p; }
    return autoPlan(st);
  }
  function planName(p) { return p.name || p.id; }
  // The method label, or '' when the plan's name already says it (engine names plans "<Method>, <DTG>").
  function methodNote(p) {
    const m = methodLabel(p.method);
    return m && planName(p).indexOf(m) < 0 ? m : '';
  }
  function planOptionText(st, p) {
    return [planName(p), planStatus(p).text, methodNote(p), windowText(st, p.windowId)].filter(Boolean).join(' \u00b7 ');
  }
  function planSelect(st, plan, fk) {
    const list = (st.plans || []).slice().sort(function (a, b) {
      const ra = a.approved ? 0 : a.superseded ? 2 : 1, rb = b.approved ? 0 : b.superseded ? 2 : 1;
      return ra - rb || byNewest(a, b);
    });
    const id = 'op-plan-' + fk;
    const sel = h('select.select.op-plan-select', {
      id: id, 'data-fk': fk,
      onChange: function () { selectedPlanId = sel.value || null; ui.emit('planner:plan-selected', { planId: sel.value, source: 'outputs' }); rerender(); }
    }, list.map(function (p) { return h('option', { value: p.id, selected: p.id === plan.id }, planOptionText(st, p)); }));
    return h('div.field.op-plan-field', h('label.field-label', { htmlFor: id }, 'Plan'), sel);
  }
  function usedRoutes(plan) {
    return (plan.routes || []).filter(function (r) { return (r.stops || []).length > 0; })
      .slice().sort(function (a, b) { return (num(a.depart) || 0) - (num(b.depart) || 0) || String(a.truckId).localeCompare(String(b.truckId)); });
  }

  // 'Diesel / JP-8, Diesel (DF-2)': item name and option, comma separated like the other planner
  // views (option labels carry their own parentheses, so no nesting). An item with one option, or an
  // option the item name already contains ('Diesel / JP-8' and JP-8), shows the item name only.
  function itemText(line) {
    const H = cats();
    const it = H && H.itemById ? H.itemById(line.itemId) : null;
    if (!it) return String(line.itemId || 'Item');
    let opt = '';
    if (it.freeText) opt = line.option ? String(line.option) : '';
    else if (it.options.length > 1) { const op = H.optionById(line.itemId, line.option); opt = op ? op.label : ''; }
    // the option only when it adds something (the same rule as plannerKit.itemName): 'Diesel / JP-8'
    // already says JP-8, and an option that contains the name ('AT4 (84 mm)') stands for both
    const nl = it.name.toLowerCase(), ol = opt.toLowerCase();
    if (!ol || ol === nl || (ol.length >= 3 && nl.indexOf(ol) >= 0)) return it.name;
    return nl.length >= 2 && ol.indexOf(nl) >= 0 ? opt : it.name + ', ' + opt;
  }
  // One delivery (or deferred line) -> display parts. Works with lineIdx (number or array) or without.
  function deliveryInfo(st, d) {
    const r = reqById(st, d.requestId);
    const idxs = Array.isArray(d.lineIdx) ? d.lineIdx : (isNum(d.lineIdx) ? [d.lineIdx] : (Array.isArray(d.lineIdxs) ? d.lineIdxs : []));
    let lines = r ? idxs.map(function (i) { return r.lines && r.lines[i]; }).filter(Boolean) : [];
    if (!lines.length && d.itemId) lines = [{ itemId: d.itemId, option: d.option, classId: d.classId }];
    const items = lines.map(itemText);
    const classId = d.classId || (lines[0] && lines[0].classId) || null;
    return {
      requestId: d.requestId,
      platoon: r ? r.unitName : d.requestId,
      designator: r ? r.designator : '',
      classId: classId,
      classLabel: classId ? F().classLabel(classId) : '',
      item: items.length ? items.join('; ') : (d.unit === 'gal' ? 'Bulk fuel' : 'Cargo'),
      qty: d.qty, qtyUnit: d.unit,
      qtyText: isNum(num(d.qty)) ? qtyText(d.qty, d.unit) : ''
    };
  }
  // '1,000 gal Diesel / JP-8, Diesel (DF-2) · Class III (Fuel)'
  function supplyText(d) { return [d.qtyText, d.item].filter(Boolean).join(' ') + (d.classLabel ? ' · ' + d.classLabel : ''); }
  // deliveries with a quantity (a load split can leave a zero-quantity line behind)
  function realDeliveries(s) { return (s.deliveries || []).filter(function (d) { return !(isNum(num(d.qty)) && num(d.qty) <= 0); }); }
  // A re-plan keeps the stops a truck already made (stop.done) and the trucks that stopped on the road
  // (route.out: marked out of service; route.cutOff: cut off by a closed road), which do not drive on.
  function isStopped(route) { return !!(route && (route.out || route.cutOff)); }
  function doneCount(route) { return (route.stops || []).filter(function (s) { return s.done; }).length; }
  // Whole-trip miles and gallons. In a re-plan the solver's route.miles / gallons cover only the part
  // from the truck's next stop on, while stops, legs and times cover the whole trip (the Plan and
  // Route views show the whole trip the same way).
  function routeTrip(st, route) {
    const legs = route.legs || [];
    if (!(route.continued || isStopped(route)) || !legs.length) return { miles: route.miles, gallons: route.gallons };
    const miles = legs.reduce(function (a, l) { return a + (isNum(l.miles) ? l.miles : 0); }, 0);
    const mpg = (st.scenario.settings && st.scenario.settings.mpg) || 2;
    return { miles: miles, gallons: miles / mpg };
  }
  function stoppedText(st, route) {
    if (route.out) {
      const t = truckById(st, route.truckId);
      return 'Out of service' + (t && t.status === 'out' && t.outReason ? ' (' + t.outReason + ')' : '') + ', does not drive on';
    }
    return 'Cut off by a closed road, return time unknown';
  }

  // Movement rows of one route: hub departure, stops, return.
  function routeRows(st, route) {
    const hub = hubForTruck(st, route.truckId, route);
    const hp = hubPoint(hub);
    const rows = [{ seq: 0, kind: 'hub', label: (hub ? hub.name : 'Hub') + ' (load, depart)', lat: hp.lat, lon: hp.lon, arrive: route.loadStart, depart: route.depart, deliveries: [] }];
    (route.stops || []).forEach(function (s, i) {
      rows.push({
        seq: isNum(s.seq) ? s.seq : i + 1, kind: s.kind || 'rally', label: stopLabel(s), gridId: s.gridId, lat: s.lat, lon: s.lon,
        arrive: s.arrive, depart: s.depart, done: !!s.done,
        deliveries: realDeliveries(s).map(function (d) { return deliveryInfo(st, d); }),
        pickups: s.pickups || []
      });
    });
    // a truck that stopped on the road (re-plan) does not return in this plan
    if (isStopped(route)) rows.push({ seq: null, kind: 'stopped', label: stoppedText(st, route), lat: null, lon: null, arrive: null, depart: null, deliveries: [] });
    else rows.push({ seq: null, kind: 'return', label: (hub ? hub.name : 'Hub') + ' (return)', lat: hp.lat, lon: hp.lon, arrive: route.returnAt, depart: null, deliveries: [] });
    return { route: route, hub: hub, truck: truckById(st, route.truckId), rows: rows };
  }
  function truckFreq(st, route) { const t = truckById(st, route.truckId); return (t && t.freq) || route.freq || ''; }

  // ==== CSV =======================================================================================
  function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+@\t\r]/.test(s)) s = "'" + s;                  // keep spreadsheets from running cell text as a formula
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // stop: 0 for the hub start, 1.. for stops, 'return' (or 'stopped' for a truck that stopped on the
  // road in a re-plan); done: 'yes' for a stop a re-plan kept because the truck had already made it.
  const CSV_HEADER = ['plan_id', 'window', 'truck', 'truck_type', 'frequency', 'stop', 'stop_kind', 'location', 'mgrs', 'arrive_dtg', 'depart_dtg',
    'request_id', 'platoon', 'class', 'item', 'qty', 'qty_unit', 'done'];
  function movementCsv(st, plan) {
    const out = [CSV_HEADER.join(',')];
    const win = windowText(st, plan.windowId);
    usedRoutes(plan).forEach(function (route) {
      const rr = routeRows(st, route);
      const base = [plan.id, win, route.truckId, truckTypeLabel(route.type || (rr.truck && rr.truck.type)), truckFreq(st, route)];
      rr.rows.forEach(function (row) {
        const head = base.concat([row.kind === 'return' || row.kind === 'stopped' ? row.kind : String(row.seq), row.kind, row.label, mgrs(row.lat, row.lon), dtg(row.arrive), dtg(row.depart)]);
        const done = row.done ? 'yes' : '';
        if (!row.deliveries.length) { out.push(head.concat(['', '', '', '', '', '', done]).map(csvCell).join(',')); return; }
        row.deliveries.forEach(function (d) {
          out.push(head.concat([d.requestId, d.platoon, d.classLabel, d.item, String(d.qty), unitWord(d.qtyUnit, d.qty), done]).map(csvCell).join(','));
        });
      });
    });
    return '\ufeff' + out.join('\r\n') + '\r\n';
  }
  function fileStamp(st) { return dtg(st.clock.simMin).replace(/\s+/g, '-'); }
  function downloadCsv(st, plan) {
    ui.download('movement-' + plan.id + '-' + (plan.windowId || 'window') + '.csv', movementCsv(st, plan), 'text/csv;charset=utf-8');
    ui.toast('Movement table downloaded as CSV.', 'success');
  }

  // ==== movement table =============================================================================
  // one entry per platoon (a platoon's lines at a stop are listed under its name once)
  function deliveriesCell(list, forPrint) {
    if (!list.length) return forPrint ? '' : h('span.faint', '\u2014');
    const groups = [];
    list.forEach(function (d) {
      let g = groups.find(function (x) { return x.requestId === d.requestId; });
      if (!g) { g = { requestId: d.requestId, platoon: d.platoon, lines: [] }; groups.push(g); }
      g.lines.push(d);
    });
    return h('ul.op-dl', groups.map(function (g) {
      return h('li', { 'data-request': g.requestId }, h('span.op-dl-unit', g.platoon), g.lines.map(function (d) { return h('span.op-dl-what', supplyText(d)); }));
    }));
  }
  function moveTable(rr, forPrint) {
    const tbody = h('tbody', rr.rows.map(function (row) {
      const ends = row.kind === 'hub' || row.kind === 'return' || row.kind === 'stopped';
      return h('tr', { 'data-kind': row.kind, 'data-done': row.done ? 'true' : null, class: [ends ? 'op-hubrow' : '', row.kind === 'stopped' ? 'op-stoprow' : '', row.done ? 'op-donerow' : ''].filter(Boolean).join(' ') || null },
        h('td.op-c-seq.num', { 'data-label': '#' }, row.kind === 'hub' ? 'Start' : ends ? 'End' : String(row.seq)),
        h('td.op-c-loc', { 'data-label': 'Location' }, row.label, row.kind === 'direct' ? h('span.op-direct', ' (direct)') : null,
          row.done ? (forPrint ? h('span.op-direct', ' (done)') : h('span.badge.badge-ok.op-done-badge', 'Done')) : null),
        h('td.op-c-mgrs.num', { 'data-label': 'MGRS' }, mgrs(row.lat, row.lon)),
        h('td.op-c-arr.num', { 'data-label': 'Arrive' }, dtg(row.arrive) || (forPrint || row.kind === 'stopped' ? '' : h('span.faint', '\u2014'))),
        h('td.op-c-dep.num', { 'data-label': 'Depart' }, dtg(row.depart) || (forPrint || row.kind === 'stopped' ? '' : h('span.faint', '\u2014'))),
        h('td.op-c-dl', { 'data-label': 'Deliveries' }, deliveriesCell(row.deliveries, forPrint)),
        // arrive and depart on one line that wraps (shown instead of the two cells in phone-width panels)
        forPrint ? null : h('td.op-c-time', { 'aria-hidden': 'true' }, dtg(row.arrive) ? h('span.op-t', h('span.op-t-k', 'Arr '), dtg(row.arrive)) : null,
          dtg(row.depart) ? h('span.op-t', h('span.op-t-k', 'Dep '), dtg(row.depart)) : null));
    }));
    return h('table.table.table-compact.op-move',
      h('thead', h('tr', h('th', '#'), h('th', 'Location'), h('th', 'MGRS'), h('th', 'Arrive'), h('th', 'Depart'), h('th', 'Deliveries'))),
      tbody);
  }
  // 'Departs 060620H OCT 26 \u00b7 back 061242H OCT 26 \u00b7 4 stops (1 done) \u00b7 217.8 mi \u00b7 109 gal'
  function routeLine(st, r) {
    const stops = (r.stops || []).length, done = doneCount(r);
    const trip = routeTrip(st, r);
    return ['Departs ' + (dtg(r.depart) || F().NA),
      isStopped(r) ? (r.out ? 'out of service' : 'cut off by a closed road') : 'back ' + (dtg(r.returnAt) || F().NA),
      plural(stops, 'stop') + (done ? ' (' + done + ' done)' : ''),
      isNum(num(trip.miles)) ? F().miles(trip.miles) : null, isNum(num(trip.gallons)) ? F().gallons(trip.gallons) : null].filter(Boolean).join(' \u00b7 ');
  }
  function truckHead(st, rr) {
    const r = rr.route;
    return h('div.op-truck-head',
      h('span.truck-chip', { style: { '--truck': r.color || (rr.truck && rr.truck.color) } }, r.truckId),
      h('div.grow',
        h('div.op-truck-title', truckTypeLabel(r.type || (rr.truck && rr.truck.type)) + (rr.hub ? ', ' + rr.hub.name : '') + ' \u00b7 Freq ' + (truckFreq(st, r) || F().NA),
          isStopped(r) ? h('span.badge.badge-danger.op-stop-badge', r.out ? 'Out of service' : 'Cut off') : null),
        h('div.small.muted.num', routeLine(st, r))));
  }
  // One row per request and reason (a request deferred line by line lists its amounts together).
  function deferredRows(st, plan) {
    const out = [];
    const byKey = {};
    (plan.deferred || []).forEach(function (d) {
      const r = reqById(st, d.requestId);
      const reason = d.note || reasonText(d.reason);
      const q = supplyText(deliveryInfo(st, d));
      const key = d.requestId + '|' + reason;
      if (byKey[key]) { if (q) byKey[key].qtyText = byKey[key].qtyText ? byKey[key].qtyText + '; ' + q : q; return; }
      byKey[key] = { requestId: d.requestId, unit: r ? r.unitName : d.requestId, qtyText: q, reason: reason };
      out.push(byKey[key]);
    });
    return out;
  }
  function reasonText(r) {
    return ({ capacity: 'No truck capacity left', time: 'Could not arrive in time', 'closed-road': 'Cut off by a closed road', 'no-truck': 'No truck of the right type', radius: 'No drop point within reach' })[r] || (r ? String(r) : 'Not in this window');
  }
  function planSummaryLine(st, plan) {
    const s = plan.stats || {};
    const parts = [windowText(st, plan.windowId), methodLabel(plan.method)];
    if (plan.approved && isNum(plan.approvedAt)) parts.push('approved ' + dtg(plan.approvedAt));
    else if (isNum(plan.createdAt)) parts.push('made ' + dtg(plan.createdAt));
    // a re-plan's stats count only what was still to drive when it was made
    const left = [];
    if (isNum(s.trucksUsed)) left.push(plural(s.trucksUsed, 'truck'));
    if (isNum(s.stops)) left.push(plural(s.stops, 'stop'));
    if (isNum(s.miles)) left.push(F().miles(s.miles));
    if (isNum(s.gallons)) left.push(F().gallons(s.gallons));
    if (left.length && plan.parentPlanId) left[0] = 'still to drive: ' + left[0];
    return parts.concat(left).join(' \u00b7 ');
  }
  function emptyNoPlan() {
    return h('div.empty.op-empty',
      h('div.empty-icon', icon('route')),
      h('p.empty-title', 'No plan yet'),
      h('p.empty-text', 'Run the optimizer in the Plan tab. The movement table, pickup notices and snapshots appear here once a plan exists.'),
      h('div.empty-actions', h('button.btn.btn-secondary', { type: 'button', onClick: function () { ui.plannerTabs.show('plan'); } }, icon('route'), 'Open Plan')));
  }
  function buildMovement(st) {
    const plan = currentPlan(st);
    if (!plan) return emptyNoPlan();
    const routes = usedRoutes(plan);
    const deferred = deferredRows(st, plan);
    const status = planStatus(plan);
    const head = h('section.card.op-head',
      planSelect(st, plan, 'move-plan'),
      h('div.hstack.wrap.op-head-meta', h('span.badge.' + (status.cls || 'st-cancelled'), status.text), h('span.small.muted.num', planSummaryLine(st, plan))),
      !plan.approved ? h('div.notice.notice-info', icon('info'), 'This plan is not approved. Approve it in the Plan tab to make it the movement schedule.') : null,
      h('div.op-actions',
        h('button.btn.btn-secondary', { type: 'button', 'data-act': 'print-movement', disabled: !routes.length, onClick: function () { printMovement(getState(), plan); } }, icon('print'), 'Print'),
        h('button.btn.btn-secondary', { type: 'button', 'data-act': 'csv', disabled: !routes.length, onClick: function () { downloadCsv(getState(), plan); } }, icon('download'), 'Download CSV')));
    const blocks = routes.map(function (r) {
      const rr = routeRows(st, r);
      return h('section.card.card-flush.card-truck.op-truck', { style: { '--truck': r.color || (rr.truck && rr.truck.color) }, 'data-truck': r.truckId },
        truckHead(st, rr), h('div.op-table-wrap', moveTable(rr, false)));
    });
    const def = deferred.length ? h('section.card.op-deferred',
      h('div.card-header', h('h3.card-title', 'Not in this plan (' + deferred.length + ')'), h('span.badge.badge-danger', 'Deferred')),
      h('ul.list.list-dense', deferred.map(function (d) {
        return h('li.list-row', h('div.list-row-main', h('div.list-row-title', d.unit), h('div.list-row-sub', [d.qtyText, d.reason].filter(Boolean).join(' \u00b7 '))), h('span.list-row-meta.faint', d.requestId));
      }))) : null;
    return [head].concat(routes.length ? blocks : [h('p.muted.op-none', 'This plan sends no trucks.')]).concat([def]);
  }
  function printMovement(st, plan) {
    ui.print(function (pr) {
      pr.appendChild(h('h1.print-title', 'Movement table'));
      pr.appendChild(h('p.print-sub', planName(plan) + ' (' + planStatus(plan).text.toLowerCase() + ') \u00b7 ' + planSummaryLine(st, plan) + ' \u00b7 printed ' + dtg(st.clock.simMin)));
      usedRoutes(plan).forEach(function (r) {
        const rr = routeRows(st, r);
        pr.appendChild(h('section.print-block.op-print-truck', { 'data-truck': r.truckId },
          h('h2.op-print-h', h('span.truck-swatch', { style: { '--truck': r.color } }), ' ' + r.truckId + ' \u00b7 ' + truckTypeLabel(r.type || (rr.truck && rr.truck.type)) + (rr.hub ? ', ' + rr.hub.name : '') + ' \u00b7 Freq ' + (truckFreq(st, r) || F().NA)),
          h('p.print-sub', routeLine(st, r)),
          moveTable(rr, true)));
      });
      const def = deferredRows(st, plan);
      if (def.length) {
        pr.appendChild(h('section.print-block',
          h('h2.op-print-h', 'Not in this plan'),
          h('table', h('thead', h('tr', h('th', 'Request'), h('th', 'Platoon'), h('th', 'Amount'), h('th', 'Reason'))),
            h('tbody', def.map(function (d) { return h('tr', h('td', d.requestId), h('td', d.unit), h('td', d.qtyText), h('td', d.reason)); })))));
      }
      if (plan.parentPlanId) {
        pr.appendChild(h('p.print-sub', 'Re-plan made ' + dtg(plan.createdAt) + ': stops marked done were already made and stay on the schedule.'));
      }
      pr.appendChild(h('p.print-footer', FOOTER));
    }, { title: 'Movement table ' + planName(plan) });
  }

  // ==== pickup notices ===========================================================================
  function noticesFor(st, plan) {
    const map = {};
    const order = [];
    function get(id) {
      if (!map[id]) { map[id] = { requestId: id, request: reqById(st, id), stops: [], deferred: [] }; order.push(id); }
      return map[id];
    }
    usedRoutes(plan).forEach(function (route) {
      (route.stops || []).forEach(function (s, i) {
        const ids = {};
        realDeliveries(s).forEach(function (d) { (ids[d.requestId] = ids[d.requestId] || []).push(d); });
        (s.pickups || []).forEach(function (p) { if (!ids[p.requestId]) ids[p.requestId] = []; });
        // stops still to make before this one on the truck's route (the engine's byRequest.stopsBefore)
        const before = (route.stops || []).slice(0, i).filter(function (x) { return !x.done; }).length;
        Object.keys(ids).forEach(function (rid) {
          get(rid).stops.push({ route: route, stop: s, index: i, before: before, done: !!s.done, deliveries: ids[rid].map(function (d) { return deliveryInfo(st, d); }) });
        });
      });
    });
    (plan.deferred || []).forEach(function (d) { get(d.requestId).deferred.push(d); });
    // a platoon's stops in time order (a request split across a tanker and a cargo truck has two)
    const at = function (x) { const v = num(x.stop.arrive); return isNum(v) ? v : Infinity; };
    order.forEach(function (id) { map[id].stops.sort(function (a, b) { return at(a) - at(b) || String(a.route.truckId).localeCompare(String(b.route.truckId)); }); });
    const first = function (n) { const s = n.stops.find(function (x) { return !x.done; }) || n.stops[0]; return s ? at(s) : Infinity; };
    return order.map(function (id) { return map[id]; }).sort(function (a, b) {
      return (first(a) - first(b)) || String(a.requestId).localeCompare(String(b.requestId));
    });
  }
  // The request was changed by an approved re-plan: its platoon sees "updated". The store flags a
  // new first arrival or pickup point; the re-plan's change list (engine plan.changes, or the same
  // comparison made here) also catches a platoon's later stop moving or changing time, such as the
  // second truck of a split request or the rest of a load after a stop already made.
  let updCache = null;
  function updatedIds(st, plan) {
    if (updCache && updCache.plan === plan && updCache.reqs === st.requests) return updCache.ids;
    const ids = {};
    if (plan && plan.approved) {
      (st.requests || []).forEach(function (r) { if (r.updated && r.planId === plan.id) ids[r.id] = true; });
      if (plan.parentPlanId) {
        let ch = Array.isArray(plan.changes) ? plan.changes.map(function (c) { return c.requestId; }) : null;
        if (!ch) {
          const parent = (st.plans || []).find(function (p) { return p.id === plan.parentPlanId; });
          ch = parent ? diffPlans(st, parent, plan).map(function (d) { return d.id; }) : [];
        }
        ch.forEach(function (id) { ids[id] = true; });
      }
    }
    updCache = { plan: plan, reqs: st.requests, ids: ids };
    return ids;
  }
  function isUpdated(st, plan, r) { return !!(r && updatedIds(st, plan)[r.id]); }
  function nextPlanTime(st, plan) {
    const w = windowOf(st, plan.windowId);
    return w && isNum(w.end) ? w.end : (SRO.core.clock ? SRO.core.clock.nextBoundary(st.clock.simMin) : null);
  }
  function noticeBody(st, plan, n, forPrint) {
    const parts = [];
    n.stops.forEach(function (x, k) {
      const s = x.stop;
      const direct = s.kind === 'direct';
      const t = truckById(st, x.route.truckId);
      parts.push(h('dl.kv.op-notice-kv', { 'data-stop': String(k), 'data-done': x.done ? 'true' : null },
        h('dt', direct ? 'Delivery' : 'Pickup point'), h('dd', direct ? 'Direct to your position' : stopLabel(s)),
        h('dt', 'MGRS'), h('dd.num', mgrs(s.lat, s.lon)),
        h('dt', x.done ? 'Delivered' : 'ETA'), h('dd.num', h('strong', dtg(s.arrive) || F().NA), isNum(s.arrive) ? ' (' + t24(s.arrive) + ' local)' : ''),
        h('dt', 'Truck'), h('dd', forPrint ? h('span', h('span.truck-swatch', { style: { '--truck': x.route.color } }), ' ' + x.route.truckId) : h('span.truck-chip', { style: { '--truck': x.route.color } }, x.route.truckId), ' ', truckTypeLabel(x.route.type || (t && t.type)).toLowerCase()),
        h('dt', 'Frequency'), h('dd.num', (truckFreq(st, x.route) || F().NA) + ' (notional)'),
        x.done ? null : h('dt', 'Stops before'), x.done ? null : h('dd.num', String(x.before)),
        h('dt', 'Supplies'), h('dd', x.deliveries.length ? h('ul.op-dl', x.deliveries.map(function (d) { return h('li', supplyText(d)); })) : 'Pickup only')));
    });
    if (n.deferred.length) {
      const next = nextPlanTime(st, plan);
      const what = n.deferred.map(function (d) { return supplyText(deliveryInfo(st, d)); }).filter(Boolean).join('; ');
      parts.push(h('div.notice.notice-warn.op-notice-def', icon('alert'), h('div',
        h('strong', n.stops.length ? 'Part of this request is not in this window' : 'Not in this window'), what ? ': ' + what + '.' : '.',
        isNum(next) ? ' Next plan at ' + t24(next) + '.' : '')));
    }
    return h('div.op-notice-body', parts);
  }
  function noticeCard(st, plan, n) {
    const r = n.request || {};
    return h('section.card.op-notice', { 'data-request': n.requestId, 'data-urgency': r.urgency || null, 'data-updated': isUpdated(st, plan, n.request) ? 'true' : null },
      h('div.card-header',
        h('div', h('h3.card-title', r.unitName || n.requestId, isUpdated(st, plan, n.request) ? h('span.badge.badge-warn.op-updated', { title: 'A re-plan changed the time or pickup point' }, 'Updated') : null),
          h('div.card-sub', [r.designator, n.requestId, r.urgency].filter(Boolean).join(' \u00b7 '))),
        h('button.btn.btn-sm.btn-ghost', { type: 'button', 'aria-label': 'Print notice for ' + (r.unitName || n.requestId), title: 'Print this notice', onClick: function () { printNotices(getState(), plan, [n.requestId]); } }, icon('print'))),
      noticeBody(st, plan, n, false));
  }
  function buildNotices(st) {
    const plan = currentPlan(st);
    if (!plan) return emptyNoPlan();
    const list = noticesFor(st, plan);
    const head = h('section.card.op-head',
      planSelect(st, plan, 'notice-plan'),
      h('p.small.muted', 'One notice per platoon: where and when to pick up, the truck callsign and its frequency. Print them all (one per page) or one at a time.'),
      h('div.op-actions', h('button.btn.btn-secondary', { type: 'button', 'data-act': 'print-notices', disabled: !list.length, onClick: function () { printNotices(getState(), plan, null); } }, icon('print'), 'Print all notices')));
    return [head].concat(list.length ? list.map(function (n) { return noticeCard(st, plan, n); }) : [h('p.muted.op-none', 'No platoons in this plan.')]);
  }
  function printNotices(st, plan, ids) {
    const list = noticesFor(st, plan).filter(function (n) { return !ids || ids.indexOf(n.requestId) >= 0; });
    ui.print(function (pr) {
      list.forEach(function (n, i) {
        const r = n.request || {};
        pr.appendChild(h('section.print-block.op-print-notice' + (i > 0 ? '.print-break' : ''), { 'data-request': n.requestId },
          h('h1.print-title', 'Pickup notice: ' + (r.unitName || n.requestId) + (isUpdated(st, plan, n.request) ? ' (updated)' : '')),
          h('p.print-sub', (r.designator ? r.designator + ' \u00b7 ' : '') + 'request ' + n.requestId + ' \u00b7 ' + planName(plan) + ', ' + windowText(st, plan.windowId)),
          noticeBody(st, plan, n, true),
          h('p.print-footer', FOOTER)));
      });
    }, { title: 'Pickup notices ' + planName(plan) });
  }

  // ==== compare ===================================================================================
  // Every stop of each request in a plan: { requestId: [{ truckId, label, key, eta, done }] } (a request
  // split across trucks or stops has several, done stops of a re-plan included).
  function assignments(plan) {
    const out = {};
    (plan.routes || []).forEach(function (r) {
      (r.stops || []).forEach(function (s) {
        const seen = {};
        realDeliveries(s).forEach(function (d) {
          if (seen[d.requestId]) return;
          seen[d.requestId] = true;
          (out[d.requestId] = out[d.requestId] || []).push({ truckId: r.truckId, color: r.color, label: stopLabel(s), key: s.nodeKey || s.gridId || (s.lat + ',' + s.lon), eta: num(s.arrive), done: !!s.done });
        });
      });
    });
    Object.keys(out).forEach(function (k) { out[k].sort(function (p, q) { return (p.eta - q.eta) || String(p.truckId).localeCompare(String(q.truckId)); }); });
    return out;
  }
  // Requests whose truck, stop or arrival time differ between plan a (before) and b (after); the same
  // rule as the engine's planChanges (whole minutes): [{ id, unit, kind, from: [stops], to: [stops],
  // truck, place, minutes }] with kind 'moved' (truck or stop), 'time', 'added', 'added-from-deferred',
  // 'deferred' (now wholly deferred), 'partial' (part now deferred), 'restored' (no longer deferred),
  // 'removed'.
  function diffPlans(st, a, b) {
    const A = assignments(a), B = assignments(b);
    const defA = {}, defB = {};
    (a.deferred || []).forEach(function (d) { if (!(num(d.qty) <= 0)) defA[d.requestId] = true; });
    (b.deferred || []).forEach(function (d) { if (!(num(d.qty) <= 0)) defB[d.requestId] = true; });
    const ids = Array.from(new Set(Object.keys(A).concat(Object.keys(B), Object.keys(defA), Object.keys(defB)))).sort();
    const tk = function (s) { return s.truckId + '@' + s.key; };
    const tkt = function (s) { return tk(s) + '@' + Math.round(s.eta); };
    const moved = [];
    ids.forEach(function (id) {
      const x = A[id], y = B[id];
      const r = reqById(st, id);
      const unit = r ? r.unitName : id;
      if (x && y) {
        const kx = x.map(tk), ky = y.map(tk);
        if (kx.slice().sort().join('|') !== ky.slice().sort().join('|')) {
          const from = x.filter(function (s) { return ky.indexOf(tk(s)) < 0; }), to = y.filter(function (s) { return kx.indexOf(tk(s)) < 0; });
          const trucks = function (l) { return l.map(function (s) { return s.truckId; }).sort().join(); };
          const places = function (l) { return l.map(function (s) { return s.key; }).sort().join(); };
          const f = from.length ? from[0] : null, t = to.length ? to[0] : null;
          moved.push({ id: id, unit: unit, kind: 'moved', from: from, to: to, truck: trucks(x) !== trucks(y), place: places(x) !== places(y),
            minutes: f && t && isNum(f.eta) && isNum(t.eta) ? Math.round(t.eta) - Math.round(f.eta) : null });
          return;
        }
        const tx = x.map(tkt), ty = y.map(tkt);
        if (tx.slice().sort().join('|') !== ty.slice().sort().join('|')) {
          const from = x.filter(function (s) { return ty.indexOf(tkt(s)) < 0; }), to = y.filter(function (s) { return tx.indexOf(tkt(s)) < 0; });
          moved.push({ id: id, unit: unit, kind: 'time', from: from, to: to, truck: false, place: false,
            minutes: from.length && to.length ? Math.round(to[0].eta) - Math.round(from[0].eta) : null });
          return;
        }
        if (!defA[id] && defB[id]) moved.push({ id: id, unit: unit, kind: 'partial', from: x, to: y });
        else if (defA[id] && !defB[id]) moved.push({ id: id, unit: unit, kind: 'restored', from: x, to: y });
      } else if (y && !x) moved.push({ id: id, unit: unit, kind: defA[id] ? 'added-from-deferred' : 'added', from: [], to: y });
      else if (x && !y) moved.push({ id: id, unit: unit, kind: defB[id] ? 'deferred' : 'removed', from: x, to: [] });
    });
    return moved;
  }
  function signed(v, dec) {
    if (!isNum(v)) return F().NA;
    const s = F().number(Math.abs(v), dec);
    return v > 0 ? '+' + s : v < 0 ? '\u2212' + s : '0';
  }
  function deltaCell(v, dec, lowerBetter) {
    const cls = !isNum(v) || Math.abs(v) < Math.pow(10, -(dec || 0)) / 2 ? 'faint' : (lowerBetter ? (v < 0 ? 'text-ok' : 'text-danger') : '');
    return h('td.num.' + (cls || 'op-neutral'), signed(v, dec));
  }
  function compareBody(st, a, b, titleA, titleB) {
    const ca = a.cost || {}, cb = b.cost || {}, sa = a.stats || {}, sb = b.stats || {};
    const costT = h('table.table.table-compact.op-cmp',
      h('thead', h('tr', h('th', 'Cost'), h('th.num', titleA), h('th.num', titleB), h('th.num', 'Change'))),
      h('tbody', COST_ROWS.map(function (row) {
        const x = num(ca[row[0]]), y = num(cb[row[0]]);
        return h('tr', { 'data-row': row[0] }, h('td', row[1]), h('td.num', isNum(x) ? F().number(x, 0) : F().NA), h('td.num', isNum(y) ? F().number(y, 0) : F().NA), deltaCell(isNum(x) && isNum(y) ? y - x : NaN, 0, true));
      })));
    const statT = h('table.table.table-compact.op-cmp',
      h('thead', h('tr', h('th', 'Plan'), h('th.num', titleA), h('th.num', titleB), h('th.num', 'Change'))),
      h('tbody', STAT_ROWS.map(function (row) {
        const x = num(sa[row[0]]), y = num(sb[row[0]]);
        return h('tr', { 'data-row': row[0] }, h('td', row[1]), h('td.num', isNum(x) ? F().number(x, row[2]) : F().NA), h('td.num', isNum(y) ? F().number(y, row[2]) : F().NA), deltaCell(isNum(x) && isNum(y) ? y - x : NaN, row[2], !!LOWER_IS_BETTER[row[0]]));
      })));
    const moved = diffPlans(st, a, b);
    const one = function (x) { return x.truckId + ' at ' + x.label + (isNum(x.eta) ? ' ' + t24(x.eta) : ''); };
    const where = function (list) { return list.length ? list.map(one).join('; ') : 'nothing'; };
    const shift = function (m) { return isNum(m.minutes) && Math.abs(m.minutes) >= 1 ? ' (' + (m.minutes > 0 ? '+' : '\u2212') + F().duration(Math.abs(m.minutes)) + ')' : ''; };
    const BADGE = { moved: null, time: ['badge-warn', 'Time'], added: ['badge-ok', 'Added'], 'added-from-deferred': ['badge-ok', 'Added'], deferred: ['badge-danger', 'Deferred'],
      partial: ['badge-danger', 'Part deferred'], restored: ['badge-ok', 'Restored'], removed: ['badge-danger', 'Removed'] };
    const movedList = moved.length ? h('ul.list.list-dense.op-moved', moved.map(function (m) {
      let text;
      if (m.kind === 'moved' || m.kind === 'time') {
        text = m.from.length && m.to.length ? where(m.from) + ' \u2192 ' + where(m.to) + shift(m) : m.from.length ? 'No longer at ' + where(m.from) : 'Also at ' + where(m.to);
      }
      else if (m.kind === 'added' || m.kind === 'added-from-deferred') text = 'Now planned: ' + where(m.to) + (m.kind === 'added-from-deferred' ? ' (was deferred)' : '');
      else if (m.kind === 'deferred') text = 'Now deferred to the next window (was ' + where(m.from) + ')';
      else if (m.kind === 'partial') text = 'Part now deferred to the next window; the rest stays: ' + where(m.to);
      else if (m.kind === 'restored') text = 'No longer deferred: ' + where(m.to);
      else text = 'No longer in the plan (was ' + where(m.from) + ')';
      const badge = m.kind === 'moved' ? ['badge-warn', m.truck ? 'Truck' : 'Place'] : BADGE[m.kind];
      return h('li.list-row', { 'data-request': m.id, 'data-kind': m.kind },
        h('div.list-row-main', h('div.list-row-title', m.unit), h('div.list-row-sub.num', text)),
        h('span.badge.' + badge[0], badge[1]));
    })) : h('p.muted', 'No stop moved: every request has the same truck, place and arrival time.');
    const desc = function (p) { const m = methodNote(p); return planName(p) + (m ? ' (' + m + ')' : ''); };
    const replan = b.parentPlanId && b.parentPlanId === a.id;
    return h('div.vstack.op-compare',
      h('p.small.muted', titleA + ': ' + desc(a) + '. ' + titleB + ': ' + desc(b) + '. Negative changes in cost are better.'),
      replan ? h('p.small.muted.op-cmp-note', 'The re-plan was made ' + dtg(b.createdAt) + ' and its totals count only what was still to drive then; the earlier plan\'s totals count its whole trips. Moved stops compare every stop.') : null,
      h('div.op-cmp-wrap', costT), h('div.op-cmp-wrap', statT),
      h('div.section-head', h('span.caps', 'Moved stops (' + moved.length + ')')), movedList);
  }
  function openCompare(st, a, b, titleA, titleB, heading) {
    ui.modal.open({
      title: heading || 'Compare plans',
      size: 'lg',
      body: function (el) { el.appendChild(compareBody(st, a, b, titleA, titleB)); },
      actions: [{ label: 'Close', kind: 'secondary' }]
    });
  }
  ui.outputs = { diffPlans: diffPlans, movementCsv: movementCsv, noticesFor: noticesFor, openCompare: openCompare };

  // ==== snapshots =================================================================================
  function snapshotList(st) { return (st.snapshots || []).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0) || String(b.id).localeCompare(String(a.id)); }); }
  function openPlan(planId, source, msg) {
    selectedPlanId = planId;
    ui.emit('planner:plan-selected', { planId: planId, source: source });
    selectSubtab('movement');
    if (msg) ui.toast(msg, 'info');
  }
  function buildSnapshots(st) {
    const plan = currentPlan(st);
    const out = [];
    if (plan) {
      const nameIn = h('input.input#op-snap-name', { type: 'text', maxlength: 60, placeholder: 'e.g. Before contingency', 'data-fk': 'snap-name' });
      const save = function () {
        const p = currentPlan(getState());
        const r = act({ type: 'snapshot/save', name: nameIn.value.trim(), planId: p.id });
        if (r) ui.toast('Snapshot saved: ' + (nameIn.value.trim() || 'Snapshot ' + getState().snapshots.length) + '.', 'success');
      };
      out.push(h('section.card.op-head',
        h('div.card-header', h('div', h('h3.card-title', 'Save a snapshot'), h('div.card-sub', 'Keeps a named copy of a plan with the settings that made it, for before / after comparisons.'))),
        planSelect(st, plan, 'snap-plan'),
        h('div.field', h('label.field-label', { htmlFor: 'op-snap-name' }, 'Name'),
          h('div.hstack.op-snap-row', nameIn, h('button.btn.btn-primary', { type: 'button', 'data-act': 'snap-save', onClick: save }, 'Save snapshot')))));
      nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    } else out.push(emptyNoPlan());
    const snaps = snapshotList(st);
    if (!snaps.length) {
      out.push(h('p.muted.op-none', 'No snapshots yet.'));
      return out;
    }
    const byOld = snaps.slice().reverse();
    out.push(h('div.section-head', h('span.caps', 'Snapshots (' + snaps.length + ')')));
    out.push(h('ul.list.op-snaps', snaps.map(function (sn) {
      const p = (st.plans || []).find(function (x) { return x.id === sn.planId; });
      const prev = byOld[byOld.indexOf(sn) - 1] || null;
      const prevPlan = prev ? (st.plans || []).find(function (x) { return x.id === prev.planId; }) : null;
      const cost = p && p.cost && isNum(p.cost.total) ? 'cost ' + F().number(p.cost.total, 0) : '';
      return h('li.list-row.op-snap', { 'data-snapshot': sn.id },
        h('div.list-row-main',
          h('div.list-row-title', sn.name),
          h('div.list-row-sub.num', ['Saved ' + dtg(sn.createdAt), p ? planName(p) + ' (' + planStatus(p).text.toLowerCase() + ')' : 'plan missing', p ? methodNote(p) : '', cost].filter(Boolean).join(' \u00b7 '))),
        h('div.op-snap-actions',
          h('button.btn.btn-sm.btn-secondary', { type: 'button', 'data-act': 'snap-open', disabled: !p, onClick: function () { openPlan(sn.planId, 'snapshot', 'Showing snapshot "' + sn.name + '" (' + planName(p) + ').'); } }, 'Open'),
          h('button.btn.btn-sm.btn-secondary', {
            type: 'button', 'data-act': 'snap-compare', disabled: !(p && prevPlan), title: prev ? 'Compare with "' + prev.name + '"' : 'No earlier snapshot',
            onClick: function () { openCompare(getState(), prevPlan, p, 'Previous', 'This', 'Compare "' + sn.name + '" with "' + prev.name + '"'); }
          }, 'Compare to previous')));
    })));
    return out;
  }

  // ==== history ===================================================================================
  function requestCounts(st, windowId) {
    const c = {};
    (st.requests || []).forEach(function (r) { if (r.windowId === windowId) c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }
  function countsText(c) {
    const parts = STATUS_ORDER.filter(function (k) { return c[k]; }).map(function (k) { return c[k] + ' ' + STATUS_TEXT[k]; });
    return parts.length ? parts.join(', ') : 'no requests';
  }
  function buildHistory(st) {
    const wins = (st.windows || []).filter(function (w) {
      return (st.plans || []).some(function (p) { return p.windowId === w.id && (p.approved || p.superseded); });
    }).sort(function (a, b) { return b.start - a.start; });
    if (!wins.length) {
      return h('div.empty.op-empty', h('div.empty-icon', icon('clock')), h('p.empty-title', 'No approved plans yet'),
        h('p.empty-text', 'Each planning window appears here once a plan for it is approved, with its requests, the approved plan and final statuses.'));
    }
    return wins.map(function (w) {
      const plans = (st.plans || []).filter(function (p) { return p.windowId === w.id && (p.approved || p.superseded); }).sort(byNewest);
      const current = plans.find(function (p) { return p.approved; }) || null;
      const c = requestCounts(st, w.id);
      const total = Object.keys(c).reduce(function (s, k) { return s + c[k]; }, 0);
      return h('section.card.op-window', { 'data-window': w.id },
        h('div.card-header',
          h('div', h('h3.card-title', F().windowLabel(w)), h('div.card-sub.num', plural(total, 'request') + ': ' + countsText(c))),
          h('span.badge.' + (w.status === 'approved' ? 'badge-ok' : 'badge-info'), w.status === 'approved' ? 'Approved' : w.status === 'planned' ? 'Planned' : 'Open')),
        h('ul.list.list-dense', plans.map(function (p) {
          const s = p.stats || {};
          const parent = p.parentPlanId ? (st.plans || []).find(function (x) { return x.id === p.parentPlanId; }) : null;
          const replaced = plans.find(function (x) { return x.supersededBy === p.id; }) || parent;
          return h('li.list-row.op-hplan', { 'data-plan': p.id, 'data-approved': String(!!p.approved) },
            h('div.list-row-main',
              h('div.list-row-title', planName(p), ' ', h('span.badge.' + (p.approved ? 'badge-ok' : 'st-cancelled'), p.approved ? 'Approved' : 'Replaced'), p.parentPlanId ? h('span.badge.badge-warn.op-replan-badge', 'Re-plan') : null),
              h('div.list-row-sub.num', [methodNote(p), isNum(p.approvedAt) ? 'approved ' + dtg(p.approvedAt) : '', p.cost && isNum(p.cost.total) ? 'cost ' + F().number(p.cost.total, 0) : '',
                isNum(s.trucksUsed) ? plural(s.trucksUsed, 'truck') : '', isNum(s.miles) ? F().miles(s.miles) : '', isNum(s.delayed) && s.delayed ? s.delayed + ' delayed' : ''].filter(Boolean).join(' \u00b7 '))),
            h('div.op-snap-actions',
              h('button.btn.btn-sm.btn-secondary', { type: 'button', 'data-act': 'hist-open', onClick: function () { openPlan(p.id, 'history', 'Showing ' + planName(p) + '.'); } }, 'Movement'),
              replaced && replaced !== p ? h('button.btn.btn-sm.btn-secondary', { type: 'button', 'data-act': 'hist-compare', onClick: function () { openCompare(getState(), replaced, p, 'Before', 'After', 'Before and after: ' + planName(p)); } }, 'Compare') : null));
        })),
        windowRequests(st, w.id, total, current));
    });
  }
  // the window's requests and where each one ended up (collapsed)
  function windowRequests(st, windowId, total, current) {
    if (!total) return null;
    const list = (st.requests || []).filter(function (r) { return r.windowId === windowId; }).sort(function (a, b) {
      return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || String(a.id).localeCompare(String(b.id));
    });
    const d = h('details.op-hreqs', { 'data-window': windowId, open: !!openReqs[windowId], onToggle: function () { openReqs[windowId] = d.open; } },
      h('summary.op-hreqs-sum', 'Requests (' + total + ')'),
      h('ul.list.list-dense.op-hreq-list', list.map(function (r) {
        return h('li.list-row.op-hreq', { 'data-request': r.id },
          h('div.list-row-main', h('div.list-row-title', r.unitName || r.id), h('div.list-row-sub.num', [r.id, r.urgency, isNum(r.eta) ? 'ETA ' + dtg(r.eta) : ''].filter(Boolean).join(' · '))),
          h('span.badge.st-' + r.status, cap(STATUS_TEXT[r.status] || r.status)), current && isUpdated(st, current, r) ? h('span.badge.badge-warn.op-updated', 'Updated') : null);
      })));
    if (openReqs[windowId]) d.setAttribute('open', '');
    return d;
  }
  const openReqs = {};
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  // ==== data =====================================================================================
  function exportData() {
    const s = appStore();
    if (!s) return;
    const text = s.exportJson ? s.exportJson() : JSON.stringify(s.getState(), null, 2);
    ui.download('supply-route-data-' + fileStamp(s.getState()) + '.json', text, 'application/json');
    ui.toast('All data exported.', 'success');
  }
  function importData() {
    if (typeof ui.pickFile !== 'function') return;
    ui.pickFile({ accept: '.json,application/json' }).then(function (file) {
      if (!file) return null;
      return (file.text ? file.text() : new Promise(function (res, rej) { const fr = new root.FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsText(file); }))
        .then(function (text) {
          let parsed;
          try { parsed = SRO.core.store.parseImport(text); } catch (e) { ui.toast('Cannot import ' + file.name + ': ' + e.message, 'error'); return null; }
          const n = (parsed.requests || []).length, p = (parsed.plans || []).length, sn = (parsed.snapshots || []).length;
          return ui.confirm({
            title: 'Import ' + file.name + '?',
            text: 'This replaces everything on this device with the file: ' + plural(n, 'request') + ', ' + plural(p, 'plan') + ', ' + plural(sn, 'snapshot') +
              (parsed.clock && isNum(parsed.clock.simMin) ? ', demo clock ' + dtg(parsed.clock.simMin) : '') + '. Export first if you want to keep the current data.',
            okLabel: 'Import', danger: true
          }).then(function (yes) {
            if (!yes) return;
            const r = act({ type: 'data/import', json: text });
            if (r) { selectedPlanId = null; ui.toast('Imported ' + plural(n, 'request') + ' and ' + plural(p, 'plan') + '.', 'success'); }
          });
        });
    }).catch(function (e) { ui.toast('Import failed: ' + ((e && e.message) || e), 'error'); });
  }
  function resetDemo() {
    const st = getState();
    let keep = null;
    ui.modal.open({
      title: 'Reset the demo?',
      size: 'sm',
      body: function (el) {
        el.appendChild(h('p.modal-text', 'This deletes every request, plan, snapshot and scenario change on this device and starts again at Day 1, 0600 with the default fleet. It cannot be undone; export first to keep a copy.'));
        if (st && st.profile) {
          keep = h('input', { type: 'checkbox', checked: true, id: 'op-keep-profile' });
          el.appendChild(h('label.check', keep, 'Keep the unit profile (' + (st.profile.unitName || 'this device') + ')'));
        }
      },
      actions: [
        { label: 'Cancel', kind: 'secondary' },
        { label: 'Reset demo', kind: 'danger', id: 'reset', onClick: function () {
          const role = getState().ui.role;
          const r = act({ type: 'data/reset', keepProfile: !!(keep && keep.checked) });
          if (!r) return false;
          // data/reset starts from the default role (platoon sergeant); stay on this page instead
          if (role === 'planner') { act({ type: 'role/set', role: 'planner' }); act({ type: 'tab/set', tab: 'outputs' }); }
          selectedPlanId = null;
          ui.toast('Demo reset.', 'success');
          return undefined;
        } }
      ]
    });
  }
  function buildData(st) {
    // the size of the file Export writes (pretty-printed JSON), not of the compact browser copy
    const size = (function () { try { return (SRO.core.store.exportJson(st).length / 1024); } catch (e) { return NaN; } })();
    return [
      h('section.card.op-data',
        h('div.card-header', h('div', h('h3.card-title', 'Export all data'), h('div.card-sub', 'A JSON file with every request, plan, snapshot, the scenario and settings on this device' + (isNum(size) ? ' (about ' + F().number(Math.max(1, size), 0) + ' KB)' : '') + '. Data lives only in this browser, so export to back it up or move it to another device.'))),
        h('div.op-actions', h('button.btn.btn-primary', { type: 'button', 'data-act': 'export', onClick: exportData }, icon('download'), 'Export all data'))),
      h('section.card.op-data',
        h('div.card-header', h('div', h('h3.card-title', 'Import'), h('div.card-sub', 'Load a file made with Export. It replaces everything on this device after you confirm.'))),
        h('div.op-actions', h('button.btn.btn-secondary', { type: 'button', 'data-act': 'import', onClick: importData }, icon('upload'), 'Import from file'))),
      h('section.card.op-data',
        h('div.card-header', h('div', h('h3.card-title', 'Reset demo'), h('div.card-sub', plural((st.requests || []).length, 'request') + ', ' + plural((st.plans || []).length, 'plan') + ' and ' + plural((st.snapshots || []).length, 'snapshot') + ' on this device now.'))),
        h('div.op-actions', h('button.btn.btn-danger', { type: 'button', 'data-act': 'reset', onClick: resetDemo }, icon('trash'), 'Reset demo')))
    ];
  }

  // ==== view =======================================================================================
  let viewRoot = null;
  let subtab = 'movement';
  const tabBtns = {};
  const panels = {};
  const blocks = {};

  function planDeps(st) { return [st.plans, st.requests, st.scenario.fleet, st.scenario.hubs, st.windows, selectedPlanId, st.ui.lastPlanId]; }
  function makeBlocks() {
    blocks.movement = block('op-movement.vstack', planDeps, buildMovement);
    blocks.notices = block('op-notices.vstack', planDeps, buildNotices);
    blocks.snapshots = block('op-snapshots.vstack', function (st) { return [st.snapshots, st.plans, selectedPlanId, st.ui.lastPlanId]; }, buildSnapshots);
    blocks.history = block('op-history.vstack', function (st) { return [st.windows, st.plans, st.requests]; }, buildHistory);
    blocks.data = block('op-dataview.vstack', function (st) { return [st.requests, st.plans, st.snapshots, st.profile]; }, buildData);
  }
  function rerender() { const st = getState(); if (st && viewRoot) render(st, true); }
  function render(st, force) {
    SUBTABS.forEach(function (t) {
      panels[t.id].hidden = t.id !== subtab;
      tabBtns[t.id].setAttribute('aria-selected', String(t.id === subtab));
      tabBtns[t.id].tabIndex = t.id === subtab ? 0 : -1;
    });
    blocks[subtab].render(st, force);
  }
  function selectSubtab(id, focus) {
    subtab = id;
    if (viewRoot) viewRoot.setAttribute('data-subtab', id);
    const st = getState();
    if (st && viewRoot) render(st, false);
    if (focus && tabBtns[id]) tabBtns[id].focus();
  }

  ui.registerView('outputs', {
    label: 'Outputs',
    icon: 'doc',
    mount: function (el) {
      makeBlocks();
      const tabs = h('div.tabs.op-tabs', { role: 'tablist', 'aria-label': 'Output sections' }, SUBTABS.map(function (t, i) {
        return (tabBtns[t.id] = h('button.tab', {
          type: 'button', role: 'tab', id: 'op-tab-' + t.id, 'data-subtab': t.id, 'aria-controls': 'op-panel-' + t.id, 'aria-selected': String(t.id === subtab),
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
      SUBTABS.forEach(function (t) {
        panels[t.id] = h('div.op-panel', { id: 'op-panel-' + t.id, role: 'tabpanel', 'aria-labelledby': 'op-tab-' + t.id, 'data-panel': t.id, hidden: t.id !== subtab }, blocks[t.id].el);
      });
      viewRoot = h('div.op.vstack', { 'data-subtab': subtab }, tabs, SUBTABS.map(function (t) { return panels[t.id]; }));
      el.appendChild(viewRoot);
    },
    update: function (st, ctx) {
      if (!viewRoot || (ctx && ctx.clockOnly)) return;
      render(st, false);
    },
    onShow: function () { const st = getState(); if (st && viewRoot) render(st, false); },
    unmount: function () { viewRoot = null; }
  });
  // a plan picked in another planner view (Plan, map) becomes the plan shown here
  ui.on('planner:plan-selected', function (e) {
    if (!e || !e.planId || e.source === 'outputs' || e.source === 'snapshot' || e.source === 'history') return;
    if (selectedPlanId === e.planId) return;
    selectedPlanId = e.planId;
    rerender();
  });
  ui.outputs.show = function (sub) { if (SUBTABS.some(function (t) { return t.id === sub; })) { subtab = sub; if (viewRoot) selectSubtab(sub); } ui.plannerTabs.show('outputs'); };
})(typeof self !== 'undefined' ? self : globalThis);
