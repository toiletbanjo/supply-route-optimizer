// Planner Queue (left panel on wide screens, 'Queue' tab on small ones).
//
// Requests of the current planning window plus open requests carried over from earlier windows,
// most pressing first (SRO.core.urgency.compareRequests: urgency, then class, then deadline).
// Columns: urgency, unit, supplies (classes and lines), NLT (DTG), mobility, pickup preference,
// status. In a narrow panel each row folds to three lines. Filter chips All / Pending / Delayed.
// Clicking a row selects the request (highlighted on the map) and opens its details with the planner
// overrides: lock to a truck and force direct delivery (store action request/lock; they apply on the
// next Plan now or Re-plan). Empty state: 'Load sample requests' (store action samples/load).
// Tab badge: open requests (red when any is delayed).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const ui = SRO.ui = SRO.ui || {};
  function K() { return ui.plannerKit; }
  const h = function () { return ui.h.apply(null, arguments); };

  const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'pending', label: 'Pending' },
    { id: 'delayed', label: 'Delayed' }
  ];

  // delayed: carried over / partly filled, or left out of the plan now on screen (draft)
  function isDelayed(r, idx) {
    if (r.status === 'delayed' || r.status === 'partial') return true;
    const x = idx.byRequest[r.id];
    return !!(x && x.deferred.length && (r.status === 'submitted' || r.status === 'planned'));
  }
  function isPending(r) { return r.status === 'submitted' || r.status === 'planned'; }

  function statusBadge(r, idx) {
    const k = K();
    const x = idx.byRequest[r.id];
    if ((r.status === 'submitted' || r.status === 'planned') && x && x.deferred.length) {
      const part = x.stops.length > 0;
      return h('span.badge.st-' + (part ? 'partial' : 'delayed'), { title: 'The plan on screen ' + (part ? 'fills part of it now; the rest waits for the next window.' : 'leaves it for the next window.') },
        part ? 'Partial (plan)' : 'Delayed (plan)');
    }
    return h('span.badge.st-' + r.status, k.STATUS_LABELS[r.status] || r.status);
  }

  const QueueView = {
    label: 'Queue', icon: 'list', region: 'left', order: 20,

    badge: function (state) {
      const k = K();
      if (!k) return null;
      const reqs = k.queueRequests(state);
      const open = reqs.filter(function (r) { return k.OPEN_STATUSES.indexOf(r.status) >= 0; });
      if (!open.length) return null;
      const delayed = open.some(function (r) { return r.status === 'delayed' || r.status === 'partial'; });
      return { text: String(open.length), alert: delayed };
    },

    mount: function (el, ctx) {
      const self = this;
      self.ctx = ctx;
      self.el = el;
      self.filter = 'all';
      self.expanded = null;
      el.classList.add('pq');
      self.head = h('div.pq-head');
      self.chips = h('div.chip-group.pq-chips', { role: 'group', 'aria-label': 'Filter requests' });
      self.list = h('div.pq-list', { role: 'list', 'aria-label': 'Requests in this window' });
      el.appendChild(self.head);
      el.appendChild(self.chips);
      el.appendChild(self.list);
      self.offSel = K().onSelect(function (sel, prev) {
        const st = ctx.getState();
        if (sel.requestId && sel.focusSeq !== prev.focusSeq && sel.source && sel.source !== 'queue') {
          self.expanded = sel.requestId;
          const r = K().request(st, sel.requestId);
          if (r && !self.passes(r, K().planIndex(K().viewedPlan(st)))) self.filter = 'all';
          self.pendingScroll = sel.requestId;
        }
        if (!sel.requestId && prev.requestId) self.expanded = null;
        self.render(st, true);
      });
    },

    unmount: function () { if (this.offSel) this.offSel(); },

    update: function (state, ctx) {
      this.ctx = ctx;
      if (ctx.clockOnly && this.lastWin === K().currentWindow(state).id) return;
      this.render(state, false);
    },

    onShow: function () { if (this.pendingScroll) this.render(this.ctx.getState(), true); },

    passes: function (r, idx) {
      if (this.filter === 'pending') return isPending(r);
      if (this.filter === 'delayed') return isDelayed(r, idx);
      return true;
    },

    render: function (state, force) {
      const self = this, k = K();
      if (!state || !k) return;
      const plan = k.viewedPlan(state);
      const idx = k.planIndex(plan);
      const reqs = k.queueRequests(state);
      const win = k.currentWindow(state);
      const key = [reqs, plan, state.scenario.fleet, self.filter, self.expanded, k.sel.requestId, win.id];
      if (!force && self.lastKey && key.every(function (v, i) { return v === self.lastKey[i]; })) return;
      self.lastKey = key;
      self.lastWin = win.id;

      // header
      ui.clear(self.head);
      const hasSamples = (state.requests || []).some(function (r) { return r.source === 'sample' && r.status !== 'cancelled'; });
      self.head.appendChild(h('div.pq-title',
        h('h2.h3', 'Requests'),
        h('div.pq-win.small.muted.num', 'Window ' + k.windowLabel(win) + ' · next plan ' + k.dtg(win.end))));
      if (reqs.length && !hasSamples) {
        self.head.appendChild(h('button.btn.btn-sm.btn-secondary.pq-load-sm', { type: 'button', onClick: function () { self.loadSamples(); }, 'data-testid': 'load-samples-small' },
          ui.icon('plus'), 'Load sample requests'));
      }

      // chips
      ui.clear(self.chips);
      const counts = {
        all: reqs.length,
        pending: reqs.filter(isPending).length,
        delayed: reqs.filter(function (r) { return isDelayed(r, idx); }).length
      };
      self.chips.hidden = !reqs.length;
      FILTERS.forEach(function (f) {
        self.chips.appendChild(h('button.chip.pq-chip', {
          type: 'button', 'aria-pressed': String(self.filter === f.id), 'data-filter': f.id,
          class: f.id === 'delayed' && counts.delayed ? 'is-alert' : null,
          onClick: function () { self.filter = f.id; self.render(self.ctx.getState(), true); }
        }, f.label, h('span.pq-chip-n.num', String(counts[f.id]))));
      });

      // rows
      ui.clear(self.list);
      if (!reqs.length) {
        self.list.appendChild(h('div.empty.pq-empty', { 'data-testid': 'queue-empty' },
          h('div.empty-icon', ui.icon('list')),
          h('p.empty-title', 'No requests yet'),
          h('p.empty-text', 'Submit one as a platoon sergeant, or load sample requests.'),
          h('div.empty-actions', h('button.btn.btn-primary.btn-lg', { type: 'button', 'data-testid': 'load-samples', onClick: function () { self.loadSamples(); } },
            ui.icon('plus'), 'Load sample requests')),
          h('p.field-help', '19 notional requests from platoons across Taiwan, mixed urgency and supply classes.')));
        return;
      }
      const shown = reqs.filter(function (r) { return self.passes(r, idx); });
      self.list.appendChild(h('div.pq-cols', { 'aria-hidden': 'true' },
        h('span', 'Urgency'), h('span', 'Unit'), h('span', 'Supplies'), h('span', 'NLT'), h('span', 'Mobility'), h('span', 'Pickup'), h('span', 'Status')));
      if (!shown.length) {
        self.list.appendChild(h('p.pq-none.muted', self.filter === 'delayed' ? 'Nothing is delayed.' : 'No requests waiting for a plan.'));
      }
      shown.forEach(function (r) { self.list.appendChild(self.row(state, r, idx, plan)); });

      if (self.pendingScroll && self.ctx.visible) {
        const target = self.list.querySelector('[data-request="' + self.pendingScroll + '"]');
        self.pendingScroll = null;
        if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
      }
    },

    row: function (state, r, idx, plan) {
      const self = this, k = K();
      const sel = k.sel.requestId === r.id;
      const open = self.expanded === r.id;
      const classes = k.requestClasses(r);
      const lines = (r.lines || []).filter(Boolean);
      const urg = r.urgency || r.urgencyRequested || 'Routine';
      const supplies = classes.map(function (c) { return k.classLabel(c); }).join(', ');
      const allLines = lines.map(function (l) { return k.classLabel(l.classId) + ': ' + k.lineText(l); }).join('\n');
      const deadline = k.isNum(r.deadline) && k.isNum(r.nlt) && r.deadline < r.nlt ? r.deadline : null;
      const mob = (k.MOBILITY_LABELS[r.mobility] || r.mobility || '');
      const pickup = k.pickupText(state, r);
      const main = h('button.pq-main', {
        type: 'button', 'aria-expanded': String(open), 'aria-controls': 'pq-detail-' + r.id,
        onClick: function () { self.toggle(r.id); }
      },
      h('span.pq-c-urg', h('span.badge.badge-urgency.' + k.urgClass(urg), urg)),
      h('span.pq-c-unit', h('span.pq-unit', { title: r.unitName || '' }, r.unitName || r.designator || r.id),
        h('span.pq-sub.pq-id.faint.num', r.id + (r.source === 'user' ? ' · own request' : ''))),
      h('span.pq-c-sup', { title: allLines },
        h('span.pq-sup.truncate', supplies || 'No supplies'),
        h('span.pq-sub.pq-sub-t.muted', lines.length === 1 ? k.lineText(lines[0]) : lines.length + ' lines'),
        h('span.pq-sub-n.faint', lines.length === 1 ? '1 line' : lines.length + ' lines')),
      h('span.pq-meta',
        h('span.pq-c-nlt.num', h('span.pq-k', 'NLT '), k.dtg(r.nlt),
          deadline !== null ? h('span.pq-sub.pq-dl.text-danger', 'Deadline ' + k.dtg(deadline)) : null),
        h('span.pq-c-mob', mob),
        h('span.pq-c-pick', { title: 'Pickup preference: ' + pickup }, h('span.pq-k', 'Pickup '), pickup)),
      h('span.pq-c-st', statusBadge(r, idx)));
      const row = h('div.pq-row.urg-bar', {
        role: 'listitem', 'data-request': r.id, 'data-urgency': urg,
        class: { 'is-selected': sel, 'is-open': open, 'is-own': r.source === 'user' }
      }, main);
      if (open) row.appendChild(self.detail(state, r, idx, plan));
      return row;
    },

    toggle: function (id) {
      const k = K();
      if (this.expanded === id) {
        this.expanded = null;
        k.select({ requestId: null, source: 'queue' });
      } else {
        this.expanded = id;
        k.focusRequest(id, 'queue');
      }
      this.render(this.ctx.getState(), true);
    },

    detail: function (state, r, idx, plan) {
      const self = this, k = K();
      const box = h('div.pq-detail', { id: 'pq-detail-' + r.id });
      const lines = (r.lines || []).filter(Boolean);
      box.appendChild(h('ul.pq-lines', lines.map(function (l) {
        return h('li', h('span.pq-line-class', k.classLabel(l.classId)), ' ', h('span.num', k.lineText(l)),
          k.isNum(l.onHand) ? h('span.faint.num', ' (on hand ' + k.qty(l.onHand, k.lineUnit(l, l.onHand)) + ')') : null);
      })));
      const kv = h('dl.kv.pq-kv');
      const add = function (dt, dd) { kv.appendChild(h('dt', dt)); kv.appendChild(h('dd', dd)); };
      add('Location', h('span.num', k.mgrs(r.lat, r.lon) || 'n/a'));
      add('NLT', h('span.num', k.dtg(r.nlt)));
      if (k.isNum(r.deadline) && r.deadline !== r.nlt) add('Deadline', h('span.num.text-danger', k.dtg(r.deadline) + ' (supply runs out)'));
      add('Mobility', (k.MOBILITY_LABELS[r.mobility] || r.mobility) + (k.isNum(r.maxTravelMi) && r.mobility !== 'fixed' ? ', up to ' + k.radius(r.maxTravelMi) + ' to a pickup point' : ''));
      add('Pickup', k.pickupText(state, r));
      if (r.directOnly && r.directReason) add('Direct because', r.directReasonText || String(r.directReason).replace(/-/g, ' '));
      const x = idx.byRequest[r.id];
      if (plan && x) {
        const parts = [];
        x.stops.forEach(function (s) {
          parts.push(h('div.pq-plan-stop', h('span.truck-chip', { style: { '--truck': s.color || k.truckColor(state, s.truckId) } }, s.truckId),
            h('span', ' stop ' + s.seq + ', ' + (s.kind === 'direct' ? 'direct to the platoon' : (s.label || k.gridName(s.gridId))) + ', '),
            h('span.num', 'ETA ' + k.dtg(s.arrive))));
        });
        x.deferred.forEach(function (d) {
          const line = r.lines && r.lines[d.lineIdx];
          parts.push(h('div.pq-plan-stop.text-danger', 'Next window: ' + (line ? k.lineText(line, d.qty) : k.qty(d.qty, d.unit)) + '. ' + k.reasonText(d)));
        });
        if (parts.length) add(plan.approved ? 'Approved plan' : 'Plan on screen', h('div.vstack-sm', parts));
      }
      if (r.remarks) add('Remarks', r.remarks);
      box.appendChild(kv);

      // overrides
      const locks = Object.assign({ truckId: null, forceDirect: false }, r.locks || {});
      const editable = k.OPEN_STATUSES.indexOf(r.status) >= 0;
      const fleet = (state.scenario.fleet || []);
      const groups = {};
      lines.forEach(function (l) { const ld = SRO.data.catalogHelpers && SRO.data.catalogHelpers.lineToLoad(l); if (ld) groups[ld.group] = true; });
      const fits = function (t) { return (t.type === 'tanker' && groups.fuel) || (t.type === 'cargo' && groups.cargo) || (!groups.fuel && !groups.cargo); };
      const sel = h('select.select.pq-lock', {
        'aria-label': 'Lock to a truck', disabled: !editable, 'data-testid': 'lock-truck',
        onChange: function (e) { self.lock(r.id, { truckId: e.target.value || null }); }
      },
      h('option', { value: '' }, 'Any truck (solver picks)'),
      fleet.filter(fits).map(function (t) {
        return h('option', { value: t.id, selected: locks.truckId === t.id },
          t.id + ' (' + k.truckTypeLabel(t.type) + (t.status === 'out' ? ', out of service' : '') + ')');
      }));
      if (locks.truckId && !fleet.some(function (t) { return t.id === locks.truckId; })) sel.appendChild(h('option', { value: locks.truckId, selected: true }, locks.truckId + ' (removed)'));
      sel.value = locks.truckId || '';
      const fixed = r.mobility === 'fixed' || r.directOnly;
      const direct = h('input.switch', {
        type: 'checkbox', checked: !!(locks.forceDirect || fixed), disabled: !editable || fixed, 'data-testid': 'force-direct',
        'aria-describedby': 'pq-direct-help-' + r.id,
        onChange: function (e) { self.lock(r.id, { forceDirect: e.target.checked }); }
      });
      box.appendChild(h('div.pq-overrides',
        h('div.caps', 'Planner overrides'),
        h('div.field', h('label.field-label', 'Lock to truck'), sel,
          groups.fuel && groups.cargo ? h('div.field-help', 'The lock applies to the load that truck can carry (fuel on a tanker, the rest on a cargo truck).') : null),
        h('label.check.pq-direct', direct, h('span', 'Force direct delivery')),
        h('div.field-help', { id: 'pq-direct-help-' + r.id }, fixed ? 'Fixed in place: always delivered direct.' :
          'Skips rally points: a truck drives to the platoon.'),
        !editable ? h('div.field-help', 'This request is ' + (k.STATUS_LABELS[r.status] || r.status).toLowerCase() + '; overrides apply to open requests only.')
          : h('div.field-help', 'Overrides apply the next time you press Plan now (or Re-plan).')));
      return box;
    },

    lock: function (id, patch) {
      const res = this.ctx.dispatch(Object.assign({ type: 'request/lock', requestId: id }, patch));
      if (!res || !res.ok) ui.toast((res && res.error) || 'Could not change the override.', 'error');
      else ui.toast(patch.truckId !== undefined ? (patch.truckId ? 'Locked to ' + patch.truckId + '.' : 'Truck lock removed.')
        : (patch.forceDirect ? 'Will be delivered direct.' : 'Direct delivery no longer forced.'), 'success', { timeout: 2500 });
    },

    loadSamples: function () {
      const res = this.ctx.dispatch({ type: 'samples/load' });
      if (!res || !res.ok) { ui.toast((res && res.error) || 'Could not load sample requests.', 'error'); return; }
      ui.toast((res.ids ? res.ids.length : 19) + ' sample requests loaded.', 'success');
    }
  };

  if (ui.registerView) ui.registerView('planner/queue', QueueView);
})(typeof self !== 'undefined' ? self : globalThis);
