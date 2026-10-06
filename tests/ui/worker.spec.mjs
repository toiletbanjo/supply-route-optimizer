#!/usr/bin/env node
// Browser check of the solver Web Worker (src/solver/worker-main.js + the 'worker' manifest group +
// HiGHS) from a file:// page in headless Chromium. Plain node script:
//
//   node tests/ui/worker.spec.mjs [--assemble] [--require-mip] [--keep]
//
// The page is assembled the way the app is: python3 tools/build.py --out <tmp> writes the three
// <script type="text/plain"> blocks (#highs-js, #highs-wasm-gz, #worker-src) and this script copies
// them into a small harness page (so the check does not depend on the UI modules). --assemble builds
// the blocks here instead (manifest order, same .json wrapping, gzip -9 + base64), e.g. when build.py
// is broken. The harness starts the Blob-URL worker exactly like the app: highs.js text + worker source.
//
// Checks:
//   - init: HiGHS decoded with DecompressionStream, instantiated, self-test solved (ready.highs)
//   - every available heuristic: solve over the protocol, progress at least every ~300 ms (max gap
//     between consecutive messages), first best plan posted early, `best` only when changed, done
//     result re-evaluates to the same total in Node, feasible
//   - estimate message for each heuristic, compared with the measured run time (reduced budgets, and
//     DEFAULT params on a Phase 1 window: within 2x)
//   - the instance posted as an object holding real Infinity (structured clone, as planner-engine.js
//     sends it): a job whose every pickup point is cut off is deferred as 'closed-road'
//   - unreadable input (no instance, broken JSON) answers with a coded error in plain language
//   - cancel via worker.terminate() during a long run: no message afterwards, the last posted best plan
//     decodes to a violation-free plan whose cost equals the posted bestCost; the same during a compare
//     run (the finished method's row and the running method's last best both re-evaluate)
//   - MIP (when mip.js is in the build): solve with a 5 s limit and a compare run (heuristic, then MIP
//     seeded with its plan), proven gap reported. Without mip.js only HiGHS init + self-test are
//     checked (a note, or a failure with --require-mip).
//   - a broken wasm and a worker source without highs.js report highs:false and heuristics still work;
//     MIP then answers with a clear error
//   - zero page errors / console errors
// Exits 1 on any failure.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadGroup, wrapSource } from '../load.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const MAX_GAP_MS = 300;          // contract: progress at least every 250 ms (+ message latency)
const GAP_SLACK_MS = 50;         // scheduling noise on a loaded machine

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch (e) { /* fall through to the global install */ }
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return require(path.join(globalRoot, 'playwright'));
}

// ---- bookkeeping ----------------------------------------------------------------------------------
const failures = [], notes = [];
let passed = 0, scope = '';
function check(cond, msg) {
  if (cond) { passed++; return true; }
  failures.push(scope + ': ' + msg);
  console.log('  FAIL ' + msg);
  return false;
}
function note(msg) { notes.push(scope + ': ' + msg); console.log('  note ' + msg); }
function section(name) { scope = name; console.log('\n== ' + name); }

// ---- the three text/plain blocks ------------------------------------------------------------------
function extract(html, id) {
  const re = new RegExp('<script type="text/plain" id="' + id + '">([\\s\\S]*?)</script>');
  const m = re.exec(html);
  if (!m) throw new Error('built file has no <script type="text/plain" id="' + id + '">');
  return m[1];
}

function blocksFromBuild(dir) {
  const out = path.join(dir, 'app.html');
  const res = execFileSync('python3', ['tools/build.py', '--quiet', '--out', out], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('build: ' + res.trim().split('\n').pop());
  const html = fs.readFileSync(out, 'utf8');
  return { highsJs: extract(html, 'highs-js'), wasmGz: extract(html, 'highs-wasm-gz'), workerSrc: extract(html, 'worker-src'), via: 'tools/build.py' };
}

function blocksAssembled() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/manifest.json'), 'utf8'));
  const chunks = [];
  for (let f of manifest.worker) {
    f = f.replace(/\?$/, '');
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    chunks.push('/* ==== ' + f + ' ==== */\n' + wrapSource(f, fs.readFileSync(full, 'utf8')).trimEnd() + '\n;');
  }
  const workerSrc = chunks.join('\n').replace(/<\/(script)/gi, '<\\/$1');
  const highsJs = fs.readFileSync(path.join(ROOT, 'node_modules/highs/build/highs.js'), 'utf8');
  const wasmGz = zlib.gzipSync(fs.readFileSync(path.join(ROOT, 'node_modules/highs/build/highs.wasm')), { level: 9 }).toString('base64');
  return { highsJs, wasmGz, workerSrc, via: 'assembled in the spec' };
}

// ---- harness page ---------------------------------------------------------------------------------
// H.boot(opts) starts a worker (opts.highs: include highs.js; opts.wasm: what init sends) and resolves
// with the ready message. H.run(w, msg, opts) posts a request and resolves on done/error with every
// message timestamped at arrival (performance.now). opts.cancelAfterMs terminates the worker instead.
const HARNESS = String.raw`
"use strict";
const $ = (id) => document.getElementById(id);
const H = window.H = { workers: [], urls: {} };
H.url = function (withHighs) {
  const k = withHighs ? 'h' : 'n';
  if (!H.urls[k]) {
    const src = (withHighs ? $('highs-js').textContent + '\n;\n' : '') + $('worker-src').textContent;
    H.urls[k] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  }
  return H.urls[k];
};
H.boot = function (opts) {
  opts = opts || {};
  const t0 = performance.now();
  const w = new Worker(H.url(opts.highs !== false));
  const idx = H.workers.push({ w: w, listeners: [], errors: [] }) - 1;
  const rec = H.workers[idx];
  w.onmessage = (e) => { const at = performance.now(); rec.listeners.slice().forEach((f) => f(e.data, at)); };
  w.onerror = (e) => { rec.errors.push(String(e.message || e)); };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ready message within 30 s')), 30000);
    const on = (d) => {
      if (d.type !== 'ready') return;
      clearTimeout(timer);
      rec.listeners.splice(rec.listeners.indexOf(on), 1);
      resolve({ idx: idx, ready: d, ms: performance.now() - t0 });
    };
    rec.listeners.push(on);
    w.postMessage({ type: 'init', wasmGzB64: opts.wasm === undefined ? $('highs-wasm-gz').textContent : opts.wasm });
  });
};
H.run = function (idx, msg, opts) {
  opts = opts || {};
  const rec = H.workers[idx];
  const msgs = [];
  const t0 = performance.now();
  return new Promise((resolve) => {
    let finished = false;
    const finish = (extra) => {
      if (finished) return;
      finished = true;
      rec.listeners.splice(rec.listeners.indexOf(on), 1);
      resolve(Object.assign({ t0: t0, msgs: msgs, wallMs: performance.now() - t0, workerErrors: rec.errors.slice() }, extra || {}));
    };
    const on = (d, at) => {
      if (d.id !== msg.id) return;
      msgs.push(Object.assign({ at: at - t0 }, d));
      if (d.type === 'done' || d.type === 'error') finish();
    };
    rec.listeners.push(on);
    // opts.reviveInstance: post the instance as an object holding real Infinity (structured clone), the
    // way planner-engine.js sends it, instead of the JSON text
    if (opts.reviveInstance && typeof msg.instance === 'string') {
      msg.instance = JSON.parse(msg.instance, (k, v) => v === '__INF__' ? Infinity : v === '__-INF__' ? -Infinity : v);
    }
    rec.w.postMessage(msg);
    // opts.cancelOn: terminate opts.cancelDelayMs after the first message of that type
    if (opts.cancelOn) {
      const onType = (d) => {
        if (d.id !== msg.id || d.type !== opts.cancelOn) return;
        rec.listeners.splice(rec.listeners.indexOf(onType), 1);
        setTimeout(() => {
          rec.w.terminate();
          const tCancel = performance.now() - t0;
          const before = msgs.length;
          setTimeout(() => finish({ cancelled: true, cancelAt: tCancel, afterTerminate: msgs.length - before }), 500);
        }, opts.cancelDelayMs || 0);
      };
      rec.listeners.push(onType);
    }
    if (opts.cancelAfterMs) {
      setTimeout(() => {
        rec.w.terminate();
        const tCancel = performance.now() - t0;
        const before = msgs.length;
        // anything arriving after terminate() would be a bug
        setTimeout(() => finish({ cancelled: true, cancelAt: tCancel, afterTerminate: msgs.length - before }), 500);
      }, opts.cancelAfterMs);
    }
    if (opts.timeoutMs) setTimeout(() => finish({ timedOut: true }), opts.timeoutMs);
  });
};
H.ok = true;
`;

function harnessPage(b) {
  for (const [k, v] of Object.entries(b)) if (k !== 'via' && /<\/script/i.test(v)) throw new Error(k + " contains '</script'");
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Worker check</title></head><body>\n' +
    '<script type="text/plain" id="highs-js">' + b.highsJs + '</script>\n' +
    '<script type="text/plain" id="highs-wasm-gz">' + b.wasmGz + '</script>\n' +
    '<script type="text/plain" id="worker-src">' + b.workerSrc + '</script>\n' +
    '<script>' + HARNESS + '</script>\n</body></html>\n';
}

// ---- analysis helpers -----------------------------------------------------------------------------
function cadence(run) {
  const prog = run.msgs.filter((m) => m.type === 'progress');
  const end = run.msgs.find((m) => m.type === 'done' || m.type === 'error');
  const times = run.msgs.filter((m) => m.type === 'progress' || m === end).map((m) => m.at);
  const seq = run.msgs.filter((m) => m.type === 'progress' || m === end);
  let maxGap = 0, at = 0, around = '';
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].at - seq[i - 1].at > maxGap) {
      maxGap = seq[i].at - seq[i - 1].at; at = seq[i - 1].at;
      around = JSON.stringify(seq[i - 1].message || seq[i - 1].type) + ' -> ' + JSON.stringify(seq[i].message || seq[i].type);
    }
  }
  return { n: prog.length, first: prog.length ? prog[0].at : null, firstBest: (prog.find((m) => m.best) || {}).at, maxGap, maxGapAt: at, around, end };
}

function checkBestOnlyWhenChanged(run) {
  const bests = run.msgs.filter((m) => m.type === 'progress' && m.best).map((m) => JSON.stringify(m.best));
  let ok = true;
  for (let i = 1; i < bests.length; i++) if (bests[i] === bests[i - 1]) ok = false;
  return ok;
}

// ---- main -----------------------------------------------------------------------------------------
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sro-worker-spec-'));
  let blocks;
  if (flag('--assemble')) blocks = blocksAssembled();
  else {
    try { blocks = blocksFromBuild(tmp); } catch (e) {
      console.log('build.py failed (' + String(e.message).split('\n')[0] + '); assembling the blocks here');
      blocks = blocksAssembled();
    }
  }
  const pageFile = path.join(tmp, 'worker-check.html');
  fs.writeFileSync(pageFile, harnessPage(blocks));
  console.log('page: ' + pageFile + ' (' + fs.statSync(pageFile).size.toLocaleString('en-US') + ' B; blocks ' + blocks.via +
    '; highs.js ' + blocks.highsJs.length.toLocaleString('en-US') + ' B, wasm gz+b64 ' + blocks.wasmGz.length.toLocaleString('en-US') + ' B, worker source ' + blocks.workerSrc.length.toLocaleString('en-US') + ' B)');

  // Node side: the same solver files, for test instances and independent re-evaluation
  const SRO = loadGroup('worker', { skipMissing: true });
  const S = SRO.solver;
  const inst = S.makeTestInstance(31, { nJobs: 30, nVehicles: 8, nRally: 8, nHubs: 3, capacity: { tanker: 7500, cargo: 30 }, deadlineMax: 900, directShare: 0.3, closedZones: 1 });
  const hasInf = inst.minutes.some((r) => r.some((x) => x === Infinity));
  const instJson = JSON.stringify(inst, SRO.util.jsonReplacer);
  const mipInst = S.makeTestInstance(32, { nJobs: 10, nVehicles: 4, nRally: 4, nHubs: 2, capacity: { tanker: 7500, cargo: 30 } });
  const mipJson = JSON.stringify(mipInst, SRO.util.jsonReplacer);
  console.log('instance: ' + inst.jobs.length + ' jobs, ' + inst.vehicles.length + ' trucks, ' + inst.nodes.length + ' nodes' + (hasInf ? ', closed roads (Infinity in the matrices)' : ''));

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e && e.stack || e).split('\n')[0]));
  await page.goto(pathToFileURL(pageFile).href, { waitUntil: 'load' });
  await page.waitForFunction(() => window.H && window.H.ok === true, null, { timeout: 15000 });
  console.log('browser: Chromium ' + browser.version() + ', origin ' + await page.evaluate(() => location.origin));

  const boot = (opts) => page.evaluate((o) => window.H.boot(o), opts || {});
  const run = (idx, msg, opts) => page.evaluate(([i, m, o]) => window.H.run(i, m, o), [idx, msg, opts || {}]);

  // ---- init ----
  section('init');
  const b = await boot({});
  const ready = b.ready;
  console.log('  ready in ' + b.ms.toFixed(0) + ' ms: highs ' + ready.highs + (ready.version ? ' ' + ready.version : '') +
    (ready.highs ? ' (decode ' + ready.decodeMs.toFixed(0) + ' ms, instantiate ' + ready.instantiateMs.toFixed(0) + ' ms, self-test ' + ready.selfTest.ms.toFixed(1) + ' ms)' : ' error: ' + ready.error));
  check(ready.highs === true, 'HiGHS loaded in the Blob worker (' + (ready.error || 'ok') + ')');
  check(ready.selfTest && ready.selfTest.objective === 5, 'HiGHS self-test solved the tiny MIP');
  check(Array.isArray(ready.methods) && ready.methods.length >= 4, 'ready lists the methods');
  const avail = (ready.methods || []).filter((m) => m.available).map((m) => m.key);
  console.log('  methods: ' + (ready.methods || []).map((m) => m.key + (m.available ? '' : ' (' + m.code + ')')).join(', '));
  const heuristics = avail.filter((k) => k !== 'mip');
  check(heuristics.length >= 1, 'at least one heuristic method is available');

  // ---- heuristics ----
  const QUICK = { tabu: { iterations: 1500 }, sa: { coolingRate: 0.98 }, aco: { iterations: 20 } };
  let lastHeuristic = null;
  let nid = 0;
  for (const m of heuristics) {
    section('solve ' + m);
    const params = QUICK[m] || {};
    const est = await run(b.idx, { type: 'estimate', id: 'est-' + (++nid), instance: instJson, method: m, params, settings: { timeLimitSec: 60 } });
    const estDone = est.msgs.find((x) => x.type === 'done');
    check(!!estDone, 'estimate answered (' + JSON.stringify(est.msgs.find((x) => x.type === 'error') || '') + ')');
    const id = 'solve-' + (++nid);
    const r = await run(b.idx, { type: 'solve', id, instance: nid % 2 ? instJson : JSON.parse(instJson), method: m, params, settings: { timeLimitSec: 60 } });
    const c = cadence(r);
    const done = c.end && c.end.type === 'done' ? c.end : null;
    if (!check(!!done, 'solve finished with done (' + JSON.stringify(c.end && c.end.message) + ')')) continue;
    const res = done.result;
    console.log('  ' + c.n + ' progress messages in ' + (r.wallMs / 1000).toFixed(2) + ' s; first after ' + c.first.toFixed(0) + ' ms, first best after ' +
      (c.firstBest == null ? '-' : c.firstBest.toFixed(0)) + ' ms, max gap ' + c.maxGap.toFixed(0) + ' ms (at ' + c.maxGapAt.toFixed(0) + ' ms, ' + c.around + ')');
    check(c.n >= 2, 'progress messages arrived');
    check(c.maxGap <= MAX_GAP_MS + GAP_SLACK_MS, 'progress at least every ~' + MAX_GAP_MS + ' ms (max gap ' + c.maxGap.toFixed(0) + ' ms)');
    check(c.first <= 1000, 'first progress within 1 s (' + c.first.toFixed(0) + ' ms)');
    check(c.firstBest != null && c.firstBest <= 1000, 'first best plan posted within 1 s');
    check(checkBestOnlyWhenChanged(r), '`best` only when it changed');
    check(r.msgs.filter((x) => x.type === 'progress').every((x) => x.fraction >= 0 && x.fraction <= 1 && typeof x.bestCost === 'number'), 'progress fields (fraction 0..1, bestCost)');
    const ev = S.evaluate(inst, res.solution);
    check(Math.abs(ev.total - res.total) <= 1e-6 * Math.max(1, Math.abs(ev.total)), 'result total re-evaluates in Node (' + res.total.toFixed(2) + ' vs ' + ev.total.toFixed(2) + ')');
    check(res.feasible === true && ev.feasible === true, 'plan is violation-free');
    check(!!res.evaluation && Array.isArray(res.explain), 'result has evaluation and explain');
    if (estDone) {
      const ratio = estDone.result.seconds / res.elapsedSec;
      console.log('  estimate ' + estDone.result.seconds.toFixed(2) + ' s [' + estDone.result.low.toFixed(2) + '-' + estDone.result.high.toFixed(2) + '] vs run ' + res.elapsedSec.toFixed(2) +
        ' s (ratio ' + ratio.toFixed(2) + ', probe ' + estDone.result.probe.ms.toFixed(0) + ' ms): ' + estDone.result.basis);
      check(ratio > 0.4 && ratio < 2.5, 'estimate within ~2x of the run (' + ratio.toFixed(2) + ')');
    }
    lastHeuristic = m;
  }

  // ---- default params: the estimate the planner sees before a normal run ----
  for (const m of heuristics.filter((k) => k === 'tabu' || k === 'sa')) {
    section('default params ' + m);
    const w = await boot({});
    const est = await run(w.idx, { type: 'estimate', id: 'dest-' + m, instance: instJson, method: m, params: {}, settings: { timeLimitSec: 300 } });
    const ed = est.msgs.find((x) => x.type === 'done');
    const r = await run(w.idx, { type: 'solve', id: 'dsolve-' + m, instance: instJson, method: m, params: {}, settings: { timeLimitSec: 300 } });
    const done = r.msgs.find((x) => x.type === 'done');
    if (check(!!ed && !!done, 'estimate and solve at default params answered')) {
      const ratio = ed.result.seconds / done.result.elapsedSec;
      const c = cadence(r);
      console.log('  estimate ' + ed.result.seconds.toFixed(2) + ' s [' + ed.result.low.toFixed(2) + '-' + ed.result.high.toFixed(2) + '] vs run ' +
        done.result.elapsedSec.toFixed(2) + ' s (ratio ' + ratio.toFixed(2) + ', probe ' + ed.result.probe.ms.toFixed(0) + ' ms); ' + c.n + ' progress messages, max gap ' + c.maxGap.toFixed(0) + ' ms');
      check(ratio > 0.5 && ratio < 2, 'default-param estimate within 2x of the run (' + ratio.toFixed(2) + ')');
      check(c.maxGap <= MAX_GAP_MS + GAP_SLACK_MS, 'progress at least every ~' + MAX_GAP_MS + ' ms at default params (max gap ' + c.maxGap.toFixed(0) + ' ms)');
    }
    await page.evaluate((i) => window.H.workers[i].w.terminate(), w.idx);
  }

  // ---- input forms and unreadable input ----
  if (heuristics.length) {
    section('input forms');
    const m = heuristics[0];
    const cutInst = JSON.parse(instJson, SRO.util.jsonReviver);
    const cut = cutInst.jobs[0].candidates.map((c) => c.node);
    for (const n of cut) for (let i = 0; i < cutInst.nodes.length; i++) if (i !== n) { cutInst.minutes[i][n] = Infinity; cutInst.minutes[n][i] = Infinity; }
    const cutJson = JSON.stringify(cutInst, SRO.util.jsonReplacer);
    const r = await run(b.idx, { type: 'solve', id: 'inf-obj', instance: cutJson, method: m, params: QUICK[m] || {}, settings: {} }, { reviveInstance: true });
    const done = r.msgs.find((x) => x.type === 'done');
    if (check(!!done, 'instance posted as an object with real Infinity is solved (' + JSON.stringify((r.msgs.find((x) => x.type === 'error') || {}).message || '') + ')')) {
      const ex0 = done.result.explain.find((x) => x.job === 0);
      check(ex0 && ex0.reason === 'closed-road', 'job with every pickup point cut off is deferred as closed-road (' + (ex0 && ex0.reason) + ')');
      const ev = S.evaluate(cutInst, done.result.solution);
      check(Math.abs(ev.total - done.result.total) <= 1e-6 * Math.max(1, Math.abs(ev.total)) && ev.feasible, 'result re-evaluates in Node on the same Infinity matrices');
    }
    for (const [id, msg] of [['no-inst', { type: 'solve', id: 'no-inst', method: m, params: {}, settings: {} }],
      ['bad-json', { type: 'solve', id: 'bad-json', method: m, instance: '{"nodes":', params: {}, settings: {} }],
      ['est-no-inst', { type: 'estimate', id: 'est-no-inst', method: m, params: {}, settings: {} }]]) {
      const e = (await run(b.idx, msg)).msgs.find((x) => x.type === 'error');
      check(!!e && e.code === 'bad-instance' && /^The plan cannot be solved: /.test(e.message), id + ' -> bad-instance in plain language (' + (e && e.code) + ': ' + (e && e.message) + ')');
    }
  }

  // ---- cancel ----
  if (heuristics.length) {
    section('cancel (terminate)');
    const m = heuristics.includes('tabu') ? 'tabu' : heuristics[0];
    const w = await boot({});
    const longParams = m === 'tabu' ? { iterations: 100000 } : m === 'sa' ? { coolingRate: 0.99999 } : { iterations: 10000 };
    const r = await run(w.idx, { type: 'solve', id: 'long', instance: instJson, method: m, params: Object.assign({ timeCapSec: 120 }, longParams), settings: {} }, { cancelAfterMs: 1500 });
    const withBest = r.msgs.filter((x) => x.type === 'progress' && x.best);
    console.log('  ' + m + ': cancelled at ' + r.cancelAt.toFixed(0) + ' ms after ' + r.msgs.length + ' messages (' + withBest.length + ' with a best plan); ' + r.afterTerminate + ' after terminate');
    check(r.cancelled && !r.msgs.some((x) => x.type === 'done'), 'run was still going when cancelled');
    check(r.afterTerminate === 0, 'no message after terminate()');
    if (check(withBest.length >= 1, 'a best plan was posted before cancel')) {
      const last = withBest[withBest.length - 1];
      const ev = S.evaluate(inst, last.best);
      console.log('  kept plan: posted bestCost ' + last.bestCost.toFixed(2) + ', re-evaluated ' + ev.total.toFixed(2) + ', feasible ' + ev.feasible);
      check(ev.feasible, 'kept plan is violation-free');
      check(Math.abs(ev.total - last.bestCost) <= 1e-6 * Math.max(1, Math.abs(ev.total)), 'kept plan cost equals the posted bestCost');
      const lastProg = r.msgs.filter((x) => x.type === 'progress').pop();
      check(lastProg.bestCost >= ev.total - 1e-6, 'no better plan was reported without its plan');
    }
    const c = cadence(r);
    check(c.maxGap <= MAX_GAP_MS + GAP_SLACK_MS, 'progress at least every ~' + MAX_GAP_MS + ' ms during the long run (max gap ' + c.maxGap.toFixed(0) + ' ms)');
  }
  if (heuristics.length >= 2) {
    section('cancel during compare');
    const [m1, m2] = heuristics;
    const w = await boot({});
    const longP = { tabu: { iterations: 100000 }, sa: { coolingRate: 0.99999 }, aco: { iterations: 10000 } };
    const r = await run(w.idx, { type: 'compare', id: 'cmp-cancel', instance: instJson, methods: [m1, m2],
      params: { [m1]: QUICK[m1] || {}, [m2]: Object.assign({ timeCapSec: 120 }, longP[m2] || {}) }, settings: {} }, { cancelOn: 'method-done', cancelDelayMs: 800 });
    const md = r.msgs.filter((x) => x.type === 'method-done').map((x) => x.row);
    const bests = r.msgs.filter((x) => x.type === 'progress' && x.best && x.method === m2);
    console.log('  ' + m1 + ' finished, ' + m2 + ' cancelled at ' + r.cancelAt.toFixed(0) + ' ms; ' + bests.length + ' best plans from ' + m2 + '; ' + r.afterTerminate + ' messages after terminate');
    check(r.cancelled && !r.msgs.some((x) => x.type === 'done'), 'compare was still running when cancelled');
    check(r.afterTerminate === 0, 'no message after terminate()');
    if (check(md.length === 1 && md[0].method === m1 && !!md[0].result, 'the finished method\'s row (with its plan) arrived before cancel')) {
      const ev = S.evaluate(inst, md[0].result.solution);
      check(Math.abs(ev.total - md[0].total) <= 1e-6 * Math.max(1, Math.abs(ev.total)) && ev.feasible, m1 + ' row re-evaluates in Node');
    }
    if (check(bests.length >= 1, m2 + ' posted a best plan before cancel')) {
      const last = bests[bests.length - 1];
      const ev = S.evaluate(inst, last.best);
      check(Math.abs(ev.total - last.bestCost) <= 1e-6 * Math.max(1, Math.abs(ev.total)) && ev.feasible, m2 + ' last best re-evaluates to its posted bestCost');
      check(typeof last.methodIndex === 'number' && last.methodCount === 2 && last.fraction >= 0.5 && last.fraction <= 1, 'compare progress carries methodIndex/methodCount and a whole-run fraction');
    }
  }

  // ---- MIP ----
  section('MIP');
  const mipReady = avail.includes('mip');
  if (!mipReady) {
    const st = (ready.methods || []).find((x) => x.key === 'mip');
    const msg = 'Exact (MIP) not available in this build (' + (st ? st.code + ': ' + st.reason : 'not listed') + '); checked HiGHS init + self-test only';
    if (flag('--require-mip')) check(false, msg); else note(msg);
    // MIP request gives a clear error
    const r = await run(b.idx, { type: 'solve', id: 'mip-x', instance: mipJson, method: 'mip', params: {}, settings: {} });
    const e = r.msgs.find((x) => x.type === 'error');
    check(!!e && /MIP|exact|build/i.test(e.message), 'MIP request answered with a clear error (' + (e && e.message) + ')');
  } else {
    const est = await run(b.idx, { type: 'estimate', id: 'mip-est', instance: mipJson, method: 'mip', params: { timeLimitSec: 5 }, settings: {} });
    const ed = est.msgs.find((x) => x.type === 'done');
    check(!!ed && /time limit/.test(ed.result.basis) && /gap/.test(ed.result.basis), 'MIP estimate states the time limit and the gap');
    if (ed) console.log('  estimate ' + ed.result.seconds.toFixed(1) + ' s: ' + ed.result.basis);
    const r = await run(b.idx, { type: 'solve', id: 'mip-1', instance: mipJson, method: 'mip', params: { timeLimitSec: 5 }, settings: {} });
    const c = cadence(r);
    const done = c.end && c.end.type === 'done' ? c.end : null;
    if (check(!!done, 'MIP solve finished (' + JSON.stringify(c.end && c.end.message) + ')')) {
      const res = done.result, ex = res.extra || {};
      console.log('  MIP: ' + (r.wallMs / 1000).toFixed(1) + ' s, status ' + ex.status + ', gap ' + (typeof ex.mipGap === 'number' ? (100 * ex.mipGap).toFixed(2) + '%' : ex.mipGap) +
        ', total ' + res.total.toFixed(2) + ', ' + c.n + ' progress messages, max gap ' + c.maxGap.toFixed(0) + ' ms');
      const ev = S.evaluate(mipInst, res.solution);
      check(Math.abs(ev.total - res.total) <= 1e-6 * Math.max(1, Math.abs(ev.total)), 'MIP plan re-evaluates in Node');
      check(ev.feasible, 'MIP plan is violation-free');
      check(ex.status != null, 'MIP reports a status');
      check(typeof ex.mipGap === 'number' && ex.mipGap >= 0, 'MIP reports a proven gap');
      if (c.maxGap > MAX_GAP_MS + GAP_SLACK_MS) note('MIP progress gap ' + c.maxGap.toFixed(0) + ' ms at ' + c.maxGapAt.toFixed(0) + ' ms, between ' + c.around + ' (the worker is blocked inside mip.js / HiGHS there)');
      check(c.maxGap <= 1000, 'MIP progress at least every 1 s');
      check(r.wallMs / 1000 <= (ed ? ed.result.high : 30) + 2, 'MIP finished within its estimate range');
    }
    if (lastHeuristic) {
      const cmp = await run(b.idx, { type: 'compare', id: 'cmp', instance: mipJson, methods: [lastHeuristic, 'mip'],
        params: { [lastHeuristic]: QUICK[lastHeuristic] || {}, mip: { timeLimitSec: 5 } }, settings: {} });
      const md = cmp.msgs.filter((x) => x.type === 'method-done').map((x) => x.row);
      const done = cmp.msgs.find((x) => x.type === 'done');
      check(md.length === 2 && md[0].method === lastHeuristic && md[1].method === 'mip', 'compare posts method-done per method, MIP last');
      if (check(!!done && done.result.length === 2, 'compare returns the table')) {
        const t = Object.fromEntries(done.result.map((x) => [x.method, x]));
        console.log('  compare: ' + done.result.map((x) => x.method + ' ' + (x.total == null ? x.error : x.total.toFixed(2)) + (x.gap != null ? ' (gap ' + (100 * x.gap).toFixed(2) + '%)' : '')).join(', ') + '; MIP started from ' + t.mip.startFrom);
        check(t.mip.startFrom === lastHeuristic, 'MIP was seeded with the heuristic plan');
        check(t.mip.total != null && t.mip.total <= t[lastHeuristic].total + 1e-6, 'seeded MIP is no worse than its start plan');
      }
    }
  }

  // ---- broken HiGHS ----
  section('HiGHS unavailable');
  const bad = await boot({ wasm: 'AAAAAAAA' });
  console.log('  broken wasm: highs ' + bad.ready.highs + ', error: ' + bad.ready.error);
  check(bad.ready.highs === false && !!bad.ready.error, 'broken wasm -> ready { highs: false, error }');
  const noH = await boot({ highs: false });
  console.log('  no highs.js: highs ' + noH.ready.highs + ', error: ' + noH.ready.error);
  check(noH.ready.highs === false && /highs\.js/.test(noH.ready.error), 'worker without highs.js -> highs: false');
  if (heuristics.length) {
    const m = heuristics[0];
    const r = await run(bad.idx, { type: 'solve', id: 'h1', instance: instJson, method: m, params: QUICK[m] || {}, settings: {} });
    check(r.msgs.some((x) => x.type === 'done' && x.result.feasible), 'heuristics still work after a failed init');
    const r2 = await run(noH.idx, { type: 'solve', id: 'h2', instance: instJson, method: m, params: QUICK[m] || {}, settings: {} });
    check(r2.msgs.some((x) => x.type === 'done' && x.result.feasible), 'heuristics work without highs.js');
  }
  const em = await run(bad.idx, { type: 'solve', id: 'h3', instance: mipJson, method: 'mip', params: {}, settings: {} });
  const err = em.msgs.find((x) => x.type === 'error');
  check(!!err && (err.code === 'mip-unavailable' || err.code === 'method-not-loaded'), 'MIP without HiGHS answers with error code ' + (err && err.code));
  if (err) console.log('  MIP error shown to the planner: ' + err.message);
  const eu = await run(bad.idx, { type: 'solve', id: 'h4', instance: instJson, method: 'nope', params: {}, settings: {} });
  check(eu.msgs.some((x) => x.type === 'error' && x.code === 'unknown-method'), 'unknown method -> error');

  section('page');
  check(consoleErrors.length === 0, 'no page or console errors' + (consoleErrors.length ? ': ' + consoleErrors.slice(0, 3).join(' | ') : ''));
  await browser.close();
  if (!flag('--keep')) fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n' + passed + ' checks passed, ' + failures.length + ' failed' + (notes.length ? ', ' + notes.length + ' note(s)' : ''));
  for (const n of notes) console.log('  note: ' + n);
  for (const f of failures) console.log('  FAIL: ' + f);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('SPEC ERROR', e); process.exit(1); });
