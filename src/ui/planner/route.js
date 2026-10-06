// Planner Route detail (hidden tab under Plan): one truck of the plan on screen.
//
// Stop list in order with arrive / depart DTG, location name + MGRS, deliveries per request with class
// labels and quantities, pickup by the platoon vs direct delivery, the leg before each stop with its
// miles, drive time and time-of-day period; the cost split of the route (fuel, distance, risk,
// simplicity, platoon travel, plus lateness and ETA changes (a re-plan's cost.stability) when there
// are any) as a small bar, or one line for a truck whose trip is already over; near-miss deadlines
// (arrival within 30 minutes of a deadline) and late arrivals flagged; and for delayed requests the
// blocking reason in plain words (plan.deferred reason / note, from explainDeferred). A truck of a
// re-plan that drove into a newly closed road shows the leg it drove, a 'Turned back' point where it
// turned (the 'pos:<truck>' node of the engine) and the leg it is re-routed on from there.
// Opened from a route or truck on the map, a truck card or timeline row in Plan (K.sel.truckId).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const ui = SRO.ui = SRO.ui || {};
  function K() { return ui.plannerKit; }
  const h = function () { return ui.h.apply(null, arguments); };

  const NEAR_MISS_MIN = 30;
  const COSTS = [
    { key: 'fuel', label: 'Fuel' },
    { key: 'distance', label: 'Distance' },
    { key: 'risk', label: 'Risk' },
    { key: 'simplicity', label: 'Simplicity' },
    { key: 'platoon', label: 'Platoon travel' },
    { key: 'lateness', label: 'Late arrival' },
    { key: 'stability', label: 'ETA changes' }
  ];
  const ONLY_WHEN_SET = { lateness: true, stability: true };

  const RouteView = {
    label: 'Route detail', icon: 'route', region: 'right', order: 35, hidden: true, parent: 'plan',

    mount: function (el, ctx) {
      const self = this;
      self.ctx = ctx;
      self.el = el;
      el.classList.add('pr');
      self.offSel = K().onSelect(function (sel, prev) {
        if (sel.truckId !== prev.truckId || sel.planId !== prev.planId) self.render(ctx.getState(), true);
      });
    },
    unmount: function () { if (this.offSel) this.offSel(); },
    onShow: function () { K().select({ routeOpen: true }); },
    onHide: function () { K().select({ routeOpen: false }); },

    update: function (state, ctx) {
      this.ctx = ctx;
      if (ctx.clockOnly) return;
      if (!K().sel.routeOpen && ctx.visible) K().select({ routeOpen: true });
      this.render(state, false);
    },

    render: function (state, force) {
      const self = this, k = K();
      if (!state) return;
      const plan = k.viewedPlan(state);
      const routes = k.usedRoutes(plan);
      let rt = routes.find(function (r) { return r.truckId === k.sel.truckId; }) || null;
      if (!rt && routes.length) rt = routes[0];
      const key = [plan, rt, state.requests, state.scenario.fleet];
      if (!force && self.lastKey && key.every(function (v, i) { return v === self.lastKey[i]; })) return;
      self.lastKey = key;
      const el = self.el;
      ui.clear(el);
      const back = h('button.btn.btn-ghost.btn-sm.pr-back', { type: 'button', 'data-testid': 'route-back', onClick: function () { self.ctx.show('plan'); } }, ui.icon('chevronLeft'), 'Plan');
      if (!plan || !rt) {
        el.appendChild(h('div.pr-top', back));
        el.appendChild(h('div.empty', h('div.empty-icon', ui.icon('route')), h('p.empty-title', 'No route to show'),
          h('p.empty-text', plan ? 'No truck has a stop in this plan.' : 'Make a plan first (Plan, then Plan now). Then pick a route on the map or a truck card.')));
        return;
      }
      if (rt.truckId !== k.sel.truckId) k.sel.truckId = rt.truckId;   // quiet: a fallback, not a user pick
      const t = k.truck(state, rt.truckId) || {};
      const type = rt.type || t.type;
      const color = k.truckColor(state, rt.truckId, rt);
      const hub = k.hubOfTruck(state, rt.truckId, rt);
      const settings = state.scenario.settings || {};

      // top: back + truck switcher
      const sw = routes.length > 1 ? h('select.select.pr-switch', {
        'aria-label': 'Show another truck', 'data-testid': 'route-switch',
        onChange: function (e) { K().select({ truckId: e.target.value }); }
      }, routes.map(function (r) { return h('option', { value: r.truckId, selected: r === rt }, r.truckId + ' (' + k.truckTypeLabel(r.type || (k.truck(state, r.truckId) || {}).type) + ')'); })) : null;
      if (sw) sw.value = rt.truckId;
      el.appendChild(h('div.pr-top', back, sw));

      // header
      el.appendChild(h('div.pr-head', { style: { '--truck': color } },
        h('div.pr-title', h('span.truck-chip', { style: { '--truck': color }, 'data-testid': 'route-truck' }, rt.truckId), h('h2.h2', k.truckTypeLabel(type))),
        h('div.small.muted', (hub ? hub.name : 'Home hub') + (t.freq ? ' · ' + t.freq + ' MHz' : '') + ' · ' + (plan.name || plan.id) + ' (' + k.planStatus(plan).label.toLowerCase() + ')')));
      const load = k.routeLoad(rt, state);
      const trip = k.routeTrip(rt, state);
      const stopped = k.isStoppedRoute(rt);
      const nDone = k.doneStops(rt);
      if (stopped) {
        el.appendChild(h('div.notice.notice-warn.pr-stopped', { 'data-testid': 'route-stopped' }, ui.icon('alert'),
          h('div', rt.out ? rt.truckId + ' was marked out of service after ' + nDone + (nDone === 1 ? ' stop' : ' stops') + '. Its remaining loads went back to the re-plan.'
            : rt.truckId + ' is cut off by a closed road after ' + nDone + (nDone === 1 ? ' stop' : ' stops') + '. Its remaining loads went back to the re-plan; its return time is unknown.')));
      }
      const kv = h('div.pr-facts');
      const fact = function (label, value, testid) { kv.appendChild(h('div.pr-fact', h('span.pr-k', label), h('span.num', { 'data-testid': testid || null }, value))); };
      fact('Depart', k.dtg(rt.depart));
      fact(stopped ? 'Stopped' : 'Return', stopped ? (rt.out ? 'Out of service' : 'Cut off') : k.dtg(rt.returnAt));
      fact('Stops', String((rt.stops || []).length) + (nDone ? ' (' + nDone + ' done)' : ''));
      fact('Miles', k.miles(trip.miles), 'route-miles');
      let driveMin = 0;
      (rt.legs || []).forEach(function (l) { if (k.isNum(l.arrive) && k.isNum(l.depart)) driveMin += Math.max(0, l.arrive - l.depart); });
      fact('Drive time', k.duration(driveMin));
      fact('Fuel used', k.gallons(trip.gallons));
      fact('Load', load.pct + '% · ' + k.num(load.used, load.unit === 'gal' ? 0 : 1) + '/' + k.num(load.capacity, 0) + ' ' + load.unit);
      fact('Risk', k.num(rt.riskUnits, 1));
      el.appendChild(kv);

      // cost split
      el.appendChild(self.costCard(rt, trip));

      // near misses and late arrivals
      const flags = self.deadlineFlags(state, rt, plan);
      if (flags.length) {
        el.appendChild(h('div.card.pr-flags', { 'data-testid': 'near-miss' },
          h('div.card-header', h('h3.card-title', 'Deadlines to watch')),
          h('div.vstack-sm', flags.map(function (f) {
            return h('div.notice.' + (f.late ? 'notice-error' : 'notice-warn'), ui.icon('alert'),
              h('div', h('strong', f.unit + ': '), h('span', f.text)));
          }))));
      }

      // stops
      el.appendChild(h('div.section-head', h('span.caps', 'Stops in order')));
      el.appendChild(self.stopList(state, plan, rt, hub, color, settings));

      // delayed requests
      el.appendChild(self.delayedCard(state, plan, rt));
    },

    costCard: function (rt, trip) {
      const k = K();
      const c = rt.cost || {};
      const parts = COSTS.map(function (x) { return { key: x.key, label: x.label, v: k.isNum(c[x.key]) ? Math.max(0, c[x.key]) : 0 }; })
        .filter(function (x) { return !ONLY_WHEN_SET[x.key] || x.v > 0; });
      const total = parts.reduce(function (a, x) { return a + x.v; }, 0);
      // nothing left to cost in a re-plan (a truck out of service or cut off does not drive on; a truck
      // whose stops are all made is driving home or back already): one line instead of a split of zeros
      const stops = rt.stops || [];
      const finished = stops.length && stops.every(function (st) { return st.done; });
      if (!(total > 0) && (k.isStoppedRoute(rt) || finished)) {
        const why = rt.out ? 'Out of service: the truck does not drive on, so nothing is left to cost in this re-plan.'
          : rt.cutOff ? 'Cut off by a closed road: the truck does not drive on in this plan, so nothing is left to cost.'
            : 'Trip finished: every stop is made, so nothing is left to cost in this re-plan.';
        return h('div.card.pr-cost.pr-cost-done', { 'data-testid': 'cost-split', 'data-empty': rt.out ? 'out' : rt.cutOff ? 'cut-off' : 'done' },
          h('div.card-header', h('div', h('h3.card-title', 'Cost split'), h('div.card-sub', why))));
      }
      const bar = h('div.pr-costbar', { role: 'img', 'aria-label': 'Cost split: ' + parts.map(function (x) { return x.label + ' ' + k.num(x.v, 0); }).join(', ') });
      parts.forEach(function (x) {
        if (total > 0 && x.v > 0) bar.appendChild(h('span.pr-cost-seg.pr-c-' + x.key, { style: { width: (x.v / total * 100).toFixed(2) + '%' }, title: x.label + ' ' + k.num(x.v, 0) }));
      });
      const legend = h('div.pr-cost-legend');
      parts.forEach(function (x) {
        legend.appendChild(h('div.pr-cost-row', { 'data-cost': x.key },
          h('span.pr-cost-sw.pr-c-' + x.key), h('span.pr-cost-l', x.label),
          h('span.num.pr-cost-v', k.num(x.v, 0)),
          h('span.num.faint.pr-cost-p', total > 0 ? Math.round(x.v / total * 100) + '%' : '0%')));
      });
      return h('div.card.pr-cost', { 'data-testid': 'cost-split' },
        h('div.card-header', h('div', h('h3.card-title', 'Cost split'), h('div.card-sub', k.isStoppedRoute(rt) ? 'No cost in this re-plan: the truck does not drive on.'
          : trip && k.isNum(trip.replannedMiles) ? 'Weighted cost points for the re-planned part of this trip (' + k.miles(trip.replannedMiles) + ')' : 'Weighted cost points for this truck')),
          h('span.num.pr-cost-total', k.num(total, 0))),
        bar, legend);
    },

    deadlineFlags: function (state, rt, plan) {
      const k = K();
      const out = [];
      const seen = {};
      (rt.stops || []).forEach(function (st, i) {
        (st.deliveries || []).forEach(function (d) {
          const key = d.requestId + '@' + i;
          if (seen[key]) return;
          seen[key] = true;
          const r = k.request(state, d.requestId);
          if (!r || !k.isNum(st.arrive)) return;
          const dl = k.isNum(r.deadline) ? r.deadline : r.nlt;
          if (!k.isNum(dl)) return;
          const slack = dl - st.arrive;
          const stop = 'stop ' + (st.seq !== undefined ? st.seq : i + 1);
          if (slack < 0) out.push({ late: true, requestId: r.id, unit: r.unitName || r.id, text: 'arrives ' + k.duration(-slack) + ' after the deadline (' + stop + ', ' + k.dtg(st.arrive) + ', deadline ' + k.dtg(dl) + ').' });
          else if (slack <= NEAR_MISS_MIN) out.push({ late: false, requestId: r.id, unit: r.unitName || r.id, text: 'near miss: arrives ' + k.duration(slack) + ' before the deadline (' + stop + ', ' + k.dtg(st.arrive) + ', deadline ' + k.dtg(dl) + ').' });
        });
      });
      return out;
    },

    stopList: function (state, plan, rt, hub, color, settings) {
      const k = K();
      const legs = rt.legs || [];
      const stops = rt.stops || [];
      const list = h('ol.pr-stops', { 'data-testid': 'stop-list' });
      const legRow = function (leg, from, to) {
        if (!leg) return null;
        const mins = k.isNum(leg.arrive) && k.isNum(leg.depart) ? leg.arrive - leg.depart : null;
        const per = k.periodName(leg.period, leg.depart, settings);
        return h('li.pr-leg', { 'aria-label': 'Drive from ' + from + ' to ' + to },
          h('span.pr-leg-line', { style: { '--truck': color } }),
          h('span.pr-leg-text.small.muted.num', [k.isNum(leg.miles) ? k.miles(leg.miles) : null, mins !== null ? k.duration(mins) + ' drive' : null,
            per ? per : null, leg.offRoad ? 'last stretch off road' : null].filter(Boolean).join(' · ')));
      };
      const hubName = hub ? hub.name : 'Home hub';
      const loadStart = k.isNum(rt.loadStart) ? rt.loadStart : null;
      list.appendChild(h('li.pr-stop.is-hub',
        h('span.pr-marker', { style: { '--truck': color } }, ui.icon('truck', { size: 14 })),
        h('div.pr-stop-main',
          h('div.pr-stop-title', hubName, h('span.badge', 'Start')),
          hub ? h('div.small.faint.num', k.mgrs(hub.lat, hub.lon)) : null,
          loadStart !== null ? h('div.small.num', 'Load from ' + k.dtg(loadStart)) : null,
          h('div.small.num', 'Depart ' + k.dtg(rt.depart)))));
      // the leg that ends at each stop: matched by node key (a re-plan can drop the leg of a truck that
      // is already at its next stop), by position when the legs carry no keys
      const before = [];
      let back = null;
      if (legs.length && legs.every(function (l) { return l && l.toKey; }) && stops.every(function (st) { return st && st.nodeKey; })) {
        let p = 0;
        stops.forEach(function (st) {
          let j = p;
          while (j < legs.length && legs[j].toKey !== st.nodeKey) j++;
          if (j < legs.length) { before.push(legs[j]); p = j + 1; } else before.push(null);
        });
        back = p < legs.length ? legs[legs.length - 1] : null;
      } else {
        stops.forEach(function (st, i) { before.push(legs[i] || null); });
        back = legs[stops.length] || null;
      }
      // a leg can be missing (a re-plan keeps only the driven legs of a truck that stopped)
      const add = function (node) { if (node) list.appendChild(node); };
      // a turn-back: the leg driven towards the closed road, the point it turned at, then the leg on
      // from there (before[] holds that last one for the next stop)
      const tb = k.turnBack(rt);
      const tbBefore = tb ? k.legStops(rt).slice(tb.legIndex + 1).find(function (x) { return x >= 0; }) : undefined;
      stops.forEach(function (st, i) {
        const from = i === 0 ? hubName : (stops[i - 1].label || 'previous stop');
        if (tb && tbBefore === i) {
          add(legRow(tb.leg, from, 'the turn-back point'));
          add(RouteView.turnRow(rt, tb, color));
          add(legRow(before[i], 'the turn-back point', st.label || 'stop'));
        } else add(legRow(before[i], from, st.label || 'stop'));
        add(RouteView.stopRow(state, plan, rt, st, i, color, settings));
      });
      if (k.isStoppedRoute(rt)) {
        list.appendChild(h('li.pr-stop.is-hub.is-stopped',
          h('span.pr-marker', { style: { '--truck': color } }, ui.icon('alert', { size: 14 })),
          h('div.pr-stop-main',
            h('div.pr-stop-title', rt.out ? 'Out of service' : 'Cut off by a closed road', h('span.badge.badge-danger', 'Stopped')),
            h('div.small.muted', rt.out ? 'Does not drive on in this plan.' : 'Return to ' + hubName + ': time unknown.'))));
        return list;
      }
      add(legRow(back, stops.length ? stops[stops.length - 1].label : hubName, hubName));
      list.appendChild(h('li.pr-stop.is-hub',
        h('span.pr-marker', { style: { '--truck': color } }, ui.icon('check', { size: 14 })),
        h('div.pr-stop-main',
          h('div.pr-stop-title', hubName, h('span.badge', 'Return')),
          h('div.small.num', 'Back ' + k.dtg(rt.returnAt)))));
      return list;
    },

    turnRow: function (rt, tb, color) {
      const k = K();
      return h('li.pr-stop.pr-turn', { 'data-testid': 'route-turnback' },
        h('span.pr-marker.pr-turn-marker', { style: { '--truck': color } }, ui.icon('refresh', { size: 14 })),
        h('div.pr-stop-main',
          h('div.pr-stop-title', h('span', 'Turned back'), h('span.badge.badge-warn', 'Road closed ahead')),
          k.isNum(tb.lat) ? h('div.small.faint.num', k.mgrs(tb.lat, tb.lon) || '') : null,
          h('div.small.num.pr-times', 'Turned ' + k.dtg(tb.at)),
          h('div.small.muted', rt.truckId + ' was driving into a road the re-plan found closed' + (k.isNum(tb.leg.miles) ? ', after ' + k.miles(tb.leg.miles) + ' of the leg' : '') +
            '. It turned where it was and is routed on from this point' + (tb.nextStop ? ' to ' + (tb.nextStop.label || 'its next stop') : '') + '.')));
    },

    stopRow: function (state, plan, rt, st, i, color, settings) {
      const k = K();
      const seq = st.seq !== undefined ? st.seq : i + 1;
      const rally = st.kind === 'rally';
      const letter = rally ? k.rallyLetter(plan, st.gridId) : '';
      const name = st.label || (st.gridId ? k.gridName(st.gridId) : 'Stop ' + seq);
      const per = k.periodName(st.period, st.arrive, settings);
      // deliveries grouped by request
      const byReq = {}, order = [];
      (st.deliveries || []).forEach(function (d) {
        if (!byReq[d.requestId]) { byReq[d.requestId] = []; order.push(d.requestId); }
        byReq[d.requestId].push(d);
      });
      const pickups = {};
      (st.pickups || []).forEach(function (p) { pickups[p.requestId] = p; });
      const reqs = order.map(function (id) {
        const r = k.request(state, id) || { id: id, lines: [] };
        const urg = r.urgency || 'Routine';
        const dl = k.isNum(r.deadline) ? r.deadline : r.nlt;
        const slack = k.isNum(dl) && k.isNum(st.arrive) ? dl - st.arrive : null;
        const flag = slack === null ? null : slack < 0 ? h('span.badge.badge-danger', 'Late ' + k.duration(-slack))
          : slack <= NEAR_MISS_MIN ? h('span.badge.badge-warn', 'Near miss: ' + k.duration(slack) + ' to spare') : null;
        const pk = pickups[id];
        const how = rally
          ? 'Platoon picks up here' + (pk && k.isNum(pk.platoonMiles) ? ' (drives ' + k.miles(pk.platoonMiles) + ')' : '')
          : 'Delivered to the platoon';
        return h('div.pr-req', { 'data-request': id },
          h('div.hstack.wrap.pr-req-head', h('span.badge.badge-urgency.' + k.urgClass(urg), urg), h('span.pr-req-unit', r.unitName || id), flag),
          h('ul.pr-lines', byReq[id].map(function (d) {
            const line = r.lines && r.lines[d.lineIdx];
            const cls = (line && line.classId) || d.classId;
            return h('li', h('span.pr-line-class', k.classLabel(cls)), ' ', h('span.num', line ? k.lineText(line, d.qty) : k.qty(d.qty, d.unit)),
              line && k.isNum(line.qty) && d.qty < line.qty ? h('span.faint.num', ' (of ' + k.qty(line.qty, k.lineUnit(line, line.qty)) + ')') : null);
          })),
          h('div.small.muted', how + (k.isNum(dl) ? '. Deadline ' + k.dtg(dl) : '') + '.'));
      });
      return h('li.pr-stop', { 'data-seq': String(seq) },
        h('span.pr-marker.num', { style: { '--truck': color } }, String(seq)),
        h('div.pr-stop-main',
          h('div.pr-stop-title', h('span', name), h('span.badge.' + (rally ? 'badge-info' : 'badge-accent'), rally ? 'Rally point' + (letter ? ' ' + letter : '') : 'Direct'),
            st.done ? h('span.badge.badge-ok', 'Done') : null),
          h('div.small.faint.num', k.mgrs(st.lat, st.lon) || ''),
          h('div.small.num.pr-times', 'Arrive ' + k.dtg(st.arrive) + ' · depart ' + k.dtg(st.depart) + (per ? ' · ' + per : '')),
          reqs.length ? h('div.pr-reqs', reqs) : h('div.small.faint', 'No deliveries recorded at this stop.')));
    },

    delayedCard: function (state, plan, rt) {
      const k = K();
      const all = k.delayedRequests(plan);
      const onThis = {};
      (rt.stops || []).forEach(function (st) { (st.deliveries || []).forEach(function (d) { onThis[d.requestId] = true; }); });
      const mine = all.filter(function (x) { return onThis[x.requestId]; });
      const locked = all.filter(function (x) {
        const r = k.request(state, x.requestId);
        return !onThis[x.requestId] && r && r.locks && r.locks.truckId === rt.truckId;
      });
      const other = all.filter(function (x) { return mine.indexOf(x) < 0 && locked.indexOf(x) < 0; });
      const row = function (x) {
        const r = k.request(state, x.requestId) || { id: x.requestId, lines: [] };
        // one line per distinct reason and note (the fuel and cargo loads of a request can differ)
        const reasons = {};
        x.items.forEach(function (d) { reasons[(d.reason || 'other') + '|' + (d.detail || '') + '|' + k.reasonText(d)] = d; });
        return h('div.list-row', { 'data-request': x.requestId },
          h('div.list-row-main',
            h('div.hstack.wrap', h('span.badge.badge-urgency.' + k.urgClass(r.urgency), r.urgency || 'Routine'), h('span.list-row-title', r.unitName || r.id)),
            h('div.list-row-sub.num', x.items.map(function (d) {
              const line = r.lines && r.lines[d.lineIdx];
              return line ? k.classLabel(line.classId) + ', ' + k.lineText(line, d.qty) : k.qty(d.qty, d.unit);
            }).join('; ')),
            Object.keys(reasons).map(function (key) {
              const d = reasons[key];
              return h('div.pr-reason', h('span.badge.badge-danger', k.reasonLabel(d)), h('span', ' ' + k.reasonText(d)));
            })));
      };
      const card = h('div.card.pr-delayed', { 'data-testid': 'route-delayed' },
        h('div.card-header', h('div', h('h3.card-title', 'Delayed requests'),
          h('div.card-sub', all.length ? 'Not fully in this window, and what blocked each.' : 'Nothing in this plan is delayed.'))));
      if (mine.length) {
        card.appendChild(h('div.caps.pr-sub-h', 'Partly on ' + rt.truckId));
        card.appendChild(h('div.list.list-dense', mine.map(row)));
      }
      if (locked.length) {
        card.appendChild(h('div.caps.pr-sub-h', 'Locked to ' + rt.truckId));
        card.appendChild(h('div.list.list-dense', locked.map(row)));
      }
      if (other.length) {
        card.appendChild(h('div.caps.pr-sub-h', mine.length || locked.length ? 'Elsewhere in this plan' : 'In this plan'));
        card.appendChild(h('div.list.list-dense', other.map(row)));
      }
      return card;
    }
  };

  if (ui.registerView) ui.registerView('planner/route', RouteView);
})(typeof self !== 'undefined' ? self : globalThis);
