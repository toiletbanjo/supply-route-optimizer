#!/usr/bin/env node
// Browser check for the exact method (src/solver/mip.js) inside a Blob-URL Web Worker opened from
// file://, the way the built app runs it (DESIGN.md section 7, "MIP (mip.js) - verified facts"):
//
//   node tests/ui/mip-worker.spec.mjs [--limit SEC] [--keep]
//
// Writes a self-contained page to a temp folder: highs.js verbatim in <script type="text/plain"
// id="highs-js">, highs.wasm gzip -9 + base64 in #highs-wasm-gz, the solver files (ns, util, instance,
// params, evaluate, construct, localsearch, tabu if present, mip) in #worker-src. The worker source is
// highs.js + solver files + a small worker main; the wasm is inflated with DecompressionStream and loaded
// through Module({ instantiateWasm }) set as SRO.solver.mip.setLoader. Checks in headless Chromium:
//   1. init: HiGHS loads in the worker (mip.available() true), no console errors;
//   2. solve: a Phase-1-size instance (30 jobs, 8 trucks) with a time limit: progress messages arrive,
//      at least one carries the best plan, the result is violation-free, no worse than its warm start,
//      reports a status and a proven gap, and ends within 15% of the limit;
//   3. cancel: a second worker is terminated mid-solve; the last best plan it posted, scored on the main
//      thread with the same solver files, is violation-free and has exactly the cost it was posted with.
// Exits 1 on any failure. Uses the global Playwright install (PLAYWRIGHT_BROWSERS_PATH as configured).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const LIMIT = Number(opt('--limit', '15'));
const KEEP = args.includes('--keep');

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch (e) { /* fall through to the global install */ }
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return require(path.join(globalRoot, 'playwright'));
}

const SOLVER = ['src/core/ns.js', 'src/core/util.js', 'src/solver/instance.js', 'src/solver/params.js', 'src/solver/evaluate.js',
  'src/solver/construct.js', 'src/solver/localsearch.js', 'src/solver/tabu.js', 'src/solver/mip.js']
  .filter((f) => fs.existsSync(path.join(ROOT, f)));

// ---- worker main (runs inside the Blob worker after highs.js and the solver files) ------------------------
function workerMain() {
  const S = self.SRO.solver;
  async function wasmBytes(b64) {
    const bin = atob(b64.trim());
    const gz = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) gz[i] = bin.charCodeAt(i);
    const ds = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  }
  self.onmessage = async (e) => {
    const m = e.data;
    try {
      if (m.type === 'init') {
        const t0 = performance.now();
        const bytes = await wasmBytes(m.wasmGzB64);
        const t1 = performance.now();
        S.mip.setLoader(() => Module({
          instantiateWasm(imports, receive) { WebAssembly.instantiate(bytes, imports).then((r) => receive(r.instance)); return {}; }
        }));
        await S.mip.ready();
        postMessage({ type: 'ready', highs: S.mip.available(), decodeMs: t1 - t0, instantiateMs: performance.now() - t1 });
      } else if (m.type === 'solve') {
        const inst = S.makeTestInstance(m.seed, m.opts);
        const res = S.methods.mip.run(inst, S.clampParams('mip', m.params), {
          onProgress(p) {
            postMessage({ type: 'progress', fraction: p.fraction, bestCost: p.bestCost, gap: p.gap, elapsedSec: p.elapsedSec, message: p.message, best: p.best || null });
          }
        });
        const ev = S.evaluate(inst, res.solution);
        postMessage({ type: 'done', result: { total: res.total, feasible: ev.feasible, evalTotal: ev.total, stopReason: res.stopReason, elapsedSec: res.elapsedSec, extra: res.extra } });
      }
    } catch (err) { postMessage({ type: 'error', message: String((err && err.stack) || err) }); }
  };
}

// ---- page -------------------------------------------------------------------------------------------------
function pageScript() {
  const $ = (id) => document.getElementById(id);
  const st = window.__mip = { runs: {} };
  const url = URL.createObjectURL(new Blob([$('highs-js').textContent + '\n;\n' + $('worker-src').textContent + '\n;(' + $('worker-main').textContent + ')();'], { type: 'text/javascript' }));
  // the same solver files on the main thread, to score posted plans independently
  const sc = document.createElement('script');
  sc.textContent = $('worker-src').textContent;
  document.head.appendChild(sc);
  window.startRun = function (name, msg) {
    const run = st.runs[name] = { progress: 0, bests: 0, lastBest: null, lastBestCost: null, done: null, error: null, ready: null, t0: performance.now(), fractions: [] };
    const w = new Worker(url);
    run.worker = w;
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'ready') { run.ready = d; w.postMessage(msg); }
      else if (d.type === 'progress') {
        run.progress++; run.fractions.push(d.fraction);
        // HiGHS phase: progress from inside the MIP solve (not the warm-start heuristic pass)
        if (d.message && !/^(Warm start|Start plan)/.test(d.message)) run.inHighs = (run.inHighs || 0) + 1;
        if (d.best) { run.bests++; run.lastBest = d.best; run.lastBestCost = d.bestCost; if (run.inHighs) run.highsBests = (run.highsBests || 0) + 1; }
        run.lastGap = d.gap;
      } else if (d.type === 'done') { run.done = d.result; run.wallSec = (performance.now() - run.t0) / 1000; w.terminate(); }
      else if (d.type === 'error') run.error = d.message;
    };
    w.onerror = (e) => { run.error = 'worker error: ' + e.message; };
    w.postMessage({ type: 'init', wasmGzB64: $('highs-wasm-gz').textContent });
  };
  window.cancelRun = function (name) {
    const run = st.runs[name];
    run.worker.terminate();
    run.cancelled = true;
    const S = window.SRO.solver;
    const inst = S.makeTestInstance(run.seed, run.opts);
    const ev = run.lastBest ? S.evaluate(inst, run.lastBest) : null;
    return { bests: run.bests, progress: run.progress, inHighs: run.inHighs || 0, highsBests: run.highsBests || 0, postedCost: run.lastBestCost, feasible: ev ? ev.feasible : null, total: ev ? ev.total : null };
  };
}

function buildPage(dir) {
  const highsJs = fs.readFileSync(path.join(ROOT, 'node_modules/highs/build/highs.js'), 'utf8');
  const wasm = fs.readFileSync(path.join(ROOT, 'node_modules/highs/build/highs.wasm'));
  const gzB64 = zlib.gzipSync(wasm, { level: 9 }).toString('base64');
  const src = SOLVER.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
  for (const [name, text] of [['highs.js', highsJs], ['solver files', src]]) {
    if (/<\/script/i.test(text) || text.includes('<!--')) throw new Error(name + ' contains </script or <!-- and cannot be inlined');
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MIP worker check</title><style>body{background:#fff;color:#111;font:14px system-ui;margin:16px}</style></head><body><p>MIP worker check</p>
<script type="text/plain" id="highs-js">${highsJs}</script>
<script type="text/plain" id="highs-wasm-gz">${gzB64}</script>
<script type="text/plain" id="worker-src">${src}</script>
<script type="text/plain" id="worker-main">${workerMain.toString()}</script>
<script>(${pageScript.toString()})();</script>
</body></html>`;
  const file = path.join(dir, 'mip-worker-check.html');
  fs.writeFileSync(file, html);
  return { file, bytes: html.length, gzB64: gzB64.length };
}

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); console.log((ok ? 'ok   ' : 'FAIL ') + msg); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sro-mip-'));
const page0 = buildPage(dir);
console.log(`page ${page0.file} (${(page0.bytes / 1e6).toFixed(2)} MB, wasm gzip+base64 ${(page0.gzB64 / 1e6).toFixed(2)} MB)`);
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(page0.file).href);

  // 1 + 2: a full solve
  const P1 = { nJobs: 30, nVehicles: 8, nRally: 8, nHubs: 3, twoJobShare: 0.5, maxRallyPoints: 4 };
  await page.evaluate(([p1, limit]) => {
    window.startRun('full', { type: 'solve', seed: 1, opts: p1, params: { timeLimitSec: limit, mipGap: 0, seed: 7 } });
  }, [P1, LIMIT]);
  await page.waitForFunction(() => { const r = window.__mip.runs.full; return r && (r.done || r.error); }, null, { timeout: (LIMIT * 1.15 + 30) * 1000 });
  const full = await page.evaluate(() => { const r = window.__mip.runs.full; return { ready: r.ready, done: r.done, error: r.error, progress: r.progress, bests: r.bests, wallSec: r.wallSec, fractions: r.fractions }; });
  check(!full.error, 'solve finished without a worker error' + (full.error ? ': ' + full.error : ''));
  check(full.ready && full.ready.highs === true, `HiGHS loaded in the Blob worker (decode ${full.ready && full.ready.decodeMs.toFixed(0)} ms, instantiate ${full.ready && full.ready.instantiateMs.toFixed(0)} ms)`);
  if (full.done) {
    const r = full.done, x = r.extra;
    check(r.feasible === true, 'MIP plan is violation-free');
    check(r.total <= x.startTotal + 1e-9, `no worse than the warm start (${r.total.toFixed(1)} <= ${x.startTotal.toFixed(1)})`);
    check(typeof x.status === 'string' && x.status !== 'Not run', 'status reported: ' + x.status);
    check(typeof x.mipGap === 'number' && x.mipGap >= 0 && x.mipGap < 1, 'proven gap reported: ' + (x.mipGap * 100).toFixed(2) + '%');
    check(r.elapsedSec <= LIMIT * 1.15, `time limit honored (${r.elapsedSec.toFixed(2)} s of ${LIMIT} s)`);
    check(full.progress >= 5 && full.bests >= 1, `progress messages ${full.progress}, with best plan ${full.bests}`);
    check(full.fractions.every((f, i) => i === 0 || f >= full.fractions[i - 1]), 'progress fraction never goes back');
    console.log(`     model ${x.rows} rows, ${x.cols} cols, ${x.binaries} binaries; start ${x.startTotal.toFixed(1)} (${x.startFrom}) -> ${r.total.toFixed(1)}; ` +
      `bound ${x.dualBound && x.dualBound.toFixed(1)}; start accepted ${x.startAccepted}; nodes ${x.nodes}`);
  } else check(false, 'solve returned a result');

  // 3: cancel mid-solve, while HiGHS runs (after the warm-start pass, which is 10 s of a 120 s limit)
  await page.evaluate(([p1]) => {
    window.__mip.runs.cancel = null;
    window.startRun('cancel', { type: 'solve', seed: 2, opts: p1, params: { timeLimitSec: 120, mipGap: 0, seed: 7 } });
    window.__mip.runs.cancel.seed = 2; window.__mip.runs.cancel.opts = p1;
  }, [P1]);
  await page.waitForFunction(() => { const r = window.__mip.runs.cancel; return r && ((r.bests >= 1 && r.inHighs >= 1) || r.error); }, null, { timeout: 90000 });
  await page.waitForTimeout(3000);
  const t0 = Date.now();
  const can = await page.evaluate(() => window.cancelRun('cancel'));
  const cancelMs = Date.now() - t0;
  check(can.bests >= 1, `cancel: ${can.bests} best plan(s) were posted before terminate()`);
  check(can.inHighs >= 1, `cancel: terminate() came while HiGHS was solving (${can.inHighs} progress messages from the MIP phase, ${can.highsBests} with a new best plan)`);
  check(can.feasible === true, 'cancel: the last posted plan is violation-free on the main thread');
  check(can.total != null && Math.abs(can.total - can.postedCost) <= 1e-6 * Math.max(1, can.postedCost), `cancel: posted cost ${can.postedCost && can.postedCost.toFixed(1)} = main-thread evaluate ${can.total && can.total.toFixed(1)} (cancel round trip ${cancelMs} ms)`);
  await page.waitForTimeout(500);
  check(errors.length === 0, 'zero console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
} finally {
  await browser.close();
  if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
}
if (failures.length) { console.log(failures.length + ' check(s) failed'); process.exit(1); }
console.log('all MIP worker checks passed');
