#!/usr/bin/env node
// Browser check of the planner engine (src/core/planner-engine.js, DESIGN.md section 8b) in the built
// single file, opened from file:// in headless Chromium. Plain node script:
//
//   node tests/ui/engine.spec.mjs [--no-build --file PATH] [--shots DIR] [--quick]
//
// Builds prototype HTML (python3 tools/build.py --out <tmp>) and checks, with the 19 sample requests
// plus one user request:
//   - the solver worker starts as a Blob worker (mode 'worker'), HiGHS loaded, methods listed
//   - Plan now (the Plan tab button) with the default method and settings: progress updates reach
//     subscribers, a Plan is stored unapproved with routes whose legs carry encoded road paths; the
//     end-to-end time from the click to the stored plan is printed (goal: under a minute)
//   - every registered method run with a short time cap: plan stored, method recorded, progress seen
//   - Cancel during a long run (the Plan tab Cancel button): the best plan so far is stored with
//     cancelled: true (with the method settings it ran with), the worker restarts and the next run works
//   - compare: one stored plan per method, one compareId
//   - contingency: approve, clock forward, a truck marked out, a closed road, replan: plan stored with
//     parentPlanId, done stops kept, the truck out gets no new stops, no new leg crosses the closure,
//     per request line delivered (done or planned) + deferred = requested
//   - a second batch planned and approved in the same window keeps the first batch approved
//   - automatic planning at a window boundary (clock across 1200 with pending requests)
//   - heuristics-only fallback when the page cannot start a Worker (MIP reported unavailable)
//   - zero console errors (blocked OpenStreetMap tiles excepted), no horizontal scroll, Plan now /
//     Cancel touch targets >= 44 px on a phone
// Screenshots (390x844 and 1440x900; dark, light, night) of the Plan tab with a plan and of a run in
// progress go to /tmp/claude-0/ui-shots/engine/. Exits 1 on any failure.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const SHOTS = opt('--shots', '/tmp/claude-0/ui-shots/engine');
const QUICK = flag('--quick');
const TILE_RE = /tile\.openstreetmap\.org/i;
const THEMES = ['dark', 'light', 'night'];
const VIEWPORTS = [{ width: 390, height: 844, touch: true }, { width: 1440, height: 900, touch: false }];

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch (e) { /* fall through to the global install */ }
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return require(path.join(globalRoot, 'playwright'));
}

function build() {
  if (flag('--no-build')) {
    const f = path.resolve(opt('--file', path.join(ROOT, 'prototype/supply-route-app.html')));
    if (!fs.existsSync(f)) throw new Error('no built file at ' + f);
    return f;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sro-engine-spec-'));
  const out = path.join(dir, 'supply-route-app.html');
  const res = execFileSync('python3', ['tools/build.py', '--quiet', '--out', out], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('build: ' + res.trim().split('\n').pop());
  return out;
}

// ---- bookkeeping ----------------------------------------------------------------------------------
const failures = [], notes = [], numbers = [];
let passed = 0, scope = '';
function check(cond, msg) {
  if (cond) { passed++; return true; }
  failures.push(scope + ': ' + msg);
  console.log('  FAIL ' + msg);
  return false;
}
function note(msg) { notes.push(scope + ': ' + msg); console.log('  note ' + msg); }
function number(msg) { numbers.push(msg); console.log('  >> ' + msg); }
function section(name) { scope = name; console.log('\n== ' + name); }

// ---- page helpers ---------------------------------------------------------------------------------
async function openApp(browser, fileUrl, vp, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, hasTouch: !!vp.touch, isMobile: !!vp.touch });
  if (opts.noWorker) await ctx.addInitScript(() => { window.Worker = undefined; });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (TILE_RE.test(t) || /ERR_FILE_NOT_FOUND|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_PROXY|Failed to load resource/.test(t)) return;
    page.errors.push(t);
  });
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  await page.goto(fileUrl);
  await page.waitForFunction(() => window.SRO && window.SRO.app && window.SRO.app.store && window.SRO.core && window.SRO.core.engine, null, { timeout: 20000 });
  await page.evaluate(() => {
    // page-side helpers
    window.__eng = {
      seen: [],
      waitPlan(n, timeoutMs) {
        const st = SRO.app.store;
        return new Promise((resolve, reject) => {
          const t0 = performance.now();
          const done = () => st.getState().plans.length >= n;
          if (done()) { resolve(performance.now() - t0); return; }
          const tm = setTimeout(() => { un(); reject(new Error('no plan #' + n + ' after ' + timeoutMs + ' ms')); }, timeoutMs);
          const un = st.subscribe(() => { if (done()) { clearTimeout(tm); un(); resolve(performance.now() - t0); } });
        });
      }
    };
    SRO.core.engine.subscribe((s) => window.__eng.seen.push({ phase: s.phase, fraction: s.fraction, bestCost: s.bestCost, method: s.method, t: performance.now(), mode: s.mode }));
  });
  return { ctx, page };
}
async function settle(page) {
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const finite = document.getAnimations().filter((a) => { const t = a.effect && a.effect.getComputedTiming(); return t && isFinite(t.endTime); });
    await Promise.all(finite.map((a) => a.finished.catch(() => null)));
  });
}
async function loadDemo(page) {
  return page.evaluate(() => {
    const st = SRO.app.store;
    const a = st.dispatch({ type: 'samples/load' });
    const b = st.dispatch({ type: 'request/submit', request: {
      unitName: '2nd PLT, B CO, 1-12 IN', designator: '2/B/1-12IN', lat: 24.15, lon: 120.68, mobility: 'mounted',
      urgencyRequested: 'Priority', nlt: 360 + 20 * 60,
      lines: [{ classId: 'III', itemId: 'diesel', qty: 400, unit: 'gal' }, { classId: 'I', itemId: 'mre', qty: 20, unit: 'case' }] } });
    return { samples: (a.ids || []).length, user: b.ok, pending: SRO.core.engine.pendingRequests(st.getState()).length };
  });
}
async function toPlanTab(page, theme) {
  await page.evaluate((th) => {
    const st = SRO.app.store;
    st.dispatch({ type: 'role/set', role: 'planner' });
    st.dispatch({ type: 'tab/set', tab: 'plan' });
    if (th) st.dispatch({ type: 'theme/set', theme: th });
  }, theme || null);
  await settle(page);
}
// a stored plan's shape: legs with encoded paths that decode near their nodes
const planReport = (page, id) => page.evaluate((pid) => {
  const p = SRO.app.store.getState().plans.find((x) => x.id === pid);
  if (!p) return null;
  const E = SRO.core.engine, G = SRO.core.geo;
  let legs = 0, withPath = 0, decoded = 0;
  p.routes.forEach((rt) => rt.legs.forEach((l) => {
    legs++;
    if (typeof l.path === 'string' && l.path.length > 4) withPath++;
    const c = E.legCoords(l);
    if (c && c.length >= 2 && isFinite(c[0][0]) && G.polylineLength(c) > 0.2 * l.miles) decoded++;
  }));
  return { id: p.id, method: p.method, approved: p.approved, cancelled: p.cancelled, compareId: p.compareId, parentPlanId: p.parentPlanId,
    routes: p.routes.length, stops: p.stats.stops, trucks: p.stats.trucksUsed, delayed: p.stats.delayed, legs, withPath, decoded,
    byRequest: Object.keys(p.byRequest || {}).length, bytes: JSON.stringify(p).length, runtimeSec: p.runtimeSec, cost: p.cost.total,
    params: !!(p.params && typeof p.params === 'object' && Object.keys(p.params).length) };
}, id);
const engStatus = (page) => page.evaluate(() => SRO.core.engine.status());
async function waitIdle(page, ms = 120000) {
  await page.waitForFunction(() => !SRO.core.engine.busy(), null, { timeout: ms });
}
async function noOverflow(page) {
  return page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
}

// ---- scenarios ----------------------------------------------------------------------------------
async function workerAndPlanNow(browser, url) {
  section('worker start + Plan now (default method, default settings)');
  const { ctx, page } = await openApp(browser, url, VIEWPORTS[1]);
  const demo = await loadDemo(page);
  check(demo.samples === 19 && demo.user && demo.pending === 20, 'samples loaded: ' + JSON.stringify(demo));
  await toPlanTab(page, 'dark');
  // the worker warms up 1.5 s after boot
  await page.waitForFunction(() => SRO.core.engine.status().mode === 'worker' && SRO.core.engine.status().highsReady !== null, null, { timeout: 30000 }).catch(() => null);
  const s0 = await engStatus(page);
  check(s0.mode === 'worker', 'solver runs in a Blob worker (mode ' + s0.mode + ')');
  check(s0.highsReady === true, 'HiGHS loaded in the worker');
  const methods = await page.evaluate(() => SRO.core.engine.methods());
  check(methods.some((m) => m.key === 'tabu' && m.available), 'Tabu search available');
  note('methods: ' + methods.map((m) => m.key + (m.available ? '' : ' (unavailable)')).join(', '));
  const settings = await page.evaluate(() => { const s = SRO.app.store.getState().scenario.settings; return { method: s.method, timeLimitSec: s.timeLimitSec }; });
  const btn = page.locator('[data-testid="plan-now"]').first();
  let ms;
  if (await btn.count() && await btn.isVisible()) {
    const wait = page.evaluate(() => window.__eng.waitPlan(1, 120000));
    await btn.click();
    ms = await wait;
  } else {
    note('Plan tab has no Plan now button; used window/planNow');
    ms = await page.evaluate(async () => { const w = window.__eng.waitPlan(1, 120000); SRO.app.store.dispatch({ type: 'window/planNow' }); return w; });
  }
  await waitIdle(page);
  const st = await engStatus(page);
  const rep = await planReport(page, st.planId);
  check(!!rep, 'plan stored (' + st.planId + ')');
  if (rep) {
    check(rep.approved === false, 'stored unapproved');
    check(rep.method === settings.method, 'method = settings.method (' + rep.method + ')');
    check(rep.legs > 0 && rep.withPath === rep.legs, 'every leg has an encoded road path (' + rep.withPath + '/' + rep.legs + ')');
    check(rep.decoded === rep.legs, 'every path decodes to a road line');
    check(rep.byRequest === 20, 'byRequest covers the 20 requests (' + rep.byRequest + ')');
    number('Plan now -> stored plan, default method ' + settings.method + ' (time limit ' + settings.timeLimitSec + ' s): ' + (ms / 1000).toFixed(1) +
      ' s wall; solver ' + rep.runtimeSec + ' s; ' + rep.trucks + ' trucks, ' + rep.stops + ' stops, ' + rep.delayed + ' requests delayed; plan JSON ' + rep.bytes + ' B');
    check(ms < 60000, 'under a minute (' + (ms / 1000).toFixed(1) + ' s)');
  }
  const seen = await page.evaluate(() => window.__eng.seen.filter((s) => s.phase === 'running'));
  check(seen.length >= 5, 'progress updates reached subscribers (' + seen.length + ')');
  check(seen.some((s) => typeof s.bestCost === 'number'), 'progress carries the best cost');
  const gaps = seen.slice(1).map((s, i) => s.t - seen[i].t);
  if (gaps.length) number('progress updates: ' + seen.length + ', largest gap ' + Math.round(Math.max(...gaps)) + ' ms');
  check(st.phase === 'done' && st.history.length >= 1, 'status done with a cost history');
  // the Plan tab shows it
  const name = await page.locator('[data-testid="plan-name"]').first().textContent().catch(() => null);
  if (name) check(name.length > 0, 'Plan tab shows the plan name'); else note('Plan tab shows no plan-name element');
  const storage = await page.evaluate(() => { let n = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); n += (localStorage.getItem(k) || '').length; } return n; });
  number('localStorage after 1 plan: ' + storage + ' chars');
  check(page.errors.length === 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

const FAST = {
  tabu: { iterations: 600 },
  sa: { coolingRate: 0.95, itersPerTemp: 40, reheats: 0 },
  aco: { ants: 6, iterations: 10 },
  mip: { mipGap: 0.05 }
};

async function eachMethod(browser, url) {
  section('each registered method with a short time cap');
  const { ctx, page } = await openApp(browser, url, VIEWPORTS[1]);
  await loadDemo(page);
  // wait for the worker so availability (MIP, methods not in the build) is known
  await page.waitForFunction(() => SRO.core.engine.status().highsReady !== null, null, { timeout: 30000 }).catch(() => null);
  const methods = await page.evaluate(() => SRO.core.engine.methods());
  const list = methods.filter((m) => m.available);
  check(list.length >= 1, 'methods available: ' + list.map((m) => m.key).join(', '));
  for (const m of methods.filter((x) => !list.some((y) => y.key === x.key))) note(m.key + ' not available: ' + m.reason);
  let n = 0;
  for (const m of list) {
    const before = await page.evaluate(() => window.__eng.seen.length);
    const t0 = Date.now();
    const res = await page.evaluate(async ({ key, params }) => {
      try { const p = await SRO.core.engine.run({ method: key, params, timeCapSec: 5 }); return { id: p && p.id }; } catch (e) { return { error: e.message }; }
    }, { key: m.key, params: FAST[m.key] || {} });
    const dt = (Date.now() - t0) / 1000;
    if (!check(!res.error && res.id, m.key + ': plan stored' + (res.error ? ' (' + res.error + ')' : ''))) continue;
    n++;
    const rep = await planReport(page, res.id);
    check(rep.method === m.key, m.key + ': plan.method');
    check(rep.withPath === rep.legs && rep.legs > 0, m.key + ': legs with road paths ' + rep.withPath + '/' + rep.legs);
    check(dt < 5 + 20, m.key + ': respects the 5 s cap (' + dt.toFixed(1) + ' s)');
    const prog = await page.evaluate((b) => window.__eng.seen.slice(b).filter((s) => s.phase === 'running').length, before);
    check(prog >= 2, m.key + ': progress updates (' + prog + ')');
    number(m.key + ' (5 s cap): ' + dt.toFixed(1) + ' s wall, cost ' + Math.round(rep.cost) + ', ' + rep.trucks + ' trucks, ' + rep.stops + ' stops, ' + rep.delayed + ' delayed');
  }
  check(await page.evaluate((k) => SRO.app.store.getState().plans.length === k, n), 'one stored plan per run');
  check(page.errors.length === 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

async function cancelKeepsBest(browser, url) {
  section('Cancel keeps the best plan so far');
  const { ctx, page } = await openApp(browser, url, VIEWPORTS[0]);
  await loadDemo(page);
  // a long run: many iterations, 60 s cap
  await page.evaluate(() => {
    const st = SRO.app.store;
    st.dispatch({ type: 'settings/update', path: 'methodParams.tabu', value: { iterations: 100000 } });
    st.dispatch({ type: 'settings/update', path: 'timeLimitSec', value: 60 });
  });
  await toPlanTab(page, 'dark');
  const btn = page.locator('[data-testid="plan-now"]').first();
  const viaUi = (await btn.count()) > 0 && await btn.isVisible();
  let runP = null;
  if (viaUi) {
    const bb = await btn.boundingBox();
    check(bb && bb.height >= 44 && bb.width >= 44, 'Plan now touch target ' + (bb ? Math.round(bb.width) + 'x' + Math.round(bb.height) : 'none'));
    await btn.click();
  } else {
    note('no Plan now button: using engine.run');
    runP = page.evaluate(() => SRO.core.engine.run({ method: 'tabu' }).then((p) => p && p.id, (e) => 'error ' + e.message));
  }
  await page.waitForFunction(() => { const s = SRO.core.engine.status(); return s.phase === 'running' && typeof s.bestCost === 'number' && s.elapsedSec > 2; }, null, { timeout: 60000 });
  // screenshot of a run in progress (phone)
  await settle(page);
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'phone-dark-running.png') });
  const cbtn = page.locator('[data-testid="cancel"]').first();
  const t0 = Date.now();
  if (viaUi && await cbtn.count() && await cbtn.isVisible()) {
    const bb = await cbtn.boundingBox();
    check(bb && bb.height >= 44, 'Cancel touch target ' + (bb ? Math.round(bb.width) + 'x' + Math.round(bb.height) : 'none'));
    await cbtn.click();
  } else {
    if (viaUi) note('no visible Cancel button: using engine.cancel');
    await page.evaluate(() => SRO.core.engine.cancel());
  }
  await waitIdle(page, 20000);
  const cancelMs = Date.now() - t0;
  if (runP) await runP;
  const st = await engStatus(page);
  check(st.phase === 'cancelled', 'status cancelled (' + st.phase + ')');
  const rep = st.planId ? await planReport(page, st.planId) : null;
  check(rep && rep.cancelled === true, 'best plan so far stored with cancelled: true');
  if (rep) {
    check(rep.withPath === rep.legs && rep.legs > 0, 'cancelled plan has road paths');
    check(rep.byRequest === 20, 'cancelled plan indexes every request');
    check(rep.params, 'cancelled plan records the method settings it ran with');
    number('Cancel -> stored plan: ' + cancelMs + ' ms; kept plan cost ' + Math.round(rep.cost) + ' after ' + rep.runtimeSec + ' s');
  }
  // the worker comes back for the next run
  const next = await page.evaluate(async () => {
    const p = await SRO.core.engine.run({ method: 'tabu', params: { iterations: 300 }, timeCapSec: 5 });
    return { id: p && p.id, mode: SRO.core.engine.status().mode, cancelled: p && p.cancelled };
  });
  check(next.id && next.mode === 'worker' && !next.cancelled, 'next run works on a fresh worker (' + JSON.stringify(next) + ')');
  const ov = await noOverflow(page);
  check(ov.doc <= ov.vw, 'no horizontal scroll on the phone (' + ov.doc + ' > ' + ov.vw + ')');
  check(page.errors.length === 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

async function compareMethods(browser, url) {
  section('compare: one plan per method');
  const { ctx, page } = await openApp(browser, url, VIEWPORTS[1]);
  await loadDemo(page);
  await page.waitForFunction(() => SRO.core.engine.status().highsReady !== null, null, { timeout: 30000 }).catch(() => null);
  const keys = (await page.evaluate(() => SRO.core.engine.methods())).filter((m) => m.available).map((m) => m.key);
  const t0 = Date.now();
  const res = await page.evaluate(async ({ keys, params }) => {
    const methodsSeen = new Set();
    const un = SRO.core.engine.subscribe((s) => { if (s.phase === 'running' && s.method) methodsSeen.add(s.method); });
    try {
      const plans = await SRO.core.engine.compare(keys, { params, timeCapSec: 5 });
      return { plans: plans.map((p) => ({ id: p.id, method: p.method, compareId: p.compareId, total: p.cost.total })), seen: [...methodsSeen], status: SRO.core.engine.status() };
    } catch (e) { return { error: e.message }; } finally { un(); }
  }, { keys, params: FAST });
  if (check(!res.error, 'compare ran' + (res.error ? ': ' + res.error : ''))) {
    check(res.plans.length === keys.length, 'one plan per method (' + res.plans.map((p) => p.method).join(', ') + ' for ' + keys.join(', ') + ')');
    check(new Set(res.plans.map((p) => p.compareId)).size === 1 && !!res.plans[0].compareId, 'one compareId');
    check(keys.every((k) => res.seen.includes(k)), 'progress named each method (' + res.seen.join(', ') + ')');
    check(res.status.phase === 'done' && res.status.planIds.length === keys.length, 'status lists the plan ids');
    const stored = await page.evaluate(() => SRO.app.store.getState().plans.length);
    check(stored === keys.length, 'stored ' + stored + ' plans');
    number('compare ' + keys.join(' + ') + ' (5 s cap each): ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s; totals ' + res.plans.map((p) => p.method + ' ' + Math.round(p.total)).join(', '));
  }
  // Cancel during a compare: plans of finished methods stay, the running method's best is kept
  const heur = keys.filter((k) => k !== 'mip');
  if (heur.length >= 2) {
    const res2 = await page.evaluate(async ({ keys }) => {
      const E = SRO.core.engine, st = SRO.app.store;
      const n0 = st.getState().plans.length;
      // first method quick, second one long
      const params = {}; keys.forEach((k, i) => { params[k] = i === 0 ? (k === 'tabu' ? { iterations: 300 } : { coolingRate: 0.9, itersPerTemp: 20, reheats: 0 }) : (k === 'tabu' ? { iterations: 100000 } : { coolingRate: 0.99999, itersPerTemp: 2000 }); });
      const p = E.compare(keys, { params, timeCapSec: 60 });
      await new Promise((resolve) => { const un = E.subscribe((s) => { if (s.phase === 'running' && s.method === keys[1] && s.elapsedSec > 1.5 && typeof s.bestCost === 'number') { un(); resolve(); } }); });
      await new Promise((r) => setTimeout(r, 600));
      await E.cancel();
      const plans = await p;
      const added = st.getState().plans.slice(n0);
      return { n: plans.length, methods: plans.map((x) => x.method), cancelled: plans.map((x) => !!x.cancelled), ids: new Set(added.map((x) => x.compareId)).size, phase: E.status().phase };
    }, { keys: heur.slice(0, 2) });
    check(res2.phase === 'cancelled', 'compare cancelled');
    check(res2.n === 2 && res2.methods.join() === heur.slice(0, 2).join(), 'finished method kept + running method best kept (' + res2.methods.join(', ') + ')');
    check(res2.cancelled.join() === 'false,true', 'only the stopped method is marked cancelled');
    check(res2.ids === 1, 'same compareId');
  }
  check(page.errors.length === 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

async function contingency(browser, url) {
  section('contingency: truck out + closed road + replan');
  const { ctx, page } = await openApp(browser, url, VIEWPORTS[1]);
  await loadDemo(page);
  const res = await page.evaluate(async () => {
    const st = SRO.app.store, E = SRO.core.engine, G = SRO.core.geo;
    const p1 = await E.run({ method: 'tabu', params: { iterations: 600 }, timeCapSec: 5 });
    st.dispatch({ type: 'plan/approve', planId: p1.id });
    const ap = st.getState().plans.find((p) => p.id === p1.id);
    const firsts = ap.routes.filter((r) => r.stops.length).map((r) => r.stops[0].arrive).sort((a, b) => a - b);
    const now = Math.ceil(firsts[1] + 1);
    st.dispatch({ type: 'clock/tick', simMin: now });
    const out = ap.routes.find((r) => r.stops.some((s) => s.arrive > now));
    st.dispatch({ type: 'truck/markOut', truckId: out.truckId, reason: 'Blown tire' });
    const other = ap.routes.find((r) => r.truckId !== out.truckId && r.legs.length > 1 && r.stops.some((s) => s.arrive > now));
    const c = E.legCoords(other.legs[other.legs.length - 1]);
    const mid = c[Math.floor(c.length / 2)];
    const z = st.dispatch({ type: 'zone/add', zone: { kind: 'closed', lat: mid[0], lon: mid[1], radiusMi: 1, label: 'Bridge out' } });
    const t0 = performance.now();
    let p2;
    try { p2 = await E.replan({ reason: 'Blown tire; bridge out', params: { iterations: 600 }, timeCapSec: 5 }); } catch (e) { return { error: e.message }; }
    const ms = performance.now() - t0;
    const zone = { lat: mid[0], lon: mid[1], radiusMi: 1 };
    const crossing = [];
    p2.routes.forEach((r) => r.legs.forEach((l) => { if (l.depart >= now && G.polylineIntersectsCircle(E.legCoords(l), zone)) crossing.push(r.truckId + ' ' + l.fromKey + '>' + l.toKey); }));
    const doneBefore = ap.routes.flatMap((r) => r.stops.filter((s) => s.arrive <= now).map((s) => r.truckId + '@' + s.nodeKey));
    const doneAfter = p2.routes.flatMap((r) => r.stops.filter((s) => s.done).map((s) => r.truckId + '@' + s.nodeKey));
    const outNew = p2.routes.filter((r) => r.truckId === out.truckId).flatMap((r) => r.stops.filter((s) => !s.done)).length;
    const enroute = p2.routes.filter((r) => r.preloaded).map((r) => r.truckId);
    // what the platoon sergeant reads: per line, delivered (done or planned) + deferred = requested
    const lineMiss = [];
    st.getState().requests.forEach((r) => {
      const e = p2.byRequest[r.id];
      if (!e) { lineMiss.push(r.id + ' missing'); return; }
      r.lines.forEach((l, i) => { const got = (e.qtyByLine[i] || 0) + (e.deferredQty[i] || 0); if (Math.abs(got - l.qty) > 1e-6) lineMiss.push(r.id + '#' + i + ' ' + got + '/' + l.qty); });
    });
    const ok = st.dispatch({ type: 'plan/approve', planId: p2.id });
    const updated = st.getState().requests.filter((r) => r.updated).map((r) => r.id);
    return { ms, zoneOk: z.ok, p1: p1.id, p2: p2.id, parent: p2.parentPlanId, crossing, lineMiss, missingDone: doneBefore.filter((d) => !doneAfter.includes(d)), outNew, enroute,
      approved: ok.ok, superseded: st.getState().plans.find((p) => p.id === p1.id).superseded, changes: (p2.changes || []).length, updated, warnings: p2.warnings };
  });
  if (!check(!res.error, 'replan ran' + (res.error ? ': ' + res.error : ''))) { await ctx.close(); return; }
  check(res.zoneOk, 'closed zone added');
  check(res.parent === res.p1, 'parentPlanId = the approved plan');
  check(res.missingDone.length === 0, 'done stops kept (' + res.missingDone.join(', ') + ')');
  check(res.outNew === 0, 'the truck marked out gets no new stops');
  check(res.enroute.length >= 1, 'en-route trucks continue from their next stop (' + res.enroute.join(', ') + ')');
  check(res.crossing.length === 0, 'no new leg crosses the closed road (' + res.crossing.join(', ') + ')');
  check(res.approved && res.superseded, 're-plan approved, old plan superseded');
  check(res.lineMiss.length === 0, 'every request line adds up in the re-plan (' + res.lineMiss.slice(0, 4).join(', ') + ')');
  const rep = await planReport(page, res.p2);
  check(rep.withPath === rep.legs, 're-plan legs carry road paths');
  number('replan (5 s cap): ' + (res.ms / 1000).toFixed(1) + ' s; ' + res.changes + ' requests changed; flagged updated on approval: ' + (res.updated.join(', ') || 'none'));
  check(page.errors.length === 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

async function secondBatch(browser, url) {
  section('a second batch in the same window keeps the first approved');
  const { ctx, page } = await openApp(browser, url, VIEWPORTS[1]);
  await loadDemo(page);
  const res = await page.evaluate(async () => {
    const st = SRO.app.store, E = SRO.core.engine;
    const p1 = await E.run({ method: 'sa', params: { coolingRate: 0.95, itersPerTemp: 40, reheats: 0 }, timeCapSec: 5 });
    st.dispatch({ type: 'plan/approve', planId: p1.id });
    st.dispatch({ type: 'clock/tick', simMin: 400 });
    const sub = st.dispatch({ type: 'request/submit', request: { unitName: '3rd PLT, C CO, 1-12 IN', designator: '3/C/1-12IN', lat: 24.16, lon: 120.66,
      mobility: 'mounted', urgencyRequested: 'Routine', nlt: 1000, lines: [{ classId: 'I', itemId: 'mre', qty: 30, unit: 'case' }] } });
    let p2;
    try { p2 = await E.run({ method: 'sa', params: { coolingRate: 0.95, itersPerTemp: 40, reheats: 0 }, timeCapSec: 5 }); } catch (e) { return { error: e.message }; }
    const a = st.dispatch({ type: 'plan/approve', planId: p2.id });
    const s = st.getState();
    const first = s.plans.find((p) => p.id === p1.id);
    const sample = s.requests.find((r) => r.id === 'R-0001');
    const rp = E.requestPlan(s, 'R-0001'), mine = E.requestPlan(s, sub.id);
    return { error: null, sameWindow: p1.windowId === p2.windowId, builtOn: p2.builtOn, superseded: a.supersededPlanId, firstApproved: first.approved && !first.superseded,
      sampleStatus: sample.status, samplePlan: rp && rp.plan.id, p1: p1.id, p2: p2.id, minePlan: mine && mine.plan.id, jobs: Object.keys(p2.byRequest) };
  });
  if (!check(!res.error, 'second plan ran' + (res.error ? ': ' + res.error : ''))) { await ctx.close(); return; }
  check(res.sameWindow, 'both plans in the same window');
  check(Array.isArray(res.builtOn) && res.builtOn.includes(res.p1), 'second plan records the plan it was built on');
  check(res.superseded === null && res.firstApproved, 'approving it keeps the first batch approved');
  check(res.samplePlan === res.p1 && res.minePlan === res.p2, 'each request reads its own approved plan (' + res.samplePlan + ', ' + res.minePlan + ')');
  check(page.errors.length === 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

async function boundaryAutoPlan(browser, url) {
  section('automatic plan at a window boundary');
  const { ctx, page } = await openApp(browser, url, VIEWPORTS[1]);
  await loadDemo(page);
  const res = await page.evaluate(async () => {
    const st = SRO.app.store;
    st.dispatch({ type: 'settings/update', path: 'methodParams.tabu', value: { iterations: 400 } });
    const w = window.__eng.waitPlan(1, 120000);
    st.dispatch({ type: 'clock/tick', simMin: 721 });
    const reason = st.getState().ui.planRequestReason;
    const ms = await w;
    await new Promise((r) => setTimeout(r, 100));
    const p = st.getState().plans[0];
    return { reason, ms, id: p.id, windowId: p.windowId, approved: p.approved, requested: st.getState().ui.planRequested, phase: SRO.core.engine.status().phase };
  });
  check(res.reason === 'boundary', 'clock across 1200 asks for a plan');
  check(!!res.id && res.approved === false, 'plan stored unapproved (' + res.id + ', ' + res.windowId + ')');
  check(res.requested === false, 'plan request cleared');
  check(res.phase === 'done', 'engine done');
  number('boundary auto-plan: ' + (res.ms / 1000).toFixed(1) + ' s');
  // a second tick inside the same window does not plan again
  const again = await page.evaluate(async () => { SRO.app.store.dispatch({ type: 'clock/tick', simMin: 740 }); await new Promise((r) => setTimeout(r, 500)); return SRO.app.store.getState().plans.length; });
  check(again === 1, 'no second automatic plan inside the window');
  check(page.errors.length === 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

async function mainThreadFallback(browser, url) {
  section('no Worker: heuristics on the main thread');
  const { ctx, page } = await openApp(browser, url, VIEWPORTS[1], { noWorker: true });
  await loadDemo(page);
  const res = await page.evaluate(async () => {
    try {
      const p = await SRO.core.engine.run({ method: 'tabu', params: { iterations: 300 }, timeCapSec: 5 });
      const mip = SRO.core.engine.methods().find((m) => m.key === 'mip');
      return { id: p.id, mode: SRO.core.engine.status().mode, highs: SRO.core.engine.status().highsReady, mip: mip ? mip.available : null, paths: p.routes.every((r) => r.legs.every((l) => l.path)) };
    } catch (e) { return { error: e.message }; }
  });
  check(!res.error, 'run works' + (res.error ? ': ' + res.error : ''));
  check(res.mode === 'main', 'mode main (' + res.mode + ')');
  check(res.highs === false && res.mip === false, 'Exact (MIP) reported unavailable');
  check(res.paths, 'legs carry road paths');
  check(page.errors.length === 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}

async function screenshots(browser, url) {
  section('screenshots: Plan tab with a plan');
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const vp of VIEWPORTS) {
    const { ctx, page } = await openApp(browser, url, vp);
    await loadDemo(page);
    await page.evaluate(() => SRO.core.engine.run({ method: 'tabu', params: { iterations: 400 }, timeCapSec: 5 }));
    for (const theme of THEMES) {
      await toPlanTab(page, theme);
      await page.waitForTimeout(200);
      await settle(page);
      const tag = (vp.width < 600 ? 'phone' : 'desktop') + '-' + theme;
      await page.screenshot({ path: path.join(SHOTS, tag + '-plan.png') });
      const ov = await noOverflow(page);
      check(ov.doc <= ov.vw, tag + ': no horizontal scroll (' + ov.doc + ' > ' + ov.vw + ')');
      if (vp.width >= 1000) {
        await page.evaluate(() => SRO.app.store.dispatch({ type: 'tab/set', tab: 'map' }));
        await page.waitForTimeout(400);
        await settle(page);
        await page.screenshot({ path: path.join(SHOTS, tag + '-map.png') });
      }
    }
    check(page.errors.length === 0, (vp.width) + ': no console errors' + (page.errors.length ? ': ' + page.errors.slice(0, 3).join(' | ') : ''));
    await ctx.close();
  }
  console.log('  screenshots in ' + SHOTS);
}

async function main() {
  const file = build();
  const url = pathToFileURL(file).href;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    await workerAndPlanNow(browser, url);
    if (!QUICK) await eachMethod(browser, url);
    await cancelKeepsBest(browser, url);
    if (!QUICK) await compareMethods(browser, url);
    await contingency(browser, url);
    await secondBatch(browser, url);
    if (!QUICK) await boundaryAutoPlan(browser, url);
    await mainThreadFallback(browser, url);
    await screenshots(browser, url);
  } catch (e) {
    failures.push(scope + ': threw ' + (e && e.stack || e));
    console.log('  FAIL threw ' + (e && e.message));
  } finally {
    await browser.close();
  }
  console.log('\n' + passed + ' checks passed, ' + failures.length + ' failed');
  if (numbers.length) console.log('numbers:\n  ' + numbers.join('\n  '));
  if (notes.length) console.log('notes:\n  ' + notes.join('\n  '));
  if (failures.length) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
}
main();
