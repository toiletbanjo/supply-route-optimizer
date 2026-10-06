#!/usr/bin/env node
// Browser check of the planner Queue, Map, Plan and Route detail views (src/ui/planner/map.js,
// queue.js, plan.js, route.js) from the built single file opened over file:// in headless Chromium.
// Plain node script:
//
//   node tests/ui/planner-plan.spec.mjs [--stub] [--shots[=DIR]] [--only=desktop|phone] [--keep]
//
//   --stub    replace SRO.core.engine with a small in-page stub (deterministic, about 2 s per run).
//             The stub is also used automatically when the build has no planner engine.
//   --shots   save screenshots of every view in the dark, light and night themes at 1440x900,
//             820x1180 (the desktop page resized below the 1100 px breakpoint) and 390x844
//             (default DIR /tmp/claude-0/ui-shots/planner-plan).
//
// Per viewport (1440x900 with all three panels, 390x844 with the bottom tab bar), in a fresh page:
//   - empty queue shows "Load sample requests"; loading fills the queue in compareRequests order;
//     the columns, the tab count badge, the All / Pending / Delayed chips, the row expand, the
//     truck lock and force-direct overrides (request/lock), a map platoon click opening its request
//   - the map shows the legend and the OpenStreetMap note
//   - time limit field (settings), estimate text before running (heuristic "about", MIP "Up to" and
//     "proven gap"), Plan now with the default method and a 5 s cap, the running panel
//   - the summary strip is in spec order and every number equals plan.stats; delayed is red and opens
//     the list of delayed requests with plain-word reasons; truck cards and the timeline
//   - a click on a route line on the map opens Route detail (stops with MGRS and DTG, deliveries with
//     class labels, legs, cost split); the truck switcher, Back, and truck cards open it too
//   - rename, snapshot, approve (the confirm names the pickup point and ETA), compare mode (table with
//     every measure, Keep), compare to previous, Cancel (keeps the best plan, marked stopped early),
//     a contingency re-plan (before / after list)
//   - trucks of the approved plan appear and move on the demo clock (none drawn before departure)
//   - all three themes: no horizontal overflow, no white backgrounds in dark and night, no emoji,
//     numbers and DTG times not cut off
//   - a stop 12 minutes before its deadline is flagged as a near miss in Route detail
//   - zero console errors and page errors, except blocked map tile requests
// Exits 1 on any failure.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const a = args.find((x) => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
const FORCE_STUB = flag('--stub');
const SHOTS = flag('--shots') || opt('--shots') ? (opt('--shots') || '/tmp/claude-0/ui-shots/planner-plan') : null;
const ONLY = opt('--only');
const TILE_RE = /tile\.openstreetmap\.org/i;
const THEMES = ['dark', 'light', 'night'];
const RUN_TIMEOUT = 180000;
const DTG_RE = /\b\d{6}[A-Z] [A-Z]{3} \d{2}\b/;
const MGRS_RE = /\b\d{1,2}[C-X] [A-Z]{2} \d{5} \d{5}\b/;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const STAT_ORDER = ['requests', 'stops', 'trucks', 'miles', 'gallons', 'risk', 'delayed', 'runtime'];

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch (e) { /* fall through to the global install */ }
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return require(path.join(globalRoot, 'playwright'));
}

// ---- bookkeeping ----------------------------------------------------------------------------------
const failures = [], notes = [];
let passed = 0, scope = '';
function check(cond, msg, detail) {
  if (cond) { passed++; return true; }
  const d = detail === undefined ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  failures.push(scope + ': ' + msg + d);
  console.log('  FAIL ' + msg + d);
  return false;
}
function note(msg) { notes.push(scope + ': ' + msg); console.log('  note ' + msg); }
function section(name) { scope = name; console.log('\n== ' + name); }

// ---- in-page stub engine (DESIGN.md 8b contract) ---------------------------------------------------
// Direct deliveries, up to three requests per truck in queue order, the rest deferred (capacity or no
// truck). Straight leg paths encoded as polylines, progress every 150 ms with a falling best cost.
function installStubEngine() {
  const S = window.SRO, K = S.ui.plannerKit, geo = S.core.geo, H = S.data.catalogHelpers, store = S.app.store, F = S.core.format;
  const SCALE = { tabu: 1, sa: 1.05, aco: 1.09, mip: 0.97 };
  const label = (m) => (S.solver && S.solver.METHOD_LABELS && S.solver.METHOD_LABELS[m]) || m;
  const listeners = [];
  let status = { phase: 'idle', kind: null, method: null, methods: null, fraction: 0, bestCost: null, elapsedSec: 0, message: '', history: [], error: null, highsReady: true };
  let job = null;
  function set(p) {
    status = Object.assign({}, status, p);
    const snap = Object.assign({}, status, { history: status.history.slice() });
    listeners.slice().forEach((f) => { try { f(snap); } catch (e) { console.error(e); } });
  }
  function build(method, o) {
    const st = store.getState(), now = st.clock.simMin;
    const reqs = K.queueRequests(st).filter((r) => K.OPEN_STATUSES.indexOf(r.status) >= 0 && isFinite(r.lat) && isFinite(r.lon));
    const fleet = st.scenario.fleet.filter((t) => t.status !== 'out');
    const jobsOf = new Map(), routes = [], deferred = [];
    ['fuel', 'cargo'].forEach((g) => {
      const trucks = fleet.filter((t) => (g === 'fuel') === (t.type === 'tanker'));
      reqs.forEach((r) => {
        const L = H.requestLoads(r.lines)[g];
        if (!L) return;
        const n = Array.from(jobsOf.values()).filter((x) => x.g === g).reduce((a, x) => a + x.jobs.length, 0);
        const t = trucks[Math.floor(n / 3)];
        if (!t) {
          L.lineIdxs.forEach((li) => deferred.push({ requestId: r.id, lineIdx: li, qty: r.lines[li].qty, unit: r.lines[li].unit || '', classId: r.lines[li].classId,
            reason: trucks.length ? 'capacity' : 'no-truck', note: '' }));
          return;
        }
        if (!jobsOf.has(t.id)) jobsOf.set(t.id, { t, g, jobs: [] });
        jobsOf.get(t.id).jobs.push({ r, idx: L.lineIdxs });
      });
    });
    const scale = SCALE[method] || 1;
    let k = 0;
    jobsOf.forEach(({ t, jobs }) => {
      const hub = st.scenario.hubs.find((x) => x.id === t.hubId) || st.scenario.hubs[0];
      const depart = now + 60 + 10 * (k++);
      let at = depart, prev = { lat: hub.lat, lon: hub.lon, key: 'H:' + hub.id }, miles = 0;
      const stops = [], legs = [];
      const leg = (to, key) => {
        const mi = geo.haversineMi(prev, to) * 1.3 * scale, mins = mi / 25 * 60;
        legs.push({ fromKey: prev.key, toKey: key, depart: at, arrive: at + mins, miles: mi, riskUnits: 0, period: null,
          path: geo.encodePolyline([[prev.lat, prev.lon], [(prev.lat + to.lat) / 2 + 0.01, (prev.lon + to.lon) / 2], [to.lat, to.lon]], 5) });
        at += mins; miles += mi; prev = { lat: to.lat, lon: to.lon, key: key };
      };
      jobs.forEach(({ r, idx }, i) => {
        leg(r, 'D:' + r.id);
        stops.push({ seq: i + 1, nodeKey: 'D:' + r.id, kind: 'direct', gridId: null, lat: r.lat, lon: r.lon, label: r.unitName || r.id, arrive: at, depart: at + 20, period: null,
          deliveries: idx.map((li) => ({ requestId: r.id, lineIdx: li, qty: r.lines[li].qty, unit: r.lines[li].unit || '', classId: r.lines[li].classId })), pickups: [] });
        at += 20;
      });
      leg(hub, 'H:' + hub.id);
      const gallons = miles / 2;
      const cost = { fuel: gallons * 4, distance: miles, risk: 0, simplicity: stops.length * 12, platoon: 0, lateness: 0 };
      cost.total = cost.fuel + cost.distance + cost.risk + cost.simplicity;
      routes.push({ truckId: t.id, type: t.type, color: t.color, loadStart: depart - 30, depart, returnAt: at, stops, legs, miles, gallons, riskUnits: 0, cost });
    });
    const sum = (f) => routes.reduce((a, r) => a + f(r), 0);
    const cost = { fuel: sum((r) => r.cost.fuel), distance: sum((r) => r.cost.distance), risk: 0, simplicity: sum((r) => r.cost.simplicity), platoon: 0, lateness: 0 };
    cost.total = cost.fuel + cost.distance + cost.simplicity + deferred.length * 50;
    const delayed = {};
    deferred.forEach((d) => { delayed[d.requestId] = true; });
    return {
      method, methodLabel: label(method), name: (o.parentPlanId ? 'Re-plan, ' : 'Stub, ') + label(method) + (o.cancelled ? ' (stopped)' : '') + ', ' + F.dtg(now),
      windowId: K.currentWindow(st).id, createdAt: now, runtimeSec: o.runtimeSec, mipGap: method === 'mip' ? 0.042 : null, cancelled: !!o.cancelled,
      parentPlanId: o.parentPlanId || null, replanReason: o.reason || null, rallyPoints: [], routes, deferred, late: [], cost,
      stats: { requests: reqs.length, stops: sum((r) => r.stops.length), trucksUsed: routes.length, miles: sum((r) => r.miles), gallons: sum((r) => r.gallons),
        riskUnits: 0, late: 0, delayed: Object.keys(delayed).length, runtimeSec: o.runtimeSec }
    };
  }
  function store1(plan) {
    const res = store.dispatch({ type: 'plan/store', plan });
    if (!res.ok) throw new Error(res.error);
    return store.getState().plans.find((p) => p.id === res.id);
  }
  function solveOne(kind, method, capSec, o) {
    return new Promise((resolve, reject) => {
      // short caps finish in about 2 s; a long cap (the Cancel check uses 120 s) runs 20 s so there is
      // time to press Cancel (and take a screenshot first)
      const dur = (capSec >= 60 ? 20 : Math.min(capSec, 2)) * 1000, t0 = performance.now();
      const base = build(method, {}).cost.total;
      const j = { kind, method, resolve, reject, t0, timer: null, history: [], o };
      job = j;
      set({ phase: 'preparing', kind, method, fraction: 0, elapsedSec: 0, history: [], bestCost: null, message: 'Preparing' });
      j.timer = setInterval(() => {
        const el = performance.now() - t0, f = Math.min(1, el / dur);
        const best = base * (1.25 - 0.25 * f);
        j.history.push({ t: el / 1000, best });
        set({ phase: 'running', fraction: f, bestCost: best, elapsedSec: el / 1000, history: j.history.slice(), message: label(method) + ': searching' });
        if (f >= 1) {
          clearInterval(j.timer);
          job = null;
          try { resolve(store1(build(method, Object.assign({ runtimeSec: el / 1000 }, o)))); } catch (e) { reject(e); }
        }
      }, 150);
    });
  }
  const E = {
    stub: true,
    status: () => Object.assign({}, status, { history: status.history.slice() }),
    subscribe: (fn) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    methods: () => ['tabu', 'sa', 'aco', 'mip'].map((k) => ({ key: k, label: label(k), available: true, reason: null })),
    estimate: (m, p) => {
      const cap = (p && (p.timeCapSec || p.timeLimitSec)) || 5;
      return Promise.resolve({ seconds: Math.min(cap, 2), low: Math.min(cap, 1.8), high: Math.min(cap, 2.4), basis: 'Stub engine estimate.' });
    },
    run: (o) => {
      const m = (o && o.method) || store.getState().scenario.settings.method || 'tabu';
      const p = (o && o.params) || {};
      return solveOne('run', m, p.timeCapSec || p.timeLimitSec || 5, {}).then((plan) => {
        if (status.phase !== 'cancelled') set({ phase: 'done', fraction: 1, planId: plan.id, message: 'Plan ready.' });
        return plan;
      });
    },
    compare: (methods) => {
      const out = [];
      let chain = Promise.resolve();
      methods.forEach((m) => { chain = chain.then(() => (status.phase === 'cancelled' ? null : solveOne('compare', m, 1, {}).then((p) => { out.push(p); }))); });
      return chain.then(() => { if (status.phase !== 'cancelled') set({ phase: 'done', fraction: 1, methods: null, message: 'Compared.' }); return out; });
    },
    replan: (o) => {
      const st = store.getState();
      const parent = st.plans.filter((p) => p.approved && !p.superseded).pop();
      if (!parent) return Promise.reject(new Error('Nothing is approved.'));
      return solveOne('replan', st.scenario.settings.method || 'tabu', 1, { parentPlanId: parent.id, reason: o && o.reason })
        .then((plan) => { if (status.phase !== 'cancelled') set({ phase: 'done', fraction: 1, message: 'Re-plan ready.' }); return plan; });
    },
    cancel: () => {
      const j = job;
      if (!j) return Promise.resolve(null);
      clearInterval(j.timer);
      job = null;
      const el = (performance.now() - j.t0) / 1000;
      const plan = store1(build(j.method, Object.assign({ runtimeSec: el, cancelled: true }, j.o)));
      set({ phase: 'cancelled', elapsedSec: el, planId: plan.id, message: 'Stopped.' });
      j.resolve(plan);
      return Promise.resolve(plan);
    }
  };
  S.core.engine = E;
  S.ui.emit && S.ui.emit('engine:replaced', null);
  return true;
}

// ---- page helpers ----------------------------------------------------------------------------------
async function openApp(browser, fileUrl, vp) {
  const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, hasTouch: vp.width < 600, isMobile: vp.width < 600 });
  const errors = [], blocked = [];
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (/^(file|data|blob):/.test(u)) return route.continue();
    if (!TILE_RE.test(u)) blocked.push(u);
    return route.abort('internetdisconnected');
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = (msg.location() && msg.location().url) || '';
    const text = msg.text();
    if (TILE_RE.test(loc) || TILE_RE.test(text)) return;
    errors.push(text + (loc ? ' @ ' + loc : ''));
  });
  page.on('pageerror', (err) => errors.push('pageerror: ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err)));
  await page.goto(fileUrl);
  await page.waitForFunction(() => window.SRO && SRO.app && SRO.app.store && SRO.ui && SRO.ui.plannerKit, null, { timeout: 30000 });
  return { context, page, errors, blocked };
}

const isPhone = (page) => page.viewportSize().width < 1100;

async function viewVisible(page, name) {
  return page.locator('section.pl-view[data-tab="' + name + '"]').isVisible();
}

// Opens a planner tab the way a person would: the bottom tab bar on small screens, the panel's
// segmented tabs on wide ones; hidden tabs (route) through SRO.ui.plannerTabs.show.
async function showTab(page, name) {
  if (await viewVisible(page, name)) return;
  const bar = page.locator('.planner-tabbar .tabbar-item[data-tab="' + name + '"]');
  const seg = page.locator('.pl-head [role="tab"][data-tab="' + name + '"]');
  if (await bar.count() && await bar.isVisible()) await bar.click();
  else if (await seg.count() && await seg.isVisible()) await seg.click();
  else await page.evaluate((n) => SRO.ui.plannerTabs.show(n), name);
  await page.waitForFunction((n) => {
    const el = document.querySelector('section.pl-view[data-tab="' + n + '"]');
    return el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
  }, name, { timeout: 5000 });
}

async function setTheme(page, theme) {
  await page.evaluate((t) => SRO.app.store.dispatch({ type: 'theme/set', theme: t }), theme);
  await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, theme);
  await page.waitForTimeout(150);
}

function engineState(page) {
  return page.evaluate(() => { const e = SRO.ui.plannerKit.engine(); return e ? e.status() : null; });
}

// waits for the engine to finish and the Plan view to leave the running state
async function waitRunEnd(page, nPlansBefore) {
  await page.waitForFunction((n) => {
    const e = SRO.ui.plannerKit.engine(), st = e && e.status();
    const panel = document.querySelector('[data-testid="run-panel"]');
    return st && ['done', 'cancelled', 'error', 'idle'].indexOf(st.phase) >= 0 && SRO.app.store.getState().plans.length > n && (!panel || panel.hidden);
  }, nPlansBefore, { timeout: RUN_TIMEOUT, polling: 200 });
  await page.waitForTimeout(250);
}

// the viewed plan as the views see it (minus heavy fields)
function viewedPlan(page) {
  return page.evaluate(() => {
    const K = SRO.ui.plannerKit, p = K.viewedPlan(SRO.app.store.getState());
    return p ? { id: p.id, stats: p.stats, cost: p.cost, approved: !!p.approved, cancelled: !!p.cancelled, parentPlanId: p.parentPlanId || null, method: p.method,
      name: p.name, runtimeSec: p.runtimeSec, mipGap: p.mipGap, routes: p.routes.map((r) => ({ truckId: r.truckId, stops: r.stops.length, legs: r.legs.length })) } : null;
  });
}

// no horizontal page scroll; my panels do not overflow sideways
async function overflowCheck(page, what) {
  const r = await page.evaluate(() => {
    const d = document.documentElement;
    const out = { page: d.scrollWidth - d.clientWidth, views: [] };
    document.querySelectorAll('.pq, .pp, .pr').forEach((el) => {
      if (el.offsetParent === null) return;
      const extra = el.scrollWidth - el.clientWidth;
      if (extra > 1) out.views.push(el.className + ' +' + extra);
      // children that stick out of the view's box
      const box = el.getBoundingClientRect();
      el.querySelectorAll('*').forEach((c) => {
        if (c.closest('.table-wrap') && c.closest('.table-wrap') !== c) return;        // tables scroll in their wrapper
        const b = c.getBoundingClientRect();
        if (b.width && b.right > box.right + 2 && getComputedStyle(c).position !== 'fixed') out.views.push((c.className || c.tagName) + ' right+' + Math.round(b.right - box.right));
      });
    });
    out.views = out.views.slice(0, 5);
    return out;
  });
  check(r.page <= 0, what + ': no horizontal page scroll', r.page);
  check(!r.views.length, what + ': nothing sticks out of the queue / plan / route panels sideways', r.views);
}

// numbers and times that must never be cut off with an ellipsis
async function truncationCheck(page, what) {
  const cut = await page.evaluate(() => Array.from(document.querySelectorAll(
    '[data-testid="summary"] .stat-value, .pp-truck-grid .num, .pr-fact > .num, .pq-c-nlt, .pr-times'))
    .filter((e) => e.offsetParent !== null && e.scrollWidth > e.clientWidth + 1)
    .map((e) => e.className + ': ' + e.textContent.trim()).slice(0, 5));
  check(!cut.length, what + ': numbers and DTG times are not cut off', cut);
  const clash = await page.evaluate(() => {
    const ts = Array.from(document.querySelectorAll('[data-testid="timeline"] .pp-tl-tick'))
      .filter((t) => t.offsetParent !== null && getComputedStyle(t).visibility !== 'hidden').map((t) => { const b = t.getBoundingClientRect(); return { l: b.left, r: b.right, t: t.textContent }; });
    return ts.filter((x, i) => i > 0 && x.l < ts[i - 1].r + 2).map((x) => x.t);
  });
  check(!clash.length, what + ': timeline hour labels do not overlap', clash);
}

// dark and night: no light backgrounds in my panels; no emoji anywhere in them
async function themeColorCheck(page, theme, what) {
  const r = await page.evaluate((theme) => {
    const lum = (c) => {
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c);
      if (!m) return null;
      const a = m[4] === undefined ? 1 : +m[4];
      if (a < 0.5) return null;
      return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
    };
    const light = [], emoji = [];
    document.querySelectorAll('.pq, .pp, .pr, .pm-legend, .modal').forEach((root) => {
      if (root.offsetParent === null && !root.classList.contains('modal')) return;
      [root].concat(Array.from(root.querySelectorAll('*'))).forEach((el) => {
        if (el.offsetParent === null && el !== root) return;
        const l = lum(getComputedStyle(el).backgroundColor);
        if (l !== null && l > (theme === 'night' ? 0.45 : 0.7) && !el.closest('.truck-chip, .pp-chip, .pr-cost-seg, .pr-cost-sw, .badge, .progress-bar, .switch, .pp-tl-span, .pp-tl-stop, .pr-marker, .pm-legend-swatch, .pm-legend-urg, .urg-dot, .pp-load-fill'))
          light.push((el.className && el.className.baseVal === undefined ? el.className : el.tagName) + ' ' + getComputedStyle(el).backgroundColor);
      });
      if (/\p{Extended_Pictographic}/u.test(root.innerText || '')) emoji.push(root.className);
    });
    return { light: light.slice(0, 6), nLight: light.length, emoji };
  }, theme);
  if (theme !== 'light') check(!r.nLight, what + ': no light backgrounds in ' + theme + ' theme', r.light);
  check(!r.emoji.length, what + ': no emoji', r.emoji);
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}

// a point on a route line of the map that a click reaches (not covered by a marker or the legend)
// Prefers a spot where only one truck's line runs; else any spot on a line (the map then reports which
// truck it was through its click:route event, recorded in window.__ppRouteClick).
async function routeHitPoint(page, truckId) {
  return page.evaluate((truckId) => {
    window.__ppRouteClick = null;
    if (!window.__ppRouteHook) window.__ppRouteHook = SRO.ui.plannerKit.map().on('click:route', (e) => { window.__ppRouteClick = e && e.truckId; });
    const K = SRO.ui.plannerKit, st = SRO.app.store.getState(), plan = K.viewedPlan(st), m = K.map();
    if (!plan || !m || !m.leaflet) return null;
    const lm = m.leaflet, rect = m.el.getBoundingClientRect();
    const routes = plan.routes.filter((r) => r.stops.length && (!truckId || r.truckId === truckId));
    // true when another truck's line passes within 12 px of the point
    const pts = plan.routes.filter((r) => r.stops.length).map((r) => ({ id: r.truckId, xy: [].concat.apply([], (K.legCoords(r, st) || []).map((l) => l.coords || []))
      .map((c) => lm.latLngToContainerPoint([Array.isArray(c) ? c[0] : c.lat, Array.isArray(c) ? c[1] : c.lon])) }));
    const segDist = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    };
    const onOther = (id, lat, lon) => {
      const p = lm.latLngToContainerPoint([lat, lon]);
      return pts.some((r) => r.id !== id && r.xy.some((q, i) => i > 0 && segDist(p, r.xy[i - 1], q) < 12));
    };
    for (const strict of [true, false]) for (const rt of routes) {
      const legs = K.legCoords(rt, st) || [];
      const coords = [].concat.apply([], legs.map((l) => l.coords || []));
      for (let i = 1; i < coords.length; i++) {
        for (const f of [0.5, 0.25, 0.75]) {
          const a = coords[i - 1], b = coords[i];
          const lat = (Array.isArray(a) ? a[0] : a.lat) * (1 - f) + (Array.isArray(b) ? b[0] : b.lat) * f;
          const lon = (Array.isArray(a) ? a[1] : a.lon) * (1 - f) + (Array.isArray(b) ? b[1] : b.lon) * f;
          const p = lm.latLngToContainerPoint([lat, lon]);
          const x = rect.left + p.x, y = rect.top + p.y;
          if (x < rect.left + 8 || y < rect.top + 8 || x > rect.right - 8 || y > rect.bottom - 8) continue;
          // only where this truck's line is the one line under the pointer (routes from one hub share roads)
          const el = document.elementFromPoint(x, y);
          const lines = document.elementsFromPoint(x, y).filter((e) => e.classList && e.classList.contains('sro-route-hit'));
          if (!(el && el.classList && el.classList.contains('sro-route-hit'))) continue;
          if (!strict) return { x, y, truckId: null };
          if (lines.length === 1 && !onOther(rt.truckId, lat, lon)) return { x, y, truckId: rt.truckId };
        }
      }
    }
    return null;
  }, truckId || null);
}

// ==== the flow for one viewport =======================================================================
async function runViewport(browser, fileUrl, vp, label) {
  const { context, page, errors, blocked } = await openApp(browser, fileUrl, vp);
  const phone = vp.width < 1100;

  // ---------------------------------------------------------------- load
  section(label + ': empty queue and samples');
  await page.evaluate(() => { SRO.app.store.dispatch({ type: 'role/set', role: 'planner' }); });
  await setTheme(page, 'dark');
  const mode = await page.evaluate(() => (SRO.core.engine && typeof SRO.core.engine.run === 'function' ? 'engine' : 'none'));
  if (FORCE_STUB || mode === 'none') {
    await page.evaluate(installStubEngine);
    note('using the in-page stub engine' + (mode === 'none' ? ' (this build has no planner engine)' : ' (--stub)'));
  } else {
    await page.waitForFunction(() => SRO.core.engine.status().highsReady !== null, null, { timeout: 60000 }).catch(() => null);
    note('using the real planner engine (' + (await engineState(page)).mode + ', HiGHS ' + ((await engineState(page)).highsReady ? 'ready' : 'not ready') + ')');
  }
  await showTab(page, 'queue');
  check(await page.locator('[data-testid="queue-empty"]').isVisible(), 'empty queue state is shown');
  const big = page.locator('[data-testid="load-samples"]');
  check(await big.isVisible(), '"Load sample requests" button is shown');
  check(/Load sample requests/.test(await big.innerText()), 'button label says Load sample requests');
  const btnBox = await big.boundingBox();
  check(btnBox && btnBox.height >= 40, 'the sample button is large (>= 40 px tall)', btnBox);
  await shot(page, label + '-dark-queue-empty');
  await big.click();
  await page.waitForFunction(() => document.querySelectorAll('.pq-row').length > 0);

  // ---------------------------------------------------------------- queue
  section(label + ': queue');
  const q = await page.evaluate(() => {
    const K = SRO.ui.plannerKit, U = SRO.core.urgency, st = SRO.app.store.getState();
    const want = K.queueRequests(st);
    const domIds = Array.from(document.querySelectorAll('.pq-row')).map((r) => r.getAttribute('data-request'));
    let sorted = true;
    for (let i = 1; i < want.length; i++) if (U.compareRequests(want[i - 1], want[i], st.clock.simMin) > 0 && U.compareRequests(want[i - 1], want[i]) > 0) sorted = false;
    const open = want.filter((r) => K.OPEN_STATUSES.indexOf(r.status) >= 0).length;
    const first = document.querySelector('.pq-row');
    const t = (sel) => { const e = first.querySelector(sel); return e ? e.innerText.trim() : ''; };
    const badges = Array.from(document.querySelectorAll('.tab-badge')).filter((b) => !b.hidden && b.offsetParent !== null && (b.closest('[data-tab="queue"]') || b.getAttribute('data-tab-badge') === 'queue')).map((b) => b.textContent.trim());
    return { want: want.map((r) => r.id), domIds, sorted, open, badges,
      cols: { urg: t('.pq-c-urg'), unit: t('.pq-c-unit'), sup: t('.pq-c-sup'), nlt: t('.pq-c-nlt'), mob: t('.pq-c-mob'), pick: t('.pq-c-pick'), st: t('.pq-c-st') },
      headers: Array.from(document.querySelectorAll('.pq-cols > *')).map((e) => e.innerText.trim()).filter(Boolean),
      urgency: first.getAttribute('data-urgency') };
  });
  check(q.domIds.length === q.want.length && q.domIds.every((id, i) => id === q.want[i]), 'rows are the window requests in queue order', { dom: q.domIds.slice(0, 5), want: q.want.slice(0, 5) });
  check(q.sorted, 'queue order follows SRO.core.urgency.compareRequests');
  check(['Routine', 'Priority', 'Urgent', 'Immediate'].indexOf(q.cols.urg) >= 0, 'urgency badge column', q.cols.urg);
  check(q.cols.unit.length > 2, 'unit column', q.cols.unit);
  check(/Class [IVX]+/.test(q.cols.sup), 'classes column uses class labels', q.cols.sup);
  check(DTG_RE.test(q.cols.nlt), 'NLT column is a DTG', q.cols.nlt);
  check(q.cols.mob.length > 2 && q.cols.pick.length > 2, 'mobility and pickup preference columns', [q.cols.mob, q.cols.pick]);
  check(q.cols.st.length > 2, 'status column', q.cols.st);
  if (!phone) check(q.headers.length >= 6, 'column headers are shown on the wide queue', q.headers);
  const qWin = await page.locator('.pq-win').innerText();
  check(/next plan \d{6}H [A-Z]{3} \d{2}/.test(qWin), 'queue header gives the next plan time as a DTG', qWin);
  check(q.badges.indexOf(String(q.open)) >= 0, 'queue tab badge shows the open count ' + q.open, q.badges);

  // chips
  const chipText = async (f) => (await page.locator('.pq-chip[data-filter="' + f + '"]').innerText()).replace(/\s+/g, ' ');
  check(/All \d+/.test(await chipText('all')) && /Pending \d+/.test(await chipText('pending')) && /Delayed \d+/.test(await chipText('delayed')), 'All / Pending / Delayed chips with counts');
  await page.click('.pq-chip[data-filter="pending"]');
  const pend = await page.evaluate(() => {
    const K = SRO.ui.plannerKit, st = SRO.app.store.getState();
    return Array.from(document.querySelectorAll('.pq-row')).map((r) => K.request(st, r.getAttribute('data-request')).status);
  });
  check(pend.length > 0 && pend.every((s) => ['submitted', 'planned', 'delayed', 'partial'].indexOf(s) >= 0), 'Pending shows open requests only', pend);
  await page.click('.pq-chip[data-filter="delayed"]');
  const nDel = await page.locator('.pq-row').count();
  const nDelChip = +(/(\d+)/.exec(await chipText('delayed'))[1]);
  check(nDel === nDelChip, 'Delayed chip count matches its rows', [nDel, nDelChip]);
  await page.click('.pq-chip[data-filter="all"]');
  check(await page.locator('.pq-row').count() === q.want.length, 'All shows every row again');

  // row expand + overrides (pick a request whose overrides are editable)
  const target = await page.evaluate(() => {
    const K = SRO.ui.plannerKit, st = SRO.app.store.getState();
    const r = K.queueRequests(st).find((x) => K.OPEN_STATUSES.indexOf(x.status) >= 0 && x.mobility !== 'fixed' && !x.directOnly);
    return r ? r.id : null;
  });
  check(!!target, 'a movable open request exists for the override checks');
  if (target) {
    const row = page.locator('.pq-row[data-request="' + target + '"]');
    await row.locator('.pq-main').click();
    check(await row.locator('.pq-detail').isVisible(), 'clicking a row opens its detail');
    const sel = await page.evaluate(() => Object.assign({}, SRO.ui.plannerKit.sel));
    check(sel.requestId === target && sel.source === 'queue', 'row click selects the request for the map', sel);
    check(MGRS_RE.test(await row.locator('.pq-detail').innerText()), 'detail shows the location as MGRS');
    const lock = row.locator('[data-testid="lock-truck"]');
    const opts = await lock.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    check(opts.length > 0, 'lock list offers trucks of the right type', opts);
    if (opts.length) {
      await lock.selectOption(opts[0]);
      let locks = await page.evaluate((id) => SRO.ui.plannerKit.request(SRO.app.store.getState(), id).locks || {}, target);
      check(locks.truckId === opts[0], 'lock to a truck dispatches request/lock', locks);
      await page.locator('.pq-row[data-request="' + target + '"] [data-testid="lock-truck"]').selectOption('');
      locks = await page.evaluate((id) => SRO.ui.plannerKit.request(SRO.app.store.getState(), id).locks || {}, target);
      check(!locks.truckId, 'choosing "No lock" clears it', locks);
    }
    const fd = page.locator('.pq-row[data-request="' + target + '"] [data-testid="force-direct"]');
    check(!(await fd.isDisabled()), 'force direct is editable for a movable platoon');
    await fd.click();
    let locks = await page.evaluate((id) => SRO.ui.plannerKit.request(SRO.app.store.getState(), id).locks || {}, target);
    check(locks.forceDirect === true, 'force direct dispatches request/lock', locks);
    await page.locator('.pq-row[data-request="' + target + '"] [data-testid="force-direct"]').click();
    locks = await page.evaluate((id) => SRO.ui.plannerKit.request(SRO.app.store.getState(), id).locks || {}, target);
    check(!locks.forceDirect, 'force direct turns off again', locks);
    await shot(page, label + '-dark-queue-open');
    await page.locator('.pq-row[data-request="' + target + '"] .pq-main').click();
  }

  // ---------------------------------------------------------------- map
  section(label + ': map');
  await showTab(page, 'map');
  await page.waitForTimeout(400);
  const legend = page.locator('.pm-legend');
  check(await legend.count() === 1, 'the map has a legend');
  if (!(await page.locator('.pm-legend-body').isVisible())) await page.click('.pm-legend-toggle');
  const legendText = await legend.innerText();
  check(/Road lines and times from OpenStreetMap road data/.test(legendText), 'legend notes OpenStreetMap road data');
  check(/Immediate/.test(legendText) && /Routine/.test(legendText), 'legend explains urgency colors');
  const nHubs = await page.locator('.leaflet-sro-hubs-pane .leaflet-marker-icon, .leaflet-marker-pane .sro-hub-icon').count();
  const nPlt = await page.locator('.leaflet-sro-platoons-pane .leaflet-marker-icon').count();
  check(nPlt > 0, 'platoon symbols on the map', nPlt);
  if (!nHubs) note('hub markers not found by pane selector');
  // platoon click -> its request in the queue
  const plt = await page.evaluate(() => {
    const rect = SRO.ui.plannerKit.map().el.getBoundingClientRect();
    const els = Array.from(document.querySelectorAll('.leaflet-sro-platoons-pane .leaflet-marker-icon'));
    for (const el of els) {
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      if (x < rect.left + 10 || x > rect.right - 10 || y < rect.top + 10 || y > rect.bottom - 10) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) return { x, y };
    }
    return null;
  });
  check(!!plt, 'a platoon symbol can be clicked');
  if (plt) {
    await page.mouse.click(plt.x, plt.y);
    await page.waitForTimeout(500);
    const s = await page.evaluate(() => Object.assign({}, SRO.ui.plannerKit.sel));
    check(!!s.requestId && s.source === 'map', 'platoon click selects its request', s);
    check(await viewVisible(page, 'queue'), 'platoon click shows the queue');
    check(await page.locator('.pq-row[data-request="' + s.requestId + '"] .pq-detail').isVisible(), 'the clicked request is open in the queue');
    await page.locator('.pq-row[data-request="' + s.requestId + '"] .pq-main').click();
  }

  // ---------------------------------------------------------------- plan: settings + estimate
  section(label + ': plan settings and estimate');
  await showTab(page, 'plan');
  check(await page.locator('[data-testid="plan-empty"]').isVisible(), 'plan panel shows its empty state before any plan');
  const method0 = await page.locator('[data-testid="method"]').inputValue();
  check(method0 === 'tabu', 'default method is Tabu search', method0);
  await page.fill('[data-testid="time-limit"]', '5');
  await page.press('[data-testid="time-limit"]', 'Enter');
  const mp = await page.evaluate(() => SRO.app.store.getState().scenario.settings.methodParams.tabu);
  check(mp && mp.timeCapSec === 5, 'time limit field sets the method time cap', mp);
  await page.waitForFunction(() => /about/.test((document.querySelector('[data-testid="estimate"]') || {}).innerText || ''), null, { timeout: 30000 }).catch(() => null);
  const estT = await page.locator('[data-testid="estimate"]').innerText();
  check(/Estimated run time about/.test(estT), 'heuristic estimate is shown before running', estT);
  const mipOpt = await page.locator('[data-testid="method"] option[value="mip"]').evaluate((o) => ({ disabled: o.disabled, text: o.textContent }));
  if (!mipOpt.disabled) {
    await page.selectOption('[data-testid="method"]', 'mip');
    await page.waitForFunction(() => /Up to/.test((document.querySelector('[data-testid="estimate"]') || {}).innerText || ''), null, { timeout: 30000 }).catch(() => null);
    const estM = await page.locator('[data-testid="estimate"]').innerText();
    check(/Up to/.test(estM) && /proven gap/.test(estM) && /limit/.test(estM), 'MIP estimate states its time limit and that it reports a gap', estM);
    await page.selectOption('[data-testid="method"]', 'tabu');
  } else {
    note('Exact (MIP) is not available here: ' + mipOpt.text);
  }
  await page.waitForFunction(() => /about/.test((document.querySelector('[data-testid="estimate"]') || {}).innerText || ''), null, { timeout: 30000 }).catch(() => null);

  // ---------------------------------------------------------------- plan now
  section(label + ': plan now');
  let nPlans = await page.evaluate(() => SRO.app.store.getState().plans.length);
  await page.click('[data-testid="plan-now"]');
  await page.waitForSelector('[data-testid="run-panel"]:not([hidden])', { timeout: 10000 });
  check(await page.locator('[data-testid="run-panel"] .progress').isVisible(), 'running panel shows a progress bar');
  check(await page.locator('[data-testid="cancel"]').isVisible(), 'running panel offers Cancel');
  await page.waitForTimeout(1200);
  const runPanel = await page.locator('[data-testid="run-panel"]').innerText().catch(() => '');
  check(/Elapsed/.test(runPanel), 'running panel shows the elapsed time', runPanel);
  check(await page.locator('[data-testid="run-panel"] svg.pp-spark').count() === 1, 'running panel draws the best-cost sparkline');
  await waitRunEnd(page, nPlans);
  let plan = await viewedPlan(page);
  check(!!plan && !plan.approved, 'a draft plan is shown after the run', plan && plan.id);
  const summary = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="summary"] [data-stat]')).map((e) => ({
    k: e.getAttribute('data-stat'), v: e.getAttribute('data-value'), text: e.innerText.replace(/\s+/g, ' ').trim(), alert: e.classList.contains('is-alert'), tag: e.tagName,
    color: getComputedStyle(e.querySelector('.stat-value') || e).color
  })));
  check(summary.map((s) => s.k).join(',') === STAT_ORDER.join(','), 'summary strip is in spec order', summary.map((s) => s.k));
  const want = { requests: plan.stats.requests, stops: plan.stats.stops, trucks: plan.stats.trucksUsed, miles: plan.stats.miles, gallons: plan.stats.gallons,
    risk: plan.stats.riskUnits, delayed: plan.stats.delayed, runtime: plan.stats.runtimeSec != null ? plan.stats.runtimeSec : plan.runtimeSec };
  summary.forEach((s) => check(Math.abs(Number(s.v) - Number(want[s.k])) < 1e-9, 'summary ' + s.k + ' equals plan.stats', [s.v, want[s.k], s.text]));
  const sm = Object.fromEntries(summary.map((s) => [s.k, s]));
  check(sm.requests && sm.requests.text.indexOf(String(plan.stats.requests)) >= 0, 'requests count is printed', sm.requests && sm.requests.text);
  check(sm.miles && sm.miles.text.replace(/,/g, '').indexOf(String(Math.round(plan.stats.miles))) >= 0, 'miles are printed rounded', sm.miles && sm.miles.text);
  check(sm.gallons && sm.gallons.text.replace(/,/g, '').indexOf(String(Math.round(plan.stats.gallons))) >= 0, 'gallons are printed rounded', sm.gallons && sm.gallons.text);
  await shot(page, label + '-dark-plan');

  // delayed list
  if (plan.stats.delayed > 0) {
    const dangerRgb = await page.evaluate(() => { const d = document.createElement('div'); d.style.color = 'var(--danger)'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; });
    check(sm.delayed.alert && sm.delayed.color === dangerRgb, 'delayed is shown in red', [sm.delayed.color, dangerRgb]);
    await page.click('[data-testid="summary"] [data-stat="delayed"]');
    await page.waitForSelector('[data-testid="delayed-list"]');
    const dl = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="delayed-list"] [data-request]')).map((e) => e.innerText.replace(/\s+/g, ' ')));
    check(dl.length === plan.stats.delayed, 'delayed list has one row per delayed request', [dl.length, plan.stats.delayed]);
    check(dl.every((t) => t.length > 20 && !/\b(no-truck|closed-road|capacity\b:|radius\b:)/.test(t)), 'each delayed row gives a plain-word reason', dl.slice(0, 3));
    await page.waitForTimeout(400);
    await shot(page, label + '-dark-delayed');
    const showQ = page.locator('[data-testid="delayed-list"] [data-request] button').first();
    if (await showQ.count()) {
      const rid = await page.locator('[data-testid="delayed-list"] [data-request]').first().getAttribute('data-request');
      await showQ.click();
      await page.waitForTimeout(400);
      check(await viewVisible(page, 'queue'), '"Show in queue" opens the queue');
      check(await page.locator('.pq-row[data-request="' + rid + '"] .pq-detail').isVisible(), 'the delayed request is open in the queue');
      const st = await page.locator('.pq-row[data-request="' + rid + '"] .pq-c-st').innerText();
      check(/Delayed|Partial/.test(st), 'queue status shows the plan delay', st);
      await page.locator('.pq-row[data-request="' + rid + '"] .pq-main').click();
      await showTab(page, 'plan');
    } else {
      await page.keyboard.press('Escape');
    }
  } else {
    note('the plan has no delayed requests, so the delayed list was not opened');
  }

  // truck cards + timeline
  const used = plan.routes.filter((r) => r.stops > 0);
  const cards = await page.locator('.pp-truck[data-truck]').count();
  check(cards === used.length, 'one route card per truck used', [cards, used.length]);
  const card0 = await page.locator('.pp-truck[data-truck]').first().innerText();
  check(DTG_RE.test(card0) && /mi\b/.test(card0) && /%/.test(card0), 'route card shows DTG times, miles and load %', card0.replace(/\s+/g, ' '));
  const tl = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-testid="timeline"] .pp-tl-row').length,
    bg: (document.querySelector('[data-testid="timeline"] .pp-tl-track') || { style: {} }).style.background || '' }));
  check(tl.rows === used.length, 'timeline has a row per truck', tl.rows);
  check(/linear-gradient/.test(tl.bg) && /--period-/.test(tl.bg), 'timeline is shaded by day / dusk / night / dawn', tl.bg.slice(0, 80));
  const ticks = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="timeline"] .pp-tl-tick'))
    .filter((t) => getComputedStyle(t).visibility !== 'hidden').map((t) => { const b = t.getBoundingClientRect(); return { l: b.left, r: b.right, t: t.textContent }; }));
  const tickClash = ticks.filter((x, i) => i > 0 && x.l < ticks[i - 1].r + 2).map((x) => x.t);
  check(ticks.length >= 2 && !tickClash.length, 'timeline hour labels do not run together', { shown: ticks.map((x) => x.t), clash: tickClash });

  // ---------------------------------------------------------------- route detail from the map
  section(label + ': route detail');
  await showTab(page, 'map');
  await page.waitForTimeout(600);
  const hit = await routeHitPoint(page);
  check(!!hit, 'a route line can be clicked on the map');
  if (hit) {
    await page.mouse.click(hit.x, hit.y);
    await page.waitForFunction(() => { const el = document.querySelector('section.pl-view[data-tab="route"]'); return el && el.offsetParent !== null; }, null, { timeout: 5000 }).catch(() => null);
    check(await viewVisible(page, 'route'), 'clicking a route opens Route detail');
    const rsel = await page.evaluate(() => ({ sel: SRO.ui.plannerKit.sel.truckId, clicked: window.__ppRouteClick }));
    const want = hit.truckId || rsel.clicked;
    if (!hit.truckId) note('routes overlap everywhere on this map; checked against the truck the map reported');
    check(!!want && rsel.sel === want && rsel.clicked === want, 'Route detail shows the clicked truck', [rsel, hit.truckId]);
    check((await page.locator('[data-testid="route-truck"]').innerText()).indexOf(want) >= 0, 'route header names the truck');
  }
  const rd = await page.evaluate(() => {
    const K = SRO.ui.plannerKit, st = SRO.app.store.getState(), plan = K.viewedPlan(st);
    const rt = plan.routes.find((r) => r.truckId === K.sel.truckId) || plan.routes[0];
    const stops = Array.from(document.querySelectorAll('[data-testid="stop-list"] li.pr-stop[data-seq]')).map((e) => e.innerText.replace(/\s+/g, ' '));
    return { truckId: rt.truckId, n: rt.stops.length, stops, legs: document.querySelectorAll('[data-testid="stop-list"] li.pr-leg').length,
      segs: document.querySelectorAll('[data-testid="cost-split"] .pr-cost-seg').length, cost: (document.querySelector('[data-testid="cost-split"]') || {}).innerText || '',
      miles: (document.querySelector('[data-testid="route-miles"]') || {}).innerText || '', routeMiles: rt.miles,
      reqs: document.querySelectorAll('[data-testid="stop-list"] .pr-req').length, rally: rt.stops.some((s) => s.kind === 'rally'), direct: rt.stops.some((s) => s.kind === 'direct') };
  });
  check(rd.stops.length === rd.n, 'stop list has every stop', [rd.stops.length, rd.n]);
  check(rd.stops.every((t) => MGRS_RE.test(t)), 'every stop shows MGRS', rd.stops.find((t) => !MGRS_RE.test(t)));
  check(rd.stops.every((t) => /Arrive \d{6}[A-Z] [A-Z]{3} \d{2}/.test(t) && /depart \d{6}[A-Z]/.test(t)), 'every stop shows arrive and depart DTG');
  check(rd.stops.every((t) => /(Day|Dusk|Night|Dawn)/.test(t)), 'every stop names the period');
  check(rd.reqs > 0 && rd.stops.some((t) => /Class [IVX]+ \(/.test(t)), 'deliveries per request with class labels', rd.stops[0]);
  if (rd.rally) check(rd.stops.some((t) => /Platoon picks up here/.test(t)), 'rally stops say the platoon picks up');
  if (rd.direct) check(rd.stops.some((t) => /Delivered to the platoon/.test(t)), 'direct stops say delivered to the platoon');
  check(rd.legs >= rd.n, 'a leg row before each stop and back to the hub', [rd.legs, rd.n]);
  check(rd.segs >= 1 && /Fuel/.test(rd.cost) && /Distance/.test(rd.cost) && /Risk/.test(rd.cost) && /Simplicity/.test(rd.cost) && /Platoon travel/.test(rd.cost), 'cost split bar and legend', rd.cost.slice(0, 120));
  const shownMi = parseFloat(rd.miles.replace(/,/g, ''));
  check(isFinite(shownMi) && Math.abs(shownMi - rd.routeMiles) <= 0.51 && /mi\b/.test(rd.miles), 'route miles printed', [rd.miles, rd.routeMiles]);
  const nm = await page.locator('[data-testid="near-miss"]').count();
  if (nm) check(/near miss|after the deadline/.test(await page.locator('[data-testid="near-miss"]').innerText()), 'deadline flags explain the near miss');
  else note('no near-miss deadlines on this route');
  await shot(page, label + '-dark-route');
  // truck switcher
  const others = await page.locator('[data-testid="route-switch"] option').evaluateAll((os) => os.map((o) => o.value));
  const other = others.find((v) => v && v !== rd.truckId);
  if (other) {
    await page.selectOption('[data-testid="route-switch"]', other);
    await page.waitForTimeout(200);
    check((await page.locator('[data-testid="route-truck"]').innerText()).indexOf(other) >= 0, 'truck switcher changes the route shown');
  }
  await page.click('[data-testid="route-back"]');
  await page.waitForTimeout(200);
  check(await viewVisible(page, 'plan'), 'Back returns to the plan');
  const lastCard = page.locator('.pp-truck[data-truck]').last();
  const lastId = await lastCard.getAttribute('data-truck');
  await lastCard.click();
  await page.waitForTimeout(250);
  check(await viewVisible(page, 'route') && (await page.locator('[data-testid="route-truck"]').innerText()).indexOf(lastId) >= 0, 'a route card opens Route detail for its truck');
  await page.click('[data-testid="route-back"]');

  // ---------------------------------------------------------------- rename, snapshot
  section(label + ': rename and snapshot');
  await page.click('.pp-head button:has-text("Rename")');
  await page.fill('#pp-name-input', 'Morning push');
  await page.click('.modal .modal-actions .btn-primary');
  await page.waitForTimeout(200);
  check((await page.locator('[data-testid="plan-name"]').innerText()).indexOf('Morning push') >= 0, 'rename changes the plan name');
  const snaps0 = await page.evaluate(() => (SRO.app.store.getState().snapshots || []).length);
  await page.click('[data-testid="snapshot"]');
  await page.fill('#pp-name-input', 'Before approval');
  await page.click('.modal .modal-actions .btn-primary');
  await page.waitForTimeout(200);
  const snaps1 = await page.evaluate(() => (SRO.app.store.getState().snapshots || []).length);
  check(snaps1 === snaps0 + 1, 'Save snapshot stores a snapshot', [snaps0, snaps1]);

  // ---------------------------------------------------------------- approve
  section(label + ': approve');
  await page.click('[data-testid="approve"]');
  await page.waitForSelector('.modal');
  const confirmText = await page.locator('.modal').last().innerText();
  check(/pickup point and ETA/.test(confirmText), 'the confirm says platoon sergeants see their pickup point and ETA', confirmText.replace(/\s+/g, ' ').slice(0, 200));
  await page.waitForTimeout(400);
  await shot(page, label + '-dark-approve');
  await page.click('.modal [data-action="approve"]');
  await page.waitForTimeout(300);
  plan = await viewedPlan(page);
  check(plan.approved, 'the plan is approved');
  check(/Approved/.test(await page.locator('[data-testid="plan-status"]').innerText()), 'status badge says Approved');
  const approvedId = plan.id;
  const reqStatus = await page.evaluate((id) => {
    const st = SRO.app.store.getState(), p = st.plans.find((x) => x.id === id);
    const ids = {};
    p.routes.forEach((r) => r.stops.forEach((s) => (s.deliveries || []).forEach((d) => { ids[d.requestId] = true; })));
    return Object.keys(ids).map((rid) => st.requests.find((r) => r.id === rid).status);
  }, approvedId);
  check(reqStatus.length > 0 && reqStatus.every((s) => s !== 'submitted'), 'requests in the approved plan are no longer just submitted', reqStatus.slice(0, 6));

  // ---------------------------------------------------------------- compare
  section(label + ': compare methods');
  await page.click('[data-testid="compare-toggle"]');
  check(await page.locator('[data-testid="cmp-tabu"]').isChecked() && await page.locator('[data-testid="cmp-sa"]').isChecked(), 'Tabu search and Simulated annealing are picked by default');
  // add Exact (MIP) when it can run here, so the table has three method columns to fit in the panel
  const mipCmp = page.locator('[data-testid="cmp-mip"]');
  const withMip = !(await mipCmp.isDisabled());
  if (withMip) await mipCmp.check();
  else note('Exact (MIP) cannot run here, so the compare uses two methods');
  const cmpMethods = withMip ? ['tabu', 'sa', 'mip'] : ['tabu', 'sa'];
  await page.waitForTimeout(500);
  nPlans = await page.evaluate(() => SRO.app.store.getState().plans.length);
  // make the compare quick: 5 s caps for every method
  await page.evaluate(() => SRO.app.store.dispatch({ type: 'settings/update', changes: { methodParams: { sa: { timeCapSec: 5 }, tabu: { timeCapSec: 5 }, mip: { timeLimitSec: 5, timeCapSec: 5 } } } }));
  // compare needs open requests: mark the approved plan's trucks out? No: compare plans the open requests; after approval there
  // may be none left, so put two requests back to submitted the way a new batch would arrive.
  const open = await page.evaluate(() => { const K = SRO.ui.plannerKit, st = SRO.app.store.getState(); return K.queueRequests(st).filter((r) => K.OPEN_STATUSES.indexOf(r.status) >= 0).length; });
  if (!open) {
    await page.evaluate(() => SRO.app.store.dispatch({ type: 'samples/load' }));
    note('loaded more sample requests so the compare has something to plan');
  }
  await page.waitForFunction(() => !document.querySelector('[data-testid="compare-run"]').disabled, null, { timeout: 10000 }).catch(() => null);
  await page.click('[data-testid="compare-run"]');
  await page.waitForSelector('[data-testid="run-panel"]:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(600);
  check(/Compar/.test(await page.locator('[data-testid="run-panel"]').innerText().catch(() => '')), 'running panel says it is comparing');
  await page.waitForFunction((n) => SRO.app.store.getState().plans.length >= n && !document.querySelector('[data-testid="run-panel"]:not([hidden])') && document.querySelector('[data-testid="compare-table"]'), nPlans + cmpMethods.length, { timeout: RUN_TIMEOUT * 2, polling: 250 });
  await page.waitForTimeout(300);
  const ct = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="compare-table"]'), wrap = t.closest('.table-wrap');
    return { cols: Array.from(t.querySelectorAll('thead th.num')).map((e) => e.innerText.replace(/\s+/g, ' ')),
      rows: Array.from(t.querySelectorAll('tbody tr th[scope="row"]')).map((e) => e.textContent.trim()).filter(Boolean),
      cells: Array.from(t.querySelectorAll('td[data-col][data-row="Total cost"]')).map((e) => ({ m: e.getAttribute('data-col'), v: e.innerText.trim() })),
      gap: Array.from(t.querySelectorAll('td[data-col][data-row="Gap (MIP)"]')).map((e) => ({ m: e.getAttribute('data-col'), v: e.innerText.trim() })),
      overflow: wrap ? wrap.scrollWidth - wrap.clientWidth : 0 };
  });
  check(ct.cols.length === cmpMethods.length && /Tabu/.test(ct.cols.join()) && /annealing/.test(ct.cols.join()) && (!withMip || /MIP/.test(ct.cols.join())), 'comparison table has a column per method', ct.cols);
  check(ct.overflow <= 1, 'the comparison table fits the panel without sideways scrolling (' + cmpMethods.length + ' methods)', ct.overflow);
  ['Total cost', 'Fuel', 'Distance', 'Risk', 'Simplicity', 'Delayed', 'Run time', 'Gap (MIP)'].forEach((r) => check(ct.rows.indexOf(r) >= 0, 'comparison row ' + r));
  const cmpPlans = await page.evaluate((n) => SRO.app.store.getState().plans.slice(-n).map((p) => ({ id: p.id, method: p.method, total: p.cost.total, mipGap: p.mipGap, compareId: p.compareId || null })), cmpMethods.length);
  cmpPlans.forEach((p) => {
    const cell = ct.cells.find((c) => c.m === p.method);
    check(cell && cell.v.replace(/,/g, '') === String(Math.round(p.total)), 'total cost cell equals the ' + p.method + ' plan cost', [cell && cell.v, p.total]);
    const g = ct.gap.find((c) => c.m === p.method);
    const wantGap = typeof p.mipGap === 'number' ? (p.mipGap * 100).toFixed(1) + '%' : '-';
    check(g && g.v === wantGap, 'gap cell of ' + p.method + ' equals plan.mipGap', [g && g.v, wantGap]);
  });
  await shot(page, label + '-dark-compare');
  await page.click('[data-testid="keep-sa"]');
  await page.waitForTimeout(250);
  check(await page.locator('[data-testid="keep-sa"]').getAttribute('aria-pressed') === 'true', 'Keep marks the kept plan');
  const kept = await viewedPlan(page);
  const saPlan = cmpPlans.find((p) => p.method === 'sa');
  check(kept && saPlan && kept.id === saPlan.id, 'the kept plan is the one shown', [kept && kept.id, saPlan && saPlan.id]);
  const reqV = await page.locator('[data-testid="summary"] [data-stat="requests"]').getAttribute('data-value');
  check(Number(reqV) === kept.stats.requests, 'summary follows the kept plan');

  // ---------------------------------------------------------------- compare to previous
  section(label + ': compare to previous plan');
  const prevBtn = page.locator('[data-testid="compare-previous"]');
  check(await prevBtn.isEnabled(), 'compare to previous is available for a later plan');
  await prevBtn.click();
  await page.waitForSelector('[data-testid="diff"]:visible', { timeout: 3000 }).catch(() => null);
  const diffT = await page.locator('[data-testid="diff"]').innerText().catch(() => '');
  check(/Compared to/.test(diffT), 'the diff card names the plan it compares to', diffT.slice(0, 120));
  await shot(page, label + '-dark-diff');
  await prevBtn.click();

  // ---------------------------------------------------------------- cancel
  section(label + ': cancel keeps the best plan');
  await page.click('[data-testid="compare-toggle"]');
  await page.fill('[data-testid="time-limit"]', '120');
  await page.press('[data-testid="time-limit"]', 'Enter');
  nPlans = await page.evaluate(() => SRO.app.store.getState().plans.length);
  const t0 = Date.now();
  await page.click('[data-testid="plan-now"]');
  await page.waitForFunction(() => { const e = SRO.ui.plannerKit.engine(); const s = e.status(); return s.phase === 'running' && s.history && s.history.length >= 1 && s.elapsedSec > 1; }, null, { timeout: 60000, polling: 100 });
  await shot(page, label + '-dark-running');
  await page.click('[data-testid="cancel"]');
  await waitRunEnd(page, nPlans);
  const took = (Date.now() - t0) / 1000;
  const stopped = await viewedPlan(page);
  check(took < 60, 'cancel stops the run long before its 120 s limit', took);
  check(stopped && stopped.cancelled, 'the kept plan is marked as stopped early', stopped && stopped.id);
  check(/stopped early/i.test(await page.locator('[data-testid="plan-status"]').innerText()), 'status says Draft (stopped early)');
  // (the Plan view asks for a fresh estimate after a run, which shows as 'estimating' for a moment)
  await page.waitForFunction(() => SRO.ui.plannerKit.engine().status().phase !== 'estimating', null, { timeout: 30000 }).catch(() => null);
  const es = await engineState(page);
  check(es.phase === 'cancelled', 'engine reports cancelled', es.phase);
  await page.fill('[data-testid="time-limit"]', '5');
  await page.press('[data-testid="time-limit"]', 'Enter');

  // ---------------------------------------------------------------- contingency re-plan
  section(label + ': re-plan before / after');
  const truckOut = await page.evaluate((id) => {
    const p = SRO.app.store.getState().plans.find((x) => x.id === id);
    const rt = p.routes.find((r) => r.stops.length);
    SRO.app.store.dispatch({ type: 'truck/markOut', truckId: rt.truckId, reason: 'Broke down at the hub' });
    return rt.truckId;
  }, approvedId);
  nPlans = await page.evaluate(() => SRO.app.store.getState().plans.length);
  const rp = await page.evaluate(() => SRO.ui.plannerKit.engine().replan({ reason: 'Truck out of service' }).then((p) => ({ id: p && p.id, parent: p && p.parentPlanId }), (e) => ({ error: String(e && e.message || e) })));
  check(!rp.error && rp.parent === approvedId, 're-plan stores a plan whose parent is the approved plan', rp);
  await page.waitForTimeout(400);
  await showTab(page, 'plan');
  const shown = await viewedPlan(page);
  check(shown && shown.id === rp.id, 'the new re-plan is shown in the Plan view', [shown && shown.id, rp.id]);
  const diff = await page.evaluate(() => { const d = document.querySelector('[data-testid="diff"]'); return d && d.offsetParent !== null ? { text: d.innerText, rows: d.querySelectorAll('[data-kind]').length } : null; });
  check(!!diff && /Before and after the re-plan/.test(diff.text), 'the before / after list is shown for a re-plan', diff && diff.text.slice(0, 80));
  check(diff && diff.rows > 0, 'the before / after list names moved stops (truck ' + truckOut + ' is out)', diff && diff.rows);
  await shot(page, label + '-dark-replan');

  // ---------------------------------------------------------------- trucks on the demo clock
  section(label + ': trucks move on the demo clock');
  await showTab(page, 'map');
  const dep = await page.evaluate((id) => {
    const p = SRO.app.store.getState().plans.find((x) => x.id === id);
    return Math.min.apply(null, p.routes.filter((r) => r.stops.length).map((r) => r.depart));
  }, approvedId);
  const truckPos = () => page.evaluate(() => Array.from(document.querySelectorAll('.leaflet-sro-trucks-pane .leaflet-marker-icon'))
    .map((e) => { const b = e.getBoundingClientRect(); return { t: e.getAttribute('title') || '', x: Math.round(b.left), y: Math.round(b.top) }; }));
  check((await truckPos()).length === 0, 'no truck symbols on the map before departure (trucks at the hub are not drawn)');
  await page.evaluate((t) => SRO.app.store.dispatch({ type: 'clock/tick', simMin: t }), dep + 30);
  await page.waitForTimeout(500);
  const p1 = await truckPos();
  check(p1.length > 0, 'trucks of the approved plan appear on the map once they leave', p1.length);
  await page.evaluate((t) => SRO.app.store.dispatch({ type: 'clock/tick', simMin: t }), dep + 50);
  await page.waitForTimeout(700);
  const p2 = await truckPos();
  const moved = p1.filter((a) => { const b = p2.find((x) => x.t === a.t); return b && (b.x !== a.x || b.y !== a.y); });
  check(moved.length > 0, 'trucks move along their roads as the clock runs', { before: p1.slice(0, 3), after: p2.slice(0, 3) });
  await shot(page, label + '-dark-trucks');

  // ---------------------------------------------------------------- mid-route contingency
  // A truck of the approved plan is marked out after its first stop and the rest is re-planned. The
  // re-plan keeps that truck's done stop (route.out) and gives trucks on the road a capacity of only
  // what is on board and miles of only the re-planned part; the cards and Route detail must still show
  // the whole trip against the real truck capacity, and the stopped truck must not count as used.
  section(label + ': mid-route contingency');
  const mid = await page.evaluate((id) => {
    const st = SRO.app.store.getState(), K = SRO.ui.plannerKit, now = st.clock.simMin;
    const p = st.plans.find((x) => x.id === id);
    let best = null;
    K.usedRoutes(p).forEach((r) => {
      const t = st.scenario.fleet.find((x) => x.id === r.truckId);
      if (!t || t.status === 'out' || r.stops.length < 2) return;
      const at = Math.max(now, r.stops[0].depart + 1);
      if (at < r.stops[r.stops.length - 1].arrive && (!best || at < best.at)) best = { truckId: r.truckId, at };
    });
    return best;
  }, approvedId);
  check(!!mid, 'the approved plan has a truck with a stop done and a stop to go', mid);
  if (mid) {
    await page.evaluate((m) => {
      if (m.at > SRO.app.store.getState().clock.simMin) SRO.app.store.dispatch({ type: 'clock/tick', simMin: m.at });
      SRO.app.store.dispatch({ type: 'truck/markOut', truckId: m.truckId, reason: 'Blown tire' });
    }, mid);
    const real = await page.evaluate(() => !SRO.core.engine.stub);
    let midId = null;
    if (real) {
      const r2 = await page.evaluate(() => SRO.ui.plannerKit.engine().replan({ reason: 'Blown tire' }).then((p) => (p ? p.id : null), (e) => 'ERR ' + (e && e.message)));
      check(r2 && !/^ERR/.test(r2), 'the mid-route re-plan finishes', r2);
      midId = r2;
    } else {
      // stub: the same shape the planner engine stores (done stops, out route, on-board capacity)
      midId = await page.evaluate(({ id, truckId }) => {
        const st = SRO.app.store.getState(), K = SRO.ui.plannerKit, now = st.clock.simMin;
        const p = JSON.parse(JSON.stringify(st.plans.find((x) => x.id === id)));
        delete p.id; p.name = 'Mid-route re-plan check'; p.parentPlanId = id; p.approved = false; p.superseded = false;
        p.routes = p.routes.filter((r) => r.stops.length).map((r) => {
          r.stops.forEach((s) => { if (s.arrive < now) s.done = true; (s.deliveries || []).forEach((d) => { d.loadQty = 1; }); });
          r.continued = true;
          if (r.truckId === truckId) {
            const n = r.stops.filter((s) => s.done).length;
            return Object.assign(r, { out: true, stops: r.stops.slice(0, n), legs: r.legs.slice(0, n), returnAt: r.legs[n - 1].arrive, miles: 0, gallons: 0, cost: { fuel: 0, distance: 0, risk: 0, simplicity: 0, platoon: 0, lateness: 0, total: 0 } });
          }
          return Object.assign(r, { capacity: 1, load: 1, miles: r.miles / 3, gallons: r.gallons / 3 });
        });
        p.stats = Object.assign({}, p.stats, { trucksUsed: p.routes.filter((r) => !r.out).length });
        const res = SRO.app.store.dispatch({ type: 'plan/store', plan: p });
        return res.ok ? res.id : null;
      }, { id: approvedId, truckId: mid.truckId });
      note('stub engine: the mid-route re-plan is a stored copy of the approved plan with the engine\'s re-plan shape');
    }
    await page.waitForTimeout(400);
    await showTab(page, 'plan');
    await page.waitForTimeout(300);
    const mv = await page.evaluate(({ truckId }) => {
      const st = SRO.app.store.getState(), K = SRO.ui.plannerKit, p = K.viewedPlan(st);
      const fleetCap = (id) => (st.scenario.fleet.find((t) => t.id === id) || {}).capacity;
      const routes = K.usedRoutes(p).map((r) => {
        const dels = [].concat.apply([], r.stops.map((s) => s.deliveries || []));
        return { truckId: r.truckId, out: !!r.out, cutOff: !!r.cutOff, continued: !!r.continued,
          legMiles: r.legs.reduce((a, l) => a + (l.miles || 0), 0), loadSum: dels.every((d) => typeof d.loadQty === 'number') ? dels.reduce((a, d) => a + d.loadQty, 0) : null,
          cap: fleetCap(r.truckId), routeCap: r.capacity, routeMiles: r.miles, stops: r.stops.length, done: r.stops.filter((s) => s.done).length };
      });
      const cards = Array.from(document.querySelectorAll('.pp-truck[data-truck]')).map((c) => ({ id: c.getAttribute('data-truck'), text: c.innerText.replace(/\s+/g, ' '), stopped: !!c.querySelector('.badge-danger') }));
      return { id: p.id, parent: p.parentPlanId, stats: p.stats, routes, cards, used: (document.querySelector('[data-testid="trucks-used"]') || {}).textContent || '', victim: truckId,
        summaryNote: (document.querySelector('[data-testid="summary-note"]') || {}).textContent || '' };
    }, mid);
    check(mv.id === midId && mv.parent, 'the mid-route re-plan is shown', [mv.id, midId, mv.parent]);
    check(/from its next stop/.test(mv.summaryNote) && /whole trips/.test(mv.summaryNote), 'a re-plan says its summary totals cover the re-planned part and the cards whole trips', mv.summaryNote);
    const vr = mv.routes.find((r) => r.truckId === mid.truckId);
    check(vr && vr.out && vr.done >= 1, 'the re-plan keeps the done stop of the truck marked out', vr);
    const vc = mv.cards.find((c) => c.id === mid.truckId);
    check(vc && vc.stopped && /Out of service/.test(vc.text) && /after stop \d/.test(vc.text) && !/RETURN/i.test(vc.text), 'the out-of-service truck card says so instead of a return time', vc && vc.text);
    const nActive = mv.cards.filter((c) => !c.stopped).length;
    check(new RegExp('^' + nActive + ' of ').test(mv.used.trim()), 'trucks used in the card header leave out the stopped truck', [mv.used, nActive]);
    if (real) check(nActive === mv.stats.trucksUsed || mv.routes.some((r) => r.continued && r.done === r.stops.length), 'card count equals the summary trucks used', [nActive, mv.stats.trucksUsed]);
    mv.routes.forEach((r) => {
      const c = mv.cards.find((x) => x.id === r.truckId);
      if (!c) { check(false, 'a card for ' + r.truckId); return; }
      if (r.loadSum !== null && r.cap) {
        const pct = Math.round(100 * r.loadSum / r.cap);
        check(new RegExp('LOAD ' + pct + '%', 'i').test(c.text), r.truckId + ' load % is the whole trip against the truck capacity (' + pct + '%, re-plan capacity ' + r.routeCap + ')', c.text);
      }
      const mi = /MILES ([\d,.]+) mi/i.exec(c.text);
      check(mi && Math.abs(parseFloat(mi[1].replace(/,/g, '')) - r.legMiles) <= 0.051, r.truckId + ' miles are the whole trip (sum of its legs)', [mi && mi[1], r.legMiles, r.routeMiles]);
    });
    await shot(page, label + '-dark-midroute');
    // Route detail of the stopped truck renders completely
    await page.locator('.pp-truck[data-truck="' + mid.truckId + '"]').click();
    await page.waitForTimeout(300);
    const od = await page.evaluate(() => ({
      stopped: !!document.querySelector('[data-testid="route-stopped"]'),
      end: !!document.querySelector('[data-testid="stop-list"] li.is-stopped'),
      stops: document.querySelectorAll('[data-testid="stop-list"] li.pr-stop[data-seq]').length,
      delayed: !!document.querySelector('[data-testid="route-delayed"]'),
      ret: /Back \d{6}H/.test((document.querySelector('[data-testid="stop-list"]') || {}).innerText || '') }));
    check(od.stopped && od.end && !od.ret, 'Route detail of the stopped truck ends at its last done stop (no return time)', od);
    check(od.stops === vr.stops && od.delayed, 'Route detail of the stopped truck lists its stops and the delayed card', [od.stops, vr && vr.stops, od.delayed]);
    await shot(page, label + '-dark-route-out');
    await page.click('[data-testid="route-back"]');
  }

  // ---------------------------------------------------------------- themes
  section(label + ': themes');
  const sizes = [vp].concat(!phone && SHOTS ? [{ width: 820, height: 1180 }] : []);
  for (const size of sizes) {
    if (size !== vp) { await page.setViewportSize(size); await page.waitForTimeout(500); }
    const tag = size.width + 'x' + size.height;
    const narrow = size.width < 1100;
    for (const theme of THEMES) {
      await setTheme(page, theme);
      const views = narrow ? ['queue', 'map', 'plan', 'route'] : ['plan', 'route'];
      for (const v of views) {
        if (v === 'route') { await page.evaluate(() => SRO.ui.plannerKit.select({ truckId: null })); }
        await showTab(page, v);
        await page.waitForTimeout(v === 'map' ? 500 : 200);
        await overflowCheck(page, tag + ' ' + theme + ' ' + v);
        await truncationCheck(page, tag + ' ' + theme + ' ' + v);
        await themeColorCheck(page, theme, tag + ' ' + theme + ' ' + v);
        await shot(page, (size === vp ? label : 'tablet') + '-' + theme + '-' + v);
      }
      if (!narrow) {
        // the comparison table and the delayed list, in each theme
        await showTab(page, 'plan');
        const d = page.locator('[data-testid="summary"] [data-stat="delayed"]');
        if (await d.isEnabled() && Number(await d.getAttribute('data-value')) > 0) {
          await d.click();
          await page.waitForSelector('[data-testid="delayed-list"]');
          await themeColorCheck(page, theme, tag + ' ' + theme + ' delayed list');
          await shot(page, label + '-' + theme + '-delayed');
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        }
      }
    }
    await setTheme(page, 'dark');
  }
  if (sizes.length > 1) await page.setViewportSize(vp);

  // ---------------------------------------------------------------- near-miss flag
  // a copy of the shown plan with one stop moved to 12 minutes before its request's deadline; it also
  // carries two optimizer notes and one request deferred for the same reason with two different notes
  // (the fuel and cargo loads of a request), which must both be shown
  section(label + ': near-miss deadline flag');
  const nmPlan = await page.evaluate(() => {
    const st = SRO.app.store.getState(), K = SRO.ui.plannerKit;
    const p = JSON.parse(JSON.stringify(K.viewedPlan(st)));
    delete p.id; p.name = 'Near-miss check'; p.parentPlanId = null; p.approved = false; p.superseded = false;
    p.warnings = ['Check note one: a lock could not be kept.', 'Check note two: a pickup point is out of reach.'];
    for (const rt of p.routes) {
      for (const s of rt.stops) {
        for (const d of (s.deliveries || [])) {
          const r = K.request(st, d.requestId);
          const dl = r && (isFinite(r.deadline) ? r.deadline : r.nlt);
          if (!isFinite(dl)) continue;
          const shift = (dl - 12) - s.arrive;
          s.arrive += shift; s.depart += shift;
          const line = r.lines[d.lineIdx] || r.lines[0];
          p.deferred = ['Check reason A: every tanker is full.', 'Check reason B: every cargo truck is full.'].map((note) => ({
            requestId: r.id, lineIdx: d.lineIdx, qty: 1, unit: line.unit, classId: line.classId, reason: 'capacity', detail: 'trucks-full', note }));
          p.stats = Object.assign({}, p.stats, { delayed: 1 });
          const res = SRO.app.store.dispatch({ type: 'plan/store', plan: p });
          return res.ok ? { id: res.id, truckId: rt.truckId, requestId: d.requestId } : null;
        }
      }
    }
    return null;
  });
  check(!!nmPlan, 'a near-miss plan could be stored');
  if (nmPlan) {
    await page.evaluate((x) => { SRO.ui.plannerKit.showPlan(x.id); SRO.ui.plannerKit.select({ truckId: x.truckId }); SRO.ui.plannerTabs.show('route'); }, nmPlan);
    await page.waitForTimeout(300);
    const nmText = await page.locator('[data-testid="near-miss"]').innerText().catch(() => '');
    check(/near miss/i.test(nmText) && /12 min/.test(nmText), 'Route detail flags the deadline met with 12 minutes to spare', nmText.slice(0, 160));
    const badge = await page.locator('[data-testid="stop-list"] .pr-req[data-request="' + nmPlan.requestId + '"]').first().innerText().catch(() => '');
    check(/Near miss: 12 min to spare/.test(badge), 'the stop marks the near miss on that request', badge.slice(0, 160));
    await shot(page, label + '-dark-nearmiss');
    const rdl = await page.locator('[data-testid="route-delayed"]').innerText().catch(() => '');
    check(/Check reason A/.test(rdl) && /Check reason B/.test(rdl), 'Route detail shows both reasons of a request deferred for one cause with two notes', rdl.slice(0, 200));
    await page.click('[data-testid="route-back"]');
    await page.waitForTimeout(250);
    const wn = page.locator('[data-testid="plan-warnings"]');
    check(await wn.count() === 1 && /2 notes from the optimizer/.test(await wn.innerText()), 'the plan header offers the optimizer notes');
    if (await wn.count()) {
      await wn.locator('summary').click();
      const wt = await wn.innerText();
      check(/Check note one/.test(wt) && /Check note two/.test(wt), 'the optimizer notes open into a list', wt.slice(0, 200));
    }
    await page.click('[data-testid="summary"] [data-stat="delayed"]');
    await page.waitForSelector('[data-testid="delayed-list"]');
    const dlt = await page.locator('[data-testid="delayed-list"]').innerText();
    check(/Check reason A/.test(dlt) && /Check reason B/.test(dlt), 'the delayed list shows both notes', dlt.slice(0, 200));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  // ---------------------------------------------------------------- console
  section(label + ': console');
  check(!errors.length, 'no console errors or page errors (blocked map tiles excepted)', errors.slice(0, 5));
  check(!blocked.length, 'no requests to other hosts than the map tiles', blocked.slice(0, 5));
  await context.close();
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sro-pp-'));
  const out = path.join(tmp, 'app.html');
  const res = execFileSync('python3', ['tools/build.py', '--quiet', '--out', out], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('build: ' + (res.trim().split('\n').pop() || 'ok'));
  const fileUrl = pathToFileURL(out).href;
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch();
  try {
    if (ONLY !== 'phone') await runViewport(browser, fileUrl, { width: 1440, height: 900 }, 'desktop-1440x900');
    if (ONLY !== 'desktop') await runViewport(browser, fileUrl, { width: 390, height: 844 }, 'phone-390x844');
  } catch (e) {
    failures.push(scope + ': spec stopped: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
    console.log('  FAIL spec stopped: ' + (e && e.message));
  } finally {
    await browser.close();
    if (!flag('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log('kept ' + out);
  }
  console.log('\n' + passed + ' checks passed, ' + failures.length + ' failed' + (notes.length ? ', ' + notes.length + ' note(s)' : ''));
  for (const n of notes) console.log('  note: ' + n);
  for (const f of failures) console.log('  FAIL: ' + f);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('SPEC ERROR', e); process.exit(1); });
