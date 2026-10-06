// Planner-tunable method parameters (DESIGN.md section 7, "Method parameters"). Single source of truth
// for the Advanced tab: the UI builds each method's tuning form from SRO.solver.PARAMS[method].
//
// Entry: { key, label, help, type: 'int'|'float'|'bool'|'select', min, max, step, default, options?,
//          defaultFrom?, offValue?, scale? }
//   defaultFrom  settings key whose value replaces `default` (e.g. timeCapSec <- settings.timeLimitSec);
//                show defaultParams(method, settings)[key] as the default beside a changed knob.
//   offValue     value meaning "off" (restartAfter 0, startTemp 0 = auto), for a hint in the form.
//   scale        'log' when a log slider reads better (wide ranges).
// defaultParams(method, settings) -> { key: value } for every knob; clampParams(method, params, settings)
// -> a clamped copy with every knob present (invalid or missing values fall back to the default).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  const S = SRO.solver = SRO.solver || {};

  S.METHOD_KEYS = ['tabu', 'sa', 'aco', 'mip'];
  S.METHOD_LABELS = { tabu: 'Tabu search', sa: 'Simulated annealing', aco: 'Ant colony', mip: 'Exact (MIP)' };

  function seed() {
    return {
      key: 'seed', label: 'Random seed', type: 'int', min: 1, max: 999999999, step: 1, default: 20261005,
      help: 'Same seed and same requests give the same plan. Change it to try a different random path through the search.'
    };
  }
  function timeCap() {
    return {
      key: 'timeCapSec', label: 'Stop after (seconds)', type: 'int', min: 5, max: 1800, step: 5, default: 300, defaultFrom: 'timeLimitSec',
      help: 'The run stops at this many seconds even if it has steps left, and keeps the best plan found so far.'
    };
  }

  S.PARAMS = {
    tabu: [
      seed(), timeCap(),
      { key: 'iterations', label: 'Iterations', type: 'int', min: 100, max: 100000, step: 100, default: 4000, scale: 'log',
        help: 'How many improvement steps the search takes. More steps can find a better plan but take longer.' },
      { key: 'tenure', label: 'Tabu tenure (moves a change stays forbidden)', type: 'int', min: 1, max: 200, step: 1, default: 12,
        help: 'After a change is made, undoing it is forbidden for this many steps so the search does not circle back. Higher explores farther; too high can block good changes.' },
      { key: 'neighborhood', label: 'Moves checked per iteration', type: 'int', min: 10, max: 5000, step: 10, default: 200, scale: 'log',
        help: 'How many random changes are tried at each step before the best one is taken. Higher gives smarter steps but each step is slower.' },
      { key: 'restartAfter', label: 'Restart after this many non-improving iterations', type: 'int', min: 0, max: 50000, step: 50, default: 600, offValue: 0,
        help: 'If this many steps in a row find nothing better, jump back to the best plan so far and shake it up. 0 turns restarts off.' },
      { key: 'aspiration', label: 'Allow a forbidden move if it beats the best plan', type: 'bool', default: true,
        help: 'Lets the search use a forbidden change when it would give the best plan seen so far.' }
    ],
    sa: [
      seed(), timeCap(),
      { key: 'startTemp', label: 'Start temperature (0 = auto)', type: 'float', min: 0, max: 1e7, step: 1, default: 0, offValue: 0, scale: 'log',
        help: 'How willing the search is to accept a worse plan at the start, in cost points. 0 sets it automatically from a short trial run.' },
      { key: 'autoAcceptRate', label: 'Auto start: accept this share of worse moves', type: 'float', min: 0.05, max: 0.95, step: 0.05, default: 0.5,
        help: 'Used when the start temperature is automatic: the share of worse changes accepted at the start. Higher explores more early on.' },
      { key: 'coolingRate', label: 'Cooling rate (per step)', type: 'float', min: 0.80, max: 0.99999, step: 0.00001, default: 0.995,
        help: 'Each temperature step multiplies the temperature by this. Closer to 1 cools more slowly: a longer, more thorough run.' },
      { key: 'itersPerTemp', label: 'Moves per temperature step', type: 'int', min: 1, max: 10000, step: 1, default: 100, scale: 'log',
        help: 'How many changes are tried before the temperature drops one step.' },
      { key: 'stopTempRatio', label: 'Stop when temperature falls to this share of start', type: 'float', min: 1e-6, max: 0.5, step: 0.000001, default: 0.001, scale: 'log',
        help: 'The run ends when the temperature has cooled to this share of the start temperature (0.001 = one thousandth).' },
      { key: 'reheats', label: 'Reheats', type: 'int', min: 0, max: 20, step: 1, default: 2,
        help: 'How many times the temperature is raised again after cooling, to climb out of a rut. Each reheat restarts from the best plan so far.' }
    ],
    aco: [
      seed(), timeCap(),
      { key: 'ants', label: 'Ants per iteration', type: 'int', min: 1, max: 500, step: 1, default: 20,
        help: 'How many trial plans are built in each iteration. More ants search more widely but each iteration is slower.' },
      { key: 'iterations', label: 'Iterations', type: 'int', min: 1, max: 10000, step: 1, default: 150, scale: 'log',
        help: 'How many rounds of trial plans are built. Each round learns from the best plans so far.' },
      { key: 'alpha', label: 'Pheromone weight (alpha)', type: 'float', min: 0, max: 10, step: 0.1, default: 1.0,
        help: 'How strongly ants follow choices that worked well before. 0 ignores past experience.' },
      { key: 'beta', label: 'Distance weight (beta)', type: 'float', min: 0, max: 10, step: 0.1, default: 3.0,
        help: 'How strongly ants prefer short, cheap next steps. Higher is greedier.' },
      { key: 'evaporation', label: 'Evaporation rate (rho)', type: 'float', min: 0.01, max: 0.99, step: 0.01, default: 0.10,
        help: 'Share of the learned trail that fades each round. Higher forgets old choices faster and keeps exploring.' },
      { key: 'q', label: 'Deposit amount (Q)', type: 'float', min: 0.01, max: 1000, step: 0.01, default: 1.0, scale: 'log',
        help: 'How much trail a good plan leaves behind. Mostly matters relative to the evaporation rate.' },
      { key: 'localSearch', label: 'Polish best ant with local search', type: 'bool', default: true,
        help: 'Cleans up the best trial plan of each round with quick local improvements. Usually better plans, a little slower.' }
    ],
    mip: [
      seed(), timeCap(),
      { key: 'timeLimitSec', label: 'Time limit (seconds)', type: 'int', min: 5, max: 1800, step: 5, default: 300, defaultFrom: 'timeLimitSec',
        help: 'How long the exact solver may run. When time runs out you get the best plan found and how far it could be from the best possible.' },
      { key: 'mipGap', label: 'Stop when within this gap of optimal', type: 'float', min: 0, max: 0.5, step: 0.001, default: 0.01,
        help: 'Stop once the plan is proven to be within this share of the best possible plan (0.01 = 1%). 0 asks for a proof of the best plan.' },
      { key: 'warmStart', label: 'Start from heuristic plan', type: 'bool', default: true,
        help: 'Gives the exact solver a quick heuristic plan to start from. It usually finds good plans much sooner.' }
    ]
  };

  function entryDefault(e, settings) {
    if (e.defaultFrom && settings && typeof settings[e.defaultFrom] === 'number' && isFinite(settings[e.defaultFrom])) {
      return coerce(e, settings[e.defaultFrom], e.default);
    }
    return e.default;
  }

  function coerce(e, v, dflt) {
    if (e.type === 'bool') {
      if (v === true || v === 'true' || v === 1 || v === '1') return true;
      if (v === false || v === 'false' || v === 0 || v === '0') return false;
      return dflt;
    }
    if (e.type === 'select') {
      const opts = (e.options || []).map(function (o) { return o && typeof o === 'object' ? o.value : o; });
      return opts.indexOf(v) >= 0 ? v : dflt;
    }
    let x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof x !== 'number' || !isFinite(x)) return dflt;
    if (e.type === 'int') x = Math.round(x);
    if (typeof e.min === 'number' && x < e.min) x = e.min;
    if (typeof e.max === 'number' && x > e.max) x = e.max;
    return x;
  }

  // Defaults for every knob of `method` ({} for an unknown method). settings.timeLimitSec feeds
  // timeCapSec (and mip.timeLimitSec).
  S.defaultParams = function (method, settings) {
    const table = S.PARAMS[method];
    const out = {};
    if (!table) return out;
    table.forEach(function (e) { out[e.key] = entryDefault(e, settings); });
    return out;
  };

  // Clamped copy of params: every knob present, ints rounded, numbers inside [min, max], bools coerced,
  // unknown keys dropped, missing/invalid values replaced by the default.
  S.clampParams = function (method, params, settings) {
    const table = S.PARAMS[method];
    const out = {};
    if (!table) return out;
    const p = params && typeof params === 'object' ? params : {};
    table.forEach(function (e) {
      const d = entryDefault(e, settings);
      out[e.key] = Object.prototype.hasOwnProperty.call(p, e.key) ? coerce(e, p[e.key], d) : d;
    });
    return out;
  };

  // The table entry for one knob, or null.
  S.paramSpec = function (method, key) {
    const table = S.PARAMS[method] || [];
    for (let i = 0; i < table.length; i++) if (table[i].key === key) return table[i];
    return null;
  };
})(typeof self !== 'undefined' ? self : globalThis);
