// App shell (DESIGN.md section 8): top bar (role switch, demo clock, theme), the view registry and
// the layout of both roles, bottom tab bars, toasts, modal / bottom sheet, a tiny DOM helper and
// inline SVG icons. boot.js creates the store and calls SRO.ui.shell.mount({ store }).
//
// VIEWS
//   SRO.ui.registerView(name, view)   view = { mount(el, ctx), update(state, ctx), onShow?(el, ctx),
//                                              onHide?(el, ctx), unmount?(el, ctx), label?, icon?,
//                                              region?, order?, hidden?, parent?, badge?(state) }
//     'psg/<tab>' or 'planner/<tab>'   adds a tab to that role (same as psgTabs / plannerTabs.add)
//     'psg' or 'planner'               a root view that owns the whole role area (no shell tabs)
//     a known tab name                 'map' 'queue' 'plan' 'scenario' 'outputs' 'route' -> planner;
//                                      'request' 'myrequests' 'profile' 'status' -> platoon sergeant
//     view.role = 'psg' | 'planner'    adds a tab with this name to that role
//   Views mount lazily the first time they are visible, then update(state, ctx) runs on every store
//   change while visible (batched to one render per animation frame) and once when shown again.
//   update also accepts the name render. ctx = { name, role, el, region, store, dispatch, getState,
//   state, prev (state at this view's last update, null first), changed(path) (e.g.
//   ctx.changed('requests'), ctx.changed('scenario.zones')), clockOnly (only state.clock changed),
//   visible, layout ('phone' | 'tablet' | 'wide'), wide, phone, show(tab), ui, h, icon, toast, modal }.
//
// PLANNER TABS  SRO.ui.plannerTabs.add({ name, label, icon, mount, update, region, order, hidden,
//   parent, badge })   (also callable as SRO.ui.plannerTabs({...}), .register(), .push()).
//   Regions: 'left' (Queue), 'center' (Map), 'right' (Plan, Scenario, Outputs, default). Under
//   1100px wide the tabs show one at a time with a bottom tab bar (Map / Queue / Plan / Scenario /
//   Outputs); from 1100px the left, center and right panels show together and each side panel has
//   a segmented tab header. hidden: true keeps a tab out of the bars (e.g. 'route' detail, parent
//   'plan'); open it with SRO.ui.plannerTabs.show('route'). Unregistered default tabs show a
//   placeholder card. SRO.ui.psgTabs has the same API for the platoon sergeant column.
//
// OTHER API
//   SRO.ui.showView(name)  'psg' | 'planner' | 'planner/plan' | 'plan' ... switches role and tab
//   SRO.ui.toast(msg, kind = 'info' | 'success' | 'warn' | 'error', { timeout, action: { label, onClick } })
//     (aliases 'warning', 'danger', 'ok'; timeout 0 keeps it until dismissed) -> { el, close }
//   SRO.ui.modal.open({ title, body: fn(el, handle) | Node | string, actions: [{ label, kind:
//     'primary' | 'secondary' | 'danger' | 'ghost', onClick(handle) (return false keeps it open),
//     close, value, disabled, icon }], size: 'sm' | 'md' | 'lg' | 'xl', dismissible, onClose(result),
//     initialFocus: selector }) -> handle { el, body, close(result), setTitle(t), result: Promise }
//   SRO.ui.modal.close(handle?)  SRO.ui.modal.isOpen()  SRO.ui.confirm({ title, text, okLabel,
//     cancelLabel, danger }) -> Promise<boolean>
//   SRO.ui.h(tag, attrs, ...children)  tag 'div.card.is-selected#id'; attrs: class (string | array |
//     object), style (string | object, '--vars' ok), dataset, on<Event>: fn, html, text, ref(el),
//     boolean attrs (true / false), properties value / checked / selected / disabled / indeterminate.
//   SRO.ui.icons[name] (SVG markup string)  SRO.ui.icon(name, { size, cls, title }) -> SVGElement
//   SRO.ui.clear(el)  SRO.ui.esc(str)  SRO.ui.on/off/emit(event, data)  SRO.ui.onBoot(fn(app))
//   SRO.ui.print(nodeOrFn, { title })  SRO.ui.download(filename, data, mime)  SRO.ui.pickFile({ accept })
//   SRO.ui.layout() -> 'phone' | 'tablet' | 'wide'   SRO.ui.isWide()  SRO.ui.isPhone()
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const ui = SRO.ui = SRO.ui || {};
  const doc = root.document;

  const THEMES = ['dark', 'light', 'night'];
  const THEME_META = {
    dark: { label: 'Dark', icon: 'moon', color: '#0f1418' },
    light: { label: 'Light', icon: 'sun', color: '#f4f5f2' },
    night: { label: 'Night', icon: 'eye', color: '#000000' }
  };
  const ROLES = [
    { id: 'psg', label: 'Platoon sergeant', short: 'PSG' },
    { id: 'planner', label: 'Planner', short: 'Planner' }
  ];
  const SPEED_HELP = { 1: 'real time', 60: '1 second = 1 minute', 600: '1 second = 10 minutes' };
  const STORE_PLANNER_TABS = ['queue', 'plan', 'scenario', 'outputs', 'map'];
  const REGIONS = ['left', 'center', 'right'];
  const WIDE_MQ = '(min-width: 1100px)';
  const PHONE_MQ = '(max-width: 599px)';

  const PLANNER_DEFAULTS = {
    map: { label: 'Map', icon: 'map', region: 'center', order: 10 },
    queue: { label: 'Queue', icon: 'list', region: 'left', order: 20 },
    plan: { label: 'Plan', icon: 'route', region: 'right', order: 30 },
    route: { label: 'Route detail', icon: 'route', region: 'right', order: 35, hidden: true, parent: 'plan' },
    scenario: { label: 'Scenario', icon: 'sliders', region: 'right', order: 40 },
    outputs: { label: 'Outputs', icon: 'doc', region: 'right', order: 50 }
  };
  const PLANNER_PLACEHOLDERS = ['map', 'queue', 'plan', 'scenario', 'outputs'];
  const PSG_DEFAULTS = {
    request: { label: 'Request', icon: 'plus', order: 10 },
    myrequests: { label: 'My requests', icon: 'truck', order: 20 },
    'my-requests': { label: 'My requests', icon: 'truck', order: 20 },
    status: { label: 'Status', icon: 'truck', order: 20 },
    profile: { label: 'Unit', icon: 'user', order: 30 }
  };

  // ==== DOM helper ===============================================================================
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = {
    svg: 1, g: 1, path: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1, rect: 1, defs: 1,
    use: 1, marker: 1, text: 1, tspan: 1, textPath: 1, clipPath: 1, mask: 1, pattern: 1, symbol: 1,
    foreignObject: 1, linearGradient: 1, radialGradient: 1, stop: 1
  };
  const PROPS = { value: 1, checked: 1, selected: 1, indeterminate: 1, muted: 1, disabled: 1, multiple: 1 };

  function isNode(x) { return !!x && typeof x === 'object' && typeof x.nodeType === 'number'; }

  function appendChildren(el, kids) {
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c === null || c === undefined || c === false || c === true) continue;
      if (Array.isArray(c)) { appendChildren(el, c); continue; }
      if (isNode(c)) { el.appendChild(c); continue; }
      el.appendChild(doc.createTextNode(String(c)));
    }
  }

  function addClasses(el, v, svg) {
    let list = [];
    if (typeof v === 'string') list = v.split(/\s+/);
    else if (Array.isArray(v)) v.forEach(function (x) { if (x) list = list.concat(String(x).split(/\s+/)); });
    else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { if (v[k]) list.push(k); });
    list = list.filter(Boolean);
    if (!list.length) return;
    if (svg) el.setAttribute('class', ((el.getAttribute('class') || '') + ' ' + list.join(' ')).trim());
    else list.forEach(function (c) { el.classList.add(c); });
  }

  // h('button.btn.btn-primary', { onClick: fn, disabled: false }, icon('plus'), 'Add')
  function h(tag, attrs) {
    let kids = Array.prototype.slice.call(arguments, 2);
    if (attrs !== null && attrs !== undefined && (typeof attrs !== 'object' || isNode(attrs) || Array.isArray(attrs))) {
      kids.unshift(attrs);
      attrs = null;
    }
    const spec = String(tag || 'div');
    const parts = spec.split(/(?=[.#])/);
    let name = parts[0] && parts[0][0] !== '.' && parts[0][0] !== '#' ? parts.shift() : 'div';
    let svg = false;
    if (name.indexOf('svg:') === 0) { name = name.slice(4); svg = true; } else if (SVG_TAGS[name]) svg = true;
    const el = svg ? doc.createElementNS(SVG_NS, name) : doc.createElement(name);
    parts.forEach(function (p) {
      if (p[0] === '#') el.setAttribute('id', p.slice(1));
      else if (p[0] === '.' && p.length > 1) addClasses(el, p.slice(1), svg);
    });
    let ref = null;
    let props = null;   // value / checked / selected ... are set after the children exist (a <select>
                        // can only take a value once its <option>s are in it)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === undefined || v === null) return;
        if (k === 'class' || k === 'className') { addClasses(el, v, svg); return; }
        if (k === 'style') {
          if (typeof v === 'string') el.style.cssText += ';' + v;
          else Object.keys(v).forEach(function (sk) {
            if (v[sk] === null || v[sk] === undefined) return;
            if (sk.indexOf('--') === 0 || sk.indexOf('-') >= 0) el.style.setProperty(sk, String(v[sk]));
            else el.style[sk] = v[sk];
          });
          return;
        }
        if (k === 'dataset') { Object.keys(v).forEach(function (dk) { if (v[dk] !== null && v[dk] !== undefined) el.dataset[dk] = v[dk]; }); return; }
        if (k === 'html') { el.innerHTML = v; return; }
        if (k === 'text') { el.textContent = v; return; }
        if (k === 'ref') { ref = v; return; }
        if (k === 'on' && typeof v === 'object') { Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); }); return; }
        if (k.length > 2 && k.slice(0, 2) === 'on' && typeof v === 'function') { el.addEventListener(k.slice(2).toLowerCase(), v); return; }
        if (!svg && PROPS[k] && k in el) { (props = props || []).push([k, v]); return; }
        if (v === false) return;
        el.setAttribute(k === 'htmlFor' ? 'for' : k, v === true ? '' : String(v));
      });
    }
    appendChildren(el, kids);
    if (props) props.forEach(function (p) { el[p[0]] = p[1]; });
    if (typeof ref === 'function') ref(el);
    return el;
  }

  function clear(el) { if (el) while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ==== icons (24 x 24, stroke = currentColor) ===================================================
  const ICON_PATHS = {
    truck: '<rect x="1.5" y="5.5" width="12.5" height="10" rx="1"/><path d="M14 9h4.2l3.3 3.6v2.9H14"/><circle cx="6" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/>',
    map: '<path d="M9 4 3 6.5V20l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
    list: '<path d="M9 6h11.5M9 12h11.5M9 18h11.5M4 6h.01M4 12h.01M4 18h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    gear: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6.8"/><path d="M12 2.5v2.7M12 18.8v2.7M2.5 12h2.7M18.8 12h2.7M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M5.3 18.7l1.9-1.9M16.8 7.2l1.9-1.9"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    play: '<path d="M7.5 4.8v14.4L19 12z" fill="currentColor"/>',
    pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor"/><rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor"/>',
    check: '<path d="M4.5 12.5l5 5 10-11"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    alert: '<path d="M12 3.5 2.3 20.5h19.4z"/><path d="M12 10v4.5M12 17.6h.01"/>',
    chevron: '<path d="M9 5l7 7-7 7"/>',
    chevronDown: '<path d="M5 9l7 7 7-7"/>',
    chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
    layers: '<path d="M12 3.5 2.5 8.5 12 13.5l9.5-5z"/><path d="m2.5 12.5 9.5 5 9.5-5"/><path d="m2.5 16.5 9.5 5 9.5-5"/>',
    print: '<path d="M7 9V3.5h10V9"/><rect x="3" y="9" width="18" height="8" rx="1.5"/><path d="M7 14h10v6.5H7z"/>',
    download: '<path d="M12 3.5v12M7 10.5l5 5 5-5M4 20h16"/>',
    upload: '<path d="M12 15.5v-12M7 8.5l5-5 5 5M4 20h16"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.3-3.9 4.3-6 8-6s6.7 2.1 8 6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
    eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.5 4v5h-5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H16a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h7.5"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    doc: '<path d="M6 2.5h8.5L19 7v14.5H6z"/><path d="M14 2.5V7h5M9 12h7M9 16h7"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>',
    skip: '<path d="M5 5v14l10-7z" fill="currentColor"/><path d="M19 5v14"/>'
  };
  const ICON_OPEN = '<svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
  const icons = {};
  Object.keys(ICON_PATHS).forEach(function (k) { icons[k] = ICON_OPEN + ICON_PATHS[k] + '</svg>'; });
  const iconCache = {};

  // icon('truck') -> <svg class="icon icon-truck">; unknown names fall back to 'info'.
  function icon(name, opts) {
    const o = opts || {};
    let markup = typeof name === 'string' && name.indexOf('<svg') === 0 ? name : icons[name] || icons.info;
    let node = iconCache[markup];
    if (!node) {
      const t = doc.createElement('template');
      t.innerHTML = markup.trim();
      node = iconCache[markup] = t.content.firstChild;
    }
    const el = node.cloneNode(true);
    if (icons[name]) el.classList.add('icon-' + name);
    if (o.cls) addClasses(el, o.cls, true);
    if (o.size) { el.setAttribute('width', o.size); el.setAttribute('height', o.size); el.style.width = o.size + 'px'; el.style.height = o.size + 'px'; }
    if (o.title) {
      el.removeAttribute('aria-hidden');
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', o.title);
    }
    return el;
  }

  // ==== small event bus ==========================================================================
  const listeners = {};
  function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return function () { off(ev, fn); }; }
  function off(ev, fn) { const l = listeners[ev]; if (!l) return; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  function emit(ev, data) {
    (listeners[ev] || []).slice().forEach(function (fn) {
      try { fn(data); } catch (e) { if (root.console) root.console.error('[SRO.ui] "' + ev + '" listener failed:', e); }
    });
  }

  // ==== shell state ==============================================================================
  const shell = {
    store: null,
    mounted: false,
    dom: {},
    roots: { psg: null, planner: null },      // root view entries
    dirty: { psg: true, planner: true },      // layout must be rebuilt
    plannerOverride: null,                    // active planner tab the store cannot hold (hidden tabs)
    lastPlannerTab: null,
    regionActive: { left: 'queue', center: 'map', right: 'plan' },
    renderQueued: false,
    layoutKey: null,
    liveHooks: [],
    bootHooks: [],
    tb: null
  };

  function mq(q) { try { return !!(root.matchMedia && root.matchMedia(q).matches); } catch (e) { return false; } }
  function isWide() { return mq(WIDE_MQ); }
  function isPhone() { return mq(PHONE_MQ); }
  function layout() { return isWide() ? 'wide' : isPhone() ? 'phone' : 'tablet'; }
  function getState() { return shell.store ? shell.store.getState() : null; }
  function dispatch(action) { return shell.store ? shell.store.dispatch(action) : { ok: false, error: 'The app is not started yet.' }; }

  function logError(where, err) {
    if (root.console) root.console.error('[SRO.ui] ' + where + ':', err);
  }

  // ==== tab registries ===========================================================================
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1).replace(/[-_]/g, ' '); }

  function makeEntry(role, name, view, meta, registered, seq) {
    const d = (role === 'planner' ? PLANNER_DEFAULTS : PSG_DEFAULTS)[name] || {};
    const m = meta || {};
    const pick = function (k, dflt) { return m[k] !== undefined ? m[k] : view && view[k] !== undefined && typeof view[k] !== 'function' ? view[k] : d[k] !== undefined ? d[k] : dflt; };
    let region = role === 'planner' ? pick('region', 'right') : 'main';
    if (role === 'planner' && REGIONS.indexOf(region) < 0) region = 'right';
    return {
      role: role,
      name: name,
      view: view || null,
      registered: !!registered,
      label: pick('label', pick('title', cap(name))),
      icon: pick('icon', role === 'planner' ? 'list' : 'doc'),
      region: region,
      order: isFinite(pick('order', NaN)) ? +pick('order', 0) : 100 + seq,
      seq: seq,
      hidden: !!pick('hidden', false),
      parent: pick('parent', null),
      badge: typeof m.badge === 'function' ? m.badge : view && typeof view.badge === 'function' ? view.badge : null,
      el: null,
      mounted: false,
      failed: false,
      visible: false,
      ctx: null,
      prevState: null,
      prevLayout: null,
      logged: {}
    };
  }

  function makeTabs(role, placeholders) {
    const entries = {};
    let seq = 0;
    (placeholders || []).forEach(function (n) { entries[n] = makeEntry(role, n, null, null, false, seq++); });

    function add(tab) {
      if (!tab || typeof tab !== 'object') throw new TypeError('SRO.ui.' + role + 'Tabs.add(tab): tab must be an object');
      const name = String(tab.name || tab.id || '');
      if (!name) throw new TypeError('SRO.ui.' + role + 'Tabs.add(tab): tab.name is required');
      const view = tab.view && typeof tab.view === 'object' ? tab.view : tab;
      const old = entries[name];
      if (old && old.mounted) disposeEntry(old);
      entries[name] = makeEntry(role, name, view, tab.view ? tab : null, true, old ? old.seq : seq++);
      shell.dirty[role] = true;
      scheduleRender();
      return api;
    }
    function remove(name) {
      const e = entries[name];
      if (!e) return api;
      if (e.mounted) disposeEntry(e);
      if (e.el && e.el.parentNode) e.el.parentNode.removeChild(e.el);
      if (role === 'planner' && PLANNER_PLACEHOLDERS.indexOf(name) >= 0) entries[name] = makeEntry(role, name, null, null, false, e.seq);
      else delete entries[name];
      shell.dirty[role] = true;
      scheduleRender();
      return api;
    }
    function list(includePlaceholders) {
      return Object.keys(entries).map(function (k) { return entries[k]; })
        .filter(function (e) { return includePlaceholders || e.registered; })
        .sort(function (a, b) { return a.order - b.order || a.seq - b.seq; });
    }
    const api = function (tab) { return add(tab); };
    api.add = add;
    api.register = add;
    api.push = function () { Array.prototype.forEach.call(arguments, add); return api; };
    api.remove = remove;
    api.get = function (name) { return entries[name] || null; };
    api.has = function (name) { return !!(entries[name] && entries[name].registered); };
    api.list = function () { return list(true).map(function (e) { return { name: e.name, label: e.label, icon: e.icon, region: e.region, order: e.order, hidden: e.hidden, registered: e.registered }; }); };
    api.entries = list;
    api.show = function (name) { selectTab(role, name); return api; };
    api.active = function () { return activeTabName(role, getState()); };
    return api;
  }

  const tabs = {
    psg: makeTabs('psg', []),
    planner: makeTabs('planner', PLANNER_PLACEHOLDERS)
  };
  ui.plannerTabs = tabs.planner;
  ui.psgTabs = tabs.psg;

  // ==== view registry ============================================================================
  ui.views = ui.views || {};

  function classify(name, view) {
    const m = /^(psg|planner)(?:[\/:._-](.+))?$/.exec(name);
    if (m && !m[2]) return { kind: 'root', role: m[1] };
    if (m) return { kind: 'tab', role: m[1], tab: m[2] };
    if (view.role === 'psg' || view.role === 'planner') return { kind: 'tab', role: view.role, tab: name };
    if (PLANNER_DEFAULTS[name]) return { kind: 'tab', role: 'planner', tab: name };
    if (PSG_DEFAULTS[name]) return { kind: 'tab', role: 'psg', tab: name };
    return { kind: 'free' };
  }

  ui.registerView = function (name, view) {
    if (typeof name !== 'string' || !name) throw new TypeError('SRO.ui.registerView(name, view): name must be a non-empty string');
    if (!view || (typeof view !== 'object' && typeof view !== 'function')) throw new TypeError('SRO.ui.registerView("' + name + '", view): view must be an object with mount/update');
    ui.views[name] = view;
    const c = classify(name, view);
    if (c.kind === 'root') {
      const old = shell.roots[c.role];
      if (old && old.mounted) disposeEntry(old);
      shell.roots[c.role] = makeEntry(c.role, c.role, view, null, true, 0);
      shell.roots[c.role].region = 'root';
      shell.dirty[c.role] = true;
      scheduleRender();
    } else if (c.kind === 'tab') {
      const meta = { name: c.tab, view: view };
      tabs[c.role].add(meta);
    } else if (root.console) {
      root.console.warn('[SRO.ui] registerView("' + name + '"): not shown anywhere; use "psg/<tab>" or "planner/<tab>".');
    }
    return view;
  };

  ui.showView = function (name) {
    if (name === 'psg' || name === 'planner') { setRole(name); return true; }
    const m = /^(psg|planner)[\/:._-](.+)$/.exec(String(name || ''));
    let role = m ? m[1] : null, tab = m ? m[2] : name;
    if (!role) role = tabs.planner.get(tab) ? 'planner' : tabs.psg.get(tab) ? 'psg' : null;
    if (!role || !tabs[role].get(tab)) return false;
    selectTab(role, tab);
    return true;
  };

  // ==== role / tab / theme / clock actions =======================================================
  function setRole(role) {
    const st = getState();
    if (!st) return;
    if (st.ui.role !== role) dispatch({ type: 'role/set', role: role });
  }

  function selectTab(role, name) {
    const st = getState();
    if (!st) return;
    if (st.ui.role !== role) dispatch({ type: 'role/set', role: role });
    if (role === 'psg') {
      if (st.ui.psgTab !== name) dispatch({ type: 'tab/set', role: 'psg', tab: name });
      scheduleRender();
      return;
    }
    // remember the choice for its panel now: two selections in one task (e.g. show('plan') then
    // show('queue')) must leave Plan in the right panel and Queue in the left on wide screens
    const pe = tabs.planner.get(name);
    if (pe) shell.regionActive[pe.region] = name;
    if (STORE_PLANNER_TABS.indexOf(name) >= 0) {
      shell.plannerOverride = null;
      if (st.ui.plannerTab !== name) dispatch({ type: 'tab/set', tab: name });
    } else {
      shell.plannerOverride = name;
    }
    emit('tab', { role: role, name: name });
    scheduleRender();
  }

  function cycleTheme() {
    const st = getState();
    if (!st) return;
    const i = THEMES.indexOf(st.ui.theme);
    dispatch({ type: 'theme/set', theme: THEMES[(i + 1) % THEMES.length] });
  }

  function clockApi() { return (SRO.core && SRO.core.clock) || null; }
  function speeds() { const C = clockApi(); return C && C.SPEEDS ? C.SPEEDS : [1, 60, 600]; }
  function toggleRun() {
    const st = getState();
    if (!st) return;
    dispatch({ type: st.clock.running ? 'clock/pause' : 'clock/start' });
  }
  function setSpeed(s) { dispatch({ type: 'clock/speed', speed: s }); }
  function nextBoundary(simMin) {
    const C = clockApi();
    return C && C.nextBoundary ? C.nextBoundary(simMin) : (Math.floor(simMin / 360) + 1) * 360;
  }
  function jumpToNextWindow() {
    const st = getState();
    if (!st) return;
    dispatch({ type: 'clock/tick', simMin: nextBoundary(st.clock.simMin) });
  }

  // ==== formatting (format.js is the only formatter; tiny fallbacks keep the shell alive) ========
  function fmt() { return (SRO.core && SRO.core.format) || null; }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function time24(m) {
    const F = fmt();
    if (F && F.time24) return F.time24(m);
    const x = ((Math.floor(m) % 1440) + 1440) % 1440;
    return pad2(Math.floor(x / 60)) + pad2(x % 60);
  }
  function dayOf(m) { const F = fmt(); return F && F.dayOf ? F.dayOf(m) : Math.floor(Math.floor(m) / 1440) + 1; }
  function dtg(m) { const F = fmt(); return F && F.dtg ? F.dtg(m) : 'Day ' + dayOf(m) + ' ' + time24(m); }
  function windowLabel(start, end) {
    const F = fmt();
    return F && F.windowLabel ? F.windowLabel(start, end) : 'Day ' + dayOf(start) + ', ' + time24(start) + '-' + time24(end);
  }
  function duration(min) {
    const F = fmt();
    if (F && F.duration) return F.duration(min);
    const hh = Math.floor(min / 60), mm = Math.round(min % 60);
    return (hh ? hh + ' h ' : '') + mm + ' min';
  }

  // ==== top bar ==================================================================================
  function buildTopbar() {
    const tb = shell.dom.topbar;
    if (!tb) return;
    clear(tb);
    const r = shell.tb = {};
    const brand = h('div.tb-brand', { title: 'Supply Route Optimizer (prototype; all data notional)' },
      h('span.tb-mark', { 'aria-hidden': 'true' }, icon('truck')),
      h('span.tb-name', 'Supply Route Optimizer'),
      h('span.tb-tag', 'Notional'));
    r.roleBtns = {};
    const role = h('div.seg.tb-role', { role: 'group', 'aria-label': 'Role' }, ROLES.map(function (ro) {
      return (r.roleBtns[ro.id] = h('button', {
        type: 'button', 'data-role': ro.id, 'aria-pressed': 'false', title: ro.label,
        onClick: function () { setRole(ro.id); }
      }, h('span.role-long', ro.label), h('span.role-short', { 'aria-hidden': 'true' }, ro.short)));
    }));
    r.day = h('span.tb-day');
    r.hhmm = h('span.tb-hhmm');
    r.time = h('button.tb-time', { type: 'button', onClick: openClockSheet }, h('span.tb-run-dot', { 'aria-hidden': 'true' }), r.day, r.hhmm);
    r.play = h('button.btn.btn-icon.tb-play', { type: 'button', onClick: toggleRun });
    r.speedBtns = {};
    r.speed = h('div.seg.tb-speed', { role: 'group', 'aria-label': 'Demo clock speed' }, speeds().map(function (s) {
      return (r.speedBtns[s] = h('button', {
        type: 'button', 'data-speed': String(s), 'aria-pressed': 'false',
        title: s + 'x (' + (SPEED_HELP[s] || s + ' simulated minutes per real minute') + ')',
        onClick: function () { setSpeed(s); }
      }, s + 'x'));
    }));
    r.clock = h('div.tb-clock', { role: 'group', 'aria-label': 'Demo clock' }, r.time, r.play, r.speed);
    r.themeIcon = h('span.tb-theme-icon', { style: 'display:inline-flex' });
    r.themeLabel = h('span.tb-theme-label');
    r.theme = h('button.btn.btn-ghost.tb-theme', { type: 'button', onClick: cycleTheme }, r.themeIcon, r.themeLabel);
    tb.appendChild(brand);
    tb.appendChild(h('div.tb-spacer'));
    tb.appendChild(role);
    tb.appendChild(r.clock);
    tb.appendChild(r.theme);
    r.last = {};
  }

  function setOnce(key, value, fn) {
    const last = shell.tb.last;
    if (last[key] === value) return;
    last[key] = value;
    fn(value);
  }

  function renderTopbar(st) {
    if (!shell.tb) return;
    const r = shell.tb;
    const role = st.ui.role === 'planner' ? 'planner' : 'psg';
    setOnce('role', role, function () {
      Object.keys(r.roleBtns).forEach(function (k) { r.roleBtns[k].setAttribute('aria-pressed', String(k === role)); });
    });
    const sim = st.clock.simMin;
    const running = !!st.clock.running;
    const day = 'Day ' + dayOf(sim), hhmm = time24(sim);
    setOnce('day', day, function (v) { r.day.textContent = v; });
    setOnce('hhmm', hhmm, function (v) { r.hhmm.textContent = v; });
    setOnce('timeLabel', day + hhmm + running, function () {
      r.time.setAttribute('aria-label', 'Demo clock ' + day + ', ' + hhmm + (running ? ', running' : ', paused') + '. Open clock controls');
      r.time.title = dtg(sim) + (running ? ' (running)' : ' (paused)');
    });
    setOnce('running', running, function () {
      r.time.classList.toggle('is-running', running);
      r.play.classList.toggle('is-running', running);
      r.play.setAttribute('aria-pressed', String(running));
      r.play.setAttribute('aria-label', running ? 'Pause demo clock' : 'Start demo clock');
      r.play.title = running ? 'Pause demo clock' : 'Start demo clock';
      clear(r.play).appendChild(icon(running ? 'pause' : 'play'));
    });
    setOnce('speed', st.clock.speed, function (v) {
      Object.keys(r.speedBtns).forEach(function (k) { r.speedBtns[k].setAttribute('aria-pressed', String(+k === +v)); });
    });
    const theme = THEMES.indexOf(st.ui.theme) >= 0 ? st.ui.theme : 'dark';
    setOnce('theme', theme, function (t) {
      const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
      clear(r.themeIcon).appendChild(icon(THEME_META[t].icon));
      r.themeLabel.textContent = THEME_META[t].label;
      r.theme.setAttribute('aria-label', 'Theme: ' + THEME_META[t].label + '. Switch to ' + THEME_META[next].label);
      r.theme.title = 'Theme: ' + THEME_META[t].label + ' (switch to ' + THEME_META[next].label + ')';
      r.theme.setAttribute('data-theme-current', t);
    });
  }

  function periodName(st) {
    const C = clockApi();
    if (!C || !C.periodAt) return '';
    const settings = st.scenario && st.scenario.settings;
    const p = C.periodAt(st.clock.simMin, settings && settings.periods);
    return p && p.name ? p.name : '';
  }

  function openClockSheet() {
    const st0 = getState();
    if (!st0) return;
    const r = {};
    const handle = ui.modal.open({
      title: 'Demo clock',
      size: 'sm',
      body: function (el) {
        r.day = h('div.clock-day');
        r.big = h('div.clock-big');
        r.dtg = h('div.muted.num.small');
        r.window = h('dd.num');
        r.period = h('dd');
        r.next = h('dd.num');
        r.run = h('button.btn.btn-primary.btn-block.clock-run', { type: 'button', onClick: toggleRun });
        r.speedBtns = {};
        r.speed = h('div.seg.seg-block.clock-speed', { role: 'group', 'aria-label': 'Clock speed' }, speeds().map(function (s) {
          return (r.speedBtns[s] = h('button', { type: 'button', 'data-speed': String(s), 'aria-pressed': 'false', onClick: function () { setSpeed(s); } }, s + 'x'));
        }));
        r.speedHelp = h('div.field-help');
        r.jump = h('button.btn.btn-secondary.btn-block.clock-jump', { type: 'button', onClick: jumpToNextWindow });
        el.appendChild(h('div.vstack',
          h('div.clock-face', r.day, r.big, r.dtg),
          h('dl.kv', h('dt', 'Window'), r.window, h('dt', 'Period'), r.period, h('dt', 'Next plan'), r.next),
          r.run,
          h('div.field', h('div.field-label', 'Speed'), r.speed, r.speedHelp),
          r.jump,
          h('p.field-help', 'Simulated time for the demo. It drives the planning windows (0000, 0600, 1200, 1800) and moves trucks along their planned routes.')));
      },
      onClose: function () { removeLiveHook(update); }
    });
    // runs on every render while the sheet is open (4 times a second with the clock running), so it
    // only touches the DOM when a value changed
    const last = {};
    function put(key, value, fn) { if (last[key] !== value) { last[key] = value; fn(value); } }
    function text(el) { return function (v) { el.textContent = v; }; }
    function update(st) {
      if (handle.closed) return;
      const sim = st.clock.simMin, running = !!st.clock.running, speed = st.clock.speed;
      const C = clockApi();
      const w = C && C.windowOf ? C.windowOf(sim) : { start: Math.floor(sim / 360) * 360, end: Math.floor(sim / 360) * 360 + 360 };
      const nb = nextBoundary(sim);
      put('day', 'Day ' + dayOf(sim), text(r.day));
      put('big', time24(sim), text(r.big));
      put('dtg', dtg(sim), text(r.dtg));
      put('window', windowLabel(w.start, w.end), text(r.window));
      put('period', periodName(st) || 'n/a', text(r.period));
      put('next', time24(nb) + ' (in ' + duration(nb - Math.floor(sim)) + ')', text(r.next));
      put('running', running, function () {
        r.big.classList.toggle('is-running', running);
        clear(r.run).appendChild(icon(running ? 'pause' : 'play'));
        r.run.appendChild(doc.createTextNode(running ? 'Pause clock' : 'Start clock'));
        r.run.setAttribute('aria-pressed', String(running));
      });
      put('speed', speed, function () {
        Object.keys(r.speedBtns).forEach(function (k) { r.speedBtns[k].setAttribute('aria-pressed', String(+k === +speed)); });
        r.speedHelp.textContent = speed + 'x: ' + (SPEED_HELP[speed] || speed + ' simulated minutes per real minute') + '.';
      });
      // the time is already in "Next plan"; a short label fits one line on 320px phones
      put('jump', time24(nb), function (v) {
        clear(r.jump).appendChild(icon('skip'));
        r.jump.appendChild(doc.createTextNode('Jump to next window'));
        r.jump.title = 'Jump the demo clock to the next planning window (' + v + ')';
      });
    }
    addLiveHook(update);
    update(st0);
    return handle;
  }

  function addLiveHook(fn) { shell.liveHooks.push(fn); }
  function removeLiveHook(fn) { const i = shell.liveHooks.indexOf(fn); if (i >= 0) shell.liveHooks.splice(i, 1); }

  // ==== theme and role on <html> =================================================================
  function applyTheme(st) {
    const t = THEMES.indexOf(st.ui.theme) >= 0 ? st.ui.theme : 'dark';
    const html = doc.documentElement;
    // the head script in index.html may already have set data-theme from storage before the first
    // paint; theme-color still has to follow (it starts as the dark color in the template)
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta && meta.getAttribute('content') !== THEME_META[t].color) meta.setAttribute('content', THEME_META[t].color);
    if (html.getAttribute('data-theme') === t) return;
    html.setAttribute('data-theme', t);
    emit('theme', t);
  }

  function applyRole(st) {
    const role = st.ui.role === 'planner' ? 'planner' : 'psg';
    const html = doc.documentElement;
    if (html.getAttribute('data-role') !== role) { html.setAttribute('data-role', role); emit('role', role); }
    if (shell.dom.app) shell.dom.app.setAttribute('data-role', role);
    if (shell.dom.psg) shell.dom.psg.hidden = role !== 'psg';
    if (shell.dom.planner) shell.dom.planner.hidden = role !== 'planner';
    return role;
  }

  // ==== layouts ==================================================================================
  function placeholderCard(title, text, iconName) {
    return h('div.empty.placeholder', { 'data-placeholder': 'true' },
      h('div.empty-icon', icon(iconName || 'layers')),
      h('p.empty-title', title),
      text ? h('p.empty-text', text) : null);
  }

  function tabButtonContent(e, withBadge) {
    return [icon(e.icon), h('span.tab-label', e.label), withBadge ? h('span.tab-badge', { hidden: true }) : null];
  }

  function buildTabbar(role, list) {
    const visible = list.filter(function (e) { return !e.hidden; });
    if (visible.length < 2) return null;
    const bar = h('nav.tabbar.' + role + '-tabbar', { role: 'tablist', 'aria-label': role === 'planner' ? 'Planner sections' : 'Platoon sergeant sections' });
    visible.forEach(function (e) {
      bar.appendChild(h('button.tabbar-item', {
        type: 'button', role: 'tab', 'data-tab': e.name, 'aria-selected': 'false',
        onClick: function () { selectTab(role, e.name); }
      }, tabButtonContent(e, true)));
    });
    return bar;
  }

  function ensureRootView(role, rootEl) {
    const e = shell.roots[role];
    clear(rootEl);
    e.el = e.el || h('div.' + role + '-root-view', { 'data-view': role });
    rootEl.appendChild(e.el);
  }

  function ensurePsgLayout() {
    if (!shell.dirty.psg || !shell.dom.psg) return;
    shell.dirty.psg = false;
    const rootEl = shell.dom.psg;
    if (shell.roots.psg) { ensureRootView('psg', rootEl); return; }
    clear(rootEl);
    const list = tabs.psg.entries(false);
    const body = h('div.psg-body');
    if (!list.length) {
      body.appendChild(placeholderCard('Platoon sergeant views load here',
        'New request, My requests and the unit profile appear in this phone-width column once their modules load.', 'user'));
      rootEl.appendChild(h('div.psg', body));
      return;
    }
    list.forEach(function (e) {
      e.el = e.el || h('section.psg-view', { 'data-tab': e.name, role: 'tabpanel', 'aria-label': e.label });
      body.appendChild(e.el);
    });
    const bar = buildTabbar('psg', list);
    rootEl.appendChild(h('div.psg', body, bar));
  }

  function ensurePlannerLayout() {
    if (!shell.dirty.planner || !shell.dom.planner) return;
    shell.dirty.planner = false;
    const rootEl = shell.dom.planner;
    if (shell.roots.planner) { ensureRootView('planner', rootEl); return; }
    clear(rootEl);
    const list = tabs.planner.entries(true);
    const body = h('div.planner-body');
    REGIONS.forEach(function (r) {
      const inRegion = list.filter(function (e) { return e.region === r; });
      body.setAttribute('data-' + r, inRegion.length ? String(inRegion.length) : 'none');
      const shown = inRegion.filter(function (e) { return !e.hidden; });
      // the center (map) gets a header only when a second center tab is registered
      if (r === 'center') body.setAttribute('data-center-tabs', shown.length > 1 ? 'true' : 'false');
      if (!inRegion.length || (r === 'center' && shown.length < 2)) return;
      const head = h('div.pl-head', { 'data-region': r });
      if (shown.length > 1) {
        head.appendChild(h('div.seg.pl-seg', { role: 'tablist', 'aria-label': (r === 'left' ? 'Left' : r === 'right' ? 'Right' : 'Center') + ' panel' }, shown.map(function (e) {
          return h('button', { type: 'button', role: 'tab', 'data-tab': e.name, 'aria-selected': 'false', onClick: function () { selectTab('planner', e.name); } },
            icon(e.icon), h('span.tab-label', e.label), h('span.tab-badge', { hidden: true }));
        })));
      } else if (shown.length === 1) {
        head.appendChild(h('div.hstack.grow', h('span.caps', shown[0].label), h('span.tab-badge', { hidden: true, 'data-tab-badge': shown[0].name })));
      }
      body.appendChild(head);
    });
    list.forEach(function (e) {
      if (!e.el) {
        e.el = h('section.pl-view', { 'data-tab': e.name, 'data-region': e.region, role: 'tabpanel', 'aria-label': e.label });
        if (!e.registered) {
          e.el.appendChild(placeholderCard('Planner views load here',
            (e.region === 'center' && e.name === 'map' ? 'The map' : 'The ' + e.label + ' panel') + ' appears here once its module loads.', e.icon));
        }
      }
      body.appendChild(e.el);
    });
    rootEl.appendChild(h('div.planner', body, buildTabbar('planner', list)));
  }

  // ==== active tabs ==============================================================================
  function firstShown(list) {
    for (let i = 0; i < list.length; i++) if (!list[i].hidden) return list[i];
    return list[0] || null;
  }

  function activeTabName(role, st) {
    if (!st) return null;
    if (role === 'psg') {
      const list = tabs.psg.entries(false);
      const want = st.ui.psgTab;
      const e = list.filter(function (x) { return x.name === want; })[0] || firstShown(list);
      return e ? e.name : null;
    }
    const list = tabs.planner.entries(true);
    const byName = {};
    list.forEach(function (e) { byName[e.name] = e; });
    if (shell.plannerOverride && byName[shell.plannerOverride]) return shell.plannerOverride;
    if (byName[st.ui.plannerTab]) return st.ui.plannerTab;
    const f = firstShown(list);
    return f ? f.name : null;
  }

  function setAttr(el, name, on) {
    if (!el) return;
    if (on) { if (!el.hasAttribute(name)) el.setAttribute(name, ''); } else if (el.hasAttribute(name)) el.removeAttribute(name);
  }

  function markSelected(container, selector, name) {
    if (!container) return;
    const items = container.querySelectorAll(selector);
    for (let i = 0; i < items.length; i++) {
      const sel = items[i].getAttribute('data-tab') === name;
      if (items[i].getAttribute('aria-selected') !== String(sel)) items[i].setAttribute('aria-selected', String(sel));
    }
  }

  function visiblePsg(st) {
    if (shell.roots.psg) return [shell.roots.psg];
    const list = tabs.psg.entries(false);
    const active = activeTabName('psg', st);
    let entry = null;
    list.forEach(function (e) { setAttr(e.el, 'data-active', e.name === active); if (e.name === active) entry = e; });
    const shownName = entry && entry.hidden && entry.parent ? entry.parent : active;
    markSelected(shell.dom.psg, '.tabbar-item', shownName);
    return entry ? [entry] : [];
  }

  function visiblePlanner(st) {
    if (shell.roots.planner) return [shell.roots.planner];
    const list = tabs.planner.entries(true);
    const byName = {};
    list.forEach(function (e) { byName[e.name] = e; });
    const activeName = activeTabName('planner', st);
    const active = byName[activeName];
    if (!active) return [];
    shell.regionActive[active.region] = active.name;
    REGIONS.forEach(function (r) {
      const inRegion = list.filter(function (e) { return e.region === r; });
      const cur = byName[shell.regionActive[r]];
      if (!cur || cur.region !== r) { const f = firstShown(inRegion); shell.regionActive[r] = f ? f.name : null; }
    });
    const wide = isWide();
    list.forEach(function (e) {
      setAttr(e.el, 'data-active', e === active);
      setAttr(e.el, 'data-region-active', shell.regionActive[e.region] === e.name);
    });
    const shownName = active.hidden && active.parent ? active.parent : active.name;
    const rootEl = shell.dom.planner;
    markSelected(rootEl, '.tabbar-item', shownName);
    REGIONS.forEach(function (r) {
      const ra = byName[shell.regionActive[r]];
      const sel = ra ? (ra.hidden && ra.parent ? ra.parent : ra.name) : null;
      markSelected(rootEl && rootEl.querySelector('.pl-head[data-region="' + r + '"]'), '[role="tab"]', sel);
    });
    if (!wide) return [active];
    return REGIONS.map(function (r) { return byName[shell.regionActive[r]]; }).filter(Boolean);
  }

  function renderBadges(role, st) {
    const rootEl = role === 'planner' ? shell.dom.planner : shell.dom.psg;
    if (!rootEl || shell.roots[role]) return;
    tabs[role].entries(false).forEach(function (e) {
      if (!e.badge) return;
      let v = null;
      try { v = e.badge.call(e.view, st); } catch (err) { logOnce(e, 'badge', err); }
      const text = v === null || v === undefined || v === false || v === 0 || v === '' ? '' : String(typeof v === 'object' && v.text !== undefined ? v.text : v);
      const alert = !!(v && typeof v === 'object' && v.alert);
      const n = e.name.replace(/["\\]/g, '\\$&');
      const els = rootEl.querySelectorAll('.tabbar-item[data-tab="' + n + '"] .tab-badge, .pl-head [data-tab="' + n + '"] .tab-badge, .tab-badge[data-tab-badge="' + n + '"]');
      for (let i = 0; i < els.length; i++) {
        if (els[i].textContent !== text) els[i].textContent = text;
        els[i].hidden = !text;
        els[i].classList.toggle('is-alert', alert);
      }
    });
  }

  // ==== view lifecycle ===========================================================================
  function getPath(o, path) {
    const parts = Array.isArray(path) ? path : String(path).split('.');
    for (let i = 0; i < parts.length; i++) { if (o === null || o === undefined) return undefined; o = o[parts[i]]; }
    return o;
  }

  function onlyClockChanged(prev, cur) {
    if (!prev || prev === cur) return false;
    const keys = Object.keys(cur);
    for (let i = 0; i < keys.length; i++) if (keys[i] !== 'clock' && prev[keys[i]] !== cur[keys[i]]) return false;
    return Object.keys(prev).length === keys.length && prev.clock !== cur.clock;
  }

  function makeCtx(e) {
    const ctx = {
      name: e.name, role: e.role, el: e.el, region: e.region,
      store: shell.store, dispatch: dispatch, getState: getState,
      state: null, prev: null, clockOnly: false, visible: false,
      layout: layout(), wide: false, phone: false,
      ui: ui, h: h, icon: icon, icons: icons, toast: ui.toast, modal: ui.modal,
      changed: function (path) {
        if (!ctx.prev) return true;
        if (path === undefined || path === null) return ctx.prev !== ctx.state;
        return getPath(ctx.prev, path) !== getPath(ctx.state, path);
      },
      show: function (tab) { selectTab(e.role, tab); },
      showTab: function (tab) { selectTab(e.role, tab); }
    };
    return ctx;
  }

  function fillCtx(e, st) {
    const c = e.ctx;
    c.el = e.el;
    c.prev = e.prevState;
    c.state = st;
    c.clockOnly = onlyClockChanged(e.prevState, st);
    c.visible = e.visible;
    c.layout = layout();
    c.wide = c.layout === 'wide';
    c.phone = c.layout === 'phone';
  }

  function logOnce(e, phase, err) {
    const key = phase + ':' + (err && err.message);
    if (e.logged[key]) return;
    e.logged[key] = true;
    logError('view "' + e.role + (e.region === 'root' ? '' : '/' + e.name) + '" ' + phase + ' failed', err);
  }

  function showViewError(e, err) {
    if (!e.el) return;
    clear(e.el);
    e.el.appendChild(h('div.notice.notice-error.view-error', { role: 'alert' }, icon('alert'),
      h('div', h('strong', 'The ' + e.label + ' view could not load. '), h('span.muted', String((err && err.message) || err)))));
  }

  function callHook(e, hook) {
    const fn = e.view && e.view[hook];
    if (typeof fn !== 'function' || !e.mounted) return;
    try { fn.call(e.view, e.el, e.ctx); } catch (err) { logOnce(e, hook, err); }
  }

  function mountEntry(e, st) {
    e.ctx = e.ctx || makeCtx(e);
    e.visible = true;
    fillCtx(e, st);
    clear(e.el);
    const fn = e.view && e.view.mount;
    try {
      if (typeof fn === 'function') fn.call(e.view, e.el, e.ctx);
      e.mounted = true;
      e.failed = false;
    } catch (err) {
      e.failed = true;
      logOnce(e, 'mount', err);
      showViewError(e, err);
    }
  }

  function updateEntry(e, st, force) {
    if (!e.mounted || e.failed) return;
    const lay = layout();
    if (!force && st === e.prevState && lay === e.prevLayout) return;
    const fn = e.view && (e.view.update || e.view.render);
    fillCtx(e, st);
    if (typeof fn === 'function') {
      try { fn.call(e.view, st, e.ctx); } catch (err) { logOnce(e, 'update', err); }
    }
    e.prevState = st;
    e.prevLayout = lay;
  }

  function disposeEntry(e) {
    if (e.mounted && e.view && typeof e.view.unmount === 'function') {
      try { e.view.unmount.call(e.view, e.el, e.ctx); } catch (err) { logOnce(e, 'unmount', err); }
    }
    e.mounted = false;
    e.visible = false;
  }

  function allEntries() {
    const out = tabs.psg.entries(false).concat(tabs.planner.entries(false));
    if (shell.roots.psg) out.push(shell.roots.psg);
    if (shell.roots.planner) out.push(shell.roots.planner);
    return out;
  }

  // ==== render loop ==============================================================================
  function render() {
    shell.renderQueued = false;
    const st = getState();
    if (!st || !shell.mounted) return;
    applyTheme(st);
    const role = applyRole(st);
    renderTopbar(st);
    ensurePsgLayout();
    ensurePlannerLayout();
    const vis = role === 'planner' ? visiblePlanner(st) : visiblePsg(st);
    const lay = layout();
    const layoutChanged = lay !== shell.layoutKey;
    shell.layoutKey = lay;
    let shown = false;
    allEntries().forEach(function (e) {
      if (e.visible && vis.indexOf(e) < 0) { e.visible = false; callHook(e, 'onHide'); }
    });
    vis.forEach(function (e) {
      if (!e.registered || !e.el) return;
      if (!e.mounted && !e.failed) {
        mountEntry(e, st);
        shown = true;
        updateEntry(e, st, true);
        return;
      }
      const became = !e.visible;
      e.visible = true;
      if (became) { shown = true; callHook(e, 'onShow'); }
      updateEntry(e, st, became || layoutChanged);
    });
    renderBadges(role, st);
    shell.liveHooks.slice().forEach(function (fn) { try { fn(st); } catch (err) { logError('live hook', err); } });
    if (shown || layoutChanged) notifyResize();
  }

  let resizeQueued = false;
  function notifyResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    const run = function () {
      resizeQueued = false;
      emit('layout', layout());
      try { root.dispatchEvent(new root.Event('resize')); } catch (e) { /* old browsers */ }
    };
    if (root.requestAnimationFrame) root.requestAnimationFrame(run); else setTimeout(run, 16);
  }

  function scheduleRender() {
    if (!shell.mounted || shell.renderQueued) return;
    shell.renderQueued = true;
    const hidden = doc.visibilityState === 'hidden';
    if (root.requestAnimationFrame && !hidden) root.requestAnimationFrame(render);
    else setTimeout(render, 16);
  }

  function renderNow() { if (shell.mounted) render(); }

  function onStoreChange(state, action, result) {
    // a planner tab chosen through the store (tab/set) replaces a hidden tab shown by plannerTabs.show
    const pt = state && state.ui ? state.ui.plannerTab : null;
    if (pt !== shell.lastPlannerTab) { shell.lastPlannerTab = pt; shell.plannerOverride = null; }
    if (action && action.type === 'clock/tick' && result && result.crossed && result.crossed.length) {
      const b = result.crossed[result.crossed.length - 1];
      ui.toast('Planning window ' + windowLabel(b, b + 360) + ' started.', 'info');
    }
    scheduleRender();
  }

  // ==== toasts ===================================================================================
  const TOAST_ICONS = { info: 'info', success: 'check', warn: 'alert', error: 'alert' };
  const TOAST_ALIASES = { warning: 'warn', danger: 'error', ok: 'success' };
  ui.toast = function (msg, kind, opts) {
    if (kind && typeof kind === 'object') { opts = kind; kind = opts.kind; }
    kind = TOAST_ALIASES[kind] || kind;
    kind = TOAST_ICONS[kind] ? kind : 'info';
    const o = opts || {};
    const rootEl = shell.dom.toast || doc.getElementById('toast-root');
    if (!rootEl) return { el: null, close: function () {} };
    let timer = null;
    // #toast-root is a polite live region; errors also interrupt (role=alert)
    const el = h('div.toast.toast-' + kind, { role: kind === 'error' ? 'alert' : null },
      icon(TOAST_ICONS[kind]),
      h('div.toast-msg', isNode(msg) ? msg : String(msg === undefined ? '' : msg)));
    function close() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    if (o.action && o.action.label) {
      el.appendChild(h('button.btn.btn-sm.btn-ghost.toast-action', {
        type: 'button',
        onClick: function () { try { if (o.action.onClick) o.action.onClick(); } finally { close(); } }
      }, o.action.label));
    }
    el.appendChild(h('button.btn.btn-sm.btn-icon.btn-ghost.toast-close', { type: 'button', 'aria-label': 'Dismiss', onClick: close }, icon('x')));
    rootEl.appendChild(el);
    while (rootEl.children.length > 4) rootEl.removeChild(rootEl.firstChild);
    const ms = o.timeout !== undefined ? o.timeout : kind === 'error' ? 7000 : 4000;
    if (ms > 0) timer = setTimeout(close, ms);
    return { el: el, close: close };
  };

  // ==== modal / bottom sheet ====================================================================
  const modalStack = [];
  let modalSeq = 0;
  const FOCUSABLE = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

  function focusables(el) {
    return Array.prototype.filter.call(el.querySelectorAll(FOCUSABLE), function (x) {
      return x.getClientRects().length > 0 && !x.closest('[hidden]');
    });
  }

  function updateInert() {
    const open = modalStack.length > 0;
    [shell.dom.topbar || doc.getElementById('topbar'), shell.dom.app || doc.getElementById('app')].forEach(function (el) {
      if (!el) return;
      if (open) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
      else { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
    });
    modalStack.forEach(function (m, i) {
      if (i < modalStack.length - 1) m.backdrop.setAttribute('inert', ''); else m.backdrop.removeAttribute('inert');
    });
  }

  function actionButton(a, handle) {
    const kind = a.kind || a.variant || (a.primary ? 'primary' : 'secondary');
    const btn = h('button.btn.btn-' + kind, { type: 'button', disabled: !!a.disabled, 'data-action': a.id || null },
      a.icon ? icon(a.icon) : null, a.label || 'OK');
    btn.addEventListener('click', function () {
      let r;
      try { r = typeof a.onClick === 'function' ? a.onClick(handle, btn) : undefined; } catch (err) {
        logError('modal action "' + (a.label || '') + '"', err);
        ui.toast(String((err && err.message) || err), 'error');
        return;
      }
      const value = a.value !== undefined ? a.value : a.id !== undefined ? a.id : a.label;
      if (r === false) return;
      if (r && typeof r.then === 'function') {
        btn.disabled = true;
        btn.classList.add('is-busy');
        r.then(function (v) {
          btn.disabled = false;
          btn.classList.remove('is-busy');
          if (v !== false && a.close !== false) handle.close(value);
        }, function (err) {
          btn.disabled = false;
          btn.classList.remove('is-busy');
          ui.toast(String((err && err.message) || err), 'error');
        });
        return;
      }
      if (a.close !== false) handle.close(value);
    });
    return btn;
  }

  ui.modal = {
    open: function (opts) {
      const o = opts || {};
      const dismissible = o.dismissible !== false;
      const id = 'sro-modal-title-' + (++modalSeq);
      const prevFocus = doc.activeElement;
      let resolveResult;
      const handle = { closed: false, result: new Promise(function (res) { resolveResult = res; }) };
      const titleEl = h('h2.modal-title', { id: id }, o.title || '');
      const header = h('div.modal-header', titleEl,
        dismissible ? h('button.btn.btn-icon.btn-ghost.modal-close', { type: 'button', 'aria-label': 'Close', onClick: function () { handle.close(); } }, icon('x')) : null);
      const body = h('div.modal-body');
      const size = o.size && o.size !== 'md' ? '.modal-' + o.size : '';
      const dialog = h('div.modal' + size, { role: o.role || 'dialog', 'aria-modal': 'true', 'aria-labelledby': id, tabindex: '-1' },
        h('div.modal-handle', { 'aria-hidden': 'true' }), header, body);
      const backdrop = h('div.modal-backdrop');
      backdrop.appendChild(dialog);
      handle.el = dialog;
      handle.body = body;
      handle.backdrop = backdrop;
      handle.dismissible = dismissible;
      handle.setTitle = function (t) { titleEl.textContent = t; };
      handle.close = function (result) {
        if (handle.closed) return;
        handle.closed = true;
        const i = modalStack.indexOf(handle);
        if (i >= 0) modalStack.splice(i, 1);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        updateInert();
        if (typeof o.onClose === 'function') { try { o.onClose(result); } catch (err) { logError('modal onClose', err); } }
        resolveResult(result);
        const top = modalStack[modalStack.length - 1];
        const target = top ? top.el : prevFocus;
        if (target && doc.contains(target) && typeof target.focus === 'function') {
          try { target.focus({ preventScroll: true }); } catch (err) { target.focus(); }
        }
      };
      // content
      try {
        if (typeof o.body === 'function') o.body(body, handle);
        else if (isNode(o.body)) body.appendChild(o.body);
        else if (o.body !== undefined && o.body !== null) body.appendChild(h('p.modal-text', String(o.body)));
      } catch (err) {
        logError('modal body', err);
        body.appendChild(h('div.notice.notice-error', icon('alert'), String((err && err.message) || err)));
      }
      const actions = (o.actions || []).filter(Boolean);
      if (actions.length) {
        const bar = h('div.modal-actions');
        actions.forEach(function (a) { bar.appendChild(actionButton(a, handle)); });
        dialog.appendChild(bar);
        handle.actions = bar;
      }
      backdrop.addEventListener('mousedown', function (ev) { backdrop._downOnSelf = ev.target === backdrop; });
      backdrop.addEventListener('click', function (ev) {
        if (ev.target === backdrop && backdrop._downOnSelf !== false && dismissible) handle.close();
      });
      const host = shell.dom.modal || doc.getElementById('modal-root') || doc.body;
      host.appendChild(backdrop);
      modalStack.push(handle);
      updateInert();
      // initial focus: a given selector, else the first field (not on phones: no surprise keyboard),
      // else the primary action, else the dialog itself
      let first = o.initialFocus ? dialog.querySelector(o.initialFocus) : null;
      if (!first && !isPhone()) first = focusables(body)[0] || null;
      if (!first && handle.actions) first = handle.actions.querySelector('.btn-primary') || null;
      try { (first || dialog).focus({ preventScroll: true }); } catch (err) { (first || dialog).focus(); }
      return handle;
    },
    close: function (handle) {
      const target = handle || modalStack[modalStack.length - 1];
      if (target) target.close();
    },
    closeAll: function () { modalStack.slice().reverse().forEach(function (m) { m.close(); }); },
    isOpen: function () { return modalStack.length > 0; },
    top: function () { return modalStack[modalStack.length - 1] || null; }
  };

  function onKeydown(ev) {
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      if (top.dismissible) { ev.preventDefault(); ev.stopPropagation(); top.close(); }
      return;
    }
    if (ev.key !== 'Tab') return;
    const list = focusables(top.el);
    if (!list.length) { ev.preventDefault(); top.el.focus(); return; }
    const firstEl = list[0], lastEl = list[list.length - 1];
    const active = doc.activeElement;
    const inside = top.el.contains(active);
    if (ev.shiftKey && (active === firstEl || active === top.el || !inside)) { ev.preventDefault(); lastEl.focus(); }
    else if (!ev.shiftKey && (active === lastEl || !inside)) { ev.preventDefault(); firstEl.focus(); }
  }

  ui.confirm = function (opts) {
    const o = typeof opts === 'string' ? { text: opts } : opts || {};
    return new Promise(function (resolve) {
      let answer = false;
      ui.modal.open({
        title: o.title || 'Are you sure?',
        size: 'sm',
        body: o.body || o.text || '',
        actions: [
          { label: o.cancelLabel || 'Cancel', kind: 'secondary', onClick: function () { answer = false; } },
          { label: o.okLabel || 'OK', kind: o.danger ? 'danger' : 'primary', onClick: function () { answer = true; } }
        ],
        onClose: function () { resolve(answer); }
      });
    });
  };

  // ==== print / download / file pick =============================================================
  ui.print = function (content, opts) {
    const o = opts || {};
    const pr = shell.dom.print || doc.getElementById('print-root');
    if (!pr) return false;
    clear(pr);
    if (typeof content === 'function') content(pr);
    else if (isNode(content)) pr.appendChild(content);
    else if (content !== undefined && content !== null) pr.appendChild(h('div', String(content)));
    const oldTitle = doc.title;
    if (o.title) doc.title = o.title;
    let done = false;
    const cleanup = function () {
      if (done) return;
      done = true;
      root.removeEventListener('afterprint', cleanup);
      doc.title = oldTitle;
      if (!o.keep) clear(pr);
    };
    root.addEventListener('afterprint', cleanup);
    try { root.print(); } catch (err) { cleanup(); throw err; }
    setTimeout(cleanup, 60000);
    return true;
  };

  ui.download = function (filename, data, mime) {
    const blob = typeof Blob !== 'undefined' && data instanceof Blob ? data : new Blob([data], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename || 'download.txt', style: 'display:none' });
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    return true;
  };

  // resolves with the chosen File, or null when the picker is cancelled ('cancel' event, Chrome 113+,
  // Firefox 91+, Safari 16.4+; older browsers never settle on cancel)
  ui.pickFile = function (opts) {
    const o = opts || {};
    return new Promise(function (resolve) {
      const input = h('input', { type: 'file', accept: o.accept || '', style: 'display:none' });
      const done = function (f) {
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(f || null);
      };
      input.addEventListener('change', function () { done(input.files && input.files[0]); });
      input.addEventListener('cancel', function () { done(null); });
      doc.body.appendChild(input);
      input.click();
    });
  };

  // ==== mount ====================================================================================
  function mount(opts) {
    const o = opts || {};
    if (!o.store) throw new Error('SRO.ui.shell.mount({ store }) needs a store');
    shell.store = o.store;
    shell.lastPlannerTab = o.store.getState().ui.plannerTab;
    shell.dom = {
      topbar: o.topbar || doc.getElementById('topbar'),
      app: o.app || doc.getElementById('app'),
      psg: o.psgRoot || doc.getElementById('psg-root'),
      planner: o.plannerRoot || doc.getElementById('planner-root'),
      toast: o.toastRoot || doc.getElementById('toast-root'),
      modal: o.modalRoot || doc.getElementById('modal-root'),
      print: o.printRoot || doc.getElementById('print-root')
    };
    buildTopbar();
    shell.dirty.psg = shell.dirty.planner = true;
    if (shell.unsubscribe) shell.unsubscribe();
    shell.unsubscribe = shell.store.subscribe(onStoreChange);
    if (!shell.keydownBound) { doc.addEventListener('keydown', onKeydown, true); shell.keydownBound = true; }
    if (root.matchMedia && !shell.mqBound) {
      shell.mqBound = true;
      [WIDE_MQ, PHONE_MQ].forEach(function (q) {
        const m = root.matchMedia(q);
        const fn = function () { scheduleRender(); };
        if (m.addEventListener) m.addEventListener('change', fn); else if (m.addListener) m.addListener(fn);
      });
    }
    shell.mounted = true;
    render();
    return ui.shell;
  }

  // boot hooks: run by boot.js after the store exists (or at once when it already booted)
  ui.onBoot = function (fn) {
    if (typeof fn !== 'function') return;
    if (SRO.app && SRO.app.store) { try { fn(SRO.app); } catch (err) { logError('boot hook', err); } }
    else shell.bootHooks.push(fn);
  };
  ui._runBootHooks = function (app) {
    const list = shell.bootHooks.splice(0);
    list.forEach(function (fn) { try { fn(app); } catch (err) { logError('boot hook', err); } });
  };

  ui.h = h;
  ui.icon = icon;
  ui.icons = icons;
  ui.clear = clear;
  ui.esc = esc;
  ui.on = on;
  ui.off = off;
  ui.emit = emit;
  ui.layout = layout;
  ui.isWide = isWide;
  ui.isPhone = isPhone;
  ui.THEMES = THEMES;
  ui.shell = {
    mount: mount,
    render: scheduleRender,
    renderNow: renderNow,
    openClock: openClockSheet,
    selectTab: selectTab,
    setRole: setRole,
    cycleTheme: cycleTheme,
    get store() { return shell.store; },
    get mounted() { return shell.mounted; }
  };
})(typeof self !== 'undefined' ? self : globalThis);
