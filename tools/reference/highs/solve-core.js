/*
 * solve-core.js  -  runs one HiGHS MIP solve through the highs-js >=1.15 persistent API,
 * streaming incumbents / progress through onEvent. Plain script (global solveMip) + CommonJS.
 *
 *   solveMip(highs, lpText, {
 *     timeLimit: 60,            // seconds (HiGHS option time_limit)
 *     mipRelGap: 1e-4,          // HiGHS default
 *     startByName: {name: value} | null, // optional MIP start keyed by column name (missing names = 0)
 *     onEvent: (ev) => {}       // {kind:'incumbent'|'progress', t, obj, bound, gap, nodes}
 *   }) -> { status, statusCode, objective, bound, gap, nodes, runTime, firstIncumbentAt,
 *           colValue (Float64Array), colNames (HiGHS column order), dims, incumbents: [...], startAccepted }
 *
 * NOTE: when a model is read from LP text, HiGHS numbers columns in order of FIRST APPEARANCE in the
 * file (objective first, then rows). Never assume your own generation order: map by name.
 */
(function (root) {
  "use strict";
  const STATUS_NAME = { 0: "Not Set", 1: "Load error", 2: "Model error", 3: "Presolve error", 4: "Solve error",
    5: "Postsolve error", 6: "Empty", 7: "Optimal", 8: "Infeasible", 9: "Primal infeasible or unbounded",
    10: "Unbounded", 11: "Bound on objective reached", 12: "Target for objective reached", 13: "Time limit reached",
    14: "Iteration limit reached", 15: "Unknown", 16: "Solution limit reached", 17: "Interrupted by user" };

  function num(v) { return typeof v === "bigint" ? Number(v) : v; }

  function solveMip(highs, lpText, opt = {}) {
    const onEvent = opt.onEvent || (() => {});
    const model = highs.createModel({ format: "lp", data: lpText });
    const t0 = Date.now();
    try {
      model.options.set({
        output_flag: !!opt.log,
        time_limit: opt.timeLimit ?? 60,
        mip_rel_gap: opt.mipRelGap ?? 1e-4,
        random_seed: opt.seed ?? 0,
      });
      if (opt.extraOptions) model.options.set(opt.extraOptions);
      const dims0 = model.getDimensions();
      const colNames = new Array(dims0.numCols);
      for (let i = 0; i < dims0.numCols; i++) colNames[i] = model.getColName(i);
      let startAccepted = null;
      if (opt.startByName) {
        const v = new Float64Array(dims0.numCols);
        for (let i = 0; i < dims0.numCols; i++) v[i] = opt.startByName[colNames[i]] || 0;
        startAccepted = model.setSolution({ colValue: v });
      }
      const C = highs.constants.callbackType;
      const incumbents = [];
      let firstIncumbentAt = null, lastProgress = 0;
      const cb = {
        [C.mipImprovingSolution](ev) {
          const d = ev.data;
          const rec = { kind: "incumbent", t: d.running_time, wall: (Date.now() - t0) / 1000, obj: d.objective_function_value,
            bound: d.mip_dual_bound, gap: d.mip_gap, nodes: num(d.mip_node_count) };
          if (firstIncumbentAt === null) firstIncumbentAt = rec.t;
          incumbents.push(rec);
          // mip_solution is a detached Float64Array copy: safe to post to the UI thread
          onEvent(Object.assign({ colValue: d.mip_solution }, rec));
        },
        // mipInterrupt fires whether or not output_flag is on (mipLogging only fires when output_flag=true),
        // so use it for the progress bar as well as for optional early stopping.
        [C.mipInterrupt](ev) {
          const d = ev.data;
          const now = Date.now();
          if (now - lastProgress >= 250) {
            lastProgress = now;
            onEvent({ kind: "progress", t: d.running_time, obj: d.mip_primal_bound, bound: d.mip_dual_bound, gap: d.mip_gap,
              nodes: num(d.mip_node_count) });
          }
          if (opt.shouldStop && opt.shouldStop(d)) ev.interrupt();
        },
      };
      const run = model.run(cb);
      const code = model.getModelStatus();
      const info = (n) => { try { return num(model.info.get(n)); } catch (e) { return null; } };
      const primalStatus = info("primal_solution_status");
      const sol = primalStatus === 2 ? model.getSolution() : null;
      const dims = model.getDimensions();
      return {
        status: STATUS_NAME[code] || String(code), statusCode: code,
        objective: primalStatus === 2 ? model.getObjectiveValue() : null,
        bound: info("mip_dual_bound"), gap: info("mip_gap"), nodes: info("mip_node_count"),
        runTime: model.getRunTime(), wall: (Date.now() - t0) / 1000, firstIncumbentAt, incumbents,
        colValue: sol ? sol.colValue : null, colNames, dims, startAccepted, runStatus: run && run.status,
      };
    } finally {
      model.dispose();
    }
  }
  root.solveMip = solveMip;
  if (typeof module === "object" && module.exports) module.exports = { solveMip };
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
