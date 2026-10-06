// Planner Plan view (right panel on wide screens, 'Plan' tab on small ones).
//
//   Optimizer card   method (Tabu search / Simulated annealing / Ant colony / Exact (MIP)), time limit,
//                    run-time estimate before running (engine.estimate; MIP states its limit and that it
//                    reports how close to optimal it got), Plan now, Compare mode (pick methods -> run
//                    them -> comparison table -> keep one). While running: progress bar, live best-cost
//                    sparkline (engine status.history), elapsed time, Cancel (keeps the best plan).
//   Plan             name (rename), status, what Exact (MIP) proved (plan.mipProof), optimizer notes
//                    (plan.warnings; turn-backs and kept plans shown open), plan picker, the summary
//                    strip in spec order (requests, stops, trucks used, miles, gallons, risk, delayed
//                    (red, opens the list of delayed requests and what blocked each), run time; a
//                    re-plan adds a 'This window' strip from plan.windowStats next to its 'From now'
//                    one), Approve plan (confirm says what happens, which trucks leave and which carry
//                    on, and lists plan.violations; a refused approval ('infeasible-plan') offers the
//                    plans that meet every rule), Save snapshot, Compare to previous plan (what
//                    moved), before/after list after a contingency re-plan, per-truck route cards
//                    with the stops in order in plain words (open Route detail) and a compact
//                    timeline with day / dusk / night / dawn shading.
//   Compare table    one column per method: total cost and the parts that add up to it (fuel,
//                    distance, risk, simplicity, platoon travel, lateness, delay and ETA-change
//                    penalties, plus pinned and rule-break penalties when any plan has them), then late
//                    and delayed requests, run time and MIP gap. After a compare (or Cancel during
//                    one) the lowest-cost plan is shown and is the one Approve acts on.
// All numbers come from the stored Plan (plan.stats, plan.cost, plan.routes); the optimizer runs through
// SRO.core.engine (DESIGN.md 8b). The view keeps only UI state (compare picks, toggles, estimate text).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const ui = SRO.ui = SRO.ui || {};
  function K() { return ui.plannerKit; }
  const h = function () { return ui.h.apply(null, arguments); };
  // Plan status in the same plain word as Outputs / History: a plan another approval replaced reads
  // 'Replaced' (the data field stays plan.superseded, and the badge class is-superseded).
  function statusOf(plan) {
    const s = K().planStatus(plan);
    return s && s.key === 'superseded' ? Object.assign({}, s, { label: 'Replaced' }) : s;
  }

  const RUN_PHASES = ['preparing', 'estimating', 'running'];
  const PERIOD_KEYS = { Day: 'day', Dusk: 'dusk', Night: 'night', Dawn: 'dawn' };

  function capKey(method) { return method === 'mip' ? 'timeLimitSec' : 'timeCapSec'; }
  function methodParams(state, method) {
    const s = state.scenario.settings || {};
    const raw = (s.methodParams && s.methodParams[method]) || {};
    return SRO.solver && SRO.solver.clampParams ? SRO.solver.clampParams(method, raw, s) : Object.assign({}, raw);
  }
  function effectiveLimit(state, method) {
    const p = methodParams(state, method);
    const v = p[capKey(method)];
    return K().isNum(v) ? v : (state.scenario.settings.timeLimitSec || 300);
  }
  // Methods the engine says cannot run here -> { key: reason }. Exact (MIP) counts as unknown (not
  // unavailable) until the solver worker has reported whether HiGHS loaded.
  function unavailableMethods(eng) {
    const out = {};
    if (!eng || typeof eng.methods !== 'function') return out;
    let list, st;
    try { list = eng.methods() || []; st = typeof eng.status === 'function' ? eng.status() : null; } catch (e) { return out; }
    const pending = !st || st.highsReady === null || st.highsReady === undefined;
    list.forEach(function (m) {
      if (!m || !m.key || m.available !== false) return;
      if (m.key === 'mip' && pending) return;
      out[m.key] = m.reason || (K().methodLabel(m.key) + ' cannot run in this browser.');
    });
    return out;
  }
  function pickerLabel(p, withId) {
    const k = K();
    const st = statusOf(p);
    // a stopped plan's name already says '(stopped)'
    const lab = st.key === 'cancelled' && /stopped/i.test(p.name || '') ? 'draft' : st.label.toLowerCase();
    // the id last: a closed select cut short still shows the name, cost and status
    return (p.name || p.id) + ' · ' + (p.cost && k.isNum(p.cost.total) ? k.num(p.cost.total, 0) + ' pts' : 'no cost') + ' · ' + lab + (withId ? ' · ' + p.id : '');
  }
  function stableKey(o) { try { return JSON.stringify(o); } catch (e) { return String(Math.random()); } }
  function openCount(state) {
    const k = K();
    return k.queueRequests(state).filter(function (r) { return k.OPEN_STATUSES.indexOf(r.status) >= 0; }).length;
  }

  // What Exact (MIP) proved, from plan.mipProof ({ stopReason 'optimal' | 'gap' | 'time' | 'cancel' |
  // 'error', gap, dualBound, gapTarget, exactModel }); plans stored before that field get one from
  // plan.stopReason and plan.mipGap. null for the heuristics.
  function mipProofOf(plan) {
    const k = K();
    if (!plan) return null;
    if (plan.mipProof) return plan.mipProof;
    if (plan.method !== 'mip' && !k.isNum(plan.mipGap)) return null;
    const g = k.isNum(plan.mipGap) ? plan.mipGap : null;
    const sr = plan.cancelled ? 'cancel' : plan.stopReason === 'time' ? 'time'
      : plan.stopReason === 'optimal' || plan.stopReason === 'gap' ? (g !== null && g <= 1e-6 ? 'optimal' : 'gap')
      : plan.stopReason === 'error' ? 'error' : 'unknown';
    return { stopReason: sr, gap: g, dualBound: null, gapTarget: plan.params && k.isNum(plan.params.mipGap) ? plan.params.mipGap : null, exactModel: null };
  }
  // a proven gap as an upper bound ('within 0.1%' for anything smaller); a gap target with the
  // decimals it was set with (0.01%)
  function pctText(g) { return g > 0 && g < 0.0005 ? '0.1%' : (g * 100).toFixed(1) + '%'; }
  function targetText(g) { return (+(g * 100).toFixed(2)) + '%'; }
  // One plain sentence (plus a caveat) for the notice under the plan name. The gap is measured against
  // the exact model's bound (the lowest cost the model could still prove possible), not against every
  // possible plan, and the model is exact only when there is one time-of-day period.
  function mipNotice(plan) {
    const k = K(), pr = mipProofOf(plan);
    if (!pr) return null;
    const g = k.isNum(pr.gap) ? pr.gap : null;
    const within = g !== null ? h('span', ' proven within ', h('strong.num', pctText(g)), ' of the exact model\'s bound.') : null;
    let lead;
    if (pr.stopReason === 'optimal') lead = h('span', 'Exact (MIP) proved this is the best plan its model can make (gap ', h('strong.num', '0%'), ').');
    else if (pr.stopReason === 'gap') lead = h('span', 'Exact (MIP) stopped at your gap target' + (k.isNum(pr.gapTarget) ? ' of ' + targetText(pr.gapTarget) : '') + ':', within);
    else if (pr.stopReason === 'time') lead = within ? h('span', 'Exact (MIP) reached its time limit:', within) : h('span', 'Exact (MIP) reached its time limit before it could prove a gap.');
    // Cancel stops the solver worker, so a cancelled run keeps the plan but no proven gap (whatever the
    // progress line showed while it ran)
    else if (pr.stopReason === 'cancel') lead = within ? h('span', 'Exact (MIP) was stopped with Cancel:', within) : h('span', 'Exact (MIP) was stopped with Cancel, so this plan carries no proven gap.');
    else if (pr.stopReason === 'unknown') lead = within ? h('span', 'Exact (MIP):', within) : h('span', 'Exact (MIP) did not record what it proved for this plan.');
    else lead = h('span', 'Exact (MIP) hit a solver error, so this is the starting plan it was given; no gap is proven.');
    const notes = [];
    if (g !== null && pr.stopReason !== 'optimal') notes.push('The bound is the lowest cost the model could still prove possible, so the best plan lies somewhere in that gap.');
    if (pr.exactModel === false) notes.push('The model uses each leg\'s average time-of-day speed and risk, while the plan is scored on the real times, so its cost can differ a little from the model\'s.');
    return h('div.notice.notice-info.pp-gap', { 'data-testid': 'mip-notice', 'data-reason': pr.stopReason }, ui.icon('info'),
      h('div', lead, notes.length ? h('div.small.muted.pp-gap-note', notes.join(' ')) : null));
  }

  // The stops of a route in plain words, in order: rally point names, and the unit designator for a
  // direct delivery ("Su'ao > 1/B/4-98CAV > Sanyi > Zhudong"); a turn-back reads 'turned back'.
  function stopsLine(state, rt) {
    const k = K();
    const stops = rt.stops || [];
    const ix = k.legStops(rt), tb = k.turnBack(rt);
    const tbAt = tb ? ix.slice(tb.legIndex + 1).find(function (x) { return x >= 0; }) : undefined;
    const names = [];
    stops.forEach(function (st, i) {
      if (tb && tbAt === i) names.push('turned back');
      // short place names ("Su'ao interchange", not "... (Suhua Hwy north end)")
      let name = String((st.kind === 'rally' && st.gridId ? k.gridName(st.gridId) : st.label) || '').replace(/\s*\([^)]*\)\s*$/, '');
      if (st.kind !== 'rally') {
        const ids = {};
        (st.deliveries || []).forEach(function (d) { ids[d.requestId] = true; });
        const one = Object.keys(ids).length === 1 ? k.request(state, Object.keys(ids)[0]) : null;
        if (one && one.designator) name = one.designator;
      }
      names.push(name || ('Stop ' + (i + 1)));
    });
    return names.join(' > ');
  }

  // small SVG line of best cost over time, drawn on to the elapsed time (nowT) so a run that has
  // not improved for a while still shows time passing
  function sparkline(history, w, hgt, nowT) {
    const pts = (history || []).filter(function (p) { return p && K().isNum(p.best) && K().isNum(p.t); });
    const svg = h('svg.pp-spark', { viewBox: '0 0 ' + w + ' ' + hgt, width: w, height: hgt, role: 'img', 'aria-label': 'Best plan cost over time' });
    if (!pts.length) {
      svg.appendChild(h('line', { x1: 0, y1: hgt - 2, x2: w, y2: hgt - 2, class: 'pp-spark-base' }));
      return svg;
    }
    const step = Math.max(1, Math.ceil(pts.length / 80));
    const use = pts.filter(function (p, i) { return i % step === 0 || i === pts.length - 1; });
    const lastT = use[use.length - 1].t;
    const now = K().isNum(nowT) && nowT > lastT ? nowT : lastT;
    if (now > lastT) use.push({ t: now, best: use[use.length - 1].best });
    if (use.length < 2) use.push({ t: use[0].t + 1, best: use[0].best });
    const t0 = use[0].t, t1 = use[use.length - 1].t > t0 ? use[use.length - 1].t : t0 + 1;
    let lo = Infinity, hi = -Infinity;
    use.forEach(function (p) { lo = Math.min(lo, p.best); hi = Math.max(hi, p.best); });
    if (hi - lo < 1e-9) { hi = lo + 1; }
    const x = function (t) { return t1 > t0 ? (t - t0) / (t1 - t0) * (w - 4) + 2 : 2; };
    const y = function (v) { return 3 + (1 - (v - lo) / (hi - lo)) * (hgt - 6); };
    // step line: the best cost only drops
    let d = 'M' + x(use[0].t).toFixed(1) + ' ' + y(use[0].best).toFixed(1);
    for (let i = 1; i < use.length; i++) d += ' H' + x(use[i].t).toFixed(1) + ' V' + y(use[i].best).toFixed(1);
    svg.appendChild(h('path', { d: d, class: 'pp-spark-line' }));
    const lastP = use[use.length - 1];
    svg.appendChild(h('circle', { cx: x(lastP.t).toFixed(1), cy: y(lastP.best).toFixed(1), r: 2.5, class: 'pp-spark-dot' }));
    return svg;
  }

  const PlanView = {
    label: 'Plan', icon: 'route', region: 'right', order: 30,

    badge: function (state) {
      const k = K();
      if (!k) return null;
      const p = k.viewedPlan(state);
      if (!p || p.approved || p.superseded) return null;
      const d = p.stats && p.stats.delayed;
      return d > 0 ? { text: String(d), alert: true } : null;
    },

    mount: function (el, ctx) {
      const self = this;
      self.ctx = ctx;
      self.el = el;
      self.keys = {};
      self.compareMode = false;
      self.compareMethods = { tabu: true, sa: true, aco: false, mip: false };
      self.compareIds = null;
      self.showDiff = false;
      self.est = { key: null, text: '', seq: 0 };
      self.busy = null;
      el.classList.add('pp');
      self.secSolver = h('section.card.pp-solver', { 'aria-label': 'Optimizer' });
      self.secCompare = h('section.pp-compare', { hidden: true, 'aria-label': 'Method comparison' });
      self.secHead = h('section.pp-head', { 'aria-label': 'Plan' });
      self.secSummary = h('div.pp-summary-wrap');
      self.secActions = h('div.pp-actions');
      self.secDiff = h('section.pp-diff-wrap', { hidden: true });
      self.secTrucks = h('section.pp-trucks-wrap', { 'aria-label': 'Trucks' });
      self.secTimeline = h('section.pp-timeline-wrap', { 'aria-label': 'Timeline' });
      [self.secSolver, self.secCompare, self.secHead, self.secSummary, self.secActions, self.secDiff, self.secTrucks, self.secTimeline]
        .forEach(function (s) { el.appendChild(s); });
      self.buildSolver();
      self.offSel = K().onSelect(function (sel, prev) {
        if (sel.planId !== prev.planId) self.render(ctx.getState(), true);
      });
      self.attachEngine();
    },

    unmount: function () {
      if (this.offSel) this.offSel();
      if (this.offEngine) this.offEngine();
      clearTimeout(this.estTimer);
    },

    attachEngine: function () {
      const self = this;
      const eng = K().engine();
      if (!eng || self.engineRef === eng) return;
      if (self.offEngine) self.offEngine();
      self.engineRef = eng;
      self.offEngine = typeof eng.subscribe === 'function' ? eng.subscribe(function (st) { self.onStatus(st); }) : null;
      if (typeof eng.status === 'function') { try { self.onStatus(eng.status()); } catch (e) { /* engine not ready */ } }
    },

    update: function (state, ctx) {
      this.ctx = ctx;
      if (ctx.clockOnly) return;
      this.render(state, false);
    },

    onShow: function () { this.render(this.ctx.getState(), true); },

    changed: function (name, key) {
      const prev = this.keys[name];
      const same = prev && prev.length === key.length && key.every(function (v, i) { return v === prev[i]; });
      if (same) return false;
      this.keys[name] = key;
      return true;
    },

    render: function (state, force) {
      if (!state) return;
      const k = K();
      this.attachEngine();
      const plan = k.viewedPlan(state);
      // a plan stored from elsewhere (re-plan from Scenario, automatic window plan) or by a new run:
      // the old comparison no longer applies; bring the new plan's header into view
      const lastId = state.ui && state.ui.lastPlanId;
      if (lastId !== this.seenLastId) {
        const first = this.seenLastId === undefined;
        this.seenLastId = lastId;
        if (!first && lastId) {
          const comparing = this.busy && this.busy.methods;
          if (!comparing && this.compareIds && this.compareIds.indexOf(lastId) < 0) { this.compareIds = null; this.keptId = null; }
          if (!this.busy && plan && plan.id === lastId) { const self = this; setTimeout(function () { self.scrollTo(self.secHead); }, 0); }
        }
      }
      if (force) this.keys = {};
      this.syncSolver(state);
      const plans = state.plans;
      if (this.changed('compare', [this.compareIds, plans, plan])) this.renderCompare(state, plan);
      if (this.changed('head', [plan, plans, state.snapshots])) { this.renderHead(state, plan); this.renderSummary(state, plan); this.renderActions(state, plan); }
      const prev = plan ? k.previousPlan(state, plan) : null;
      if (this.changed('diff', [plan, prev, this.showDiff, state.requests])) this.renderDiff(state, plan, prev);
      if (this.changed('trucks', [plan, state.scenario.fleet])) this.renderTrucks(state, plan);
      if (this.changed('timeline', [plan, state.scenario.settings.periods])) this.renderTimeline(state, plan);
    },

    // ==== optimizer card =============================================================================
    buildSolver: function () {
      const self = this, k = K();
      const card = self.secSolver;
      const r = self.sv = {};
      r.title = h('div.card-header', h('div', h('h2.card-title', 'Optimizer'), r.sub = h('div.card-sub.num')));
      r.method = h('select.select#pp-method', {
        'data-testid': 'method',
        onChange: function (e) { self.ctx.dispatch({ type: 'settings/update', path: 'method', value: e.target.value }); }
      }, k.METHOD_KEYS.map(function (m) { return h('option', { value: m }, k.methodLabel(m)); }));
      r.limit = h('input.input.num#pp-limit', {
        type: 'number', min: 5, max: 1800, step: 5, inputmode: 'numeric', 'data-testid': 'time-limit',
        'aria-describedby': 'pp-limit-help',
        onChange: function (e) { self.setLimit(e.target.value); },
        onKeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); self.setLimit(e.target.value); } }
      });
      r.limitHelp = h('div.field-help#pp-limit-help');
      r.est = h('div.pp-est', { 'data-testid': 'estimate', 'aria-live': 'polite' });
      r.planNow = h('button.btn.btn-primary.pp-run', { type: 'button', 'data-testid': 'plan-now', onClick: function () { self.planNow(); } }, ui.icon('play'), 'Plan now');
      r.cmpToggle = h('button.btn.btn-secondary.pp-cmp-toggle', {
        type: 'button', 'aria-pressed': 'false', 'data-testid': 'compare-toggle',
        onClick: function () { self.compareMode = !self.compareMode; self.syncSolver(self.ctx.getState(), true); }
      }, ui.icon('sliders'), 'Compare methods');
      r.cmpBox = h('div.pp-cmp-pick', { hidden: true });
      r.cmpChecks = {};
      const checks = h('div.pp-cmp-checks', { role: 'group', 'aria-label': 'Methods to compare' });
      k.METHOD_KEYS.forEach(function (m) {
        const cb = h('input', { type: 'checkbox', value: m, checked: !!self.compareMethods[m], 'data-testid': 'cmp-' + m,
          onChange: function (e) { self.compareMethods[m] = e.target.checked; self.syncSolver(self.ctx.getState(), true); } });
        r.cmpChecks[m] = cb;
        checks.appendChild(h('label.check', cb, h('span', k.methodLabel(m))));
      });
      r.cmpEst = h('div.pp-est.pp-cmp-est');
      r.cmpRun = h('button.btn.btn-primary', { type: 'button', 'data-testid': 'compare-run', onClick: function () { self.runCompare(); } }, ui.icon('play'), 'Run compare');
      r.cmpBox.appendChild(h('div.field-label', 'Run these methods one after another on the same requests'));
      r.cmpBox.appendChild(checks);
      r.cmpBox.appendChild(r.cmpEst);
      r.cmpBox.appendChild(h('div.hstack.wrap', r.cmpRun, h('span.field-help', 'Each method uses its current settings (Scenario, Advanced).')));
      // running panel
      r.run = h('div.pp-running', { hidden: true, 'data-testid': 'run-panel', role: 'status' });
      r.runTitle = h('div.pp-run-title');
      r.bar = h('div.progress-bar');
      r.progress = h('div.progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Optimizer progress' }, r.bar);
      r.elapsed = h('span.num');
      r.best = h('span.num');
      r.spark = h('div.pp-spark-box');
      r.msg = h('div.field-help.pp-run-msg');
      r.cancel = h('button.btn.btn-danger.btn-sm', { type: 'button', 'data-testid': 'cancel', onClick: function () { self.cancel(); } }, ui.icon('x'), 'Cancel');
      r.run.appendChild(r.runTitle);
      r.run.appendChild(r.progress);
      r.run.appendChild(h('div.progress-meta', r.elapsed, r.best));
      r.run.appendChild(h('div.pp-run-row', r.spark, h('div.pp-run-side', r.cancel, h('div.field-help', 'Cancel keeps the best plan found so far.'))));
      r.run.appendChild(r.msg);
      r.unavail = h('div.notice.notice-warn', { hidden: true, 'data-testid': 'method-unavailable' }, ui.icon('alert'), r.unavailText = h('div'));
      r.missing = h('div.notice.notice-warn', { hidden: true }, ui.icon('alert'), h('div', 'The optimizer (planner engine) is not loaded in this build, so plans cannot be made here.'));
      r.pending = h('div.pp-pending.small.muted.num');
      card.appendChild(r.title);
      card.appendChild(h('div.card-body',
        h('div.pp-solver-row',
          h('div.field.pp-f-method', h('label.field-label', { for: 'pp-method' }, 'Method'), r.method),
          h('div.field.pp-f-limit', h('label.field-label', { for: 'pp-limit' }, 'Time limit ', h('span.field-opt', '(s)')), r.limit)),
        r.limitHelp,
        r.est,
        r.unavail,
        r.missing,
        h('div.pp-solver-actions', r.planNow, r.cmpToggle),
        r.pending,
        r.cmpBox,
        r.run));
    },

    setLimit: function (raw) {
      const st = this.ctx.getState();
      const m = st.scenario.settings.method || 'tabu';
      let v = Math.round(Number(raw));
      if (!isFinite(v)) { ui.toast('Enter the time limit in seconds (5 to 1800).', 'warn'); this.syncSolver(st, true); return; }
      v = Math.max(5, Math.min(1800, v));
      const mp = {};
      mp[m] = {};
      mp[m][capKey(m)] = v;
      if (m === 'mip') mp[m].timeCapSec = v;
      const res = this.ctx.dispatch({ type: 'settings/update', changes: { timeLimitSec: v, methodParams: mp } });
      if (!res || !res.ok) ui.toast((res && res.error) || 'Could not change the time limit.', 'error');
    },

    syncSolver: function (state, force) {
      const self = this, k = K(), r = self.sv;
      if (!r) return;
      const s = state.scenario.settings || {};
      const method = s.method || 'tabu';
      if (r.method.value !== method) r.method.value = method;
      const limit = effectiveLimit(state, method);
      if (root.document.activeElement !== r.limit && String(r.limit.value) !== String(limit)) r.limit.value = String(limit);
      r.limitHelp.textContent = method === 'mip'
        ? 'The exact solver runs until this limit (or until it proves its gap target), then returns its best plan and its proven gap to the exact model\'s bound.'
        : 'The run stops here at the latest and keeps the best plan found so far.';
      const eng = k.engine();
      const running = self.isRunning();
      const n = openCount(state);
      const off = unavailableMethods(eng);
      self.unavailKey = stableKey(off);
      Array.prototype.forEach.call(r.method.options, function (o) {
        const no = !!off[o.value];
        o.disabled = no;
        o.textContent = k.methodLabel(o.value) + (no ? ' (not available)' : '');
      });
      r.unavail.hidden = !off[method];
      if (off[method]) r.unavailText.textContent = off[method] + ' Pick another method.';
      r.missing.hidden = !!eng;
      r.sub.textContent = 'Window ' + k.windowLabel(k.currentWindow(state));
      r.pending.textContent = n ? n + (n === 1 ? ' open request' : ' open requests') + ' will be planned.' : 'No open requests to plan in this window.';
      r.planNow.disabled = !eng || running || !n || !!off[method];
      r.cmpToggle.disabled = !eng || running;
      r.method.disabled = running;
      r.limit.disabled = running;
      r.cmpToggle.setAttribute('aria-pressed', String(self.compareMode));
      r.cmpBox.hidden = !self.compareMode;
      const picks = self.comparePicks();
      r.cmpRun.disabled = !eng || running || picks.length < 2 || !n;
      Object.keys(r.cmpChecks).forEach(function (m) {
        const cb = r.cmpChecks[m];
        cb.disabled = running || !!off[m];
        cb.checked = !!self.compareMethods[m] && !off[m];
        cb.parentNode.title = off[m] || '';
        cb.parentNode.classList.toggle('is-disabled', !!off[m]);
      });
      r.run.hidden = !running;
      // estimates (debounced; re-run when the method, its knobs, the requests or the fleet change)
      const estKey = stableKey([method, methodParams(state, method), self.compareMode ? picks : null,
        self.compareMode ? picks.map(function (m) { return methodParams(state, m); }) : null, s.weights, s.maxRallyPoints]) + '|' + n;
      const dataKey = [state.requests, state.scenario.fleet, state.scenario.zones];
      const dataChanged = !self.estData || dataKey.some(function (v, i) { return v !== self.estData[i]; });
      if (eng && !running && (force || estKey !== self.est.key || dataChanged)) {
        self.est.key = estKey;
        self.estData = dataKey;
        self.scheduleEstimate(state, method, picks, n);
      }
      if (!eng) { r.est.textContent = ''; r.cmpEst.textContent = ''; }
    },

    scheduleEstimate: function (state, method, picks, n) {
      const self = this, k = K(), r = self.sv;
      clearTimeout(self.estTimer);
      const seq = ++self.est.seq;
      if (!n) { r.est.textContent = ''; r.cmpEst.textContent = ''; return; }
      r.est.classList.add('is-busy');
      if (!r.est.textContent) r.est.textContent = 'Estimating run time...';
      self.estTimer = setTimeout(function () {
        const eng = k.engine();
        if (!eng || typeof eng.estimate !== 'function') return;
        const st = self.ctx.getState();
        const one = function (m) {
          let p;
          try { p = eng.estimate(m, methodParams(st, m)); } catch (e) { p = Promise.reject(e); }
          return Promise.resolve(p);
        };
        one(method).then(function (res) {
          if (seq !== self.est.seq) return;
          r.est.classList.remove('is-busy');
          self.paintEstimate(r.est, method, res, st);
        }, function () {
          if (seq !== self.est.seq) return;
          r.est.classList.remove('is-busy');
          r.est.textContent = 'Run-time estimate unavailable right now.';
        });
        if (self.compareMode && picks.length) {
          Promise.all(picks.map(function (m) { return one(m).catch(function () { return null; }); })).then(function (list) {
            if (seq !== self.est.seq) return;
            const ok = list.filter(Boolean);
            if (!ok.length) { r.cmpEst.textContent = ''; return; }
            const tot = ok.reduce(function (a, x) { return a + (x.seconds || 0); }, 0);
            const lo = ok.reduce(function (a, x) { return a + (x.low || x.seconds || 0); }, 0);
            const hi = ok.reduce(function (a, x) { return a + (x.high || x.seconds || 0); }, 0);
            r.cmpEst.textContent = 'All ' + picks.length + ' together: about ' + k.secs(tot) + (hi > lo ? ' (' + k.secs(lo) + ' to ' + k.secs(hi) + ')' : '') + '.';
          });
        }
      }, 350);
    },

    paintEstimate: function (el, method, res, state) {
      const k = K();
      ui.clear(el);
      el.appendChild(ui.icon('clock'));
      if (!res || !k.isNum(res.seconds)) { el.appendChild(h('span', 'Run-time estimate unavailable.')); return; }
      const limit = effectiveLimit(state, method);
      let text;
      if (method === 'mip') {
        text = h('span', h('strong.num', 'Up to ' + k.secs(res.seconds)), ': a quick heuristic start, then the exact solver until its ' + k.secs(limit) +
          ' limit. It reports how close the plan is to the exact model\'s bound (proven gap).');
      } else {
        const range = k.isNum(res.low) && k.isNum(res.high) && res.high > res.low ? ' (' + k.secs(res.low) + ' to ' + k.secs(res.high) + ')' : '';
        text = h('span', 'Estimated run time ', h('strong.num', 'about ' + k.secs(res.seconds)), h('span.num', range),
          res.capped || (k.isNum(res.high) && res.high >= limit) ? h('span', ', stops at the ' + k.secs(limit) + ' limit') : null, '.');
      }
      el.appendChild(text);
      if (res.basis) el.title = String(res.basis);
    },

    comparePicks: function () {
      const self = this, off = unavailableMethods(K().engine());
      return K().METHOD_KEYS.filter(function (m) { return self.compareMethods[m] && !off[m]; });
    },

    isRunning: function () {
      if (this.busy) return true;
      const st = this.status;
      return !!(st && (st.phase === 'preparing' || st.phase === 'running'));
    },

    onStatus: function (st) {
      const self = this;
      self.status = st || {};
      const running = self.isRunning();
      if (running !== self.wasRunning) {
        self.wasRunning = running;
        if (self.ctx) self.syncSolver(self.ctx.getState(), !running);
      } else if (self.ctx && self.sv && stableKey(unavailableMethods(K().engine())) !== self.unavailKey) {
        self.syncSolver(self.ctx.getState(), false);      // the worker reported which methods can run
      }
      if (running) self.paintRun(self.status);
    },

    paintRun: function (st) {
      const k = K(), r = this.sv;
      if (!r) return;
      r.run.hidden = false;
      const methods = st.methods && st.methods.length ? st.methods : (this.busy && this.busy.methods) || null;
      const m = st.method || (this.busy && this.busy.method) || '';
      let title = 'Running ' + k.methodLabel(m);
      if (methods && methods.length > 1) {
        const i = methods.indexOf(m);
        title = 'Comparing: ' + k.methodLabel(m) + (i >= 0 ? ' (' + (i + 1) + ' of ' + methods.length + ')' : '');
      }
      else if (st.kind === 'replan') title = 'Re-planning with ' + k.methodLabel(m);
      if (st.phase === 'preparing') title = 'Preparing the requests and road times';
      r.runTitle.textContent = title;
      const f = k.isNum(st.fraction) ? Math.max(0, Math.min(1, st.fraction)) : null;
      r.progress.classList.toggle('is-indeterminate', f === null || st.phase === 'preparing');
      r.bar.style.width = f === null ? '' : (f * 100).toFixed(1) + '%';
      r.progress.setAttribute('aria-valuenow', f === null ? '' : String(Math.round(f * 100)));
      r.elapsed.textContent = 'Elapsed ' + k.secs(k.isNum(st.elapsedSec) ? st.elapsedSec : 0);
      r.best.textContent = k.isNum(st.bestCost) ? 'Best cost ' + k.num(st.bestCost, 0) : 'Best cost: searching';
      ui.clear(r.spark).appendChild(sparkline(st.history, 160, 34, st.elapsedSec));
      r.msg.textContent = st.message || '';
    },

    planNow: function () {
      const self = this, k = K();
      const eng = k.engine();
      if (!eng || self.isRunning()) return;
      const state = self.ctx.getState();
      const method = state.scenario.settings.method || 'tabu';
      self.busy = { method: method, methods: null };
      self.onStatus({ phase: 'preparing', method: method, fraction: 0, elapsedSec: 0, history: [] });
      let p;
      try { p = Promise.resolve(eng.run({ method: method, params: methodParams(state, method) })); } catch (e) { p = Promise.reject(e); }
      p.then(function (plan) { self.finish(plan, 'run'); }, function (err) { self.failed(err); });
    },

    runCompare: function () {
      const self = this, k = K();
      const eng = k.engine();
      const methods = self.comparePicks();
      if (!eng || self.isRunning() || methods.length < 2) return;
      self.busy = { method: methods[0], methods: methods };
      self.onStatus({ phase: 'preparing', method: methods[0], methods: methods, fraction: 0, elapsedSec: 0, history: [] });
      let p;
      try { p = Promise.resolve(eng.compare(methods)); } catch (e) { p = Promise.reject(e); }
      p.then(function (plans) {
        plans = (plans || []).filter(Boolean);
        self.busy = null;
        self.compareIds = plans.map(function (x) { return x.id; });
        self.keptId = null;
        let best = null;
        plans.forEach(function (x) { if (x.cost && (!best || x.cost.total < best.cost.total)) best = x; });
        self.pulseId = best ? best.id : null;
        // the cheapest plan is shown (and is what Approve acts on), not the last one stored
        if (best) K().showPlan(best.id);
        const st = eng.status ? eng.status() : { phase: 'done' };
        self.onStatus(st);
        self.render(self.ctx.getState(), true);
        const which = best ? ' (' + k.methodLabel(best.method) + (best.cancelled ? ', stopped early' : '') + ')' : '';
        if (!plans.length) ui.toast('Stopped before any method finished a plan.', 'warn');
        else if (st.phase === 'cancelled') ui.toast('Stopped. Kept ' + plans.length + (plans.length === 1 ? ' plan' : ' plans') + ' found so far. Showing the lowest-cost one' + which + '; keep the one you want.', 'warn');
        else ui.toast('Compared ' + plans.length + ' methods. Showing the lowest-cost plan' + which + '; keep the one you want.', 'success');
        self.scrollTo(self.secCompare);
      }, function (err) { self.failed(err); });
    },

    finish: function (plan, kind) {
      const self = this, k = K();
      self.busy = null;
      const eng = k.engine();
      self.onStatus(eng && eng.status ? eng.status() : { phase: 'done' });
      if (plan && plan.id) {
        self.pulseId = plan.id;
        k.showPlan(plan.id);
        const st = plan.stats || {};
        const msg = plan.cancelled ? 'Stopped early. Kept the best plan found so far.'
          : 'Plan ready: ' + (st.requests || 0) + ' requests on ' + (st.trucksUsed || 0) + ' trucks' + (st.delayed ? ', ' + st.delayed + ' delayed.' : '.');
        ui.toast(msg, plan.cancelled || st.delayed ? 'warn' : 'success');
      } else {
        // the engine resolves a cancelled run with null when no plan was found yet
        ui.toast('Stopped before a plan was found.', 'warn');
      }
      self.render(self.ctx.getState(), true);
      if (kind === 'run') self.scrollTo(self.secHead);
    },

    failed: function (err) {
      const self = this, k = K();
      self.busy = null;
      const eng = k.engine();
      const st = eng && eng.status ? eng.status() : null;
      self.onStatus(st || { phase: 'error' });
      const state = self.ctx.getState();
      if (st && st.phase === 'cancelled') {
        const last = state.ui && state.ui.lastPlanId;
        if (last) { self.pulseId = last; k.showPlan(last); }
        ui.toast(last ? 'Stopped. Kept the best plan found so far.' : 'Stopped before a plan was found.', 'warn');
      } else {
        ui.toast('The optimizer stopped: ' + String((err && err.message) || err || 'unknown error'), 'error');
      }
      self.render(state, true);
    },

    cancel: function () {
      const eng = K().engine();
      if (eng && typeof eng.cancel === 'function') { try { eng.cancel(); } catch (e) { ui.toast(String(e.message || e), 'error'); } }
    },

    scrollTo: function (el) {
      if (!el || !el.scrollIntoView || !this.ctx.visible) return;
      try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
    },

    // ==== compare results ============================================================================
    renderCompare: function (state, viewed) {
      const self = this, k = K(), sec = self.secCompare;
      ui.clear(sec);
      const plans = (self.compareIds || []).map(function (id) { return (state.plans || []).find(function (p) { return p.id === id; }); }).filter(Boolean);
      sec.hidden = !plans.length;
      if (!plans.length) return;
      let best = null;
      plans.forEach(function (p) { if (p.cost && (!best || p.cost.total < best.cost.total)) best = p; });
      // the cost parts add up to the total: the route terms, the plan-level penalties, and (only when a
      // plan has them) ETA changes of a re-plan, unused pinned points and the penalty for broken rules
      const n0 = function (v) { return k.num(v, 0); };
      const part = function (key) { return function (p) { return p.cost && k.isNum(p.cost[key]) ? p.cost[key] : 0; }; };
      const PARTS = ['fuel', 'distance', 'risk', 'simplicity', 'platoon', 'lateness', 'deferral', 'stability', 'pinned'];
      const rest = function (p) {
        if (!p.cost || !k.isNum(p.cost.total)) return 0;
        const r = p.cost.total - PARTS.reduce(function (a, key) { return a + part(key)(p); }, 0);
        return r > 0.5 ? r : 0;
      };
      const any = function (get) { return plans.some(function (p) { return get(p) > 0.005; }); };
      const rows = [
        { label: 'Total cost', get: function (p) { return p.cost && p.cost.total; }, fmt: n0, low: true, cls: 'pp-cmp-total' },
        { label: 'Fuel', get: part('fuel'), fmt: n0, low: true, part: true },
        { label: 'Distance', get: part('distance'), fmt: n0, low: true, part: true },
        { label: 'Risk', get: part('risk'), fmt: n0, low: true, part: true },
        { label: 'Simplicity', get: part('simplicity'), fmt: n0, low: true, part: true },
        { label: 'Platoon travel', get: part('platoon'), fmt: n0, low: true, part: true },
        { label: 'Late penalty', get: part('lateness'), fmt: n0, low: true, part: true },
        { label: 'Delay penalty', get: part('deferral'), fmt: n0, low: true, part: true },
        any(part('stability')) || plans.some(function (p) { return p.parentPlanId; }) ? { label: 'ETA changes', get: part('stability'), fmt: n0, low: true, part: true } : null,
        any(part('pinned')) ? { label: 'Unused pinned points', get: part('pinned'), fmt: n0, low: true, part: true } : null,
        any(rest) ? { label: 'Broken rules', get: rest, fmt: n0, low: true, part: true, alert: true } : null,
        { label: 'Late', get: function (p) { return p.stats && p.stats.late; }, fmt: n0, low: true, alert: true, cls: 'pp-cmp-first' },
        { label: 'Delayed', get: function (p) { return p.stats && p.stats.delayed; }, fmt: n0, low: true, alert: true },
        { label: 'Run time', get: function (p) { return p.stats && k.isNum(p.stats.runtimeSec) ? p.stats.runtimeSec : p.runtimeSec; }, fmt: function (v) { return k.secs(v); } },
        { label: 'Gap (MIP)', get: function (p) { return k.isNum(p.mipGap) ? p.mipGap : null; }, fmt: function (v) { return v === null ? '-' : (v * 100).toFixed(1) + '%'; } }
      ].filter(Boolean);
      // each plan's parts rounded so that the shown parts add up to the shown total (largest remainder):
      // rounding every row on its own can leave the sum a point off the total. Only a part with a
      // fraction takes an extra point (a whole number stays as it is), and equal parts (fuel and
      // distance often are) take it together or not at all, so they still read equal.
      const partRows = rows.filter(function (row) { return row.part; });
      const shown = plans.map(function (p) {
        const vals = partRows.map(function (row) { const v = row.get(p); return k.isNum(v) ? Math.max(0, v) : 0; });
        const out = vals.map(Math.floor);
        const target = p.cost && k.isNum(p.cost.total) ? Math.round(p.cost.total) : null;
        if (target === null) return vals.map(Math.round);
        let diff = target - out.reduce(function (a, v) { return a + v; }, 0);
        const frac = function (i) { return vals[i] - out[i]; };
        const byFrac = vals.map(function (v, i) { return i; }).filter(function (i) { return frac(i) > 1e-9; })
          .sort(function (a, b) { return frac(b) - frac(a) || a - b; });
        const given = {};
        const give = function (i) { out[i] += 1; given[i] = true; diff--; };
        byFrac.forEach(function (i) {
          if (diff <= 0 || given[i]) return;
          const same = byFrac.filter(function (j) { return !given[j] && Math.abs(vals[j] - vals[i]) < 1e-9; });
          if (same.length <= diff) same.forEach(give);
        });
        // still short: split a group of equal parts, then (a total with a part not shown) the largest part
        byFrac.forEach(function (i) { if (diff > 0 && !given[i]) give(i); });
        const big = vals.reduce(function (a, v, i) { return v > vals[a] ? i : a; }, 0);
        if (diff > 0) out[big] += diff;
        while (diff < 0 && out[big] > 0) { out[big] -= 1; diff++; }
        return out;
      });
      const head = h('tr', h('th', { scope: 'col' }, h('span.sr-only', 'Measure')), plans.map(function (p) {
        return h('th.num', { scope: 'col', class: { 'is-viewed': p === viewed } }, h('div.pp-cmp-m', k.methodLabel(p.method)),
          p === best ? h('div.pp-cmp-best', 'Lowest cost') : null, p.cancelled ? h('div.faint', 'stopped early') : null);
      }));
      const body = rows.map(function (row) {
        const vals = plans.map(function (p) { const v = row.get(p); return k.isNum(v) ? v : null; });
        const nums = vals.filter(function (v) { return v !== null; });
        const min = row.low && nums.length > 1 ? Math.min.apply(null, nums) : null;
        return h('tr', { class: [row.part ? 'pp-cmp-part' : null, row.cls || null].filter(Boolean).join(' ') || null },
          h('th', { scope: 'row', title: row.part ? 'Part of the total cost' : null }, row.label), vals.map(function (v, i) {
          return h('td.num', {
            class: { 'is-best': min !== null && v === min && nums.some(function (x) { return x !== min; }), 'text-danger': row.alert && v > 0, 'is-viewed': plans[i] === viewed },
            'data-col': plans[i].method, 'data-row': row.label
          }, row.part && v !== null ? n0(shown[i][partRows.indexOf(row)]) : row.fmt(v));
        }));
      });
      const keep = h('tr.pp-cmp-keep', h('th', { scope: 'row' }, h('span.sr-only', 'Keep')), plans.map(function (p) {
        const kept = self.keptId === p.id;
        return h('td', { class: { 'is-viewed': p === viewed } }, h('button.btn.btn-sm', {
          type: 'button', class: kept ? 'btn-primary' : 'btn-secondary', 'data-testid': 'keep-' + p.method, 'aria-pressed': String(kept),
          onClick: function () {
            self.keptId = p.id;
            K().showPlan(p.id);
            self.render(self.ctx.getState(), true);
            ui.toast('Keeping the ' + k.methodLabel(p.method) + ' plan. Review it below, then approve.', 'success');
          }
        }, kept ? ui.icon('check') : null, kept ? 'Kept' : 'Keep'));
      }));
      sec.appendChild(h('div.card.pp-cmp-card',
        h('div.card-header', h('div', h('h2.card-title', 'Method comparison'), h('div.card-sub', 'Same requests, cost points from one scoring rule; the indented rows add up to the total. Lower is better.')),
          h('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Close comparison', onClick: function () { self.compareIds = null; self.render(self.ctx.getState(), true); } }, ui.icon('x'))),
        h('div.table-wrap.pp-cmp-wrap', h('table.table.table-compact.pp-cmp-table', { 'data-testid': 'compare-table' }, h('thead', head), h('tbody', body, keep)))));
    },

    // ==== plan head, summary, actions ================================================================
    renderHead: function (state, plan) {
      const self = this, k = K(), sec = self.secHead;
      ui.clear(sec);
      if (!plan) {
        sec.appendChild(h('div.empty.pp-empty', { 'data-testid': 'plan-empty' },
          h('div.empty-icon', ui.icon('route')),
          h('p.empty-title', 'No plan yet'),
          h('p.empty-text', openCount(state) ? 'Pick a method above and press Plan now. The plan appears here for review before you approve it.'
            : 'Load or submit requests first (Queue), then press Plan now.')));
        return;
      }
      const stt = statusOf(plan);
      const win = k.planWindow(plan);
      const title = h('div.pp-title-row',
        h('h2.h2.pp-name', { title: plan.name, 'data-testid': 'plan-name' }, plan.name || plan.id),
        h('button.btn.btn-ghost.btn-sm.pp-rename', { type: 'button', 'aria-label': 'Rename plan', title: 'Rename plan', onClick: function () { self.rename(plan); } }, ui.icon('edit'), h('span.pp-rename-l', 'Rename')));
      const meta = h('div.pp-meta.small.muted',
        h('span.badge.pp-status.is-' + stt.key, { 'data-testid': 'plan-status' }, stt.key === 'approved' ? ui.icon('check') : null, stt.label),
        h('span', k.methodLabel(plan.method)),
        win ? h('span.num', 'Window ' + k.windowLabel(win)) : null,
        k.isNum(plan.createdAt) ? h('span.num', 'Made ' + k.dtg(plan.createdAt)) : null,
        // id and total cost: tell apart two plans with the same name (the picker, closed, may cut its label)
        h('span.num', { 'data-testid': 'plan-id' }, plan.id),
        plan.cost && k.isNum(plan.cost.total) ? h('span.num', { 'data-testid': 'plan-cost' }, 'Cost ' + k.num(plan.cost.total, 0) + ' pts') : null);
      sec.appendChild(title);
      sec.appendChild(meta);
      const mn = mipNotice(plan);
      if (mn) sec.appendChild(mn);
      if (plan.cancelled) sec.appendChild(h('div.notice.notice-warn', ui.icon('alert'), h('div', 'Stopped early with Cancel: this is the best plan found before stopping.')));
      // planning rules the plan breaks (plan.violations): seen before Approve, not only in its dialog
      const viol = Array.isArray(plan.violations) ? plan.violations : [];
      if (viol.length) {
        sec.appendChild(h('div.notice.notice-error.pp-viol', { 'data-testid': 'plan-violations' }, ui.icon('alert'),
          h('div', h('strong', 'This plan breaks ' + (viol.length === 1 ? 'a planning rule' : viol.length + ' planning rules') + ':'),
            h('ul', viol.map(function (v) { return h('li', v.detail || v.code); })),
            plan.approved || plan.superseded ? null
              : h('div.small', 'Approve plan refuses it while another plan for this window meets every rule. Re-plan, or change the settings (Scenario), to fix it.'))));
      }
      if (plan.superseded) {
        const by = (state.plans || []).find(function (p) { return p.id === plan.supersededBy; });
        sec.appendChild(h('div.notice.notice-info', ui.icon('info'), h('div', 'Replaced by ' + (by ? by.name : 'a newer approved plan') + '.')));
      }
      if (plan.parentPlanId) {
        const par = (state.plans || []).find(function (p) { return p.id === plan.parentPlanId; });
        sec.appendChild(h('div.notice.notice-warn.pp-replan-note', ui.icon('refresh'), h('div', 'Re-plan of ' + (par ? par.name : plan.parentPlanId) + ' after a contingency. Changes are listed below.')));
      }
      // what the engine had to adjust (a lock it could not keep, a truck cut off, a pickup point out of
      // reach): the planner needs to see these before approving
      // Notes about a truck on the road (turned back from a closed road, cut off, a load it could not
      // place) and a re-plan that kept the current plan change what happens next: they stay open.
      const warns = (plan.warnings || []).filter(function (w, i, a) { return typeof w === 'string' && w && a.indexOf(w) === i; });
      const KEY_NOTE = /^Truck |turns back|cut off|keeps it\.|stays on the truck|rally points? (?:pinned|is out of reach)|out of reach of every platoon|used \d+ rally points?|already on the road carry/;
      const key = warns.filter(function (w) { return KEY_NOTE.test(w); });
      const other = warns.filter(function (w) { return key.indexOf(w) < 0; });
      if (key.length) {
        sec.appendChild(h('div.notice.notice-warn.pp-key-notes', { 'data-testid': 'plan-key-notes' }, ui.icon('alert'),
          key.length === 1 ? h('div', key[0]) : h('ul.pp-key-list', key.map(function (w) { return h('li', w); }))));
      }
      if (other.length) {
        sec.appendChild(h('details.notice.notice-info.pp-warnings', { 'data-testid': 'plan-warnings' },
          h('summary', ui.icon('info'), h('span', (other.length === 1 ? '1 note' : other.length + ' notes') + ' from the optimizer' + (key.length ? ' (more)' : ''))),
          h('ul', other.map(function (w) { return h('li', w); }))));
      }
      // plan picker
      const list = k.plansForPicker(state, plan);
      if (list.length > 1) {
        const sel = h('select.select.pp-picker#pp-picker', {
          'data-testid': 'plan-picker',
          onChange: function (e) { K().showPlan(e.target.value); }
        }, list.map(function (p) {
          // name (it names the method already), total cost and status; the plan id too when two plans
          // share a name (the same method run twice in a window)
          const twin = list.some(function (q) { return q !== p && q.name === p.name; });
          return h('option', { value: p.id, selected: p === plan }, pickerLabel(p, twin));
        }));
        sel.value = plan.id;
        sec.appendChild(h('div.pp-picker-row', h('label.field-label', { for: 'pp-picker' }, 'Show plan'), sel));
      }
    },

    renderSummary: function (state, plan) {
      const self = this, k = K(), sec = self.secSummary;
      ui.clear(sec);
      if (!plan) return;
      const s = plan.stats || {};
      const rt = k.isNum(s.runtimeSec) ? s.runtimeSec : plan.runtimeSec;
      const stat = function (key, label, value, display, unit, extra) {
        return h((extra && extra.onClick ? 'button' : 'div') + '.stat', Object.assign({ 'data-stat': key, 'data-value': k.isNum(value) ? String(value) : '' }, extra || {}),
          h('span.stat-label', label),
          h('span.stat-value', display, unit ? h('span.stat-unit', unit) : null));
      };
      const delayed = s.delayed || 0;
      const strip = h('div.summary.pp-summary', { role: 'group', 'aria-label': 'Plan summary', 'data-testid': 'summary' },
        stat('requests', 'Requests', s.requests, k.num(s.requests, 0)),
        stat('stops', 'Stops', s.stops, k.num(s.stops, 0)),
        stat('trucks', 'Trucks used', s.trucksUsed, k.num(s.trucksUsed, 0)),
        stat('miles', 'Miles', s.miles, k.num(s.miles, 0), 'mi'),
        stat('gallons', 'Gallons', s.gallons, k.num(s.gallons, 0), 'gal'),
        stat('risk', 'Risk', s.riskUnits, k.num(s.riskUnits, 1)),
        stat('delayed', 'Delayed', delayed, k.num(delayed, 0), null, {
          class: delayed > 0 ? 'is-alert' : null, type: 'button',
          'aria-label': delayed + ' delayed requests. Show why',
          title: delayed > 0 ? 'Show the delayed requests and what blocked each' : 'Nothing delayed',
          onClick: function () { self.showDelayed(plan); }
        }),
        stat('runtime', 'Run time', rt, k.secs(rt)));
      if (self.pulseId === plan.id) {
        self.pulseId = null;
        strip.classList.add('is-pulse');
      }
      // a re-plan: the strip above counts what is planned from now on; plan.windowStats adds the stops
      // already made, for the whole window
      const ws = plan.parentPlanId && plan.windowStats ? plan.windowStats : null;
      if (ws) sec.appendChild(h('div.caps.pp-summary-cap', 'From now'));
      sec.appendChild(strip);
      if (ws) {
        // note: a small line under the value ('3 made'), not a unit run on to it ('153 made')
        const wstat = function (key, label, value, display, unit, note) {
          return h('div.stat', { 'data-wstat': key, 'data-value': k.isNum(value) ? String(value) : '' },
            h('span.stat-label', label), h('span.stat-value', display, unit ? h('span.stat-unit', unit) : null),
            note ? h('span.pp-stat-note', note) : null);
        };
        sec.appendChild(h('div.caps.pp-summary-cap', 'This window (stops made + planned)'));
        sec.appendChild(h('div.summary.pp-summary.pp-summary-window', { role: 'group', 'aria-label': 'Whole window', 'data-testid': 'summary-window' },
          wstat('requests', 'Requests', ws.requests, k.num(ws.requests, 0)),
          wstat('stops', 'Stops', ws.stops, k.num(ws.stops, 0), null, k.isNum(ws.stopsDone) && ws.stopsDone ? ws.stopsDone + ' made' : null),
          wstat('trucks', 'Trucks used', ws.trucksUsed, k.num(ws.trucksUsed, 0)),
          wstat('miles', 'Miles', ws.miles, k.num(ws.miles, 0), 'mi'),
          wstat('gallons', 'Gallons', ws.gallons, k.num(ws.gallons, 0), 'gal'),
          wstat('risk', 'Risk', ws.riskUnits, k.num(ws.riskUnits, 1)),
          wstat('delayed', 'Delayed', ws.delayed, k.num(ws.delayed, 0)),
          wstat('rally', 'Rally points', ws.rallyPoints, k.num(ws.rallyPoints, 0), k.isNum(state.scenario.settings.maxRallyPoints) ? 'of ' + state.scenario.settings.maxRallyPoints : null)));
      }
      if (plan.parentPlanId) {
        sec.appendChild(h('div.small.faint.pp-summary-note', { 'data-testid': 'summary-note' },
          ws ? 'From now counts what is planned from now on: for a truck already on the road, from its next stop. This window adds the stops already made. The truck cards show whole trips.'
            : 'Re-plan totals count what is planned from now on: for a truck already on the road, from its next stop. The truck cards show whole trips.'));
      }
      if (delayed > 0 && !plan.approved && !plan.superseded) {
        const win = k.planWindow(plan);
        sec.appendChild(h('button.notice.notice-error.pp-delayed-note', { type: 'button', onClick: function () { self.showDelayed(plan); } }, ui.icon('alert'),
          h('div', h('strong', delayed + (delayed === 1 ? ' request does' : ' requests do') + ' not fully fit in this window. '),
            h('span', 'The rest carries to the next window' + (win ? ' (next plan ' + k.dtg(win.end) + ')' : '') + '. '), h('span.pp-link', 'See why'))));
      }
    },

    renderActions: function (state, plan) {
      const self = this, k = K(), sec = self.secActions;
      ui.clear(sec);
      if (!plan) return;
      const prev = k.previousPlan(state, plan);
      const approve = h('button.btn.btn-primary.pp-approve', {
        type: 'button', 'data-testid': 'approve', disabled: !!(plan.approved || plan.superseded),
        onClick: function () { self.approve(plan); }
      }, ui.icon('check'), plan.approved ? 'Approved' : plan.superseded ? 'Replaced' : 'Approve plan');
      const snap = h('button.btn.btn-secondary', { type: 'button', 'data-testid': 'snapshot', onClick: function () { self.snapshot(plan); } }, ui.icon('download'), 'Save snapshot');
      // a re-plan always shows its before / after list, so there is nothing to toggle
      const cmp = prev && !plan.parentPlanId ? h('button.btn.btn-secondary', {
        type: 'button', 'aria-pressed': String(self.showDiff), 'data-testid': 'compare-previous',
        onClick: function () { self.showDiff = !self.showDiff; self.render(self.ctx.getState(), false); }
      }, ui.icon('layers'), self.showDiff ? 'Hide comparison' : 'Compare to previous plan') : null;
      sec.appendChild(h('div.pp-actions-row', approve, snap, cmp));
      const snaps = (state.snapshots || []).filter(function (x) { return x.planId === plan.id; });
      if (snaps.length) sec.appendChild(h('div.small.faint', 'Snapshots: ' + snaps.map(function (x) { return x.name; }).join(', ')));
      if (plan.approved) sec.appendChild(h('div.small.muted', 'Approved ' + (k.isNum(plan.approvedAt) ? k.dtg(plan.approvedAt) : '') + '. Platoon sergeants see their pickup point and ETA.'));
    },

    // ==== delayed list ===============================================================================
    showDelayed: function (plan) {
      const self = this, k = K();
      const state = self.ctx.getState();
      const list = k.delayedRequests(plan);
      ui.modal.open({
        title: list.length ? 'Delayed requests (' + list.length + ')' : 'Delayed requests',
        size: 'md',
        body: function (el, handle) {
          if (!list.length) { el.appendChild(h('p.modal-text', 'Everything in this plan fits in the window.')); return; }
          const win = k.planWindow(plan);
          el.appendChild(h('p.modal-text', 'These do not fully fit in this window. What does not fit is carried to the next window' + (win ? ' (next plan ' + k.dtg(win.end) + ')' : '') + '.'));
          const ul = h('div.list.pp-delayed-list', { 'data-testid': 'delayed-list' });
          list.forEach(function (x) {
            const r = k.request(state, x.requestId) || { id: x.requestId, lines: [] };
            const urg = r.urgency || 'Routine';
            const part = (k.planIndex(plan).byRequest[x.requestId] || { stops: [] }).stops.length > 0;
            const reasons = {};
            x.items.forEach(function (d) { reasons[(d.reason || 'other') + '|' + (d.detail || '') + '|' + k.reasonText(d)] = d; });
            ul.appendChild(h('div.list-row.pp-delayed-row', { 'data-request': x.requestId },
              h('div.list-row-main',
                h('div.hstack.wrap', h('span.badge.badge-urgency.' + k.urgClass(urg), urg), h('span.list-row-title', r.unitName || r.id)),
                h('div.list-row-sub', x.items.map(function (d) {
                  const line = r.lines && r.lines[d.lineIdx];
                  return h('div.num', (part ? 'Remainder: ' : '') + (line ? k.classLabel(line.classId) + ', ' + k.lineText(line, d.qty) : k.qty(d.qty, d.unit)));
                })),
                Object.keys(reasons).map(function (key) {
                  const d = reasons[key];
                  return h('div.pp-reason', h('span.badge.badge-danger', k.reasonLabel(d)), h('span', ' ' + k.reasonText(d)));
                })),
              h('button.btn.btn-sm.btn-ghost.list-row-action', {
                type: 'button', onClick: function () { handle.close(); K().focusRequest(x.requestId, 'plan'); self.ctx.show('queue'); }
              }, 'Show in queue')));
          });
          el.appendChild(ul);
        },
        actions: [{ label: 'Close', kind: 'secondary' }]
      });
    },

    // ==== approve / rename / snapshot ================================================================
    approve: function (plan) {
      const self = this, k = K();
      const now = self.ctx.getState().clock.simMin;
      const routes = k.activeRoutes(plan);
      // Only a re-plan has trucks already on the road: those that left before it was made carry on
      // with it. Any other departure time already past (a plan approved after its trucks were due to
      // leave) is a late start, never a truck on the road.
      const made = plan.parentPlanId ? (k.isNum(plan.createdAt) ? Math.min(plan.createdAt, now) : now) : null;
      const left = function (r) { return made !== null && k.isNum(r.depart) && r.depart <= made; };
      const due = function (r) { return k.isNum(r.depart) && r.depart <= now; };
      const onRoad = routes.filter(function (r) { return left(r) && !(k.isNum(r.returnAt) && r.returnAt <= now); });
      const late = routes.filter(function (r) { return !left(r) && due(r); });
      const leave = routes.filter(function (r) { return !left(r) && !due(r); });
      const firstOf = function (list) { return list.reduce(function (a, r) { return k.isNum(r.depart) && (a === null || r.depart < a) ? r.depart : a; }, null); };
      const first = firstOf(leave), firstLate = firstOf(late);
      const win = k.planWindow(plan);
      const delayed = (plan.stats && plan.stats.delayed) || 0;
      const viol = Array.isArray(plan.violations) ? plan.violations : [];
      const ids = function (list) { return list.map(function (r) { return r.truckId; }).join(', '); };
      const body = h('div.vstack-sm',
        h('p.modal-text', 'This plan becomes the movement schedule' + (win ? ' for ' + k.windowLabel(win) : '') + '.'),
        viol.length ? h('div.notice.notice-error.pp-confirm-viol', { 'data-testid': 'approve-violations' }, ui.icon('alert'),
          h('div', h('strong', 'This plan breaks ' + (viol.length === 1 ? 'a planning rule' : viol.length + ' planning rules') + ':'),
            h('ul', viol.map(function (v) { return h('li', v.detail || v.code); })))) : null,
        late.length ? h('div.notice.notice-warn.pp-confirm-late', { 'data-testid': 'approve-late' }, ui.icon('clock'),
          h('div', h('strong', 'Departure ' + (late.length === 1 ? 'time' : 'times') + ' already past. '),
            h('span', (late.length === 1 ? late[0].truckId + ' was due to leave at ' : late.length + ' trucks (' + ids(late) + ') were due to leave from ') + k.dtg(firstLate) +
              '; it is now ' + k.dtg(now) + '. Approved as it is, ' + (late.length === 1 ? 'it starts' : 'they start') +
              ' behind this schedule. For times that start now, press Plan now again and approve the new plan.'))) : null,
        h('ul.pp-confirm-list',
          onRoad.length ? h('li', onRoad.length + (onRoad.length === 1 ? ' truck already on the road carries' : ' trucks already on the road carry') + ' on with the new plan: ' + ids(onRoad) + '.') : null,
          leave.length ? h('li', leave.length + (leave.length === 1 ? ' truck leaves' : ' trucks leave') + ' at the planned times' + (first !== null ? ' (first at ' + k.dtg(first) + ')' : '') + ': ' + ids(leave) + '.')
            : !onRoad.length && !late.length ? h('li', 'No truck drives in this plan.') : null,
          h('li', 'Platoon sergeants see their pickup point and ETA, and the truck callsign and frequency.'),
          delayed ? h('li', delayed === 1 ? 'The platoon sergeant of the 1 delayed request is told it is not in this window' : 'The platoon sergeants of the ' + delayed + ' delayed requests are told they are not in this window',
            (win ? '; the next plan starts at ' + k.dtg(win.end) : ''), '.') : null,
          plan.parentPlanId ? h('li', 'It replaces the plan it re-planned; platoons whose ETA or pickup changed see it marked "updated".') : null));
      ui.modal.open({
        title: 'Approve ' + (plan.name || 'plan') + '?',
        size: 'sm',
        body: body,
        actions: [
          { label: 'Cancel', kind: 'secondary' },
          { label: 'Approve plan', kind: 'primary', id: 'approve', onClick: function () {
            const res = self.ctx.dispatch({ type: 'plan/approve', planId: plan.id, now: Math.floor(self.ctx.getState().clock.simMin) });
            if (res && !res.ok && res.code === 'infeasible-plan') { self.refused(plan, res); return true; }
            if (!res || !res.ok) { ui.toast((res && res.error) || 'Could not approve the plan.', 'error'); return false; }
            K().showPlan(plan.id);
            // approved although it breaks a rule (no other plan of the window meets them all)
            if (res.warning) ui.toast(res.warning, 'warn', { timeout: 12000 });
            else ui.toast('Plan approved. Platoon sergeants now see their pickup point and ETA.', 'success');
            return true;
          } }
        ]
      });
    },

    // plan/approve refused a plan that breaks a planning rule while other drafts of the window meet
    // them all: say why and offer those plans (the planner reviews one, then approves it).
    refused: function (plan, res) {
      const self = this, k = K();
      const plans = self.ctx.getState().plans || [];
      const alts = (res.alternativeIds || []).map(function (id) { return plans.find(function (p) { return p.id === id; }); }).filter(Boolean)
        .sort(function (a, b) { return ((a.cost && a.cost.total) || 0) - ((b.cost && b.cost.total) || 0); });
      ui.modal.open({
        title: 'Not approved',
        size: 'sm',
        body: function (el, handle) {
          el.appendChild(h('div.notice.notice-error', { 'data-testid': 'approve-refused' }, ui.icon('alert'), h('div', res.error || 'This plan breaks a planning rule.')));
          if (alts.length) {
            el.appendChild(h('p.modal-text', alts.length === 1 ? 'This plan for the same window meets every rule:' : 'These plans for the same window meet every rule:'));
            el.appendChild(h('div.list.list-dense.pp-alt-list', alts.map(function (p) {
              return h('div.list-row', { 'data-plan': p.id },
                h('div.list-row-main', h('div.list-row-title', p.name || p.id),
                  h('div.list-row-sub.num', p.id + ' · ' + k.methodLabel(p.method) + ' · ' + (p.cost ? k.num(p.cost.total, 0) + ' pts' : '') + ' · ' + ((p.stats && p.stats.delayed) || 0) + ' delayed')),
                h('button.btn.btn-sm.btn-secondary.list-row-action', { type: 'button', 'data-testid': 'show-alt-' + p.id,
                  onClick: function () {
                    handle.close();
                    K().showPlan(p.id);
                    self.render(self.ctx.getState(), true);
                    self.scrollTo(self.secHead);
                    ui.toast('Showing ' + (p.name || p.id) + '. Review it, then approve.', 'info');
                  } }, 'Show plan'));
            })));
          } else el.appendChild(h('p.modal-text', 'Re-plan, or change the settings, then try again.'));
        },
        actions: [{ label: 'Close', kind: 'secondary' }]
      });
    },

    askName: function (opts) {
      return ui.modal.open({
        title: opts.title,
        size: 'sm',
        body: function (el, handle) {
          const input = h('input.input#pp-name-input', { type: 'text', value: opts.value || '', maxlength: 80, autocomplete: 'off',
            onKeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); const b = handle.actions && handle.actions.querySelector('.btn-primary'); if (b) b.click(); } } });
          handle.input = input;
          el.appendChild(h('div.field', h('label.field-label', { for: 'pp-name-input' }, opts.label), input, opts.help ? h('div.field-help', opts.help) : null));
        },
        initialFocus: '#pp-name-input',
        actions: [
          { label: 'Cancel', kind: 'secondary' },
          { label: opts.ok, kind: 'primary', onClick: function (handle) {
            const v = handle.input.value.trim();
            if (!v) { ui.toast('Enter a name.', 'warn'); return false; }
            return opts.onOk(v);
          } }
        ]
      });
    },

    rename: function (plan) {
      const self = this;
      self.askName({ title: 'Rename plan', label: 'Plan name', value: plan.name, ok: 'Rename', onOk: function (v) {
        const res = self.ctx.dispatch({ type: 'plan/rename', planId: plan.id, name: v });
        if (!res || !res.ok) { ui.toast((res && res.error) || 'Could not rename the plan.', 'error'); return false; }
        return true;
      } });
    },

    snapshot: function (plan) {
      const self = this, k = K();
      const win = k.planWindow(plan);
      self.askName({
        title: 'Save snapshot', label: 'Snapshot name', ok: 'Save snapshot',
        value: plan.name + (win ? ' (' + k.windowLabel(win) + ')' : ''),
        help: 'Saved in this browser with the settings that produced it. Outputs lists snapshots and exports them.',
        onOk: function (v) {
          const res = self.ctx.dispatch({ type: 'snapshot/save', planId: plan.id, name: v });
          if (!res || !res.ok) { ui.toast((res && res.error) || 'Could not save the snapshot.', 'error'); return false; }
          ui.toast('Snapshot "' + v + '" saved.', 'success');
          return true;
        }
      });
    },

    // ==== compare with previous / before-after =======================================================
    renderDiff: function (state, plan, prev) {
      const self = this, k = K(), sec = self.secDiff;
      ui.clear(sec);
      const show = plan && prev && (self.showDiff || plan.parentPlanId);
      sec.hidden = !show;
      if (!show) return;
      const diff = k.diffPlans(prev, plan);
      const KIND = {
        moved: ['Moved', 'badge-warn'], retimed: ['New time', 'badge-info'], delayed: ['Now delayed', 'badge-danger'],
        added: ['Now delivered', 'badge-ok'], less: ['Less now', 'badge-warn'], more: ['More now', 'badge-ok'], removed: ['Not in plan', 'badge-info']
      };
      // every stop of the request (a split request has several), and what waits for the next window
      const place = function (x) {
        if (!x) return h('span.faint', 'not in plan');
        if (!x.delivered) return h('span.text-danger', 'next window');
        const list = x.list && x.list.length ? x.list : [{ truckId: x.truckId, color: x.color, seq: x.seq, label: x.label, eta: x.eta }];
        return h('span.pp-place-list', list.map(function (y) {
          return h('span.pp-place', y.truckId ? h('span.truck-chip', { style: { '--truck': y.color || k.truckColor(state, y.truckId) } }, y.truckId) : null,
            h('span', ' stop ' + y.seq + ', ' + (y.label || '') + ', '), h('span.num', k.dtg(y.eta)));
        }), x.deferredQty > 0 ? h('span.text-danger.small', 'rest next window') : null);
      };
      const moved = diff.filter(function (d) { return d.kind === 'moved'; }).length;
      const title = plan.parentPlanId ? 'Before and after the re-plan' : 'Compared to ' + (prev.name || prev.id);
      const card = h('div.card.pp-diff', { 'data-testid': 'diff' },
        h('div.card-header', h('div', h('h2.card-title', title),
          h('div.card-sub.num', diff.length ? moved + ' moved, ' + (diff.length - moved) + ' other changes. Before: ' + (prev.name || prev.id) + (prev.approved ? ' (approved)' : '') + '.' : 'No request changed truck, stop or time.'))));
      if (diff.length) {
        const list = h('div.list.list-dense.pp-diff-list');
        diff.forEach(function (d) {
          const r = k.request(state, d.requestId) || { id: d.requestId };
          const kk = KIND[d.kind];
          list.appendChild(h('div.list-row.pp-diff-row', { 'data-kind': d.kind, 'data-request': d.requestId },
            h('div.list-row-main',
              h('div.hstack.wrap', h('span.badge.' + kk[1], kk[0]), h('span.list-row-title', r.unitName || r.id)),
              h('div.list-row-sub.pp-diff-move', h('span.pp-diff-lbl', 'Before'), place(d.before)),
              h('div.list-row-sub.pp-diff-move', h('span.pp-diff-lbl', 'After'), place(d.after)))));
        });
        card.appendChild(list);
      }
      sec.appendChild(card);
    },

    // ==== per-truck route cards ======================================================================
    renderTrucks: function (state, plan) {
      const self = this, k = K(), sec = self.secTrucks;
      ui.clear(sec);
      if (!plan) return;
      const routes = k.usedRoutes(plan);
      const fleet = state.scenario.fleet || [];
      const nActive = routes.filter(function (r) { return !k.isStoppedRoute(r); }).length;
      sec.appendChild(h('div.section-head', h('span.caps', 'Trucks'), h('span.small.muted.num', { 'data-testid': 'trucks-used' }, nActive + ' of ' + fleet.length + ' used')));
      if (!routes.length) {
        sec.appendChild(h('p.small.muted', 'No truck has a stop in this plan.'));
      }
      const grid = h('div.pp-trucks');
      routes.forEach(function (rt) {
        const t = k.truck(state, rt.truckId) || {};
        const type = rt.type || t.type;
        const load = k.routeLoad(rt, state);
        const color = k.truckColor(state, rt.truckId, rt);
        const stopped = k.isStoppedRoute(rt);
        const nDone = k.doneStops(rt);
        grid.appendChild(h('button.card.card-truck.pp-truck', {
          type: 'button', style: { '--truck': color }, 'data-truck': rt.truckId, 'aria-label': 'Route detail for ' + rt.truckId,
          class: stopped ? 'is-stopped' : null,
          onClick: function () { K().select({ truckId: rt.truckId }); self.ctx.show('route'); }
        },
        h('div.pp-truck-top', h('span.truck-chip', { style: { '--truck': color } }, rt.truckId), h('span.pp-truck-type', k.truckTypeLabel(type)),
          stopped ? h('span.badge.badge-danger', rt.out ? 'Out of service' : 'Cut off') : null,
          h('span.pp-truck-go', ui.icon('chevron'))),
        h('div.pp-truck-stops', { 'data-testid': 'truck-stops', title: stopsLine(state, rt) }, stopsLine(state, rt)),
        h('div.pp-truck-grid',
          h('div', h('span.pp-k', 'Depart'), h('span.num', k.dtg(rt.depart))),
          stopped ? h('div', h('span.pp-k', 'Stopped'), h('span', 'after stop ' + nDone))
            : h('div', h('span.pp-k', 'Return'), h('span.num', k.dtg(rt.returnAt))),
          h('div', h('span.pp-k', 'Stops'), h('span.num', String((rt.stops || []).length) + (nDone ? ' (' + nDone + ' done)' : ''))),
          h('div', h('span.pp-k', 'Miles'), h('span.num', k.miles(k.routeTrip(rt, state).miles))),
          h('div.pp-truck-load', h('span.pp-k', 'Load'), h('span.num', load.pct + '%'),
            h('span.pp-loadbar', { title: k.num(load.used, load.unit === 'gal' ? 0 : 1) + ' of ' + k.num(load.capacity, 0) + ' ' + load.unit },
              h('span', { style: { width: Math.min(100, Math.max(0, load.pct)) + '%' } }))))));
      });
      sec.appendChild(grid);
      const used = {};
      routes.forEach(function (r) { if (!k.isStoppedRoute(r)) used[r.truckId] = true; });
      const idle = fleet.filter(function (t) { return !used[t.id] && t.status !== 'out' && !routes.some(function (r) { return r.truckId === t.id; }); }).map(function (t) { return t.id; });
      const out = fleet.filter(function (t) { return t.status === 'out'; }).map(function (t) { return t.id; });
      if (idle.length || out.length) {
        sec.appendChild(h('p.small.faint.pp-idle', (idle.length ? 'Not used: ' + idle.join(', ') + '. ' : '') + (out.length ? 'Out of service: ' + out.join(', ') + '.' : '')));
      }
    },

    // ==== timeline ===================================================================================
    renderTimeline: function (state, plan) {
      const self = this, k = K(), sec = self.secTimeline;
      ui.clear(sec);
      const routes = k.usedRoutes(plan);
      if (!plan || !routes.length) return;
      let t0 = Infinity, t1 = -Infinity;
      routes.forEach(function (r) {
        const s = k.isNum(r.loadStart) ? r.loadStart : r.depart;
        if (k.isNum(s)) t0 = Math.min(t0, s);
        if (k.isNum(r.returnAt)) t1 = Math.max(t1, r.returnAt);
        (r.stops || []).forEach(function (st) { if (k.isNum(st.depart)) t1 = Math.max(t1, st.depart); });
      });
      if (!isFinite(t0) || !isFinite(t1)) return;
      t0 = Math.floor(t0 / 60) * 60;
      t1 = Math.max(t0 + 120, Math.ceil(t1 / 60) * 60);
      const span = t1 - t0;
      const pct = function (m) { return ((m - t0) / span * 100); };
      const C = SRO.core.clock;
      const bands = C.expandPeriods(state.scenario.settings.periods, t0, span / 60);
      const stops = [];
      bands.forEach(function (b) {
        const c = 'var(--period-' + (PERIOD_KEYS[b.name] || 'other') + ')';
        stops.push(c + ' ' + pct(b.startMin).toFixed(2) + '%', c + ' ' + pct(b.endMin).toFixed(2) + '%');
      });
      const grad = stops.length ? 'linear-gradient(to right, ' + stops.join(', ') + ')' : 'none';
      // hour ticks, every 1, 2, 3 or 6 h so labels do not crowd
      const hours = span / 60;
      const every = hours <= 6 ? 1 : hours <= 12 ? 2 : hours <= 24 ? 3 : 6;
      const axis = h('div.pp-tl-axis', { 'aria-hidden': 'true' });
      for (let m = t0; m <= t1; m += every * 60) {
        axis.appendChild(h('span.pp-tl-tick.num', { style: { left: pct(m).toFixed(2) + '%' } }, k.time(m)));
      }
      const body = h('div.pp-tl-rows');
      routes.forEach(function (rt) {
        const color = k.truckColor(state, rt.truckId, rt);
        const stopped = k.isStoppedRoute(rt);
        // a truck that stopped (out of service, cut off) ends at its last stop, not at a return time
        const lastStop = (rt.stops || []).reduce(function (a, st) { return Math.max(a, k.isNum(st.depart) ? st.depart : -Infinity); }, -Infinity);
        const start = k.isNum(rt.depart) ? rt.depart : t0;
        const end = stopped ? (isFinite(lastStop) ? lastStop : start) : k.isNum(rt.returnAt) ? rt.returnAt : t1;
        const track = h('div.pp-tl-track', { style: { background: grad } },
          h('span.pp-tl-span', { class: stopped ? 'is-stopped' : null, style: { left: pct(start).toFixed(2) + '%', width: Math.max(0.5, pct(end) - pct(start)).toFixed(2) + '%', '--truck': color },
            title: rt.truckId + (stopped ? ' out ' + k.dtg(start) + ', stopped after its last stop (' + (rt.out ? 'out of service' : 'cut off') + ')' : ' out ' + k.dtg(start) + ' to ' + k.dtg(end)) }));
        (rt.stops || []).forEach(function (st, i) {
          const per = k.periodName(st.period, st.arrive, state.scenario.settings);
          track.appendChild(h('span.pp-tl-stop.num', {
            style: { left: pct(st.arrive).toFixed(2) + '%', '--truck': color },
            title: 'Stop ' + (st.seq !== undefined ? st.seq : i + 1) + ': ' + (st.label || '') + ', arrive ' + k.dtg(st.arrive) + (per ? ' (' + per + ')' : '')
          }, String(st.seq !== undefined ? st.seq : i + 1)));
        });
        body.appendChild(h('button.pp-tl-row', {
          type: 'button', 'data-truck': rt.truckId, 'aria-label': rt.truckId + ' timeline, open route detail',
          onClick: function () { K().select({ truckId: rt.truckId }); self.ctx.show('route'); }
        }, h('span.pp-tl-label', h('span.truck-swatch', { style: { '--truck': color } }), h('span.num', rt.truckId), stopped ? h('span.pp-tl-out', 'out') : null), track));
      });
      const legend = h('div.pp-tl-legend', ['Day', 'Dusk', 'Night', 'Dawn'].map(function (n) {
        return h('span', h('span.pp-tl-sw', { style: { background: 'var(--period-' + PERIOD_KEYS[n] + ')' } }), n);
      }));
      sec.appendChild(h('div.section-head', h('span.caps', 'Timeline'), h('span.small.muted.num', k.dtg(t0) + ' to ' + k.dtg(t1))));
      sec.appendChild(h('div.card.pp-tl', { 'data-testid': 'timeline' },
        h('div.pp-tl-grid', { class: routes.some(function (r) { return k.isStoppedRoute(r); }) ? 'has-out' : null }, h('span.pp-tl-corner'), axis), body, legend));
    }
  };

  if (ui.registerView) ui.registerView('planner/plan', PlanView);
})(typeof self !== 'undefined' ? self : globalThis);
