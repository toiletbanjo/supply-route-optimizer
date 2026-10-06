// Platoon sergeant: the request form (spec-answers.md Section 2; DESIGN.md sections 3 and 8). The
// two-minute flow: pick a class (big tiles), an item, options and quantity in a bottom sheet (DoorDash
// style), add more lines, choose drop point or direct delivery, NLT (24 h), urgency, optional remarks,
// submit. Urgent asks for on hand (every line) and, when that lasts 24 h or more, "How many hours until
// you run out?"; the result is shown plainly ("This will be sent as IMMEDIATE: you run out in about 9
// hours"). Validation comes from SRO.core.urgency.validate: blocking errors inline, warnings (over 5x
// daily use, NLT sooner than the nearest hub can reach) as a confirm step. Submit -> request/submit,
// then a confirmation with the request id and what happens next.
//
// VIEW 'psg/request' (tab "New request"). With no unit profile yet it shows the one-time setup
// (SRO.ui.psg.profileForm) instead of the form.
// API  SRO.ui.psg.request = { edit(requestId), reset(), draft() }   edit() loads a request that is
//      still editable (submitted / planned / delayed) into the form and switches to this tab.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const ui = SRO.ui = SRO.ui || {};
  const psg = ui.psg = ui.psg || {};

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function h() { return ui.h.apply(null, arguments); }
  function icon(n, o) { return ui.icon(n, o); }
  function F() { return SRO.core.format; }
  function U() { return SRO.core.urgency; }
  function CH() { return SRO.data.catalogHelpers; }
  function cat() { return SRO.data.catalog; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  const CLASS_SUB = {
    III: 'Fuel and oil',
    I: 'Meals and water',
    V: 'Small arms, grenades, mortars, AT4',
    VIII: 'Aid bag and IFAK refills, litters',
    IX: 'Tires, batteries, filters, parts'
  };
  const URGENCY = [
    { value: 'Routine', title: 'Routine', sub: 'Normal resupply. Deliver by the NLT.' },
    { value: 'Priority', title: 'Priority', sub: 'Needed by the NLT, served ahead of Routine.' },
    { value: 'Urgent', title: 'Urgent', sub: 'The mission stops without it. NLT is firm. You tell us what you have on hand.' }
  ];
  const DIRECT_REASONS = [
    { value: 'no-vehicles', label: 'No vehicles' },
    { value: 'in-contact', label: 'In contact' },
    { value: 'other', label: 'Other' }
  ];
  const SEC_OF_FIELD = { location: 'unit', desiredPickup: 'delivery', direct: 'delivery', nlt: 'when', urgency: 'urgency',
    lines: 'supplies', qty: 'supplies', option: 'supplies', onHand: 'urgency', runout: 'urgency' };

  // ==== draft (UI state only; the store holds requests once submitted) ==============================
  function freshDraft() {
    return {
      editingId: null, lines: [], pick: 'drop', directReason: null, directReasonText: '', desiredPickup: null,
      mobility: null, nlt: null, nltOther: false, urgency: 'Routine', hoursReported: null, remarks: '',
      browseClass: null, adding: true, showErrors: false, pickMapOpen: false
    };
  }
  let draft = freshDraft();

  function nowOf(state) { return Math.floor(state.clock.simMin); }
  function defaultNlt(now) { return psg.nextPlanAt(now) + 360; }
  function nltOf(state) { return isNum(draft.nlt) ? draft.nlt : defaultNlt(nowOf(state)); }
  function mobilityOf(state) { return draft.mobility || (state.profile && state.profile.mobility) || 'mounted'; }
  function dailyUse(state) {
    const t = state.scenario && state.scenario.settings && state.scenario.settings.dailyUse;
    return t && Object.keys(t).length ? t : undefined;
  }

  // The request exactly as it will be submitted (urgency / deadline are left to the store, which runs
  // the same escalation as the preview below).
  function buildRequest(state) {
    const p = state.profile || {};
    const mob = mobilityOf(state);
    const info = psg.mobilityInfo(state, mob);
    const direct = mob === 'fixed' || draft.pick === 'direct';
    const reason = direct && mob !== 'fixed' ? draft.directReason : null;
    const req = {
      unitName: p.unitName, designator: p.designator, lat: p.lat, lon: p.lon, gridId: p.gridId || null,
      mobility: mob, maxTravelMi: mob === 'fixed' ? 0 : info.radiusMi,
      desiredPickup: !direct && draft.desiredPickup ? { lat: draft.desiredPickup.lat, lon: draft.desiredPickup.lon, gridId: draft.desiredPickup.gridId } : null,
      directOnly: direct,
      directReason: reason,
      directReasonText: reason === 'other' ? String(draft.directReasonText || '').trim() : '',
      lines: draft.lines.map(function (l) {
        return { classId: l.classId, itemId: l.itemId, option: l.option, qty: l.qty, unit: l.unit, onHand: isNum(l.onHand) ? l.onHand : null };
      }),
      urgencyRequested: draft.urgency,
      hoursLeftReported: draft.urgency === 'Urgent' && isNum(draft.hoursReported) ? draft.hoursReported : null,
      nlt: nltOf(state),
      remarks: String(draft.remarks || '').trim()
    };
    // a run-out answer only counts while the question is asked (Urgent, on hand lasting 24 h or more)
    if (req.hoursLeftReported !== null && !U().needsRunOutQuestion(req, undefined, dailyUse(state))) req.hoursLeftReported = null;
    return req;
  }

  // Editing: on hand (and the run-out answer) count from when they were reported. While the edit
  // leaves them as they were, the request keeps its original report time, so changing only the NLT
  // of an IMMEDIATE request does not push its run-out deadline later. The store does the same when
  // request/edit leaves out lines and hoursLeftReported (see send()).
  function reportKey(lines, hours) {
    return JSON.stringify([(lines || []).map(function (l) { return [l.classId, l.itemId, l.option, l.qty, l.unit, isNum(l.onHand) ? l.onHand : null]; }), isNum(hours) ? hours : null]);
  }
  function sameReport(req) { return !!(draft.editingId && draft.orig && reportKey(req.lines, req.hoursLeftReported) === draft.orig.key); }
  function reportedAt(state, req) { return sameReport(req) && isNum(draft.orig.at) ? draft.orig.at : nowOf(state); }

  // -> { req, errors, warnings, esc, needsRunOut, computed }
  function evaluate(state) {
    const req = buildRequest(state);
    const now = nowOf(state);
    const du = dailyUse(state);
    const reach = psg.reach(state, req.lat, req.lon);
    let res;
    try {
      res = U().validate(req, { nowMin: now, dailyUse: du, hubReachMin: reach ? reach.minutes : null });
    } catch (e) { res = { ok: false, errors: [{ code: 'internal', field: 'lines', message: String(e.message || e) }], warnings: [] }; }
    const errors = res.errors.map(function (e) { return relabel(e, req, du); });
    const warnings = res.warnings.map(function (w) { return relabel(w, req, du); });
    if (req.directOnly && req.mobility !== 'fixed') {
      if (!req.directReason) errors.push({ code: 'direct-reason', field: 'direct', message: 'Pick why you need direct delivery.' });
      else if (req.directReason === 'other' && !req.directReasonText) errors.push({ code: 'direct-reason-text', field: 'direct', message: 'Say in a few words why you need direct delivery.' });
    }
    const urgent = req.urgencyRequested === 'Urgent';
    const needsRunOut = urgent && U().needsRunOutQuestion(req, undefined, du);
    if (needsRunOut && !isNum(draft.hoursReported)) {
      errors.push({ code: 'runout-missing', field: 'runout', message: 'Answer how many hours until you run out.' });
    } else if (needsRunOut && draft.hoursReported < 0) {
      errors.push({ code: 'runout-bad', field: 'runout', message: 'Hours until you run out must be 0 or more.' });
    }
    let esc = null, computed = null;
    try {
      computed = U().hoursLeft(req.lines, cat(), du);
      esc = U().escalate(req, reportedAt(state, req), { dailyUse: du });
    } catch (e) { esc = null; }
    return { req: req, errors: errors, warnings: warnings, esc: esc, needsRunOut: needsRunOut, computed: computed, reach: reach };
  }

  // urgency.validate names a line by its catalog item ('Diesel / JP-8: 1600 is more than ... (300)');
  // the form names it as the cart does ('JP-8') and gives amounts with their units.
  function relabel(m, req, du) {
    const line = isNum(m.lineIdx) ? req.lines[m.lineIdx] : null;
    if (!line) return m;
    const it = CH().itemById(line.itemId);
    const title = psg.lineTitle(line);
    if (m.code === 'over-daily-use') {
      const rate = U().dailyUseFor(line, cat(), du);
      if (isNum(rate)) {
        return Object.assign({}, m, { message: title + ': ' + qtyText(line.qty, line.unit) + ' is more than ' + U().OVER_DAILY_FACTOR +
          ' times what a platoon typically uses in a day (' + qtyText(rate, line.unit) + '). Check the amount.' });
      }
    }
    if (it && m.message.indexOf(it.name + ':') === 0 && title !== it.name) return Object.assign({}, m, { message: title + m.message.slice(it.name.length) });
    return m;
  }

  // ---- wording helpers ----------------------------------------------------------------------------
  function hoursWords(hrs) {
    if (!isNum(hrs)) return '';
    if (hrs < 1) return 'under an hour';
    const v = hrs < 2 ? Math.round(hrs * 10) / 10 : Math.round(hrs);
    return 'about ' + v + (v === 1 ? ' hour' : ' hours');
  }
  function daysWords(qty, rate) {
    if (!isNum(qty) || !isNum(rate) || rate <= 0) return '';
    const d = qty / rate;
    if (d < 1) return hoursWords(d * 24) + ' of supply';
    const v = Math.round(d * 10) / 10;
    return 'about ' + v + (v === 1 ? ' day' : ' days') + ' of supply';
  }
  function loadWords(line) {
    const l = CH().lineToLoad(line);
    if (!l) return '';
    if (l.group === 'fuel') {
      const pct = Math.round(l.qty / 2500 * 100);
      return pct >= 100 ? 'a full tanker' : (pct < 1 ? 'under 1%' : pct + '%') + ' of a tanker';
    }
    if (l.exact < 0.05) return 'under 0.1 pallet';
    const v = Math.round(l.exact * 10) / 10;
    return v + (v === 1 ? ' pallet' : ' pallets');
  }
  function rateFor(line, state) { return U().dailyUseFor(line, cat(), dailyUse(state)); }
  function qtyText(q, unit) { return psg.lineQty(q, unit); }

  // ==== view ========================================================================================
  const view = {
    label: 'New request',
    icon: 'plus',
    order: 10,
    mount: function (el, ctx) {
      this.el = el;
      this.ctx = ctx;
      this.mode = null;
      el.classList.add('psg-request-view');
      psg.keepScroll(this, el);
      this.build(ctx.getState());
    },
    unmount: function () { this.teardown(); if (this.offScroll) this.offScroll(); },
    onShow: function (el, ctx) {
      this.ctx = ctx;
      psg.showScroll(this);
      // a confirmation that was already seen gives way to a fresh form
      if (this.mode === 'done' && this.doneSeen) { draft = freshDraft(); this.build(ctx.getState()); psg.toTop(this); }
    },
    onHide: function () { psg.hideScroll(this); if (this.mode === 'done') this.doneSeen = true; },
    update: function (state, ctx) {
      this.ctx = ctx;
      if (!state.profile) { if (this.mode !== 'setup') this.build(state); return; }
      if (this.mode === 'setup' || this.mode === null) { const wasSetup = this.mode === 'setup'; this.build(state); if (wasSetup) psg.toTop(this); return; }
      if (this.mode === 'done') return;
      if (ctx.clockOnly) { this.tick(state); return; }
      // the request being edited is gone (data reset or import): back to a new request
      if (draft.editingId && !(state.requests || []).some(function (x) { return x.id === draft.editingId; })) { draft = freshDraft(); this.build(state); return; }
      const prev = ctx.prev;
      // Only what the form shows: the profile and the planner settings, zones (hub reach), hubs and
      // rally bans. Trucks leaving or coming back change state.scenario too, and a full refresh would
      // rebuild the input the platoon sergeant is typing in.
      const inputs = function (s) { const S = s.scenario || {}; return [s.profile, S.settings, S.zones, S.hubs, S.rally]; };
      const changed = !prev || inputs(prev).some(function (x, i) { return x !== inputs(state)[i]; });
      if (changed) {
        this.refresh(['head', 'unit', 'delivery', 'supplies', 'when', 'urgency', 'footer']);
      } else if (prev.requests !== state.requests && draft.editingId) {
        this.refresh(['head', 'unit', 'footer']);
      } else {
        this.tick(state);
      }
    },

    teardown: function () {
      if (this.form) { this.form.destroy(); this.form = null; }
      this.dropPickMap();
    },
    dropPickMap: function () {
      if (this.pickMapWait) { this.pickMapWait(); this.pickMapWait = null; }
      if (this.pickMap) { psg.destroyMap(this.pickMap); this.pickMap = null; }
    },

    build: function (state) {
      const self = this, el = this.el;
      this.teardown();
      ui.clear(el);
      this.R = {};
      if (!state.profile) {
        this.mode = 'setup';
        // saved at the bottom of the setup form: the request form from its top ("What do you need?")
        this.form = psg.profileForm(el, this.ctx, { mode: 'setup', onSaved: function () { self.form = null; self.mode = null; self.build(self.ctx.getState()); psg.toTop(self); } });
        return;
      }
      if (draft.editingId && !(state.requests || []).some(function (x) { return x.id === draft.editingId; })) draft = freshDraft();
      this.mode = 'form';
      const R = this.R;
      R.head = h('div.psg-head');
      R.unit = h('div.psg-unit-strip-wrap', { 'data-sec': 'unit' });
      R.supplies = h('section.psg-section.psg-step', { 'data-sec': 'supplies', 'aria-labelledby': 'psg-s1' });
      R.delivery = h('section.psg-section.psg-step', { 'data-sec': 'delivery', 'aria-labelledby': 'psg-s2' });
      R.when = h('section.psg-section.psg-step', { 'data-sec': 'when', 'aria-labelledby': 'psg-s3' });
      R.urgency = h('section.psg-section.psg-step', { 'data-sec': 'urgency', 'aria-labelledby': 'psg-s4' });
      R.remarks = h('section.psg-section.psg-step', { 'data-sec': 'remarks', 'aria-labelledby': 'psg-s5' });
      R.footer = h('div.psg-footer', { 'data-sec': 'footer' });
      el.append(R.head, R.unit, R.supplies, R.delivery, R.when, R.urgency, R.remarks, R.footer);
      this.renderRemarks();
      this.refresh(['head', 'unit', 'supplies', 'delivery', 'when', 'urgency', 'footer']);
    },

    refresh: function (names) {
      if (this.mode !== 'form') return;
      const st = this.ctx.getState();
      const ev = evaluate(st);
      this.ev = ev;
      const self = this;
      names.forEach(function (n) {
        const fn = self['render' + n.charAt(0).toUpperCase() + n.slice(1)];
        if (fn) fn.call(self, st, ev);
      });
    },
    // everything that depends on the draft (after any change to it)
    changed: function (extra) { this.refresh(['supplies', 'delivery', 'when', 'urgency', 'footer'].concat(extra || [])); },

    tick: function (state) {
      if (this.mode !== 'form' || !this.R) return;
      const now = nowOf(state);
      const key = psg.nextPlanAt(now) + '|' + (nltOf(state) < now) + '|' + Math.floor(now / 30);
      if (key !== this.tickKey) {
        this.tickKey = key;
        if (!(this.R.when && this.R.when.contains(document.activeElement) && document.activeElement.tagName === 'SELECT')) this.refresh(['when', 'footer']);
      }
    },

    // ---- header and unit strip ---------------------------------------------------------------------
    renderHead: function (st) {
      const R = this.R;
      ui.clear(R.head);
      if (draft.editingId) {
        const r = (st.requests || []).find(function (x) { return x.id === draft.editingId; });
        R.head.append(h('h2.psg-title', 'Edit ', h('span.num', draft.editingId)),
          h('p.muted', 'You can change this request until the plan is approved.'));
        if (r && psg.EDITABLE.indexOf(r.status) < 0) {
          R.head.appendChild(h('div.notice.notice-warn', icon('alert'), h('div', draft.editingId + ' is now ' + (psg.STATUS_LABEL[r.status] || r.status).toLowerCase() + ' and can no longer be changed.')));
        }
      } else {
        R.head.append(h('h2.psg-title', 'New request'), h('p.muted', 'Pick what you need. Every step has a default; change only what matters.'));
      }
    },
    renderUnit: function (st, ev) {
      const self = this;
      const R = this.R, p = st.profile;
      ui.clear(R.unit);
      const err = draft.showErrors ? ev.errors.filter(function (e) { return e.field === 'location'; }) : [];
      R.unit.appendChild(h('div.psg-unit-strip' + (err.length ? '.is-invalid' : ''),
        psg.symbolSvg(p, 22),
        h('div.psg-unit-strip-main',
          h('div.psg-unit-strip-name.truncate', p.unitName),
          h('div.small.muted', h('span.mono.psg-nowrap', psg.mgrs(p.lat, p.lon) || 'No location'), ' · ', h('span.psg-nowrap', psg.nearText(p.lat, p.lon)))),
        h('button.btn.btn-sm.btn-ghost.psg-strip-update', { type: 'button', onClick: function () { psg.openLocationSheet(self.ctx); } }, 'Update')));
      err.forEach(function (e) { R.unit.appendChild(fieldMsg('error', e.message)); });
    },

    // ---- 1. supplies ------------------------------------------------------------------------------
    renderSupplies: function (st, ev) {
      const self = this, R = this.R, sec = R.supplies;
      ui.clear(sec);
      sec.appendChild(stepHead(1, 'psg-s1', 'What do you need?', draft.lines.length ? h('span.badge', draft.lines.length + (draft.lines.length === 1 ? ' item' : ' items')) : null));
      const lineErr = function (i) { return draft.showErrors ? ev.errors.filter(function (e) { return e.lineIdx === i && (e.field === 'qty' || e.field === 'option' || e.field === 'lines'); }) : []; };
      if (draft.lines.length) {
        const list = h('ul.list.psg-cart', { 'aria-label': 'Items in this request' });
        draft.lines.forEach(function (line, i) {
          const it = CH().itemById(line.itemId);
          const rate = rateFor(line, st);
          const bits = [daysWords(line.qty, rate), loadWords(line)].filter(Boolean);
          if (isNum(line.onHand)) bits.unshift('on hand ' + qtyText(line.onHand, line.unit));
          const errs = lineErr(i);
          const warns = ev.warnings.filter(function (w) { return w.lineIdx === i; });
          const li = h('li.psg-line' + (errs.length ? '.is-invalid' : warns.length ? '.is-warning' : ''), { 'data-line': String(i) },
            h('button.psg-line-main', { type: 'button', 'aria-label': 'Change ' + psg.lineTitle(line), onClick: function () { self.openItem(it, i); } },
              h('span.psg-line-class', CH().classLabel(line.classId)),
              h('span.psg-line-title', psg.lineTitle(line)),
              h('span.psg-line-sub', bits.join(' · '))),
            h('span.psg-line-qty.num', qtyText(line.qty, line.unit)),
            h('button.btn.btn-icon.btn-ghost.psg-line-remove', {
              type: 'button', 'aria-label': 'Remove ' + psg.lineTitle(line),
              onClick: function () {
                const removed = draft.lines.splice(i, 1)[0];
                if (!draft.lines.length) { draft.adding = true; draft.browseClass = null; }
                self.changed();
                ui.toast('Removed ' + psg.lineTitle(removed) + '.', 'info', { action: { label: 'Undo', onClick: function () { draft.lines.splice(Math.min(i, draft.lines.length), 0, removed); draft.adding = false; self.changed(); } } });
              }
            }, icon('x')));
          errs.forEach(function (e) { li.appendChild(fieldMsg('error', e.message)); });
          warns.forEach(function (w) { li.appendChild(fieldMsg('warn', w.message)); });
          list.appendChild(li);
        });
        sec.appendChild(list);
      }
      if (draft.adding || !draft.lines.length) {
        if (!draft.browseClass) {
          const tiles = h('div.psg-tiles', { role: 'list', 'aria-label': 'Supply classes' });
          cat().classes.forEach(function (c) {
            tiles.appendChild(h('button.psg-tile', {
              type: 'button', role: 'listitem', 'data-class': c.id,
              onClick: function () { draft.browseClass = c.id; self.refresh(['supplies']); focusFirst(sec, '.psg-item'); }
            }, h('span.psg-tile-num', c.id), h('span.psg-tile-label', c.label), h('span.psg-tile-sub', CLASS_SUB[c.id] || '')));
          });
          sec.appendChild(tiles);
          if (draft.lines.length) {
            sec.appendChild(h('button.btn.btn-ghost.btn-block', { type: 'button', onClick: function () { draft.adding = false; self.refresh(['supplies']); } }, 'Done adding'));
          }
        } else {
          const c = CH().classById(draft.browseClass);
          const list = h('ul.list.psg-items', { 'aria-label': c.label + ' items' });
          CH().itemsForClass(draft.browseClass).forEach(function (it) {
            const opts = it.freeText ? 'Describe the part' : it.options.slice(0, 3).map(function (o) { return o.label; }).join(', ') + (it.options.length > 3 ? ' +' + (it.options.length - 3) + ' more' : '');
            list.appendChild(h('li', h('button.list-row.psg-item', { type: 'button', 'data-item': it.id, onClick: function () { self.openItem(it, null); } },
              h('div.list-row-main', h('div.list-row-title', it.name), h('div.list-row-sub', opts + ' · ' + CH().unitLabel(it.unit, 2))),
              icon('chevron'))));
          });
          sec.appendChild(h('div.psg-browse',
            h('div.psg-browse-head',
              h('button.btn.btn-ghost.btn-sm.psg-back', { type: 'button', onClick: function () { draft.browseClass = null; self.refresh(['supplies']); focusFirst(sec, '.psg-tile'); } }, icon('chevronLeft'), 'All classes'),
              h('span.psg-browse-title', c.label)),
            list));
        }
      } else {
        sec.appendChild(h('button.btn.btn-secondary.btn-block.psg-add-more', { type: 'button', onClick: function () { draft.adding = true; draft.browseClass = null; self.refresh(['supplies']); focusFirst(sec, '.psg-tile'); } }, icon('plus'), 'Add another item'));
      }
      if (draft.showErrors) ev.errors.filter(function (e) { return e.code === 'no-lines'; }).forEach(function (e) { sec.appendChild(fieldMsg('error', 'Add at least one item: tap a class above.')); });
    },

    // item sheet: options, quantity, on hand
    openItem: function (it, lineIdx) {
      const self = this;
      const st = this.ctx.getState();
      const editing = lineIdx !== null && lineIdx !== undefined;
      const cur = editing ? draft.lines[lineIdx] : null;
      const local = {
        option: cur ? cur.option : (it.freeText ? '' : (it.options[0] && it.options[0].id) || null),
        qty: cur ? cur.qty : null, onHand: cur && isNum(cur.onHand) ? cur.onHand : null, qtyTouched: !!cur
      };
      function spec() { return CH().spec(it.id, it.freeText ? null : local.option); }
      if (!isNum(local.qty)) local.qty = spec().defaultQty;
      const urgent = draft.urgency === 'Urgent';
      const R2 = {};
      ui.modal.open({
        title: it.name,
        size: 'md',
        initialFocus: it.freeText ? '.psg-part-desc' : null,
        body: function (el) {
          el.classList.add('psg-item-sheet');
          el.appendChild(h('div.psg-sheet-sub', CH().classLabel(it.classId) + (it.note && !it.freeText ? ' · ' + it.note.replace(/\s*\(see header\)\.?/, '.') : '')));
          // options
          if (it.freeText) {
            R2.desc = h('input.input.psg-part-desc', { type: 'text', maxlength: '80', placeholder: 'e.g. Starter motor, light tactical vehicle', value: local.option || '', id: 'psg-part-desc' });
            R2.desc.addEventListener('input', function () { local.option = R2.desc.value; R2.descErr.hidden = true; });
            R2.descErr = h('div.field-error', { hidden: true }, icon('alert'), h('span', 'Describe the part you need.'));
            el.appendChild(h('div.field', h('label.field-label', { htmlFor: 'psg-part-desc' }, it.optionLabel || 'Description'), R2.desc, R2.descErr));
          } else {
            R2.opts = h('div.chip-group.psg-opts', { role: 'radiogroup', 'aria-label': it.optionLabel || 'Type' });
            el.appendChild(h('div.field', h('span.field-label', it.optionLabel || 'Type'), R2.opts));
          }
          // quantity
          R2.qtyBox = h('div.psg-qty-row');
          R2.quick = h('div.chip-group.psg-quick');
          R2.equiv = h('div.psg-equiv', { 'aria-live': 'polite' });
          R2.qtyMsg = h('div');
          el.appendChild(h('div.field', h('span.field-label', 'Quantity'), R2.qtyBox, R2.quick, R2.equiv, R2.qtyMsg));
          // on hand
          R2.ohBox = h('div.psg-qty-row');
          R2.ohHelp = h('div.field-help');
          el.appendChild(h('div.field.psg-onhand-field', h('span.field-label', 'On hand now ', h('span.field-opt', urgent ? '(needed for Urgent)' : '(optional)')), R2.ohBox, R2.ohHelp));
          drawOptions();
          drawQty();
          drawOnHand();
        },
        actions: [
          {
            label: editing ? 'Update item' : 'Add to request', kind: 'primary', id: 'add-item', icon: editing ? 'check' : 'plus',
            onClick: function () {
              const sp = spec();
              if (it.freeText && !String(local.option || '').trim()) { R2.descErr.hidden = false; try { R2.desc.focus(); } catch (e) { /* ignore */ } return false; }
              if (!isNum(local.qty) || local.qty <= 0) { qtyMsg('error', 'Enter a quantity greater than 0.'); return false; }
              if (isNum(sp.maxQty) && local.qty > sp.maxQty) { local.qty = sp.maxQty; R2.qty.set(sp.maxQty); }
              if (local.onHand !== null && (!isNum(local.onHand) || local.onHand < 0)) { local.onHand = null; }
              const line = { classId: it.classId, itemId: it.id, option: it.freeText ? String(local.option).trim() : local.option, qty: local.qty, unit: it.unit, onHand: isNum(local.onHand) ? local.onHand : null };
              if (editing) draft.lines[lineIdx] = line; else draft.lines.push(line);
              draft.adding = false;
              draft.browseClass = null;
              self.changed();
              return true;
            }
          }
        ]
      });
      function drawOptions() {
        if (!R2.opts) return;
        ui.clear(R2.opts);
        it.options.forEach(function (o) {
          R2.opts.appendChild(h('button.chip', {
            type: 'button', role: 'radio', 'aria-checked': String(o.id === local.option), 'aria-pressed': String(o.id === local.option), 'data-option': o.id,
            onClick: function () {
              if (local.option === o.id) return;
              local.option = o.id;
              if (!local.qtyTouched) local.qty = spec().defaultQty;
              drawOptions(); drawQty(); drawOnHand();
            }
          }, o.label));
        });
      }
      function qtyMsg(kind, text) {
        ui.clear(R2.qtyMsg);
        if (text) R2.qtyMsg.appendChild(fieldMsg(kind, text));
      }
      function drawQty() {
        const sp = spec();
        ui.clear(R2.qtyBox);
        R2.qty = psg.stepper({ value: local.qty, min: 0, max: sp.maxQty, step: sp.step || 1, label: 'Quantity', onChange: function (v) { local.qty = v; local.qtyTouched = true; drawEquiv(); drawQuick(); } });
        R2.qtyBox.append(R2.qty.el, h('span.psg-unit', CH().unitLabel(it.unit, 2)));
        drawQuick();
        drawEquiv();
      }
      function drawQuick() {
        const sp = spec();
        const rate = U().dailyUseFor({ itemId: it.id, option: local.option }, cat(), dailyUse(st));
        ui.clear(R2.quick);
        if (!isNum(rate) || rate <= 0) return;
        const step = sp.step || 1;
        const seen = {};
        [1, 2, 3].forEach(function (d) {
          const q = Math.max(step, Math.round(rate * d / step) * step);
          if (seen[q] || (isNum(sp.maxQty) && q > sp.maxQty)) return;
          seen[q] = true;
          R2.quick.appendChild(h('button.chip.psg-quick-chip', {
            type: 'button', 'aria-pressed': String(local.qty === q), title: F().number(q) + ' ' + CH().unitLabel(it.unit, q),
            onClick: function () { local.qty = q; local.qtyTouched = true; R2.qty.set(q); drawQuick(); drawEquiv(); }
          }, d + (d === 1 ? ' day' : ' days')));
        });
      }
      function drawEquiv() {
        const sp = spec();
        const line = { itemId: it.id, option: local.option, qty: local.qty };
        const rate = U().dailyUseFor(line, cat(), dailyUse(st));
        const bits = [daysWords(local.qty, rate), isNum(local.qty) && local.qty > 0 ? loadWords(line) : ''].filter(Boolean);
        R2.equiv.textContent = bits.length ? '= ' + bits.join(' · ') : '';
        if (isNum(local.qty) && isNum(sp.maxQty) && local.qty >= sp.maxQty) qtyMsg('help', 'Most one request can carry: ' + qtyText(sp.maxQty, it.unit) + '.');
        else if (isNum(local.qty) && isNum(rate) && rate > 0 && local.qty > U().OVER_DAILY_FACTOR * rate) qtyMsg('warn', 'More than ' + U().OVER_DAILY_FACTOR + ' times what a platoon typically uses in a day (' + qtyText(rate, it.unit) + '). Check the amount.');
        else if (local.qty !== null && (!isNum(local.qty) || local.qty <= 0)) qtyMsg('error', 'Enter a quantity greater than 0.');
        else qtyMsg(null, '');
      }
      function drawOnHand() {
        const sp = spec();
        ui.clear(R2.ohBox);
        R2.oh = psg.stepper({ value: local.onHand, min: 0, step: sp.step || 1, allowEmpty: true, label: 'On hand', placeholder: urgent ? 'required' : 'optional', onChange: function (v) { local.onHand = v; drawOhHelp(); } });
        R2.ohBox.append(R2.oh.el, h('span.psg-unit', CH().unitLabel(it.unit, 2)));
        drawOhHelp();
      }
      function drawOhHelp() {
        const rate = U().dailyUseFor({ itemId: it.id, option: local.option }, cat(), dailyUse(st));
        R2.ohHelp.textContent = isNum(local.onHand) && isNum(rate) && rate > 0
          ? 'That lasts ' + hoursWords(local.onHand / rate * 24) + ' at typical use.'
          : 'Helps the planner judge how urgent this really is.';
      }
    },

    // ---- 2. delivery --------------------------------------------------------------------------------
    renderDelivery: function (st, ev) {
      const self = this, R = this.R, sec = R.delivery;
      this.dropPickMap();
      ui.clear(sec);
      sec.appendChild(stepHead(2, 'psg-s2', 'Pickup'));
      const mob = mobilityOf(st);
      const prof = st.profile;
      const info = psg.mobilityInfo(st, mob);
      sec.appendChild(h('div.field',
        h('span.field-label', 'You are ', h('span.field-opt', mob === prof.mobility ? '(from your unit profile)' : '(this request only)')),
        psg.seg({
          label: 'Mobility for this request', name: 'mobility', value: mob,
          options: psg.mobilityModes(st).map(function (m) { return { value: m.id, label: m.id === 'fixed' ? 'Fixed' : m.label, title: m.label + ': ' + m.sub }; }),
          onChange: function (v) { draft.mobility = v === prof.mobility ? null : v; self.changed(); }
        })));
      if (mob === 'fixed') {
        sec.appendChild(h('div.notice.notice-info.psg-fixed-note', icon('truck'), h('div', h('strong', 'Delivered direct to you. '), 'Fixed in place: the truck comes to your location (' + psg.mgrs(prof.lat, prof.lon) + ').')));
      } else {
        sec.appendChild(psg.choiceGroup({
          label: 'Pickup', name: 'pickup', value: draft.pick,
          options: [
            { value: 'drop', title: 'Deliver to a nearby drop point', tag: 'Default', sub: 'The planner picks a drop point within ' + F().miles(info.radiusMi).replace('.0 mi', ' mi') + ' of you' + (mob === 'dismounted' ? ' (on foot).' : '. You drive to it.') },
            { value: 'direct', title: 'Deliver direct to me', sub: 'A truck comes to your location. Use it when you cannot move.' }
          ],
          onChange: function (v) { draft.pick = v; self.changed(); }
        }));
        if (draft.pick === 'drop') this.renderPickupHint(st, sec, info);
        else {
          const reasonErr = draft.showErrors ? ev.errors.filter(function (e) { return e.field === 'direct'; }) : [];
          const chips = h('div.chip-group.psg-reasons', { role: 'radiogroup', 'aria-label': 'Reason for direct delivery' },
            DIRECT_REASONS.map(function (r) {
              return h('button.chip', { type: 'button', role: 'radio', 'aria-checked': String(draft.directReason === r.value), 'aria-pressed': String(draft.directReason === r.value), 'data-reason': r.value,
                onClick: function () { draft.directReason = r.value; self.changed(); if (r.value === 'other') focusFirst(sec, '.psg-reason-text'); } }, r.label);
            }));
          const field = h('div.field.psg-direct-reason' + (reasonErr.length ? '.is-invalid' : ''), h('span.field-label', 'Why direct?'), chips);
          if (draft.directReason === 'other') {
            const t = h('input.input.psg-reason-text', { type: 'text', maxlength: '120', placeholder: 'e.g. Bridge out on our only road', value: draft.directReasonText || '', 'aria-label': 'Other reason' });
            t.addEventListener('input', function () { draft.directReasonText = t.value; });
            t.addEventListener('change', function () { self.refresh(['footer']); });
            field.appendChild(t);
          }
          reasonErr.forEach(function (e) { field.appendChild(fieldMsg('error', e.message)); });
          sec.appendChild(field);
        }
      }
      const pErr = draft.showErrors ? ev.errors.filter(function (e) { return e.field === 'desiredPickup'; }) : [];
      pErr.forEach(function (e) { sec.appendChild(fieldMsg('error', e.message)); });
    },

    // optional preferred pickup spot (a hint for the solver), tapped on a mini map
    renderPickupHint: function (st, sec, info) {
      const self = this;
      const prof = st.profile;
      const dp = draft.desiredPickup;
      const box = h('div.psg-hint');
      sec.appendChild(box);
      if (dp) {
        const dist = SRO.core.geo.haversineMi(prof, dp);
        box.appendChild(h('div.psg-hint-row',
          h('div.psg-hint-main',
            h('div.caps', 'Preferred pickup spot'),
            h('div.psg-hint-name', dp.name || 'Selected spot'),
            h('div.small.muted', h('span.mono', psg.mgrs(dp.lat, dp.lon)), ' · ' + F().miles(dist) + ' from you')),
          h('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: function () { draft.pickMapOpen = !draft.pickMapOpen; self.refresh(['delivery']); } }, draft.pickMapOpen ? 'Hide map' : 'Change'),
          h('button.btn.btn-sm.btn-ghost', { type: 'button', 'aria-label': 'Clear preferred pickup spot', onClick: function () { draft.desiredPickup = null; draft.pickMapOpen = false; self.changed(); } }, 'Clear')));
        if (info.radiusMi > 0 && dist > info.radiusMi) box.appendChild(fieldMsg('warn', dp.name + ' is ' + F().miles(dist) + ' away, beyond your ' + F().miles(info.radiusMi) + ' range. The planner may pick a closer point.'));
        box.appendChild(h('div.field-help', 'A hint only: the planner may pick another drop point.'));
      } else if (!draft.pickMapOpen) {
        box.appendChild(h('button.btn.btn-ghost.btn-block.psg-hint-open', { type: 'button', onClick: function () { draft.pickMapOpen = true; self.refresh(['delivery']); } }, icon('pin'), 'Suggest a pickup spot (optional)'));
      }
      if (!draft.pickMapOpen) return;
      // the map: you, your range, candidate drop points; tap one (or near one) to choose it
      const mapEl = h('div.psg-map.psg-map-hint-pick', { role: 'region', 'aria-label': 'Map of drop points near you. Tap one to suggest it.' });
      box.appendChild(h('div.psg-map-wrap', mapEl, h('div.psg-map-hint', { 'aria-hidden': 'true' }, 'Tap a drop point')));
      const grid = (SRO.data.grid || []).filter(function (g) { return g.rallyCandidate; });
      const banned = (st.scenario.rally && st.scenario.rally.banned) || [];
      // a phone-sized map: on foot the walk radius plus a margin, mounted the closest 20 mi
      const showMi = info.radiusMi <= 10 ? Math.max(info.radiusMi + 5, 10) : 20;
      const ranked = grid.filter(function (g) { return banned.indexOf(g.id) < 0; })
        .map(function (g) { return { g: g, d: SRO.core.geo.haversineMi(prof, g) }; })
        .sort(function (a, b) { return a.d - b.d; });
      let near = ranked.filter(function (x) { return x.d <= showMi; }).map(function (x) { return x.g; });
      if (near.length < 3) near = ranked.slice(0, 5).map(function (x) { return x.g; });
      const choose = function (g) {
        draft.desiredPickup = { lat: g.lat, lon: g.lon, gridId: g.id, name: psg.placeName(g) };
        draft.pickMapOpen = false;
        self.changed();
      };
      const pts = near.slice(0, 10).map(function (g) { return [g.lat, g.lon]; }).concat([[prof.lat, prof.lon]]);
      let lastTap = null;
      ['pointerup', 'mouseup', 'touchend'].forEach(function (t) {
        mapEl.addEventListener(t, function (ev) { const p = ev.changedTouches ? ev.changedTouches[0] : ev; if (p && isNum(p.clientX)) lastTap = { clientX: p.clientX, clientY: p.clientY }; }, true);
      });
      this.pickMapWait = psg.whenSized(mapEl, function () {
        self.pickMapWait = null;
        let m;
        try { m = psg.createMap(mapEl, { compact: true, tiles: true }); } catch (e) { mapEl.appendChild(h('div.notice.notice-warn', icon('alert'), h('div', 'The map could not load here.'))); return; }
        self.pickMap = m;
        mapEl.__sroMap = m;
        m.setPlatoons([{ id: 'me', lat: prof.lat, lon: prof.lon, unitName: prof.unitName, designator: prof.designator, mobility: prof.mobility, urgency: draft.urgency }]);
        m.setRally(near.map(function (g) { return { id: g.id, gridId: g.id, lat: g.lat, lon: g.lon, name: psg.placeName(g), label: '', used: !!(dp && dp.gridId === g.id) }; }), { walkRingMi: 0 });
        if (info.radiusMi > 0 && info.radiusMi <= showMi && root.L) {
          root.L.circle([prof.lat, prof.lon], { pane: 'sro-walk', radius: info.radiusMi * 1609.344, color: cssVar('--text-faint', '#75838e'), weight: 1.5, dashArray: '4 6', fill: false, interactive: false }).addTo(m.leaflet);
        }
        m.on('click:rally', function (e) { const g = grid.find(function (x) { return x.id === (e.point.gridId || e.point.id); }); if (g) choose(g); });
        // The platoon symbol (and its urgency ring) sits on top of the drop points next to it and
        // took the tap without an answer: take the drop point nearest to where the finger landed.
        m.on('click:platoon', function () {
          let ll = null;
          try { ll = lastTap ? m.leaflet.mouseEventToLatLng(lastTap) : null; } catch (e) { ll = null; }
          const g = SRO.core.geo.nearestGrid(ll ? { lat: ll.lat, lon: ll.lng } : { lat: prof.lat, lon: prof.lon }, near.length ? near : grid);
          if (g) choose(g);
        });
        m.on('click:map', function (e) {
          if (!psg.inside(e.lat, e.lon)) { ui.toast('That spot is outside Taiwan.', 'warn'); return; }
          const g = SRO.core.geo.nearestGrid({ lat: e.lat, lon: e.lon }, near.length ? near : grid);
          if (g) choose(g);
        });
        m.fitTo(pts.length > 1 ? pts : [[prof.lat, prof.lon]], { maxZoom: 12, padding: [30, 30], animate: false });
      });
      box.appendChild(fieldMsg('help', near.length ? 'Drop points near you. Tap one to suggest it.' : 'No drop points nearby. The planner will choose, or deliver direct.'));
    },

    // ---- 3. when (NLT) -------------------------------------------------------------------------------
    renderWhen: function (st, ev) {
      const self = this, R = this.R, sec = R.when;
      ui.clear(sec);
      const now = nowOf(st);
      const nb = psg.nextPlanAt(now);
      const nlt = nltOf(st);
      sec.appendChild(stepHead(3, 'psg-s3', 'Need it by (NLT)'));
      const choices = [180, 360, 540, 720].map(function (d) { return nb + d; });
      const chips = h('div.chip-group.psg-nlt-chips', { role: 'radiogroup', 'aria-label': 'No later than' });
      choices.forEach(function (t) {
        const on = !draft.nltOther && nlt === t;
        chips.appendChild(h('button.chip.num', { type: 'button', role: 'radio', 'aria-checked': String(on), 'aria-pressed': String(on), 'data-nlt': String(t),
          onClick: function () { draft.nlt = t; draft.nltOther = false; self.changed(); } }, psg.time(t, now)));
      });
      const other = draft.nltOther || choices.indexOf(nlt) < 0;
      chips.appendChild(h('button.chip.psg-nlt-other', { type: 'button', role: 'radio', 'aria-checked': String(other), 'aria-pressed': String(other),
        onClick: function () { draft.nltOther = true; draft.nlt = nlt; self.changed(); } }, 'Other time'));
      sec.appendChild(chips);
      if (other) sec.appendChild(nltSelects(now, nlt, function (v) { draft.nlt = v; draft.nltOther = true; self.changed(); }));
      R.nltRel = h('span.psg-nlt-rel');
      sec.appendChild(h('div.psg-nlt-line', h('span.caps', 'NLT'), h('span.psg-nlt-big.num', psg.time(nlt, now)), R.nltRel));
      R.nltRel.textContent = nlt >= now ? (F().dayOf(nlt) === F().dayOf(now) ? 'today' : 'Day ' + F().dayOf(nlt)) + ', in ' + F().duration(nlt - now) : 'already passed';
      const errs = draft.showErrors || nlt < now ? ev.errors.filter(function (e) { return e.field === 'nlt'; }) : [];
      errs.forEach(function (e) { sec.appendChild(fieldMsg('error', e.message)); });
      ev.warnings.filter(function (w) { return w.field === 'nlt'; }).forEach(function (w) { sec.appendChild(fieldMsg('warn', w.message)); });
      sec.classList.toggle('is-invalid', errs.length > 0);
      sec.appendChild(h('div.field-help', 'Next plan at ' + F().time24(nb) + '. Trucks leave after the plan is approved.'));
    },

    // ---- 4. urgency + on hand + run-out question ------------------------------------------------------
    renderUrgency: function (st, ev) {
      const self = this, R = this.R, sec = R.urgency;
      ui.clear(sec);
      sec.appendChild(stepHead(4, 'psg-s4', 'Urgency'));
      sec.appendChild(psg.choiceGroup({
        label: 'Urgency', name: 'urgency', value: draft.urgency, cls: 'psg-urg-choice',
        options: URGENCY.map(function (u) { return { value: u.value, title: u.title, sub: u.sub, urgency: u.value }; }),
        onChange: function (v) { draft.urgency = v; self.changed(); }
      }));
      if (draft.urgency !== 'Urgent') {
        if (draft.lines.some(function (l) { return isNum(l.onHand); })) sec.appendChild(h('div.field-help', 'On hand is optional for ' + draft.urgency + '; what you entered is passed to the planner.'));
        return;
      }
      // on hand for every line
      const box = h('div.psg-onhand');
      sec.appendChild(box);
      box.appendChild(h('div.psg-onhand-head', h('span.field-label', 'On hand now'), h('span.field-opt.small', 'required for Urgent')));
      if (!draft.lines.length) {
        box.appendChild(h('div.field-help', 'Add an item first; then enter how much of it you have.'));
      }
      const du = dailyUse(st);
      draft.lines.forEach(function (line, i) {
        const rate = rateFor(line, st);
        const missing = draft.showErrors && !isNum(line.onHand);
        const hrsEl = h('span.psg-onhand-hrs.num');
        let row = null;
        const setHrs = function () {
          const hh = U().lineHoursLeft(line, cat(), du);
          hrsEl.textContent = hh === null ? (isNum(line.onHand) ? 'no typical rate' : '') : 'lasts ' + hoursWords(hh);
        };
        const stp = psg.stepper({
          value: line.onHand, min: 0, step: CH().spec(line.itemId, line.option) ? CH().spec(line.itemId, line.option).step || 1 : 1, allowEmpty: true, label: 'On hand ' + psg.lineTitle(line), placeholder: 'how many?',
          onChange: function (v) {
            line.onHand = isNum(v) && v >= 0 ? v : null;
            setHrs();
            if (row && line.onHand !== null) row.classList.remove('is-invalid');
            clearTimeout(self.ohTimer);
            // redraw the result after a pause so typing is not interrupted
            self.ohTimer = setTimeout(function () { self.refreshUrgencyResult(); self.refresh(['supplies', 'footer']); }, 350);
          }
        });
        setHrs();
        box.appendChild(row = h('div.psg-onhand-row' + (missing ? '.is-invalid' : ''), { 'data-line': String(i) },
          h('div.psg-onhand-name', h('span.truncate', psg.lineTitle(line)), h('span.small.muted', isNum(rate) ? 'typical ' + qtyText(rate, line.unit) + ' a day' : 'no typical rate')),
          h('div.psg-qty-row', stp.el, h('span.psg-unit', CH().unitLabel(line.unit, 2))),
          hrsEl));
      });
      R.urgResult = h('div.psg-urg-result');
      sec.appendChild(R.urgResult);
      this.refreshUrgencyResult(ev);
    },
    refreshUrgencyResult: function (ev0) {
      const self = this, R = this.R;
      if (!R || !R.urgResult || draft.urgency !== 'Urgent') return;
      const st = this.ctx.getState();
      const ev = ev0 || evaluate(st);
      this.ev = ev;
      const now = nowOf(st);
      const box = R.urgResult;
      // keep the hours input (and its focus) when only the result text changes
      const keepFocus = box.contains(document.activeElement);
      if (keepFocus && R.runOutInput && document.activeElement === R.runOutInput) { this.drawUrgOutcome(ev, now); return; }
      ui.clear(box);
      R.runOutInput = null;
      const missing = ev.errors.filter(function (e) { return e.code === 'urgent-no-onhand' || (e.field === 'onHand' && e.code === 'bad-onhand'); });
      if (draft.showErrors) missing.forEach(function (e) { box.appendChild(fieldMsg('error', e.message)); });
      if (ev.needsRunOut) {
        const field = h('div.field.psg-runout' + (draft.showErrors && ev.errors.some(function (e) { return e.field === 'runout'; }) ? '.is-invalid' : ''));
        field.appendChild(h('label.field-label', { htmlFor: 'psg-runout' }, 'How many hours until you run out?'));
        field.appendChild(h('div.field-help', ev.computed === null
          ? 'There is no typical use rate for this item, so we cannot work it out.'
          : 'At typical use your on hand lasts ' + hoursWords(ev.computed) + '. Missions can burn faster; tell us what you expect.'));
        const stp = psg.stepper({
          value: draft.hoursReported, min: 0, max: 999, step: 1, allowEmpty: true, decimals: true, label: 'Hours until you run out', placeholder: 'hours', id: 'psg-runout',
          onChange: function (v) {
            draft.hoursReported = isNum(v) && v >= 0 ? v : null;
            if (draft.hoursReported !== null) {   // answered: drop the inline error now (the input keeps focus)
              field.classList.remove('is-invalid');
              Array.prototype.forEach.call(field.querySelectorAll('.field-error'), function (n) { n.remove(); });
            }
            self.drawUrgOutcome(null, now);
            self.refresh(['footer']);
          }
        });
        R.runOutInput = stp.input;
        field.appendChild(h('div.psg-qty-row', stp.el, h('span.psg-unit', 'hours')));
        if (draft.showErrors) ev.errors.filter(function (e) { return e.field === 'runout'; }).forEach(function (e) { field.appendChild(fieldMsg('error', e.message)); });
        box.appendChild(field);
      }
      R.urgOutcome = h('div.psg-urg-outcome', { 'aria-live': 'polite' });
      box.appendChild(R.urgOutcome);
      this.drawUrgOutcome(ev, now);
    },
    drawUrgOutcome: function (ev0, now) {
      const R = this.R;
      if (!R.urgOutcome) return;
      const st = this.ctx.getState();
      const ev = ev0 || evaluate(st);
      ui.clear(R.urgOutcome);
      const esc = ev.esc;
      const allOnHand = draft.lines.length && draft.lines.every(function (l) { return isNum(l.onHand); });
      if (!esc || !allOnHand) return;
      if (esc.urgency === 'Immediate') {
        const hrs = esc.runOutAt !== null ? (esc.runOutAt - now) / 60 : null;
        R.urgOutcome.appendChild(h('div.notice.notice-error.psg-immediate', { 'data-urgency': 'Immediate' }, icon('alert'),
          h('div', h('strong', 'This will be sent as IMMEDIATE: '), 'you run out in ' + hoursWords(hrs) + (esc.runOutAt !== null ? ' (' + psg.time(esc.runOutAt, now) + ')' : '') + '.',
            esc.deadline < ev.req.nlt ? h('div.small', 'Deadline moves up to ' + psg.time(esc.deadline, now) + ', before your NLT ' + psg.time(ev.req.nlt, now) + '.') : h('div.small', 'Deadline is your NLT ' + psg.time(esc.deadline, now) + '.'))));
      } else if (ev.needsRunOut && !isNum(draft.hoursReported)) {
        // waiting for the answer
      } else {
        const hrs = isNum(esc.hoursLeftReported) ? esc.hoursLeftReported : esc.hoursLeftComputed;
        R.urgOutcome.appendChild(h('div.notice.notice-warn.psg-stays-urgent', { 'data-urgency': 'Urgent' }, icon('info'),
          h('div', h('strong', 'This stays URGENT: '), (isNum(hrs) ? 'you have ' + hoursWords(hrs) + ' of supply. ' : '') + 'NLT ' + psg.time(ev.req.nlt, now) + ' is firm.')));
      }
    },

    // ---- 5. remarks (rendered once so typing is never interrupted) -----------------------------------
    renderRemarks: function () {
      const sec = this.R.remarks;
      ui.clear(sec);
      sec.appendChild(stepHead(5, 'psg-s5', 'Remarks', h('span.field-opt.small', 'optional')));
      const t = h('textarea.textarea.psg-remarks', { rows: '2', maxlength: '300', placeholder: 'e.g. Gate on the east side. Call on arrival.', 'aria-labelledby': 'psg-s5' });
      t.value = draft.remarks || '';
      t.addEventListener('input', function () { draft.remarks = t.value; });
      sec.appendChild(t);
    },

    // ---- footer: summary, errors, submit ------------------------------------------------------------
    renderFooter: function (st, ev) {
      const self = this, R = this.R, f = R.footer;
      ui.clear(f);
      const now = nowOf(st);
      if (draft.showErrors && ev.errors.length) {
        const list = h('ul.psg-err-list');
        dedupe(ev.errors).forEach(function (e) {
          list.appendChild(h('li', h('button.psg-err-link', { type: 'button', onClick: function () { self.scrollTo(SEC_OF_FIELD[e.field] || 'supplies'); } }, e.message)));
        });
        f.appendChild(h('div.notice.notice-error.psg-errors', { role: 'alert' }, icon('alert'), h('div', h('strong', ev.errors.length === 1 ? 'Fix this first:' : 'Fix these first:'), list)));
      }
      const n = draft.lines.length;
      const urg = ev.esc && ev.esc.urgency ? ev.esc.urgency : draft.urgency;
      const summary = h('div.psg-footer-sum',
        n ? h('span', n + (n === 1 ? ' item' : ' items')) : h('span.faint', 'No items yet'),
        h('span.badge.badge-urgency.urg-' + urg.toLowerCase(), urg),
        h('span.num', 'NLT ' + psg.time(nltOf(st), now)));
      f.appendChild(summary);
      const editing = draft.editingId;
      const r = editing ? (st.requests || []).find(function (x) { return x.id === editing; }) : null;
      const locked = editing && (!r || psg.EDITABLE.indexOf(r.status) < 0);
      const btn = h('button.btn.btn-primary.btn-lg.btn-block.psg-submit', { type: 'button', disabled: !!locked, onClick: function () { self.submit(); } },
        icon(editing ? 'check' : 'send'), editing ? 'Save changes' : 'Submit request');
      f.appendChild(btn);
      if (editing) {
        f.appendChild(h('button.btn.btn-ghost.btn-block.psg-discard', { type: 'button', onClick: function () { reveal(editing); self.reset(); ui.psgTabs.show('myrequests'); } }, 'Discard changes'));
      }
    },

    scrollTo: function (secName) {
      const el = this.R && this.R[secName === 'unit' ? 'unit' : secName];
      if (!el) return;
      try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
    },

    reset: function () {
      draft = freshDraft();
      if (this.mode === 'form' || this.mode === 'done') this.build(this.ctx.getState());
    },

    submit: function () {
      const self = this;
      const st = this.ctx.getState();
      draft.showErrors = true;
      const ev = evaluate(st);
      if (ev.errors.length) {
        // only now: re-rendering re-creates the pickup-hint map, which the confirmation would remove again
        this.refresh(['unit', 'supplies', 'delivery', 'when', 'urgency', 'footer']);
        const first = ev.errors[0];
        this.scrollTo(SEC_OF_FIELD[first.field] || 'supplies');
        return;
      }
      const go = function () { self.send(ev.req); };
      if (ev.warnings.length) {
        ui.modal.open({
          title: 'Check before sending',
          size: 'sm',
          body: function (el) {
            el.classList.add('psg-warn-sheet');
            el.appendChild(h('ul.psg-warn-list', dedupe(ev.warnings).map(function (w) { return h('li', fieldMsg('warn', w.message)); })));
            el.appendChild(h('p.small.muted', 'You can still send it; the planner will see the request as it is.'));
          },
          actions: [
            { label: 'Go back', kind: 'secondary', id: 'warn-back' },
            { label: draft.editingId ? 'Save anyway' : 'Send anyway', kind: 'primary', id: 'warn-send', onClick: function () { setTimeout(go, 0); } }
          ]
        });
        return;
      }
      go();
    },

    send: function (req) {
      const st = this.ctx.getState();
      if (draft.editingId) {
        const id = draft.editingId;
        const changes = Object.assign({}, req);
        // unchanged on hand: leave it out so the store keeps the original report time
        if (sameReport(req)) { delete changes.lines; delete changes.hoursLeftReported; }
        const res = this.ctx.dispatch({ type: 'request/edit', id: id, changes: changes, now: nowOf(st) });
        if (!res || !res.ok) { ui.toast((res && res.error) || 'Could not save the changes.', 'error'); this.refresh(['head', 'footer']); return; }
        ui.toast(id + ' updated.', 'success');
        draft = freshDraft();
        this.build(this.ctx.getState());
        psg.toTop(this);
        reveal(id);
        ui.psgTabs.show('myrequests');
        return;
      }
      const res = this.ctx.dispatch({ type: 'request/submit', request: req, now: nowOf(st) });
      if (!res || !res.ok) { ui.toast((res && res.error) || 'Could not submit the request.', 'error'); return; }
      draft = freshDraft();
      this.showDone(res.id);
    },

    // ---- confirmation --------------------------------------------------------------------------------
    showDone: function (id) {
      const self = this, el = this.el;
      this.teardown();
      ui.clear(el);
      this.mode = 'done';
      this.doneSeen = false;
      this.R = {};
      const st = this.ctx.getState();
      const r = (st.requests || []).find(function (x) { return x.id === id; }) || {};
      const now = nowOf(st);
      const nb = psg.nextPlanAt(r.createdAt !== undefined ? r.createdAt : now);
      const urg = r.urgency || r.urgencyRequested || 'Routine';
      const card = h('div.card.psg-done', { role: 'status' },
        h('div.psg-done-icon', icon('check', { size: 28 })),
        h('h2.psg-title', 'Request sent'),
        h('div.psg-done-id', h('span.num.psg-done-rid', id), h('span.badge.badge-urgency.urg-' + urg.toLowerCase(), urg), h('span.badge.st-submitted', 'Submitted')),
        urg === 'Immediate' && r.urgencyRequested === 'Urgent'
          ? h('div.notice.notice-error', icon('alert'), h('div', h('strong', 'Sent as IMMEDIATE. '), 'Deadline ' + psg.time(r.deadline, now) + '.'))
          : null,
        h('ul.psg-done-lines', (r.lines || []).map(function (l) { return h('li', h('span.num', qtyText(l.qty, l.unit)), ' ', psg.lineTitle(l)); })),
        h('dl.kv.psg-kv',
          h('dt', 'NLT'), h('dd.num', psg.time(r.nlt, now)),
          h('dt', 'Pickup'), h('dd', r.directOnly ? 'Direct to your location' : 'Nearby drop point' + (r.desiredPickup ? ' (you suggested ' + (psg.place(r.desiredPickup.lat, r.desiredPickup.lon) || {}).name + ')' : ''))),
        h('div.psg-next',
          h('h3.psg-sec-title', 'What happens next'),
          h('p.psg-next-text', 'Planned at the ' + F().time24(nb) + ' window; you will see your pickup point and ETA in My requests.'),
          h('p.small.muted', 'You can edit or cancel it there until the plan is approved.')),
        h('div.psg-done-actions',
          h('button.btn.btn-primary.btn-lg.btn-block.psg-view-mine', { type: 'button', onClick: function () { self.doneSeen = true; reveal(id); ui.psgTabs.show('myrequests'); } }, icon('truck'), 'View my requests'),
          h('button.btn.btn-secondary.btn-block.psg-new', { type: 'button', onClick: function () { draft = freshDraft(); self.build(self.ctx.getState()); } }, icon('plus'), 'New request')));
      el.appendChild(card);
      psg.toTop(this);
    }
  };

  // ==== small DOM helpers ==========================================================================
  // My requests opens on this request's card (it may sit lower in the list than where that tab was left)
  function reveal(id) { if (id && psg.myRequestsView && psg.myRequestsView.reveal) psg.myRequestsView.reveal(id); }
  function stepHead(n, id, title, extra) {
    return h('div.psg-step-head', h('span.psg-step-num', { 'aria-hidden': 'true' }, String(n)), h('h3.psg-sec-title', { id: id }, title), extra || null);
  }
  function fieldMsg(kind, text) {
    const cls = kind === 'error' ? 'field-error' : kind === 'warn' ? 'field-warn' : 'field-help';
    return h('div.' + cls, kind === 'help' ? null : icon('alert'), h('span', text));
  }
  function dedupe(list) {
    const seen = {};
    return list.filter(function (e) { if (seen[e.message]) return false; seen[e.message] = true; return true; });
  }
  function focusFirst(scope, sel) {
    setTimeout(function () {
      const el = scope.querySelector(sel);
      if (el && !ui.isPhone()) { try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      if (el) { try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ignore */ } }
    }, 0);
  }
  function cssVar(name, dflt) {
    try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || dflt; } catch (e) { return dflt; }
  }
  // Day / hour / minute selects for "Other time" (24 h)
  function nltSelects(now, value, onChange) {
    const day0 = F().dayOf(now);
    const vDay = F().dayOf(value), vMin = ((value % 1440) + 1440) % 1440;
    const dSel = h('select.select.psg-nlt-day', { 'aria-label': 'Day' });
    for (let d = day0; d <= day0 + 2; d++) dSel.appendChild(h('option', { value: String(d) }, 'Day ' + d + (d === day0 ? ' (today)' : d === day0 + 1 ? ' (tomorrow)' : '')));
    if (vDay < day0 || vDay > day0 + 2) dSel.appendChild(h('option', { value: String(vDay) }, 'Day ' + vDay));
    dSel.value = String(vDay);
    const hSel = h('select.select.num.psg-nlt-hour', { 'aria-label': 'Hour (24 h)' });
    for (let i = 0; i < 24; i++) hSel.appendChild(h('option', { value: String(i) }, (i < 10 ? '0' : '') + i));
    hSel.value = String(Math.floor(vMin / 60));
    const mSel = h('select.select.num.psg-nlt-min', { 'aria-label': 'Minutes' });
    const mins = [0, 15, 30, 45];
    if (mins.indexOf(vMin % 60) < 0) mins.push(vMin % 60);
    mins.sort(function (a, b) { return a - b; }).forEach(function (m) { mSel.appendChild(h('option', { value: String(m) }, (m < 10 ? '0' : '') + m)); });
    mSel.value = String(vMin % 60);
    const fire = function () { onChange((+dSel.value - 1) * 1440 + (+hSel.value) * 60 + (+mSel.value)); };
    [dSel, hSel, mSel].forEach(function (s) { s.addEventListener('change', fire); });
    return h('div.psg-nlt-selects', h('div.field', h('span.field-label', 'Day'), dSel), h('div.field', h('span.field-label', 'Hour'), hSel), h('div.field', h('span.field-label', 'Min'), mSel));
  }

  // ==== API =========================================================================================
  psg.request = {
    view: view,
    draft: function () { return draft; },
    reset: function () { view.ctx ? view.reset() : (draft = freshDraft()); },
    // Load an editable request into the form and show it.
    edit: function (id) {
      const app = SRO.app;
      const st = app && app.store ? app.store.getState() : null;
      const r = st ? (st.requests || []).find(function (x) { return x.id === id; }) : null;
      if (!r) { ui.toast('Request ' + id + ' was not found.', 'error'); return false; }
      if (psg.EDITABLE.indexOf(r.status) < 0) { ui.toast(id + ' is ' + (psg.STATUS_LABEL[r.status] || r.status).toLowerCase() + ' and can no longer be changed.', 'warn'); return false; }
      const prof = st.profile || {};
      const d = freshDraft();
      d.editingId = id;
      d.lines = clone(r.lines || []);
      d.mobility = r.mobility && r.mobility !== prof.mobility ? r.mobility : null;
      d.pick = r.directOnly && r.mobility !== 'fixed' ? 'direct' : 'drop';
      d.directReason = r.directReason || null;
      d.directReasonText = r.directReasonText || '';
      if (r.desiredPickup) {
        const g = (SRO.data.grid || []).find(function (x) { return x.id === r.desiredPickup.gridId; });
        d.desiredPickup = { lat: r.desiredPickup.lat, lon: r.desiredPickup.lon, gridId: r.desiredPickup.gridId, name: g ? psg.placeName(g) : 'Selected spot' };
      }
      d.nlt = r.nlt;
      d.nltOther = false;   // renderWhen shows the selects when no quick chip matches
      d.urgency = r.urgencyRequested || 'Routine';
      d.hoursReported = isNum(r.hoursLeftReported) ? r.hoursLeftReported : null;
      d.remarks = r.remarks || '';
      d.adding = false;
      d.orig = { key: reportKey(r.lines, r.hoursLeftReported), at: r.createdAt };
      draft = d;
      if (view.ctx && (view.mode === 'form' || view.mode === 'done')) view.build(view.ctx.getState());
      ui.psgTabs.show('request');
      psg.toTop(view);   // the form from its top, wherever the tab was left
      return true;
    }
  };

  if (ui.registerView) ui.registerView('psg/request', view);
})(typeof self !== 'undefined' ? self : globalThis);
