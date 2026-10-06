// Starts the app (last script in the 'main' group): creates the store, mounts the shell and every
// registered view, starts the demo clock ticker and exposes window.SRO.app = { store, ticker, ui }.
// Modules that need the store at start-up use SRO.ui.onBoot(function (app) { ... }) or listen for
// the window event 'sro:ready' (event.detail = app).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const ui = SRO.ui = SRO.ui || {};
  const doc = root.document;

  // Leaflet's default marker images are inlined by build.py as data URIs (SRO.lib.leafletImages).
  // imagePath must be '' or Leaflet 1.9.4 prefixes a guessed folder to every icon URL.
  function configureLeaflet() {
    const L = root.L;
    if (!L || !L.Icon || !L.Icon.Default) return false;
    L.Icon.Default.imagePath = '';
    const imgs = SRO.lib && SRO.lib.leafletImages;
    if (imgs && L.Icon.Default.mergeOptions) L.Icon.Default.mergeOptions(imgs);
    return true;
  }

  function fatal(message, err) {
    if (root.console) root.console.error('[SRO.boot] ' + message, err || '');
    const app = doc.getElementById('app');
    if (!app) return;
    while (app.firstChild) app.removeChild(app.firstChild);
    const box = doc.createElement('div');
    box.className = 'card';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'margin:24px auto;max-width:480px;align-self:flex-start';
    const t = doc.createElement('p');
    t.className = 'card-title';
    t.textContent = 'The app could not start';
    const p = doc.createElement('p');
    p.className = 'muted';
    p.style.marginTop = '6px';
    p.textContent = message + (err && err.message ? ' (' + err.message + ')' : '');
    box.appendChild(t);
    box.appendChild(p);
    app.appendChild(box);
  }

  function storageWorks() {
    try {
      const ls = root.localStorage;
      ls.setItem('sro.probe', '1');
      ls.removeItem('sro.probe');
      return true;
    } catch (e) { return false; }
  }

  function createStore() {
    const S = SRO.core && SRO.core.store;
    if (!S || typeof S.createStore !== 'function') throw new Error('the data store module (src/core/store.js) is missing');
    const sc = SRO.data && SRO.data.scenario;
    let initialState;
    if (sc && typeof sc.defaultState === 'function') {
      try { initialState = sc.defaultState(); } catch (e) {
        if (root.console) root.console.warn('[SRO.boot] scenario.defaultState() failed; using the store defaults', e);
      }
    }
    const adapter = typeof S.LocalStorageAdapter === 'function' ? S.LocalStorageAdapter() : undefined;
    return S.createStore({ adapter: adapter, initialState: initialState });
  }

  function boot() {
    if (SRO.app && SRO.app.store) return SRO.app;
    configureLeaflet();
    let store;
    try { store = createStore(); } catch (e) { fatal('Could not create the app state.', e); return null; }

    const app = { store: store, ticker: null, ui: ui, version: SRO.version, build: SRO.build || null };
    SRO.app = app;
    if (root.SRO !== SRO) root.SRO = SRO;

    // modules that want the store before the first render (e.g. the planner engine)
    if (typeof ui._runBootHooks === 'function') ui._runBootHooks(app);

    if (!ui.shell || typeof ui.shell.mount !== 'function') { fatal('The app shell (src/ui/shell.js) is missing.'); return app; }
    try {
      ui.shell.mount({
        store: store,
        topbar: doc.getElementById('topbar'),
        app: doc.getElementById('app'),
        psgRoot: doc.getElementById('psg-root'),
        plannerRoot: doc.getElementById('planner-root'),
        toastRoot: doc.getElementById('toast-root'),
        modalRoot: doc.getElementById('modal-root'),
        printRoot: doc.getElementById('print-root')
      });
    } catch (e) { fatal('The app shell failed to start.', e); return app; }

    // demo clock: dispatches clock/tick every 250 ms of wall time while state.clock.running
    const C = SRO.core && SRO.core.clock;
    if (C && typeof C.createTicker === 'function') {
      app.ticker = C.createTicker({ store: store, intervalMs: 250 }).start();
    }

    // clock-only ticks are saved at most every 2 s; save the rest when the page goes away
    const flush = function () { try { if (store.flush) store.flush(); } catch (e) { /* storage blocked */ } };
    root.addEventListener('pagehide', flush);
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'hidden') flush(); });

    if (!storageWorks()) {
      ui.toast('This browser blocks local storage, so changes last only until the page closes.', 'warn', { timeout: 8000 });
    } else if (store.adapter && typeof store.subscribe === 'function') {
      // storage can also fail later (quota full after many plans and snapshots): the store keeps
      // working in memory; say so once
      const stop = store.subscribe(function () {
        if (!store.adapter.usingMemory) return;
        stop();
        ui.toast('Browser storage is full or blocked, so recent changes last only until the page closes.', 'warn', { timeout: 10000 });
      });
    }
    try { root.dispatchEvent(new root.CustomEvent('sro:ready', { detail: app })); } catch (e) { /* old browsers */ }
    return app;
  }

  ui.boot = boot;
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof self !== 'undefined' ? self : globalThis);
