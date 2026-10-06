// Platoon sergeant: My requests (spec-answers.md Sections 2 and 5 "PSG post-submit card", "Truck
// movement"; DESIGN.md sections 3, 8 and 8b). One card per request made on this device: status,
// urgency, lines, NLT; Edit and Cancel until the plan is approved. Once approved: pickup point (name +
// MGRS) or "Direct to your location", ETA (24 h), truck callsign, frequency and color, "N stops before
// yours", a live line ("Alpha-2: 2 stops before yours. ETA 2000") and a compact map with the truck
// moving along its real road route on the demo clock, the pickup point, the platoon and its line to
// the pickup. Delayed: "Not in this window - next plan at HHMM" with the reason in plain words.
// "Updated" when a re-plan changed the ETA or pickup. Empty state points to New request.
//
// Plan data: plan.byRequest[requestId] = { truckId, stopSeq, nodeKind, gridId, lat, lon, label, eta,
// qtyByLine, deferredQty, stopsBefore } (DESIGN.md 8b; an array of these is accepted for split
// deliveries), plan.routes[].stops / legs (leg.path = encoded polyline5). Without byRequest the card
// reads the route stops' deliveries; without leg paths it routes the legs on the road graph.
//
// VIEW 'psg/myrequests' (tab "My requests", badge = open requests, alert when delayed or updated).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const ui = SRO.ui = SRO.ui || {};
  const psg = ui.psg = ui.psg || {};

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function h() { return ui.h.apply(null, arguments); }
  function icon(n, o) { return ui.icon(n, o); }
  function F() { return SRO.core.format; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  const ACTIVE = ['en_route', 'approved', 'partial', 'delayed', 'planned', 'submitted'];
  const TRACKED = ['approved', 'en_route', 'partial'];
  const DEFER_REASON = {
    capacity: 'All trucks were full this window.',
    time: 'No truck could reach you in time this window.',
    'closed-road': 'Closed roads cut off the route to you.',
    'no-truck': 'No truck was available this window.',
    radius: 'No drop point is within your travel range, and no truck could come direct.'
  };
  // Why a request waits for the next window, in the platoon sergeant's words. The solver's own note
  // (plan.deferred[].note) is written for the planner ("Locked to truck ...", "2400 of 2500 gal
  // loaded", "cost more than carrying it next window") and is not shown here; reason 'capacity'
  // also covers detail 'rally-limit' and 'cost', where "all trucks were full" would be wrong.
  function deferWhy(d) {
    if (!d) return 'It did not fit this window.';
    if (d.reason === 'capacity' && d.detail === 'rally-limit') return 'This window already uses every drop point the planner allows.';
    if (d.reason === 'capacity' && d.detail === 'cost') return 'Higher-priority loads took the truck space this window.';
    if (d.reason === 'no-truck' && d.detail === 'no-vehicle-type') return 'No ' + (d.group === 'fuel' ? 'fuel tanker' : d.group === 'cargo' ? 'cargo truck' : 'truck') + ' was available this window.';
    if (d.reason === 'no-truck' && d.detail && d.detail.indexOf('locked') === 0) return 'The truck the planner set for it is not available this window.';
    return DEFER_REASON[d.reason] || 'It did not fit this window.';
  }
  psg.deferWhy = deferWhy;
  const TYPE_LABEL = { tanker: 'Fuel tanker', cargo: 'Cargo truck' };

  // ==== plan lookup ===================================================================================
  function livePlans(state) {
    return (state.plans || []).filter(function (p) { return p && p.approved && !p.cancelled && !p.superseded; })
      .sort(function (a, b) { return (b.approvedAt || b.createdAt || 0) - (a.approvedAt || a.createdAt || 0); });
  }
  function routeOf(plan, truckId) { return (plan.routes || []).find(function (rt) { return rt.truckId === truckId; }) || null; }
  function entriesFor(plan, r) {
    const out = [];
    const br = plan.byRequest && plan.byRequest[r.id];
    let list = br ? (Array.isArray(br) ? br : [br]) : [];
    // a delivery split over several stops or trucks: the engine lists every stop in byRequest[id].stops
    if (list.length === 1 && Array.isArray(list[0].stops) && list[0].stops.length > 1) {
      const b0 = list[0];
      list = b0.stops.filter(function (x) { return x && x.truckId && !x.done; }).map(function (x) {
        return Object.assign({}, x, { qtyByLine: b0.qtyByLine, deferredQty: b0.deferredQty });
      });
      if (!list.length) list = [b0];
    }
    list.forEach(function (b) {
      if (!b || !b.truckId) return;
      const route = routeOf(plan, b.truckId);
      const stops = (route && route.stops) || [];
      let k = stops.findIndex(function (s) { return s.seq === b.stopSeq; });
      if (k < 0) k = stops.findIndex(function (s) { return (s.deliveries || []).some(function (d) { return d.requestId === r.id; }); });
      const s = stops[k] || {};
      out.push({
        route: route, stopIdx: k, truckId: b.truckId, nodeKind: b.nodeKind || s.kind, gridId: b.gridId || s.gridId,
        lat: isNum(b.lat) ? b.lat : s.lat, lon: isNum(b.lon) ? b.lon : s.lon, label: b.label || s.label || '',
        eta: isNum(b.eta) ? b.eta : s.arrive, qtyByLine: b.qtyByLine || null, deferredQty: b.deferredQty,
        stopsBefore: isNum(b.stopsBefore) ? b.stopsBefore : Math.max(0, k)
      });
    });
    if (!out.length) {
      (plan.routes || []).forEach(function (rt) {
        (rt.stops || []).forEach(function (s, i) {
          const dl = (s.deliveries || []).filter(function (d) { return d.requestId === r.id; });
          if (!dl.length) return;
          out.push({ route: rt, stopIdx: i, truckId: rt.truckId, nodeKind: s.kind, gridId: s.gridId, lat: s.lat, lon: s.lon,
            label: s.label || '', eta: s.arrive, qtyByLine: null, deliveries: dl, stopsBefore: i });
        });
      });
    }
    return out.sort(function (a, b) { return (a.eta || 0) - (b.eta || 0); });
  }
  // -> { plan, entries: [...], deferred: [...] }
  function planInfo(state, r) {
    const plans = livePlans(state);
    let plan = null, entries = [];
    const pref = plans.find(function (p) { return p.id === r.planId; });
    if (pref) { entries = entriesFor(pref, r); if (entries.length) plan = pref; }
    if (!plan) {
      for (let i = 0; i < plans.length; i++) {
        const e = entriesFor(plans[i], r);
        if (e.length) { plan = plans[i]; entries = e; break; }
      }
    }
    let deferred = [];
    const dp = plan ? [plan] : plans;
    for (let i = 0; i < dp.length; i++) {
      const d = (dp[i].deferred || []).filter(function (x) { return x.requestId === r.id; });
      if (d.length) { deferred = d; if (!plan) plan = dp[i]; break; }
    }
    return { plan: plan, entries: entries, deferred: deferred };
  }
  psg.planInfo = planInfo;

  function gridPoint(id) { return (SRO.data.grid || []).find(function (g) { return g.id === id; }) || null; }
  function pickupName(e) {
    if (!e) return '';
    if (e.nodeKind === 'direct') return 'Direct to your location';
    const g = gridPoint(e.gridId);
    const place = g ? psg.placeName(g) : '';
    let lab = String(e.label || '').trim();
    if (lab && lab.length <= 3) lab = 'Drop point ' + lab;
    if (!lab) return place ? 'Drop point at ' + place : 'Drop point';
    return place && lab.toLowerCase().indexOf(place.toLowerCase()) < 0 ? lab + ' · ' + place : lab;
  }
  psg.pickupName = pickupName;

  // Road (mounted) or straight (on foot) line from the platoon to its pickup point.
  function platoonLine(r, e, state) {
    if (!e || e.nodeKind === 'direct' || !isNum(e.lat) || !isNum(r.lat)) return null;
    const from = { lat: r.lat, lon: r.lon }, to = { lat: e.lat, lon: e.lon };
    if (r.mobility === 'mounted') {
      try {
        const closed = (state.scenario.zones || []).filter(function (z) { return z.kind === 'closed'; });
        const p = SRO.core.roads.path(from, to, closed);
        if (p && p.coords && p.coords.length > 1) return { coords: p.coords, miles: p.miles, mode: 'drive' };
      } catch (err) { /* straight below */ }
    }
    return { coords: [[from.lat, from.lon], [to.lat, to.lon]], miles: SRO.core.geo.haversineMi(from, to), mode: 'walk' };
  }

  // Leg geometry with times for the truck animation (cached per plan + truck).
  const geomCache = {};
  function routeGeometry(state, plan, route) {
    const key = plan.id + '|' + route.truckId;
    if (geomCache[key]) return geomCache[key];
    const G = SRO.core.geo;
    const truck = (state.scenario.fleet || []).find(function (t) { return t.id === route.truckId; }) || {};
    const hub = (state.scenario.hubs || []).find(function (x) { return x.id === truck.hubId; }) || null;
    const stops = route.stops || [];
    const legs = route.legs || [];
    const decode = function (L) {
      if (!L) return null;
      if (typeof L.path === 'string' && L.path) { try { return G.decodePolyline(L.path); } catch (e) { return null; } }
      if (Array.isArray(L.path) && L.path.length > 1) return L.path;
      if (Array.isArray(L.coords) && L.coords.length > 1) return L.coords;
      return null;
    };
    let out = [];
    const allDecoded = legs.length && legs.every(function (L) { return decode(L) && isNum(L.depart) && isNum(L.arrive); });
    if (allDecoded) {
      out = legs.map(function (L) { return { coords: decode(L), depart: L.depart, arrive: L.arrive }; });
    } else if (hub && stops.length) {
      const closed = (state.scenario.zones || []).filter(function (z) { return z.kind === 'closed'; });
      const pts = [hub].concat(stops).concat([hub]);
      for (let j = 0; j + 1 < pts.length; j++) {
        const L = legs[j];
        let coords = decode(L);
        if (!coords) {
          try { coords = SRO.core.roads.path({ lat: pts[j].lat, lon: pts[j].lon }, { lat: pts[j + 1].lat, lon: pts[j + 1].lon }, closed).coords; } catch (e) { coords = [[pts[j].lat, pts[j].lon], [pts[j + 1].lat, pts[j + 1].lon]]; }
        }
        const depart = L && isNum(L.depart) ? L.depart : (j === 0 ? route.depart : stops[j - 1].depart);
        const arrive = L && isNum(L.arrive) ? L.arrive : (j < stops.length ? stops[j].arrive : route.returnAt);
        out.push({ coords: coords, depart: depart, arrive: arrive });
      }
    }
    const g = { legs: out, hub: hub, truck: truck };
    geomCache[key] = g;
    return g;
  }

  // Live line for one tracked delivery at simMin.
  function liveText(now, e, callsign, hubName) {
    const rt = e.route, stops = (rt && rt.stops) || [], k = e.stopIdx;
    const my = stops[k];
    const eta = ' ETA ' + psg.time(e.eta, now) + '.';
    if (!my) return callsign + ':' + eta;
    if (!isNum(rt.depart) || now < rt.depart) {
      return callsign + ' loads at ' + (hubName || 'the hub') + ' and departs ' + psg.time(rt.depart, now) + '.' + eta;
    }
    if (now >= my.arrive) {
      if (isNum(my.depart) && now < my.depart) return callsign + (e.nodeKind === 'direct' ? ' is at your location now.' : ' is at your drop point now.');
      return 'Delivered at ' + psg.time(my.arrive, now) + ' by ' + callsign + '.';
    }
    for (let i = 0; i < k; i++) {
      if (now >= stops[i].arrive && now < stops[i].depart) {
        const left = k - i - 1;
        return callsign + ' is at stop ' + (i + 1) + '; ' + (left ? plural(left, 'more stop') + ' before yours.' : 'yours is next.') + eta;
      }
      // once a stop is done, say so: the card's headline keeps the planned count ("2 stops before
      // yours"), and a bare "1 stop before yours" under it reads as a contradiction
      if (now < stops[i].arrive) return callsign + (i ? ' has left stop ' + i + '; ' + plural(k - i, 'more stop') : ': ' + plural(k - i, 'stop')) + ' before yours.' + eta;
    }
    return callsign + ' is on the way to you.' + eta;
  }

  // What one stop brings for this request ('20 cases'; lines joined), from the route's deliveries.
  function stopQty(r, e) {
    const st = e && e.route && e.route.stops && e.route.stops[e.stopIdx];
    const per = {};
    ((st && st.deliveries) || []).forEach(function (d) { if (d.requestId === r.id && isNum(d.qty) && d.qty > 0) per[d.lineIdx] = (per[d.lineIdx] || 0) + d.qty; });
    return Object.keys(per).map(function (i) {
      const l = (r.lines || [])[i];
      return l ? psg.lineQty(Math.round(per[i] * 10) / 10, l.unit) + ((r.lines || []).length > 1 ? ' ' + psg.lineTitle(l) : '') : '';
    }).filter(Boolean).join(', ');
  }

  function partialText(r, e, info, now) {
    const q = e && e.qtyByLine;
    const parts = [], rest = [];
    (r.lines || []).forEach(function (l, i) {
      const got = q ? q[i] : undefined;
      if (!isNum(got) || got >= l.qty - 1e-9) return;
      parts.push(F().number(got) + ' of ' + psg.lineQty(l.qty, l.unit) + ' ' + psg.lineTitle(l));
      rest.push(psg.lineQty(l.qty - got, l.unit) + ' more');
    });
    if (parts.length) return parts.join('; ') + ' at ' + pickupName(e) + ', ETA ' + psg.time(e.eta, now) + '; ' + rest.join(', ') + ' next window.';
    return 'Part of this request comes in this window (ETA ' + psg.time(e && e.eta, now) + '); the rest is carried to the next window.';
  }

  // ==== view ==========================================================================================
  const view = {
    label: 'My requests',
    icon: 'truck',
    order: 20,
    badge: function (state) {
      const mine = psg.userRequests(state);
      const open = mine.filter(function (r) { return ACTIVE.indexOf(r.status) >= 0; });
      if (!open.length) return null;
      const alert = mine.some(function (r) { return r.status === 'delayed' || (r.updated && TRACKED.indexOf(r.status) >= 0); });
      return { text: String(open.length), alert: alert };
    },
    mount: function (el, ctx) {
      this.el = el;
      this.ctx = ctx;
      this.cards = {};
      el.classList.add('psg-mine-view');
      psg.keepScroll(this, el);
      this.head = h('div.psg-head');
      this.list = h('div.psg-req-list');
      el.append(this.head, this.list);
      const self = this;
      this.offTheme = ui.on ? ui.on('theme', function () { self.recolor(); }) : null;
    },
    unmount: function () {
      const self = this;
      Object.keys(this.cards || {}).forEach(function (id) { self.dropMap(self.cards[id]); });
      this.cards = {};
      if (this.offTheme) this.offTheme();
      if (this.offScroll) this.offScroll();
    },
    onHide: function () { psg.hideScroll(this); },
    // Show this request's card the next time the tab is shown (after submit or edit).
    reveal: function (id) { this.revealId = id; },
    doReveal: function () {
      const id = this.revealId;
      if (!id || !this.el || !this.scrollBody) return;
      const card = this.el.querySelector('.psg-req[data-id="' + id + '"]');
      if (!card || !card.getClientRects().length) return;
      this.revealId = null;
      const body = this.scrollBody;
      const top = card.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 8;
      body.scrollTop = Math.max(0, top);
      this.scrollY = body.scrollTop;
    },
    onShow: function () {
      const self = this;
      psg.showScroll(this);
      // maps in a hidden tab have no size; fit them again once visible
      setTimeout(function () { Object.keys(self.cards || {}).forEach(function (id) { const c = self.cards[id]; if (c.map) { c.map.invalidateSize(); self.fitCard(c); } }); }, 0);
    },
    update: function (state, ctx) {
      this.ctx = ctx;
      if (ctx.clockOnly) { this.tick(state); }
      else this.sync(state);
      if (this.revealId) this.doReveal();
    },

    sync: function (state) {
      const self = this;
      const now = Math.floor(state.clock.simMin);
      ui.clear(this.head).append(h('h2.psg-title', 'My requests'),
        this.headSub = h('p.muted.psg-mine-sub', 'Next plan at ' + F().time24(psg.nextPlanAt(now)) + '.'));
      const mine = psg.userRequests(state);
      if (!mine.length) {
        Object.keys(this.cards).forEach(function (id) { self.dropMap(self.cards[id]); });
        this.cards = {};
        ui.clear(this.list).appendChild(h('div.card.card-flush.psg-empty', h('div.empty',
          h('div.empty-icon', icon('truck')),
          h('p.empty-title', state.profile ? 'No requests yet' : 'Set up your unit first'),
          h('p.empty-text', 'Requests you send from this device show here with their pickup point, ETA and truck.'),
          h('div.empty-actions', h('button.btn.btn-primary.psg-empty-new', { type: 'button', onClick: function () { ui.psgTabs.show('request'); } },
            icon('plus'), state.profile ? 'New request' : 'Set up unit')))));
        return;
      }
      const order = function (r) { const i = ACTIVE.indexOf(r.status); return i < 0 ? 100 : i; };
      const active = mine.filter(function (r) { return ACTIVE.indexOf(r.status) >= 0; })
        .sort(function (a, b) { return order(a) - order(b) || (b.createdAt || 0) - (a.createdAt || 0); });
      const done = mine.filter(function (r) { return ACTIVE.indexOf(r.status) < 0; });
      const keep = {};
      const frag = document.createDocumentFragment();
      if (active.length) frag.appendChild(h('div.caps.psg-group-head', 'Open (' + active.length + ')'));
      active.forEach(function (r) { frag.appendChild(self.card(r, state)); keep[r.id] = true; });
      if (done.length) frag.appendChild(h('div.caps.psg-group-head', 'Done'));
      done.forEach(function (r) { frag.appendChild(self.card(r, state)); keep[r.id] = true; });
      Object.keys(this.cards).forEach(function (id) { if (!keep[id]) { self.dropMap(self.cards[id]); delete self.cards[id]; } });
      ui.clear(this.list).appendChild(frag);
      this.tick(state);
    },

    // one card (rebuilt only when what it shows changed; the map survives rebuilds)
    card: function (r, state) {
      const info = TRACKED.indexOf(r.status) >= 0 || r.status === 'delayed' || r.status === 'delivered' ? planInfo(state, r) : { plan: null, entries: [], deferred: [] };
      const e = info.entries[0] || null;
      const sig = JSON.stringify([r.status, r.urgency, r.updated, r.lines, r.nlt, r.deadline, r.eta, r.directOnly, r.desiredPickup, r.remarks, r.cancelledAt, r.deliveredAt,
        info.plan && info.plan.id, info.entries.map(function (x) { return [x.truckId, x.stopIdx, x.eta, x.gridId, x.label, x.nodeKind]; }),
        info.deferred.map(function (d) { return [d.reason, d.detail]; }), state.profile && state.profile.unitName]);
      let c = this.cards[r.id];
      if (c && c.sig === sig) return c.el;
      const mapKey = e && TRACKED.indexOf(r.status) >= 0 && info.plan ? info.plan.id + '|' + e.truckId + '|' + e.stopIdx : null;
      if (c && c.mapKey !== mapKey) this.dropMap(c);
      c = Object.assign(c || {}, { id: r.id, sig: sig, mapKey: mapKey, info: info, entry: e });
      this.cards[r.id] = c;
      c.el = this.renderCard(r, state, c);
      return c.el;
    },

    renderCard: function (r, state, c) {
      const self = this, ctx = this.ctx;
      const now = Math.floor(state.clock.simMin);
      const e = c.entry, info = c.info;
      const urg = r.urgency || r.urgencyRequested || 'Routine';
      const editable = psg.EDITABLE.indexOf(r.status) >= 0;
      const card = h('article.card.psg-req' + (r.updated && r.status !== 'cancelled' ? '.is-updated' : '') + (r.status === 'cancelled' ? '.is-cancelled' : ''),
        { 'data-id': r.id, 'data-status': r.status, 'data-urgency': urg, 'aria-label': 'Request ' + r.id });
      // head
      card.appendChild(h('header.psg-req-head',
        h('div.psg-req-badges',
          h('span.psg-req-id.num', r.id),
          h('span.badge.st-' + r.status, psg.STATUS_LABEL[r.status] || r.status),
          h('span.badge.badge-urgency.urg-' + urg.toLowerCase(), urg),
          r.updated && r.status !== 'cancelled' ? h('span.badge.badge-warn.psg-updated', icon('refresh'), 'Updated') : null),
        h('div.psg-req-meta.small.muted.num', 'Sent ' + psg.time(r.createdAt, now) + ' · NLT ' + psg.time(r.nlt, now) +
          (urg === 'Immediate' && isNum(r.deadline) && r.deadline !== r.nlt ? ' · deadline ' + psg.time(r.deadline, now) : ''))));
      // lines
      card.appendChild(h('ul.psg-req-lines', (r.lines || []).map(function (l) {
        return h('li', h('span.psg-req-qty.num', psg.lineQty(l.qty, l.unit)), h('span.psg-req-item', psg.lineTitle(l)));
      })));
      // status body
      const body = h('div.psg-req-body');
      card.appendChild(body);
      c.live = null;
      if (r.status === 'submitted') {
        c.nextEl = h('strong.num', F().time24(psg.nextPlanAt(now)));
        body.appendChild(h('div.notice.notice-info.psg-status-note', icon('clock'), h('div', 'Waiting for the next plan at ', c.nextEl, '. ',
          h('span.muted', 'Your pickup point and ETA show here once the planner approves it.'))));
      } else if (r.status === 'planned') {
        body.appendChild(h('div.notice.notice-info.psg-status-note', icon('clock'), h('div', 'In a draft plan the planner is reviewing. ', h('span.muted', 'Pickup point and ETA show here once it is approved.'))));
      } else if (r.status === 'delayed') {
        c.nextEl = h('span.num', F().time24(psg.nextPlanAt(now)));
        const why = deferWhy(info.deferred[0]);
        body.appendChild(h('div.notice.notice-error.psg-delayed', icon('alert'), h('div',
          h('strong', 'Not in this window - next plan at ', c.nextEl, '.'), h('div.psg-why', 'Why: ' + why))));
      } else if (r.status === 'cancelled') {
        body.appendChild(h('div.small.faint', 'Cancelled' + (isNum(r.cancelledAt) ? ' at ' + psg.time(r.cancelledAt, now) : '') + '.'));
      } else if (r.status === 'delivered') {
        body.appendChild(h('div.notice.notice-ok.psg-delivered', icon('check'), h('div', 'Delivered' + (isNum(r.deliveredAt) ? ' at ' + psg.time(r.deliveredAt, now) : '') +
          (e ? ' · ' + pickupName(e) + ' · ' + e.truckId : '') + '.')));
      }
      if (TRACKED.indexOf(r.status) >= 0) {
        if (e) this.renderTracking(body, r, state, c, now);
        else body.appendChild(h('div.notice.notice-info', icon('info'), h('div', 'Approved. Pickup details will show here shortly.')));
        if (r.status === 'partial' && e) body.insertBefore(h('div.notice.notice-warn.psg-partial', icon('alert'), h('div', partialText(r, e, info, now))), body.firstChild);
      }
      if (r.updated && r.status !== 'cancelled' && r.status !== 'delivered') {
        body.appendChild(h('div.field-warn.psg-updated-note', icon('refresh'), h('span', 'The plan changed: new ETA or pickup point. Check the details above.')));
      }
      if (r.remarks) card.appendChild(h('div.small.muted.psg-req-remarks', 'Remarks: ' + r.remarks));
      // actions
      if (editable) {
        card.appendChild(h('div.psg-req-actions',
          h('button.btn.btn-secondary.psg-edit', { type: 'button', onClick: function () { psg.request.edit(r.id); } }, icon('edit'), 'Edit'),
          h('button.btn.btn-ghost.psg-cancel', {
            type: 'button',
            onClick: function () {
              ui.confirm({ title: 'Cancel ' + r.id + '?', text: 'It is taken out of the queue and will not be planned. This cannot be undone.', okLabel: 'Cancel request', cancelLabel: 'Keep it', danger: true })
                .then(function (yes) {
                  if (!yes) return;
                  const res = ctx.dispatch({ type: 'request/cancel', id: r.id });
                  if (res && res.ok) ui.toast(r.id + ' cancelled.', 'success');
                  else ui.toast((res && res.error) || 'Could not cancel.', 'error');
                });
            }
          }, icon('x'), 'Cancel request')));
      } else if (TRACKED.indexOf(r.status) >= 0) {
        card.appendChild(h('div.small.faint.psg-locked', 'Approved: this request can no longer be changed here. To change it, contact the planner.'));
      }
      return card;
    },

    renderTracking: function (body, r, state, c, now) {
      const self = this;
      const e = c.entry, plan = c.info.plan;
      const truck = (state.scenario.fleet || []).find(function (t) { return t.id === e.truckId; }) || { id: e.truckId };
      const color = (e.route && e.route.color) || truck.color || '#2F6FE0';
      const hub = (state.scenario.hubs || []).find(function (x) { return x.id === truck.hubId; }) || null;
      const line = platoonLine(r, e, state);
      const direct = e.nodeKind === 'direct';
      const top = h('div.psg-track-top',
        h('div.psg-pickup',
          h('div.caps', direct ? 'Delivery' : 'Pick up at'),
          h('div.psg-pickup-name', pickupName(e)),
          h('div.mono.small.psg-pickup-grid', psg.mgrs(e.lat, e.lon)),
          line ? h('div.small.muted', (line.mode === 'drive' ? 'Drive ' : 'Walk ') + F().miles(line.miles) + ' from you') : null),
        h('div.psg-eta', h('div.caps', 'ETA'), h('div.psg-eta-time.num', F().time24(e.eta)),
          F().dayOf(e.eta) !== F().dayOf(now) ? h('div.small.muted', 'Day ' + F().dayOf(e.eta)) : null));
      const truckRow = h('div.psg-truck-row',
        h('span.truck-chip.psg-truck-chip', { style: { '--truck': color }, title: 'Truck color on the map' }, truck.id),
        h('span.psg-truck-type.small.muted', TYPE_LABEL[truck.type] || 'Truck'),
        h('span.psg-freq', h('span.caps', 'Freq'), ' ', h('span.num', truck.freq || 'n/a')));
      const before = isNum(e.stopsBefore) ? e.stopsBefore : Math.max(0, e.stopIdx);
      const stopsEl = h('div.psg-stops-before', icon('route'), h('span', before === 0 ? 'First stop: no stops before yours' : plural(before, 'stop') + ' before yours'));
      const also = this.alsoList(r, state, c, now);
      c.live = h('div.psg-live', { 'aria-live': 'polite' });
      c.bar = h('div.progress-bar');
      c.callsign = truck.id;
      c.hubName = hub ? hub.name : '';
      body.append(top, truckRow, stopsEl);
      if (also) body.appendChild(also);
      body.append(c.live, h('div.progress.psg-progress', { role: 'presentation' }, c.bar));
      // map
      if (!c.mapHost) {
        c.mapHost = h('div.psg-map.psg-map-track', { role: 'region', 'aria-label': 'Map: truck ' + truck.id + ' route, your pickup point and your location' });
      }
      body.appendChild(h('div.psg-map-wrap', c.mapHost));
      // the map is made once the card is on screen with a size (cards are built detached, and the
      // tab or the whole platoon sergeant column may be hidden when a plan is approved)
      if (!c.map && !c.mapWait) c.mapWait = psg.whenSized(c.mapHost, function () { c.mapWait = null; self.buildMap(c, r, plan, e, color, line); });
    },

    // A delivery split over more than one stop or truck: the other parts, one line each
    // ("Bravo-1 · 20 cases at Daxi (Hwy 3 / Hwy 7), ETA 1015").
    alsoList: function (r, state, c, now) {
      const others = (c.info.entries || []).slice(1);
      if (!others.length) return null;
      return h('div.psg-also',
        h('div.caps', 'Also coming'),
        h('ul.psg-also-list', others.map(function (o) {
          const t = (state.scenario.fleet || []).find(function (x) { return x.id === o.truckId; }) || {};
          const col = (o.route && o.route.color) || t.color || '#2F6FE0';
          const q = stopQty(r, o);
          return h('li', h('span.truck-chip.psg-truck-chip', { style: { '--truck': col } }, o.truckId),
            h('span', (q ? q + ' at ' : '') + pickupName(o) + ', ETA ' + psg.time(o.eta, now)));
        })));
    },

    buildMap: function (c, r, plan, e, color, line) {
      if (!e.route || !c.mapHost) return;
      const state = this.ctx.getState();
      let m;
      try { m = psg.createMap(c.mapHost, { compact: true, tiles: true }); } catch (err) { c.mapHost.appendChild(h('div.notice.notice-warn', icon('alert'), h('div', 'Map unavailable here.'))); return; }
      c.map = m;
      c.mapHost.__sroMap = m;
      // On a touch screen a one-finger swipe over the card map scrolls the list instead of panning
      // the map (it is fitted to the route; pinch and the +/- buttons still zoom).
      try { if (root.matchMedia && root.matchMedia('(pointer: coarse)').matches && m.leaflet.dragging) m.leaflet.dragging.disable(); } catch (err) { /* ignore */ }
      const geom = routeGeometry(state, plan, e.route);
      c.geom = geom;
      const truck = geom.truck || {};
      const stops = e.route.stops || [];
      if (geom.hub) m.setHubs([geom.hub]);
      m.setRoutes([{
        truckId: e.truckId, color: color, label: e.truckId,
        legs: geom.legs.map(function (L) { return { coords: L.coords }; }),
        stops: stops.map(function (s, i) { return { lat: s.lat, lon: s.lon, seq: i + 1 }; })
      }], { highlightTruckId: e.truckId });
      if (e.nodeKind !== 'direct') {
        const radius = r.mobility === 'dismounted' && isNum(r.maxTravelMi) ? r.maxTravelMi : 0;
        m.setRally([{ id: e.gridId || 'pickup', gridId: e.gridId, lat: e.lat, lon: e.lon, label: String(e.label || '').length <= 3 ? e.label : '', name: pickupName(e), used: true, walkRingMi: radius }]);
      }
      m.setPlatoons([{ id: r.id, lat: r.lat, lon: r.lon, unitName: r.unitName, designator: r.designator, mobility: r.mobility, urgency: r.urgency || r.urgencyRequested, directOnly: r.directOnly }]);
      if (line && root.L) {
        c.line = root.L.polyline(line.coords, { pane: 'sro-routes', color: lineColor(), weight: 3, opacity: 0.95, dashArray: line.mode === 'walk' ? '1 7' : '6 6', lineCap: 'round', interactive: false }).addTo(m.leaflet);
      }
      c.truckData = { id: e.truckId, color: color, type: truck.type, label: SRO.ui.symbols && SRO.ui.symbols.shortCallsign ? SRO.ui.symbols.shortCallsign(e.truckId) : e.truckId };
      const pts = [];
      geom.legs.forEach(function (L) { (L.coords || []).forEach(function (p) { pts.push(p); }); });
      pts.push([r.lat, r.lon]);
      c.fitPts = pts;
      this.fitCard(c);
      this.moveTruck(c, state.clock.simMin);
    },
    fitCard: function (c) {
      if (!c.map || !c.fitPts || !c.fitPts.length) return;
      const s = c.map.leaflet.getSize();
      if (!s.x || !s.y) return;
      c.map.fitTo(c.fitPts, { maxZoom: 12, padding: [18, 18], animate: false });
    },
    dropMap: function (c) {
      if (c && c.mapWait) { c.mapWait(); c.mapWait = null; }
      if (c && c.map) psg.destroyMap(c.map);
      if (c) { c.map = null; c.mapHost = null; c.line = null; c.geom = null; }
    },
    recolor: function () {
      const col = lineColor();
      const self = this;
      Object.keys(this.cards || {}).forEach(function (id) { const c = self.cards[id]; if (c.line) c.line.setStyle({ color: col }); });
    },

    moveTruck: function (c, simMin) {
      if (!c.map || !c.geom || !c.geom.legs.length) return null;
      const pos = ui.map.truckPosition({ legs: c.geom.legs }, simMin);
      if (!pos) return null;
      c.map.setTrucks([Object.assign({}, c.truckData, { lat: pos.lat, lon: pos.lon, heading: pos.status === 'en-route' ? pos.heading : null, status: pos.status })]);
      c.pos = pos;
      return pos;
    },

    // clock tick: move trucks, refresh live lines and next-plan times (no rebuilds)
    tick: function (state) {
      const self = this;
      const sim = state.clock.simMin, now = Math.floor(sim);
      const nb = F().time24(psg.nextPlanAt(now));
      if (this.headSub && this.headSub.textContent.indexOf(nb) < 0) this.headSub.textContent = 'Next plan at ' + nb + '.';
      Object.keys(this.cards || {}).forEach(function (id) {
        const c = self.cards[id];
        if (c.nextEl && c.nextEl.textContent !== nb) c.nextEl.textContent = nb;
        if (!c.live || !c.entry) return;
        const e = c.entry;
        const txt = liveText(now, e, c.callsign, c.hubName);
        if (c.live.textContent !== txt) c.live.textContent = txt;
        const dep = e.route && isNum(e.route.depart) ? e.route.depart : null;
        const frac = dep === null || !isNum(e.eta) || e.eta <= dep ? (now >= e.eta ? 1 : 0) : Math.max(0, Math.min(1, (sim - dep) / (e.eta - dep)));
        const w = (frac * 100).toFixed(1) + '%';
        if (c.bar.style.width !== w) c.bar.style.width = w;
        self.moveTruck(c, sim);
      });
    }
  };

  function lineColor() {
    try { return getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#a3afb9'; } catch (e) { return '#a3afb9'; }
  }

  psg.myRequestsView = view;
  if (ui.registerView) ui.registerView('psg/myrequests', view);
})(typeof self !== 'undefined' ? self : globalThis);
