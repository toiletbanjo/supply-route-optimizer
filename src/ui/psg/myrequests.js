// Platoon sergeant: My requests (spec-answers.md Sections 2 and 5 "PSG post-submit card", "Truck
// movement"; DESIGN.md sections 3, 8 and 8b). One card per request made on this device: status,
// urgency, lines, NLT; Edit and Cancel until the plan is approved. Once approved: pickup point (name +
// MGRS) or "Direct to your location", ETA (24 h), truck callsign, frequency and color, "N stops before
// yours" and which ones ("1 Fengyuan 0853 · 2 Direct 1032 · 3 You 1128"), a live line ("Alpha-2: 2 stops
// before yours. ETA 2000") and a compact map with the truck moving along its real road route on the
// demo clock, the pickup point, the platoon and its line to the pickup, closed areas, and a one-line
// key. The map fits the hub, this stop, the platoon and the truck (the whole route stays drawn), and
// fits again when the truck leaves the view, until the platoon sergeant moves the map.
// Delayed: "Not in this window - next plan at HHMM" with the reason in plain words.
// "Updated" with what changed ("Pickup moved to X. ETA 1300 → 1430.", from request.updatedChange) when
// an approved re-plan moved or retimed any of its stops, carried more of it to the next window or
// brought it back; it stays until the platoon sergeant taps the card (or "Got it"), which dispatches
// request/seen, or until a later plan replaces the one that changed it. Partial: "40 of 60 ... ; 20
// more next window" from byRequest qtyByLine / deferredQty. Empty state points to New request.
// Open requests sort by what needs attention: delayed, partial, updated, en route, approved, planned,
// submitted (an updated card keeps its place once seen until the tab is left or a new plan arrives).
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
  // list order: what needs the platoon sergeant first (an updated, tracked request ranks 2)
  const RANK = { delayed: 0, partial: 1, en_route: 3, approved: 4, planned: 5, submitted: 6 };
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

  // 'Updated' shows until seen, or until a later plan replaces the one that changed the request (the
  // store keeps the flag until request/seen).
  function updatedShown(r, info) {
    if (!r || !r.updated || r.status === 'cancelled' || r.status === 'delivered') return false;
    const pid = r.updatedChange && r.updatedChange.planId;
    return !pid || !info || !info.plan || info.plan.id === pid;
  }
  psg.updatedShown = function (state, r) {
    return updatedShown(r, r && r.updated ? planInfo(state, r) : null);
  };

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

  // Per line: what this plan brings (byRequest qtyByLine) and what it carries to the next window
  // (byRequest deferredQty). Without byRequest both come from the plan's route deliveries and
  // plan.deferred. The remainder is never line qty minus qtyByLine: a plan in a later window covers
  // only what an earlier window left, so the line total would overstate what is still to come.
  function perLine(obj) {
    const out = {};
    if (obj && typeof obj === 'object') Object.keys(obj).forEach(function (k) { const v = Number(obj[k]); if (isFinite(v)) out[k] = v; });
    return out;
  }
  function lineAmounts(r, e, info) {
    let got = e && e.qtyByLine && typeof e.qtyByLine === 'object' ? perLine(e.qtyByLine) : null;
    let def = e && e.deferredQty && typeof e.deferredQty === 'object' ? perLine(e.deferredQty) : null;
    if (!got) {
      got = {};
      (((info && info.plan) || {}).routes || []).forEach(function (rt) {
        (rt.stops || []).forEach(function (s) {
          (s.deliveries || []).forEach(function (d) { if (d.requestId === r.id && isNum(d.qty)) got[d.lineIdx] = (got[d.lineIdx] || 0) + d.qty; });
        });
      });
    }
    if (!def) {
      def = {};
      ((info && info.deferred) || []).forEach(function (d) { if (isNum(d.qty)) def[d.lineIdx] = (def[d.lineIdx] || 0) + d.qty; });
    }
    return { got: got, def: def };
  }
  function partialText(r, e, info, now) {
    const q = lineAmounts(r, e, info);
    const parts = [], rest = [];
    const round = function (v) { return Math.round(v * 10) / 10; };
    (r.lines || []).forEach(function (l, i) {
      const def = q.def[i] || 0, got = q.got[i] || 0;
      if (!(def > 1e-9)) return;
      if (got > 1e-9) {
        // what this plan covers for the line; less than the line when an earlier window brought some
        const covered = round(got + def);
        parts.push(F().number(round(got)) + ' of ' + (covered < l.qty - 1e-9 ? 'the remaining ' : '') + psg.lineQty(covered, l.unit) + ' ' + psg.lineTitle(l));
        rest.push(psg.lineQty(round(def), l.unit) + ' more');
      } else {
        rest.push(psg.lineQty(round(def), l.unit) + ' ' + psg.lineTitle(l));
      }
    });
    const eta = psg.time(e && e.eta, now);
    if (parts.length) return parts.join('; ') + ' at ' + pickupName(e) + ', ETA ' + eta + '; ' + rest.join(', ') + ' next window.';
    if (rest.length) return 'Part of this request comes in this window (ETA ' + eta + '); ' + rest.join(', ') + ' next window.';
    return 'Part of this request comes in this window (ETA ' + eta + '); the rest is carried to the next window.';
  }

  // What a re-plan changed, in the platoon sergeant's words, from request.updatedChange (store.js
  // plan/approve): 'Pickup moved to Drop point B · Zhongli. ETA now 1430.'
  const ORDINAL = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth'];
  function changeText(r, now) {
    const c = r.updatedChange;
    if (!c) return 'The plan changed: new ETA or pickup point. Check the details above.';
    const bits = [];
    const where = function (x) { return x.nodeKind === 'direct' ? 'direct to your location' : 'at ' + pickupName(x); };
    const more = c.deferredMore || (c.deferredMore === undefined && c.kind === 'delayed');
    const less = c.deferredLess || (c.deferredLess === undefined && c.kind === 'restored');
    if (more) bits.push(r.status === 'delayed' || c.status === 'deferred' ? 'Moved to the next window' : 'More of it now comes next window');
    else if (less) bits.push(c.status === 'partial' ? 'More of it now comes in this window' : 'Back in this window');
    if (less && !c.pickupMoved && !c.etaChanged && isNum(c.eta) && !isNum(c.prevEta)) {
      bits.push('Pickup ' + where(c) + ', ETA ' + psg.time(c.eta, now));
    }
    if (c.pickupMoved) bits.push(c.nodeKind === 'direct' ? 'Now delivered direct to your location' : 'Pickup moved to ' + pickupName(c));
    if (c.etaChanged) bits.push(isNum(c.prevEta) ? 'ETA ' + psg.time(c.prevEta, now) + ' \u2192 ' + psg.time(c.eta, now) : 'ETA now ' + psg.time(c.eta, now));
    if (c.truckChanged) bits.push('Truck now ' + c.truckId);
    (c.others || []).forEach(function (o) {
      bits.push((ORDINAL[o.order] || 'Another') + ' delivery (' + o.truckId + ') now ' + where(o) + ', ETA ' + psg.time(o.eta, now));
    });
    if (c.fewerStops > 0) bits.push('Now in fewer deliveries');
    if (!bits.length) bits.push('The plan changed. Check the details above');
    return bits.join('. ') + '.';
  }
  psg.changeText = changeText;

  // ==== view ==========================================================================================
  const view = {
    label: 'My requests',
    icon: 'truck',
    order: 20,
    badge: function (state) {
      const mine = psg.userRequests(state);
      const open = mine.filter(function (r) { return ACTIVE.indexOf(r.status) >= 0; });
      if (!open.length) return null;
      const alert = mine.some(function (r) { return r.status === 'delayed' || (r.updated && TRACKED.indexOf(r.status) >= 0 && psg.updatedShown(state, r)); });
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
      // ids sorted as 'updated' since the tab was shown: a card the platoon sergeant has just tapped
      // (seen) keeps its place instead of jumping down the list
      this.sticky = {};
    },
    unmount: function () {
      const self = this;
      Object.keys(this.cards || {}).forEach(function (id) { self.dropMap(self.cards[id]); });
      this.cards = {};
      if (this.offTheme) this.offTheme();
      if (this.offScroll) this.offScroll();
    },
    onHide: function () { psg.hideScroll(this); this.sticky = {}; },
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
      // a new plan starts the order afresh
      const lp = livePlans(state)[0];
      if ((lp && lp.id) !== this.stickyPlan) { this.sticky = {}; this.stickyPlan = lp && lp.id; }
      const sticky = this.sticky;
      const order = function (r) {
        if (RANK[r.status] === undefined) return 100;
        if (TRACKED.indexOf(r.status) >= 0 && RANK[r.status] > 2 && (sticky[r.id] || psg.updatedShown(state, r))) { sticky[r.id] = true; return 2; }
        return RANK[r.status];
      };
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
      // closed areas on the card maps follow the scenario
      Object.keys(this.cards).forEach(function (id) { self.mapZones(self.cards[id], state); });
      this.tick(state);
    },

    // one card (rebuilt only when what it shows changed; the map survives rebuilds)
    card: function (r, state) {
      const info = TRACKED.indexOf(r.status) >= 0 || r.status === 'delayed' || r.status === 'delivered' ? planInfo(state, r) : { plan: null, entries: [], deferred: [] };
      const e = info.entries[0] || null;
      const sig = JSON.stringify([r.status, r.urgency, updatedShown(r, info), r.updatedChange || null, r.lines, r.nlt, r.deadline, r.eta, r.directOnly, r.desiredPickup, r.remarks, r.cancelledAt, r.deliveredAt,
        info.plan && info.plan.id, info.entries.map(function (x) { return [x.truckId, x.stopIdx, x.eta, x.gridId, x.label, x.nodeKind]; }),
        info.deferred.map(function (d) { return [d.reason, d.detail]; }), state.profile && state.profile.unitName,
        !!e && (state.scenario.zones || []).some(function (z) { return z.kind === 'closed'; })]);   // the map key's 'Closed area'
      let c = this.cards[r.id];
      if (c && c.sig === sig) return c.el;
      const mapKey = e && TRACKED.indexOf(r.status) >= 0 && info.plan ? info.plan.id + '|' + e.truckId + '|' + e.stopIdx : null;
      if (c && c.mapKey !== mapKey) this.dropMap(c);
      c = Object.assign(c || {}, { id: r.id, sig: sig, mapKey: mapKey, info: info, entry: e });
      this.cards[r.id] = c;
      c.el = this.renderCard(r, state, c);
      return c.el;
    },

    // 'Updated' until seen: a tap on the card (or its "Got it") -> request/seen. Never on a timer: a
    // platoon sergeant who glances away would miss the change.
    markSeen: function (id) {
      if (!this.ctx) return;
      const r = (this.ctx.getState().requests || []).find(function (x) { return x.id === id; });
      if (r && (r.updated || r.updatedChange)) this.ctx.dispatch({ type: 'request/seen', id: id });
    },

    renderCard: function (r, state, c) {
      const self = this, ctx = this.ctx;
      const now = Math.floor(state.clock.simMin);
      const e = c.entry, info = c.info;
      const urg = r.urgency || r.urgencyRequested || 'Routine';
      const editable = psg.EDITABLE.indexOf(r.status) >= 0;
      const upd = updatedShown(r, info);
      const card = h('article.card.psg-req' + (upd ? '.is-updated' : '') + (r.status === 'cancelled' ? '.is-cancelled' : ''),
        { 'data-id': r.id, 'data-status': r.status, 'data-urgency': urg, 'aria-label': 'Request ' + r.id });
      if (upd) card.addEventListener('click', function () { self.markSeen(r.id); });
      // head
      card.appendChild(h('header.psg-req-head',
        h('div.psg-req-badges',
          h('span.psg-req-id.num', r.id),
          h('span.badge.st-' + r.status, psg.STATUS_LABEL[r.status] || r.status),
          h('span.badge.badge-urgency.urg-' + urg.toLowerCase(), urg),
          upd ? h('span.badge.badge-warn.psg-updated', icon('refresh'), 'Updated') : null),
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
      // what a re-plan changed, first thing in the card, until the platoon sergeant has seen it
      const updNote = upd
        ? h('div.notice.notice-warn.psg-change-note', { role: 'status' }, icon('refresh'), h('div.grow', h('strong', 'Updated: '), h('span.psg-updated-text', changeText(r, now))),
          h('button.btn.btn-sm.btn-ghost.psg-seen', { type: 'button', onClick: function (ev) { ev.stopPropagation(); self.markSeen(r.id); } }, 'Got it'))
        : null;
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
      if (updNote) body.insertBefore(updNote, body.firstChild);
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
      const stopList = before > 0 ? this.stopList(c, e, now) : null;
      const also = this.alsoList(r, state, c, now);
      c.live = h('div.psg-live', { 'aria-live': 'polite' });
      c.bar = h('div.progress-bar');
      c.callsign = truck.id;
      c.hubName = hub ? hub.name : '';
      body.append(top, truckRow, stopsEl);
      if (stopList) body.appendChild(stopList);
      if (also) body.appendChild(also);
      body.append(c.live, h('div.progress.psg-progress', { role: 'presentation' }, c.bar));
      // map
      if (!c.mapHost) {
        c.mapHost = h('div.psg-map.psg-map-track', { role: 'region', 'aria-label': 'Map: truck ' + truck.id + ' route, your stop, your pickup point and your location' });
      }
      body.appendChild(h('div.psg-map-wrap', c.mapHost));
      body.appendChild(this.mapKeyLine(r, e, truck, color, hub, state));
      // the map is made once the card is on screen with a size (cards are built detached, and the
      // tab or the whole platoon sergeant column may be hidden when a plan is approved)
      if (!c.map && !c.mapWait) c.mapWait = psg.whenSized(c.mapHost, function () { c.mapWait = null; self.buildMap(c, r, plan, e, color, line); });
    },

    // Which stops come before theirs, in order, with arrival times (spec-answers: "the delivery schedule
    // (which stops come before theirs)"): '1 Fengyuan 0853 · 2 Direct 1032 · 3 You 1128'. Other
    // platoons' stops are named by the place only, a direct delivery as "Direct".
    stopList: function (c, e, now) {
      const stops = (e.route && e.route.stops) || [];
      if (!(e.stopIdx > 0) || e.stopIdx >= stops.length) return null;
      const mine = {};
      (c.info.entries || []).forEach(function (x) { if (x.truckId === e.truckId && x.stopIdx >= 0) mine[x.stopIdx] = true; });
      mine[e.stopIdx] = true;
      c.stopItems = [];
      return h('ol.psg-stop-list', { 'aria-label': 'Stops in order, with arrival times' }, stops.slice(0, e.stopIdx + 1).map(function (s, i) {
        const you = !!mine[i];
        const g = s.kind === 'direct' ? null : gridPoint(s.gridId);
        const name = you ? 'You' : s.kind === 'direct' ? 'Direct' : (g ? psg.placeName(g) : String(s.label || '').replace(/\s*\(.*\)\s*$/, '')) || 'Drop point';
        const li = h('li' + (you ? '.is-you' : ''), h('span.psg-stop-n.num', String(i + 1)), h('span.psg-stop-name', name), h('span.psg-stop-t.num', psg.time(s.arrive, now)));
        if (!you) c.stopItems.push({ el: li, stop: s });
        return li;
      }));
    },

    // One-line key under the card map: your stop badge, you, the hub, the truck's route, closed areas.
    mapKeyLine: function (r, e, truck, color, hub, state) {
      const S = ui.symbols;
      const sym = function (sidc) { try { const sp = h('span.psg-key-sym', { 'aria-hidden': 'true' }); sp.innerHTML = S.svg(sidc, { size: 13, infoFields: false }); return sp; } catch (err) { return null; } };
      const fg = S && S.textOn ? S.textOn(color) : '#fff';
      const closed = (state.scenario.zones || []).some(function (z) { return z.kind === 'closed'; });
      return h('div.psg-map-key.small', { 'aria-hidden': 'true' },
        h('span.psg-key-item', h('span.psg-key-stop.num', { style: { '--truck': color, '--truck-fg': fg } }, String(e.stopIdx + 1)), 'Your stop'),
        h('span.psg-key-item', S ? sym(S.platoonSidc(r)) : null, 'You'),
        hub ? h('span.psg-key-item', S ? sym(S.SIDC.hub) : null, hub.name) : null,
        h('span.psg-key-item', h('span.truck-line', { style: { '--truck': color } }), truck.id + ' route'),
        closed ? h('span.psg-key-item', h('span.psg-key-zone'), 'Closed area') : null);
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
      const mine = {};
      (c.info.entries || []).forEach(function (x) { if (x.truckId === e.truckId && x.stopIdx >= 0) mine[x.stopIdx] = true; });
      mine[e.stopIdx] = true;
      // small map: no hub or designator text (the key under the map names them), the other stops as dots
      if (geom.hub) m.setHubs([geom.hub], { labels: false });
      c.zonesRef = undefined;
      this.mapZones(c, state);
      m.setRoutes([{
        truckId: e.truckId, color: color, label: e.truckId,
        legs: geom.legs.map(function (L) { return { coords: L.coords }; }),
        stops: stops.map(function (s, i) { return { lat: s.lat, lon: s.lon, seq: i + 1, mine: !!mine[i] }; })
      }], { highlightTruckId: e.truckId, stopLabels: 'mine' });
      if (e.nodeKind !== 'direct') {
        const radius = r.mobility === 'dismounted' && isNum(r.maxTravelMi) ? r.maxTravelMi : 0;
        m.setRally([{ id: e.gridId || 'pickup', gridId: e.gridId, lat: e.lat, lon: e.lon, label: String(e.label || '').length <= 3 ? e.label : '', name: pickupName(e), used: true, walkRingMi: radius }]);
      }
      // the platoon symbol is drawn beside its pickup point (or its own stop, direct) when it would cover it
      m.setPlatoons([{ id: r.id, lat: r.lat, lon: r.lon, unitName: r.unitName, designator: r.designator, mobility: r.mobility, urgency: r.urgency || r.urgencyRequested, directOnly: r.directOnly }],
        { labels: false, clearOf: [{ lat: e.lat, lon: e.lon, rally: e.nodeKind !== 'direct' }] });
      if (line && root.L) {
        c.line = root.L.polyline(line.coords, { pane: 'sro-routes', color: lineColor(), weight: 3, opacity: 0.95, dashArray: line.mode === 'walk' ? '1 7' : '6 6', lineCap: 'round', interactive: false }).addTo(m.leaflet);
      }
      c.truckData = { id: e.truckId, color: color, type: truck.type, label: SRO.ui.symbols && SRO.ui.symbols.shortCallsign ? SRO.ui.symbols.shortCallsign(e.truckId) : e.truckId };
      // a truck waiting at its hub is drawn beside the hub symbol, on the side away from the platoon
      c.truckOpts = geom.hub ? { clearOf: [geom.hub, { lat: r.lat, lon: r.lon }] } : {};
      // fit: hub, this stop, the platoon (and the truck, added when it is placed)
      c.fitPts = [[e.lat, e.lon], [r.lat, r.lon]];
      if (geom.hub) c.fitPts.push([geom.hub.lat, geom.hub.lon]);
      // once the platoon sergeant zooms or pans, the map stays where they put it
      c.userView = false;
      ['pointerdown', 'wheel', 'keydown'].forEach(function (t) { c.mapHost.addEventListener(t, function () { c.userView = true; }, { passive: true }); });
      this.moveTruck(c, state.clock.simMin);
      this.fitCard(c);
    },
    fitCard: function (c) {
      if (!c.map || !c.fitPts || !c.fitPts.length) return;
      const s = c.map.leaflet.getSize();
      if (!s.x || !s.y) return;
      const pts = c.fitPts.slice();
      if (c.pos) pts.push([c.pos.lat, c.pos.lon]);
      // room for the symbols on the points, below them for the truck's callsign chip and above them
      // for a drop point symbol (it stands on its point)
      c.map.fitTo(pts, { maxZoom: 12, padding: [14, 14], clearControls: true, iconPad: 30, padBottom: 12, padTop: 12, animate: false });
    },
    // closed areas on a card map (they explain an 'Updated' new route)
    mapZones: function (c, state) {
      if (!c || !c.map) return;
      const zones = state.scenario.zones;
      if (c.zonesRef === zones) return;
      c.zonesRef = zones;
      c.map.setZones((zones || []).filter(function (z) { return z.kind === 'closed'; }));
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
      c.map.setTrucks([Object.assign({}, c.truckData, { lat: pos.lat, lon: pos.lon, heading: pos.status === 'en-route' ? pos.heading : null, status: pos.status })], c.truckOpts);
      c.pos = pos;
      // the truck left the view: fit again with it (not once the platoon sergeant has moved the map)
      if (!c.userView && c.fitPts) {
        try {
          const lm = c.map.leaflet, pt = lm.latLngToContainerPoint([pos.lat, pos.lon]), sz = lm.getSize();
          if (sz.x && sz.y && (pt.x < 12 || pt.y < 12 || pt.x > sz.x - 12 || pt.y > sz.y - 24)) this.fitCard(c);
        } catch (err) { /* map not laid out yet */ }
      }
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
        (c.stopItems || []).forEach(function (it) {
          const done = now >= (isNum(it.stop.depart) ? it.stop.depart : it.stop.arrive);
          if (it.el.classList.contains('is-done') !== done) it.el.classList.toggle('is-done', done);
        });
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
