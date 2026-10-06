// Platoon sergeant: one-time unit profile (spec-answers.md Section 2 "Unit + location", "Mobility";
// DESIGN.md sections 3 and 8) and the small helpers the other platoon sergeant views share.
//
// VIEW 'psg/profile' (tab "Unit")
//   No profile yet: the setup form. Otherwise a summary card (unit, designator, 2525 symbol, location
//   as MGRS + nearest town, mobility) with "Update my location", a quick mobility switch and "Edit unit".
//   The Request view shows the same setup form on first open (profile null), so the first thing a new
//   platoon sergeant sees is "Set up your unit".
//
// SHARED HELPERS  SRO.ui.psg (loaded before request.js and myrequests.js; manifest order)
//   psg.profileForm(host, ctx, { mode: 'setup' | 'edit', onSaved(profile), onCancel })
//       unit name builder (platoon / company / battalion / branch -> '1st PLT, B CO, 4-93 IN', designator
//       from SRO.data.scenario.designatorFor), location picker, mobility; saves with profile/save.
//   psg.locationPicker(host, { lat, lon, getUnit(), onChange(loc), mapClass }) -> { get(), set(lat, lon),
//       destroy(), map }   compact map (tap to set), "Use my location" (navigator.geolocation, graceful
//       failure), "Type a grid" (MGRS); rejects points outside Taiwan (SRO.data.scenario.insideTaiwan).
//   psg.openLocationSheet(ctx)   "Update my location" bottom sheet (saves with profile/save).
//   psg.choiceGroup / psg.seg / psg.stepper   radio cards, segmented buttons, number stepper.
//   psg.mgrs, psg.place, psg.placeName, psg.mobilityModes, psg.mobilityInfo, psg.inside, psg.reach
//       (nearest-hub reach minutes at convoy speed), psg.nextPlanAt, psg.time, psg.userRequests,
//       psg.lineTitle, psg.lineQty, psg.whenSized(el, fn) (create maps once visible), psg.STATUS_LABEL.
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const ui = SRO.ui = SRO.ui || {};
  const psg = ui.psg = ui.psg || {};

  // ==== small helpers ==========================================================================
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function F() { return SRO.core.format; }
  function scen() { return (SRO.data && SRO.data.scenario) || {}; }
  function h() { return ui.h.apply(null, arguments); }
  function icon(n, o) { return ui.icon(n, o); }
  psg.isNum = isNum;

  psg.STATUS_LABEL = {
    submitted: 'Submitted', planned: 'Planned', approved: 'Approved', en_route: 'En route',
    delivered: 'Delivered', partial: 'Partial', delayed: 'Delayed', cancelled: 'Cancelled'
  };
  psg.EDITABLE = ['submitted', 'planned', 'delayed'];

  psg.mgrs = function (lat, lon) { return isNum(lat) && isNum(lon) ? F().mgrs(lat, lon, 5) : ''; };
  // '1800' today, '0130 Day 2' otherwise
  psg.time = function (simMin, nowMin) { return F().dayTime(simMin, nowMin); };
  psg.nextPlanAt = function (simMin) {
    const C = SRO.core.clock;
    return C && C.nextBoundary ? C.nextBoundary(simMin) : (Math.floor(simMin / 360) + 1) * 360;
  };

  // 'Xizhi (Fwy 1 / Hwy 5)' -> 'Xizhi'; 'FOB Granite (notional, near Sanxia)' -> 'FOB Granite'
  psg.placeName = function (g) {
    if (!g) return '';
    return String(g.name || g.id || '').replace(/\s*\(.*\)\s*$/, '').trim();
  };
  // Nearest grid point: { name, distMi, gridId, point }
  psg.place = function (lat, lon, filter) {
    const grid = (SRO.data && SRO.data.grid) || [];
    if (!isNum(lat) || !isNum(lon) || !grid.length) return null;
    const g = SRO.core.geo.nearestGrid({ lat: lat, lon: lon }, grid, filter);
    return g ? { name: psg.placeName(g), distMi: g.distMi, gridId: g.id, point: g } : null;
  };
  psg.nearText = function (lat, lon) {
    const p = psg.place(lat, lon);
    if (!p) return '';
    return p.distMi < 0.3 ? 'at ' + p.name : 'near ' + p.name + ' (' + F().miles(p.distMi) + ')';
  };

  psg.inside = function (lat, lon) {
    const fn = scen().insideTaiwan;
    if (!isNum(lat) || !isNum(lon)) return false;
    return typeof fn === 'function' ? !!fn(lat, lon) : (lat >= 21.88 && lat <= 25.32 && lon >= 120 && lon <= 122.03);
  };

  // Mobility modes with the planner's current radii (settings.mobility).
  psg.mobilityModes = function (state) {
    const set = (state && state.scenario && state.scenario.settings && state.scenario.settings.mobility) || {};
    const r = function (k, d) { return set[k] && isNum(set[k].radiusMi) ? set[k].radiusMi : d; };
    const mounted = r('mounted', 50), dismounted = r('dismounted', 5);
    return [
      { id: 'mounted', label: 'Mounted', radiusMi: mounted, sub: 'You have vehicles. You may drive up to ' + fmtMi(mounted) + ' to a pickup point.' },
      { id: 'dismounted', label: 'Dismounted', radiusMi: dismounted, sub: 'On foot. Pickup point within ' + fmtMi(dismounted) + ' of you.' },
      { id: 'fixed', label: 'Fixed in place', radiusMi: 0, sub: 'Holding or in contact. Trucks deliver direct to you.' }
    ];
  };
  function fmtMi(x) { return (Math.round(x * 10) / 10) + ' mi'; }
  psg.mobilityInfo = function (state, id) {
    const list = psg.mobilityModes(state);
    return list.find(function (m) { return m.id === id; }) || list[0];
  };

  // Requests made on this device (the platoon sergeant's own), newest first.
  psg.userRequests = function (state) {
    return ((state && state.requests) || []).filter(function (r) { return r.source === 'user'; })
      .slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0) || (a.id < b.id ? 1 : -1); });
  };

  // Catalog text for a line: 'Small arms ammunition, 5.56 mm' (or just 'JP-8') and '500 gal'.
  psg.lineTitle = function (line) {
    const H = SRO.data.catalogHelpers;
    const it = H.itemById(line.itemId);
    if (!it) return String(line.itemId || 'Item');
    if (it.freeText) return it.name + (line.option ? ': ' + line.option : '');
    const op = H.optionById(line.itemId, line.option);
    if (!op || it.options.length <= 1) return it.name;
    // 'JP-8' rather than 'Diesel / JP-8, JP-8'; 'Diesel (DF-2)' rather than 'Diesel / JP-8, Diesel (DF-2)'
    const nm = it.name.toLowerCase(), ol = op.label.toLowerCase();
    if (nm.indexOf(ol) >= 0 || ol.indexOf(nm.split(/[\s/]+/)[0]) === 0) return op.label;
    return it.name + ', ' + op.label;
  };
  psg.lineQty = function (qty, unit) {
    const H = SRO.data.catalogHelpers;
    return isNum(qty) ? F().number(qty, Number.isInteger(qty) ? 0 : 1) + ' ' + H.unitLabel(unit, qty) : '';
  };

  // Minutes for the nearest hub to have a truck at (lat, lon): load time + road drive time x convoy
  // factor, closed zones applied. -> { minutes, hub } (minutes Infinity when no hub can reach it).
  const reachCache = {};
  psg.reach = function (state, lat, lon) {
    if (!state || !isNum(lat) || !isNum(lon)) return null;
    const S = state.scenario || {};
    const set = S.settings || {};
    const roads = SRO.core.roads;
    const closed = (S.zones || []).filter(function (z) { return z.kind === 'closed'; });
    const key = lat.toFixed(4) + ',' + lon.toFixed(4) + '|' + JSON.stringify(closed.map(function (z) { return [z.lat, z.lon, z.radiusMi]; })) + '|' + set.convoyFactor + '|' + set.loadMin;
    if (reachCache[key]) return reachCache[key];
    let best = Infinity, bestHub = null;
    (S.hubs || []).forEach(function (hub) {
      let min = Infinity;
      try {
        if (roads && roads.route) {
          const r = roads.route({ lat: hub.lat, lon: hub.lon }, { lat: lat, lon: lon }, { closed: closed });
          if (r && r.reachable !== false && isNum(r.minutes)) min = r.minutes;
        } else {
          min = SRO.core.geo.haversineMi(hub, { lat: lat, lon: lon }) * 1.3 / 40 * 60;
        }
      } catch (e) { min = Infinity; }
      if (min < best) { best = min; bestHub = hub; }
    });
    const conv = isNum(set.convoyFactor) ? set.convoyFactor : 1.5;
    const load = isNum(set.loadMin) ? set.loadMin : 20;
    const out = { minutes: best === Infinity ? Infinity : Math.ceil(best * conv + load), hub: bestHub };
    reachCache[key] = out;
    return out;
  };

  // Run fn once el is in the document with a real size (at once when it already has one). Maps are
  // created through this: a map made in a hidden tab, a detached card or a sheet body before it opens
  // would otherwise get the map component's own first-visible fit to Taiwan after ours.
  // -> cancel()
  psg.whenSized = function (el, fn) {
    const ready = function () { return el.isConnected && el.clientWidth > 0 && el.clientHeight > 0; };
    if (ready()) { fn(); return function () {}; }
    let done = false;
    if (typeof root.ResizeObserver !== 'function') {
      const t = setInterval(function () { if (!done && ready()) { done = true; clearInterval(t); fn(); } }, 200);
      return function () { done = true; clearInterval(t); };
    }
    const ro = new root.ResizeObserver(function () {
      if (done || !ready()) return;
      done = true;
      ro.disconnect();
      fn();
    });
    ro.observe(el);
    return function () { done = true; ro.disconnect(); };
  };

  // One scroll container (.psg-body) holds every platoon sergeant tab, so without this a tab opened
  // after scrolling another one shows up part-way down (and the request form showed up at step 3
  // after the unit setup was saved). Each view keeps its own place:
  //   mount: psg.keepScroll(view, el)   onShow: psg.showScroll(view)   onHide: psg.hideScroll(view)
  //   psg.toTop(view) when a view swaps its content (setup saved, edit loaded, confirmation).
  psg.keepScroll = function (view, el) {
    const body = el && el.closest ? el.closest('.psg-body') : null;
    view.scrollY = 0;
    view.shown = true;
    if (!body) return;
    view.scrollBody = body;
    body.scrollTop = 0;   // a tab opened for the first time starts at its top
    const onScroll = function () { if (view.shown) view.scrollY = body.scrollTop; };
    body.addEventListener('scroll', onScroll, { passive: true });
    view.offScroll = function () { body.removeEventListener('scroll', onScroll); };
  };
  psg.showScroll = function (view) {
    view.shown = true;
    const body = view.scrollBody;
    if (!body) return;
    // the tab's content stays in the DOM while hidden, so its height is already right here
    body.scrollTop = view.scrollY || 0;
  };
  psg.hideScroll = function (view) { view.shown = false; };
  psg.toTop = function (view) {
    view.scrollY = 0;
    if (view.shown !== false && view.scrollBody) view.scrollBody.scrollTop = 0;
  };

  // Maps in these views are made and removed through these two. A map removed in the same task that
  // created it leaves a Leaflet canvas redraw pending, which then throws "Cannot read properties of
  // undefined (reading 'save')" (SRO.ui.map: the road renderer's redraw is not cancelled). It happened
  // when Submit re-rendered the open pickup-hint map just before the form gave way to the
  // confirmation. A map that has not seen a frame yet is removed on the next one.
  psg.createMap = function (el, opts) {
    const m = ui.map.create(el, opts);
    m.__psgFresh = true;
    const seen = function () { m.__psgFresh = false; };
    if (root.requestAnimationFrame) root.requestAnimationFrame(seen); else setTimeout(seen, 0);
    return m;
  };
  psg.destroyMap = function (m) {
    if (!m) return;
    const kill = function () { try { m.destroy(); } catch (e) { /* ignore */ } };
    if (m.__psgFresh && root.requestAnimationFrame) root.requestAnimationFrame(kill); else kill();
  };

  // ==== small controls ===========================================================================
  // Radio cards: options [{ value, title, sub, disabled, extra (node) }]
  psg.choiceGroup = function (o) {
    const group = h('div.psg-choices', { role: 'radiogroup', 'aria-label': o.label || null, 'data-name': o.name || null });
    (o.options || []).forEach(function (opt) {
      const on = opt.value === o.value;
      group.appendChild(h('button.psg-choice' + (o.cls ? '.' + o.cls : ''), {
        type: 'button', role: 'radio', 'aria-checked': String(on), 'data-value': opt.value,
        disabled: !!opt.disabled, 'data-urgency': opt.urgency || null,
        onClick: function () { if (!opt.disabled && o.onChange) o.onChange(opt.value); }
      },
      h('span.psg-choice-mark', { 'aria-hidden': 'true' }),
      h('span.psg-choice-title', opt.title, opt.tag ? h('span.psg-choice-tag', opt.tag) : null),
      opt.sub ? h('span.psg-choice-sub', opt.sub) : null));
    });
    return group;
  };

  // Segmented buttons: options [{ value, label, title }]
  psg.seg = function (o) {
    return h('div.seg.seg-block.psg-seg', { role: 'group', 'aria-label': o.label || null, 'data-name': o.name || null },
      (o.options || []).map(function (opt) {
        return h('button', {
          type: 'button', 'aria-pressed': String(opt.value === o.value), 'data-value': opt.value, title: opt.title || null,
          onClick: function () { if (o.onChange) o.onChange(opt.value); }
        }, opt.label);
      }));
  };

  // Number stepper: { value, min, max, step, allowEmpty, decimals, label, placeholder, onChange(v|null) }
  psg.parseNum = function (s) {
    const t = String(s === null || s === undefined ? '' : s).replace(/[,\s]/g, '');
    if (t === '') return null;
    const v = Number(t);
    return isFinite(v) ? v : NaN;
  };
  psg.stepper = function (o) {
    const step = o.step || 1;
    let value = isNum(o.value) ? o.value : null;
    const input = h('input', {
      type: 'text', inputmode: o.decimals ? 'decimal' : 'numeric', autocomplete: 'off', enterkeyhint: 'done',
      'aria-label': o.label || 'Quantity', placeholder: o.placeholder || '', value: value === null ? '' : String(value),
      id: o.id || null
    });
    const minus = h('button', { type: 'button', 'aria-label': 'Less' + (o.label ? ' ' + o.label.toLowerCase() : ''), onClick: function () { bump(-1); } }, '−');
    const plus = h('button', { type: 'button', 'aria-label': 'More' + (o.label ? ' ' + o.label.toLowerCase() : ''), onClick: function () { bump(1); } }, '+');
    const el = h('div.stepper.stepper-block.psg-stepper', minus, input, plus);
    const lo = isNum(o.min) ? o.min : 0;
    function clampV(v) {
      if (v === null) return null;
      if (isNum(o.max) && v > o.max) v = o.max;
      if (v < lo) v = lo;
      return v;
    }
    function sync() {
      minus.disabled = value === null || isNaN(value) || value <= lo;
      plus.disabled = value !== null && !isNaN(value) && isNum(o.max) && value >= o.max;
    }
    // +/- move to the next multiple of the step (500 -> 550 -> 600 with step 50; 512 -> 550 / 500)
    function bump(dir) {
      let v;
      if (value === null || isNaN(value)) {
        if (dir < 0) return;
        v = lo > 0 ? lo : step;
      } else {
        v = dir > 0 ? (Math.floor(value / step + 1e-9) + 1) * step : (Math.ceil(value / step - 1e-9) - 1) * step;
      }
      set(clampV(Math.round(v * 1000) / 1000), true);
    }
    function set(v, notify) {
      value = v;
      input.value = v === null || isNaN(v) ? (v === null ? '' : input.value) : String(v);
      sync();
      if (notify && o.onChange) o.onChange(value);
    }
    input.addEventListener('input', function () {
      const v = psg.parseNum(input.value);
      value = v;
      sync();
      if (o.onChange) o.onChange(v);
    });
    input.addEventListener('blur', function () {
      const v = psg.parseNum(input.value);
      if (v === null || isNaN(v)) return;
      const c = clampV(v);
      if (c !== v) set(c, true);
    });
    input.addEventListener('focus', function () { try { input.select(); } catch (e) { /* ignore */ } });
    sync();
    return { el: el, input: input, get: function () { return value; }, set: function (v) { set(v, false); } };
  };

  // ==== unit name builder ==========================================================================
  const PLATOONS = ['1', '2', '3', '4'];
  const COMPANIES = ['A', 'B', 'C', 'D'];
  const BRANCHES = [
    { id: 'IN', label: 'IN (Infantry)' }, { id: 'AR', label: 'AR (Armor)' }, { id: 'CAV', label: 'CAV (Cavalry)' },
    { id: 'EN', label: 'EN (Engineer)' }, { id: 'FA', label: 'FA (Field Artillery)' }
  ];
  function ord(n) { n = String(n); return n + (n === '1' ? 'st' : n === '2' ? 'nd' : n === '3' ? 'rd' : 'th'); }
  function coWord(branch) { return branch === 'CAV' ? 'TRP' : branch === 'FA' ? 'BTRY' : 'CO'; }
  psg.parseUnit = function (name) {
    const m = /^(\d+)(?:st|nd|rd|th)\s+PLT,\s*([A-Z])\s+(CO|TRP|BTRY),\s*(\d+-\d+)\s+([A-Z]+)$/i.exec(String(name || '').trim());
    return m ? { plt: m[1], co: m[2].toUpperCase(), bn: m[4], br: m[5].toUpperCase() } : null;
  };
  psg.unitName = function (p) { return ord(p.plt) + ' PLT, ' + p.co + ' ' + coWord(p.br) + ', ' + p.bn + ' ' + p.br; };
  psg.designator = function (unitName) {
    const fn = scen().designatorFor;
    return typeof fn === 'function' ? fn(unitName) : String(unitName || '').replace(/\s+/g, '');
  };
  const BN_RE = /^\d{1,2}-\d{1,3}$/;

  function symbolSvg(profileLike, size) {
    try {
      const S = ui.symbols;
      if (!S || !S.svg) return null;
      const span = h('span.psg-sym', { 'aria-hidden': 'true' });
      span.innerHTML = S.svg(S.platoonSidc(profileLike), { size: size || 30, label: 'Platoon symbol' });
      return span;
    } catch (e) { return null; }
  }
  psg.symbolSvg = symbolSvg;

  // ==== location picker ==========================================================================
  psg.locationPicker = function (host, o) {
    o = o || {};
    let loc = isNum(o.lat) && isNum(o.lon) ? { lat: o.lat, lon: o.lon } : null;
    const mapEl = h('div.psg-map' + (o.mapClass ? '.' + o.mapClass : ''), { 'aria-label': 'Map of Taiwan. Tap to set your location.', role: 'region' });
    const tapHint = h('div.psg-map-hint', { 'aria-hidden': 'true' }, 'Tap where your platoon is');
    const mapWrap = h('div.psg-map-wrap', mapEl, tapHint);
    const readout = h('div.psg-loc-readout', { 'aria-live': 'polite' });
    const msg = h('div.psg-loc-msg', { role: 'status' });
    const geoBtn = h('button.btn.btn-secondary.psg-geo-btn', { type: 'button', onClick: useMyLocation }, icon('pin'), h('span', 'Use my location'));
    const gridInput = h('input.input.mono.psg-grid-input', {
      type: 'text', placeholder: '51R UH 12345 67890', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'MGRS grid', enterkeyhint: 'go'
    });
    const gridForm = h('form.psg-grid-form', { hidden: true, onSubmit: function (e) { e.preventDefault(); setFromGrid(); } },
      gridInput, h('button.btn.btn-secondary', { type: 'submit' }, 'Set grid'));
    const gridBtn = h('button.btn.btn-ghost.psg-grid-btn', {
      type: 'button', 'aria-expanded': 'false',
      onClick: function () {
        const open = gridForm.hidden;
        gridForm.hidden = !open;
        gridBtn.setAttribute('aria-expanded', String(open));
        if (open) { try { gridInput.focus(); } catch (e) { /* ignore */ } }
      }
    }, 'Type a grid');
    host.appendChild(h('div.psg-loc', mapWrap, h('div.psg-loc-actions', geoBtn, gridBtn), gridForm, readout, msg));

    let m = null;
    const cancelMap = psg.whenSized(mapEl, function () {
      try {
        m = psg.createMap(mapEl, { compact: true, tiles: true });
        mapEl.__sroMap = m;
        const st = o.state || (SRO.app && SRO.app.store && SRO.app.store.getState());
        if (st && st.scenario) m.setHubs(st.scenario.hubs || []);
        m.on('click:map', function (e) { setLoc(e.lat, e.lon, 'map'); });
        m.on('click:platoon', function () { /* the marker is the current spot */ });
        // hubs are shown for orientation; a tap on one sets the location there
        m.on('click:hub', function (e) { if (e && e.hub) setLoc(e.hub.lat, e.hub.lon, 'map'); });
        if (loc) m.leaflet.setView([loc.lat, loc.lon], 10, { animate: false });
        draw();
      } catch (e) {
        m = null;
        mapEl.appendChild(h('div.notice.notice-warn', icon('alert'), h('div', 'The map could not load here. Use "Type a grid" or "Use my location".')));
      }
    });

    function say(kind, text) {
      ui.clear(msg);
      if (!text) return;
      msg.appendChild(h('div.' + (kind === 'error' ? 'field-error' : kind === 'warn' ? 'field-warn' : 'field-help'), kind === 'info' ? null : icon('alert'), h('span', text)));
    }
    function draw() {
      ui.clear(readout);
      mapWrap.classList.toggle('has-loc', !!loc);
      if (!loc) {
        readout.appendChild(h('div.psg-loc-empty.muted', 'No location set yet.'));
        if (m) m.setPlatoons([]);
        return;
      }
      readout.appendChild(h('div.psg-loc-grid',
        h('span.caps', 'Grid'), h('span.mono.psg-mgrs', psg.mgrs(loc.lat, loc.lon))));
      readout.appendChild(h('div.psg-loc-near.muted', psg.nearText(loc.lat, loc.lon)));
      if (m) {
        const u = o.getUnit ? o.getUnit() : {};
        m.setPlatoons([Object.assign({ id: 'me', urgency: 'Routine' }, u, { lat: loc.lat, lon: loc.lon })]);
      }
    }
    function setLoc(lat, lon, source) {
      if (!psg.inside(lat, lon)) {
        say('error', source === 'map' ? 'That spot is outside Taiwan. Tap a point on the main island.'
          : 'Grid ' + psg.mgrs(lat, lon) + ' is outside Taiwan. Enter a grid on the main island.');
        return false;
      }
      loc = { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
      say(null, '');
      draw();
      if (m && source !== 'map') m.leaflet.setView([loc.lat, loc.lon], Math.max(m.leaflet.getZoom(), 10));
      if (o.onChange) o.onChange(loc, source);
      return true;
    }
    function useMyLocation() {
      const geo = root.navigator && root.navigator.geolocation;
      if (!geo || typeof geo.getCurrentPosition !== 'function') {
        say('warn', 'This device cannot share its location. Tap the map or type a grid instead.');
        return;
      }
      geoBtn.disabled = true;
      geoBtn.classList.add('is-busy');
      const label = geoBtn.querySelector('span');
      label.textContent = 'Finding you...';
      say('info', '');
      let finished = false;
      const done = function () {
        finished = true;
        geoBtn.disabled = false;
        geoBtn.classList.remove('is-busy');
        label.textContent = 'Use my location';
      };
      // some browsers never call back when the prompt is dismissed; give up after 15 s
      const guard = setTimeout(function () {
        if (finished) return;
        done();
        say('warn', 'No answer from the device location service. Tap the map or type a grid instead.');
      }, 15000);
      try {
        geo.getCurrentPosition(function (pos) {
          if (finished) return;
          clearTimeout(guard);
          done();
          const lat = pos.coords.latitude, lon = pos.coords.longitude;
          if (!psg.inside(lat, lon)) {
            say('warn', 'Your device puts you at ' + psg.mgrs(lat, lon) + ', outside Taiwan. For this exercise, tap the map to place your platoon on the island.');
            return;
          }
          setLoc(lat, lon, 'geo');
        }, function (err) {
          if (finished) return;
          clearTimeout(guard);
          done();
          const code = err && err.code;
          say('warn', code === 1 ? 'Location permission is off for this page. Tap the map or type a grid instead.'
            : code === 3 ? 'Finding your location took too long. Tap the map or type a grid instead.'
              : 'Your device could not find its position. Tap the map or type a grid instead.');
        }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 });
      } catch (e) {
        clearTimeout(guard);
        done();
        say('warn', 'Location is not available here. Tap the map or type a grid instead.');
      }
    }
    function setFromGrid() {
      const raw = String(gridInput.value || '').trim().toUpperCase();
      if (!raw) { say('error', 'Type a grid, for example 51R UH 36006 58258.'); return; }
      const lib = root.mgrs;
      let p = null;
      try { p = lib && lib.toPoint ? lib.toPoint(raw.replace(/\s+/g, '')) : null; } catch (e) { p = null; }
      if (!p || !isNum(p[0]) || !isNum(p[1])) { say('error', 'That grid was not recognized. Use the form 51R UH 36006 58258.'); return; }
      if (setLoc(p[1], p[0], 'grid')) { gridInput.value = ''; gridForm.hidden = true; gridBtn.setAttribute('aria-expanded', 'false'); }
    }

    draw();
    return {
      get map() { return m; },
      get: function () { return loc; },
      set: function (lat, lon) { return setLoc(lat, lon, 'set'); },
      redraw: draw,
      error: function (text) { say('error', text); },
      destroy: function () { cancelMap(); if (m) { psg.destroyMap(m); m = null; } }
    };
  };

  // ==== profile form =================================================================================
  let formSeq = 0;
  psg.profileForm = function (host, ctx, o) {
    o = o || {};
    const uid = 'psg-pf' + (++formSeq);   // ids unique per form (setup can be open on two tabs)
    const st0 = ctx.getState();
    const prof = st0.profile || {};
    const parts = psg.parseUnit(prof.unitName) || { plt: '1', co: 'A', bn: '', br: 'IN' };
    const form = { plt: parts.plt, co: parts.co, bn: parts.bn, br: parts.br, mobility: prof.mobility || 'mounted' };
    let showErrors = false;
    const setup = o.mode !== 'edit';

    const root0 = h('div.psg-profile-form.vstack-lg', { 'data-mode': setup ? 'setup' : 'edit' });
    host.appendChild(root0);

    // header
    root0.appendChild(h('div.psg-head',
      h('h2.psg-title', setup ? 'Set up your unit' : 'Edit unit'),
      h('p.muted', setup ? 'One time. Saved on this device, no sign-in. You can change it later under Unit.' : 'Changes apply to new requests.')));

    // unit
    const unitSec = h('section.psg-section', { 'aria-labelledby': uid + '-unit-h' }, h('h3.psg-sec-title', { id: uid + '-unit-h' }, 'Unit'));
    const pltBox = h('div'), coBox = h('div');
    const bnInput = h('input.input.psg-bn', {
      type: 'text', inputmode: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '4-93', maxlength: '7', value: form.bn,
      id: uid + '-bn', 'aria-describedby': uid + '-bn-help'
    });
    const brSelect = h('select.select.psg-br', { id: uid + '-br' }, BRANCHES.concat(BRANCHES.some(function (b) { return b.id === form.br; }) ? [] : [{ id: form.br, label: form.br }])
      .map(function (b) { return h('option', { value: b.id }, b.label); }));
    brSelect.value = form.br;
    const bnErr = h('div.field-error.psg-bn-err', { hidden: true, id: uid + '-bn-err' });
    const preview = h('div.psg-unit-preview', { 'aria-live': 'polite' });
    unitSec.appendChild(h('div.field', h('span.field-label', 'Platoon'), pltBox));
    unitSec.appendChild(h('div.field', h('span.field-label', 'Company'), coBox));
    unitSec.appendChild(h('div.psg-unit-row',
      h('div.field.psg-bn-field', h('label.field-label', { htmlFor: uid + '-bn' }, 'Battalion'), bnInput, h('div.field-help', { id: uid + '-bn-help' }, 'For example 4-93'), bnErr),
      h('div.field', h('label.field-label', { htmlFor: uid + '-br' }, 'Branch'), brSelect)));
    unitSec.appendChild(preview);
    root0.appendChild(unitSec);

    function drawUnitControls() {
      ui.clear(pltBox).appendChild(psg.seg({ label: 'Platoon', name: 'plt', value: form.plt, options: PLATOONS.map(function (p) { return { value: p, label: ord(p) }; }), onChange: function (v) { form.plt = v; drawUnitControls(); } }));
      const cos = COMPANIES.indexOf(form.co) >= 0 ? COMPANIES : COMPANIES.concat([form.co]);
      ui.clear(coBox).appendChild(psg.seg({ label: 'Company', name: 'co', value: form.co, options: cos.map(function (c) { return { value: c, label: c + ' ' + coWord(form.br) }; }), onChange: function (v) { form.co = v; drawUnitControls(); } }));
      drawPreview();
    }
    function unitValid() { return BN_RE.test(form.bn); }
    function currentUnit() {
      const name = unitValid() ? psg.unitName(form) : '';
      return { unitName: name, designator: name ? psg.designator(name) : '', mobility: form.mobility };
    }
    function drawPreview() {
      ui.clear(preview);
      const u = currentUnit();
      const sym = symbolSvg({ mobility: form.mobility, designator: u.designator || 'PLT', unitName: u.unitName }, 28);
      if (!u.unitName) {
        preview.appendChild(h('div.psg-unit-name.faint', ord(form.plt) + ' PLT, ' + form.co + ' ' + coWord(form.br) + ', ', h('span.psg-unit-missing', 'battalion'), ' ' + form.br));
      } else {
        preview.appendChild(h('div.hstack.psg-unit-line', sym, h('div.vstack-sm.grow',
          h('div.psg-unit-name', u.unitName),
          h('div.small.muted', 'Designator ', h('span.mono', u.designator)))));
      }
      if (showErrors && !unitValid()) {
        bnErr.hidden = false;
        ui.clear(bnErr).appendChild(icon('alert'));
        bnErr.appendChild(h('span', form.bn ? 'Write the battalion as number-regiment, for example 4-93.' : 'Enter your battalion, for example 4-93.'));
        bnInput.setAttribute('aria-invalid', 'true');
      } else {
        bnErr.hidden = true;
        bnInput.removeAttribute('aria-invalid');
      }
      if (picker) picker.redraw();
    }
    bnInput.addEventListener('input', function () {
      form.bn = String(bnInput.value || '').replace(/\s+/g, '').replace(/[‐-―]/g, '-');
      drawPreview();
    });
    brSelect.addEventListener('change', function () { form.br = brSelect.value; drawUnitControls(); });

    // location
    const locSec = h('section.psg-section.psg-loc-sec', { 'aria-labelledby': uid + '-loc-h' }, h('h3.psg-sec-title', { id: uid + '-loc-h' }, 'Location'),
      h('p.small.muted', 'Where the platoon is now. You can update it any time; platoons move.'));
    root0.appendChild(locSec);
    const locErr = h('div.field-error.psg-loc-err', { hidden: true });
    let picker = null;
    picker = psg.locationPicker(locSec, {
      lat: prof.lat, lon: prof.lon, state: st0,
      getUnit: currentUnit,
      onChange: function () { locErr.hidden = true; }
    });
    locSec.appendChild(locErr);

    // mobility
    const mobSec = h('section.psg-section', { 'aria-labelledby': uid + '-mob-h' }, h('h3.psg-sec-title', { id: uid + '-mob-h' }, 'How does your platoon move?'));
    const mobBox = h('div');
    mobSec.appendChild(mobBox);
    mobSec.appendChild(h('p.small.muted', 'Sets how far a pickup point can be from you. You can change it per request.'));
    root0.appendChild(mobSec);
    function drawMobility() {
      ui.clear(mobBox).appendChild(psg.choiceGroup({
        label: 'Mobility', name: 'mobility', value: form.mobility,
        options: psg.mobilityModes(ctx.getState()).map(function (mo) { return { value: mo.id, title: mo.label, sub: mo.sub }; }),
        onChange: function (v) { form.mobility = v; drawMobility(); drawPreview(); }
      }));
    }

    // actions
    const actions = h('div.psg-form-actions',
      h('button.btn.btn-primary.btn-lg.btn-block.psg-save-profile', { type: 'button', onClick: save }, icon('check'), setup ? 'Save unit' : 'Save changes'),
      setup ? null : h('button.btn.btn-ghost.btn-block', { type: 'button', onClick: function () { cleanup(); if (o.onCancel) o.onCancel(); } }, 'Cancel'));
    root0.appendChild(actions);

    function save() {
      showErrors = true;
      drawPreview();
      const loc = picker.get();
      let bad = null;
      if (!unitValid()) bad = bnInput;
      if (!loc) {
        locErr.hidden = false;
        ui.clear(locErr).appendChild(icon('alert'));
        locErr.appendChild(h('span', 'Set your location: tap the map, use your location, or type a grid.'));
        bad = bad || locSec;
      } else if (!psg.inside(loc.lat, loc.lon)) {
        picker.error('Your location is outside Taiwan. Move it onto the main island.');
        bad = bad || locSec;
      }
      if (bad) {
        try { bad.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { bad.scrollIntoView(); }
        if (bad === bnInput) { try { bnInput.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        return;
      }
      const u = currentUnit();
      const place = psg.place(loc.lat, loc.lon);
      const profile = { unitName: u.unitName, designator: u.designator, lat: loc.lat, lon: loc.lon, gridId: place ? place.gridId : null, mobility: form.mobility };
      const res = ctx.dispatch({ type: 'profile/save', profile: profile });
      if (!res || !res.ok) { ui.toast((res && res.error) || 'Could not save the unit.', 'error'); return; }
      ui.toast(setup ? 'Unit saved on this device.' : 'Unit updated.', 'success');
      cleanup();
      if (o.onSaved) o.onSaved(profile);
    }
    function cleanup() { if (picker) { picker.destroy(); picker = null; } }

    drawUnitControls();
    drawMobility();
    return { destroy: cleanup, el: root0 };
  };

  // ==== "Update my location" sheet =====================================================================
  psg.openLocationSheet = function (ctx) {
    const st = ctx.getState();
    const prof = st.profile;
    if (!prof) return null;
    let picker = null, next = null;
    const handle = ui.modal.open({
      title: 'Update my location',
      size: 'md',
      body: function (el) {
        el.classList.add('psg-sheet');
        el.appendChild(h('p.small.muted', 'Tap the map where the platoon is now, use your device location, or type a grid. New requests use this location.'));
        picker = psg.locationPicker(el, {
          lat: prof.lat, lon: prof.lon, state: st, mapClass: 'psg-map-sheet',
          getUnit: function () { return { unitName: prof.unitName, designator: prof.designator, mobility: prof.mobility }; },
          onChange: function (loc) { next = loc; }
        });
      },
      actions: [
        { label: 'Cancel', kind: 'secondary' },
        {
          label: 'Save location', kind: 'primary', id: 'save-location',
          onClick: function () {
            const loc = next || (picker && picker.get());
            if (!loc) { picker.error('Tap the map to set a location first.'); return false; }
            if (!next) return true;   // unchanged
            const place = psg.place(loc.lat, loc.lon);
            const res = ctx.dispatch({ type: 'profile/save', profile: { lat: loc.lat, lon: loc.lon, gridId: place ? place.gridId : null } });
            if (!res || !res.ok) { ui.toast((res && res.error) || 'Could not save the location.', 'error'); return false; }
            ui.toast('Location updated: ' + psg.mgrs(loc.lat, loc.lon) + '.', 'success');
            return true;
          }
        }
      ],
      onClose: function () { if (picker) picker.destroy(); picker = null; }
    });
    return handle;
  };

  // ==== Unit view (tab) ==============================================================================
  const view = {
    label: 'Unit',
    icon: 'user',
    order: 30,
    mount: function (el, ctx) {
      this.el = el;
      this.mode = null;
      this.form = null;
      el.classList.add('psg-unit-view');
      psg.keepScroll(this, el);
      this.render(ctx.getState(), ctx);
    },
    onShow: function () { psg.showScroll(this); },
    onHide: function () { psg.hideScroll(this); },
    update: function (state, ctx) {
      if (ctx.clockOnly) return;
      if (this.mode === 'edit' || (this.mode === 'setup' && !state.profile)) return;   // a form is open
      if (this.mode === 'summary' && ctx.prev && ctx.prev.profile === state.profile && ctx.prev.scenario.settings.mobility === state.scenario.settings.mobility) return;
      this.render(state, ctx);
    },
    unmount: function () { if (this.form) this.form.destroy(); this.form = null; if (this.offScroll) this.offScroll(); },
    render: function (state, ctx) {
      const self = this, el = this.el;
      // saved or cancelled at the bottom of a form: the summary from its top
      const back = function () { self.form = null; self.mode = null; self.render(ctx.getState(), ctx); psg.toTop(self); };
      if (this.form) { this.form.destroy(); this.form = null; }
      ui.clear(el);
      if (!state.profile) {
        this.mode = 'setup';
        this.form = psg.profileForm(el, ctx, { mode: 'setup', onSaved: back });
        return;
      }
      this.mode = 'summary';
      const p = state.profile;
      const mob = psg.mobilityInfo(state, p.mobility);
      const sym = symbolSvg(p, 34);
      el.appendChild(h('div.psg-head', h('h2.psg-title', 'Unit'), h('p.muted', 'Saved on this device. Requests use this unit and location.')));
      el.appendChild(h('div.card.psg-unit-card',
        h('div.hstack.psg-unit-line', sym, h('div.vstack-sm.grow',
          h('div.psg-unit-name.psg-unit-name-lg', p.unitName || 'Unit'),
          h('div.small.muted', 'Designator ', h('span.mono', p.designator || psg.designator(p.unitName))))),
        h('div.divider'),
        h('dl.kv.psg-kv',
          h('dt', 'Grid'), h('dd', h('span.mono.psg-mgrs', psg.mgrs(p.lat, p.lon) || 'Not set'), h('div.small.muted', psg.nearText(p.lat, p.lon))),
          h('dt', 'Moving'), h('dd', h('strong', mob.label), h('div.small.muted', mob.sub))),
        h('div.psg-card-actions',
          h('button.btn.btn-secondary.btn-block.psg-update-loc', { type: 'button', onClick: function () { psg.openLocationSheet(ctx); } }, icon('pin'), 'Update my location'))));
      el.appendChild(h('section.psg-section',
        h('h3.psg-sec-title', 'Change how you move'),
        psg.choiceGroup({
          label: 'Mobility', name: 'mobility', value: p.mobility,
          options: psg.mobilityModes(state).map(function (mo) { return { value: mo.id, title: mo.label, sub: mo.sub }; }),
          onChange: function (v) {
            if (v === p.mobility) return;
            const res = ctx.dispatch({ type: 'profile/save', profile: { mobility: v } });
            if (res && res.ok) ui.toast('Moving: ' + psg.mobilityInfo(ctx.getState(), v).label + '. New requests use this.', 'success');
          }
        })));
      el.appendChild(h('button.btn.btn-ghost.btn-block.psg-edit-unit', {
        type: 'button',
        onClick: function () {
          ui.clear(el);
          self.mode = 'edit';
          self.form = psg.profileForm(el, ctx, { mode: 'edit', onSaved: back, onCancel: back });
          psg.toTop(self);
        }
      }, icon('edit'), 'Edit unit name, location or mobility'));
    }
  };
  psg.profileView = view;
  if (ui.registerView) ui.registerView('psg/profile', view);
})(typeof self !== 'undefined' ? self : globalThis);
