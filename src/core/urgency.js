// Hours-of-supply and urgency escalation (spec-answers.md, Section 2). Pure functions, no DOM.
//
// Rules:
//   - Tiers: Routine, Priority, Urgent (what a platoon sergeant can pick) and Immediate (only by
//     escalation). Urgency always beats class; class order III > I > V > VIII > IX breaks ties.
//   - On hand is optional on any request and mandatory (every line) for Urgent.
//   - Urgent: hours left = on hand / daily use x 24, the scarcest line decides.
//       computed < 24 h            -> Immediate (no question asked)
//       computed >= 24 h (or no daily rate for the item) -> ask "how much longer until you run out?"
//         reported < 24 h          -> Immediate
//         reported >= 24 h or none -> stays Urgent (never downgraded)
//   - Immediate deadline = min(NLT, run-out time); run-out = time on hand was reported + hours left
//     (the smaller of computed and reported hours when both are under 24 h).
//   - Deadlines are hard for Urgent ("NLT hard") and Immediate; soft for Routine and Priority.
// Escalation only applies to Urgent requests: a Routine or Priority request keeps its tier even when
// its on hand runs low (the platoon sergeant chose the tier; validation does not second-guess it).
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.core = SRO.core || {};
  const U = SRO.core.urgency = SRO.core.urgency || {};

  U.TIERS = ['Routine', 'Priority', 'Urgent', 'Immediate'];
  U.REQUESTABLE = ['Routine', 'Priority', 'Urgent'];
  U.CLASS_ORDER = ['III', 'I', 'V', 'VIII', 'IX'];
  U.RUN_OUT_HOURS = 24;
  U.OVER_DAILY_FACTOR = 5;

  U.tierIndex = function (name) { return U.TIERS.indexOf(name); };
  U.tierName = function (idx) { return U.TIERS[idx] || null; };
  U.classRank = function (classId) { const i = U.CLASS_ORDER.indexOf(classId); return i < 0 ? U.CLASS_ORDER.length : i; };
  U.isHardDeadline = function (urgency) { return urgency === 'Urgent' || urgency === 'Immediate'; };

  // Best (lowest) class rank over a request's lines.
  U.requestClassRank = function (request) {
    let best = U.CLASS_ORDER.length;
    linesOf(request).forEach(function (l) { if (l) best = Math.min(best, U.classRank(l.classId)); });
    return best;
  };

  // Sort comparator, most pressing first: tier (Immediate first), class rank, deadline, created, id.
  U.compareRequests = function (a, b) {
    const ta = U.tierIndex(a.urgency || a.urgencyRequested), tb = U.tierIndex(b.urgency || b.urgencyRequested);
    if (ta !== tb) return tb - ta;
    const ca = U.requestClassRank(a), cb = U.requestClassRank(b);
    if (ca !== cb) return ca - cb;
    const da = num(a.deadline, num(a.nlt, Infinity)), db = num(b.deadline, num(b.nlt, Infinity));
    if (da !== db) return da - db;
    const ka = num(a.createdAt, 0), kb = num(b.createdAt, 0);
    if (ka !== kb) return ka - kb;
    return String(a.id || '') < String(b.id || '') ? -1 : String(a.id || '') > String(b.id || '') ? 1 : 0;
  };

  function num(x, dflt) { return typeof x === 'number' && !isNaN(x) ? x : dflt; }
  function linesOf(request) { return request && Array.isArray(request.lines) ? request.lines : []; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function defaultCatalog() { return (SRO.data && SRO.data.catalog) || null; }
  function floor2(x) { return Math.floor(x * 100 + 1e-9) / 100; }

  function findItem(catalog, itemId) {
    const items = (catalog && catalog.items) || [];
    for (let i = 0; i < items.length; i++) if (items[i].id === itemId) return items[i];
    return null;
  }

  // Daily use for a line: table 'itemId:option', then table 'itemId' (unless the option has its own
  // catalog rate), then the catalog option rate, then the catalog item rate. null = no rate.
  U.dailyUseFor = function (line, catalog, table) {
    if (!line) return null;
    const it = findItem(catalog || defaultCatalog(), line.itemId);
    const op = it && !it.freeText ? (it.options || []).find(function (o) { return o.id === line.option; }) : null;
    const kOpt = line.itemId + ':' + line.option;
    if (table && isNum(table[kOpt])) return table[kOpt];
    const opRate = op && op.dailyUse !== undefined ? op.dailyUse : undefined;
    if (table && isNum(table[line.itemId]) && opRate === undefined) return table[line.itemId];
    if (isNum(opRate)) return opRate;
    return it && isNum(it.dailyUse) ? it.dailyUse : null;
  };

  // Hours of supply for one line, or null (no on hand, or no daily rate). Floored to 0.01 h so the
  // stored value never crosses the 24 h line upward.
  U.lineHoursLeft = function (line, catalog, table) {
    if (!line || !isNum(line.onHand) || line.onHand < 0) return null;
    const rate = U.dailyUseFor(line, catalog, table);
    if (!isNum(rate) || rate <= 0) return null;
    return floor2(line.onHand / rate * 24);
  };

  // Hours of supply for a request: the scarcest line with on hand and a daily rate; null if none.
  U.hoursLeft = function (lines, catalog, table) {
    let best = null;
    (Array.isArray(lines) ? lines : []).forEach(function (l) {
      const h = U.lineHoursLeft(l, catalog, table);
      if (h !== null && (best === null || h < best)) best = h;
    });
    return best;
  };

  function allLinesHaveOnHand(lines) {
    return Array.isArray(lines) && lines.length > 0 && lines.every(function (l) { return l && isNum(l.onHand) && l.onHand >= 0; });
  }

  // Should the form ask "How much longer until you run out?"
  //   needsRunOutQuestion(request, catalog?, dailyUseTable?)    request = { urgencyRequested, lines }
  //   needsRunOutQuestion('Urgent', hoursLeftComputed)          shorthand once hours are known
  // True for Urgent once on hand is filled in and the computed hours are >= 24 h, or cannot be
  // computed (an item with no daily rate). False before on hand is complete.
  U.needsRunOutQuestion = function (a, b, c) {
    if (typeof a === 'string') {
      if (a !== 'Urgent') return false;
      return !isNum(b) || b >= U.RUN_OUT_HOURS;
    }
    const req = a || {};
    if (req.urgencyRequested !== 'Urgent') return false;
    if (!allLinesHaveOnHand(req.lines)) return false;
    const h = U.hoursLeft(req.lines, b || defaultCatalog(), c);
    return h === null || h >= U.RUN_OUT_HOURS;
  };

  // escalate(request, nowMin, opts?) -> { urgency, deadline, hardDeadline, reason, code,
  //   hoursLeftComputed, hoursLeftReported, runOutAt }
  // nowMin = when on hand was reported (normally request.createdAt; used if nowMin is omitted).
  // opts = { catalog (default SRO.data.catalog), dailyUse (settings.dailyUse table) }.
  // With no catalog available, request.hoursLeftComputed is used as given.
  // Plain-language reasons only; clock times are formatted by format.js, not here.
  U.escalate = function (request, nowMin, opts) {
    opts = opts || {};
    const req = request || {};
    const catalog = opts.catalog || defaultCatalog();
    const base = isNum(nowMin) ? nowMin : num(req.createdAt, 0);
    const nlt = req.nlt;
    const requested = U.TIERS.indexOf(req.urgencyRequested) >= 0 ? req.urgencyRequested : 'Routine';
    const computed = catalog ? U.hoursLeft(req.lines, catalog, opts.dailyUse)
      : (isNum(req.hoursLeftComputed) ? req.hoursLeftComputed : null);
    const reported = isNum(req.hoursLeftReported) && req.hoursLeftReported >= 0 ? req.hoursLeftReported : null;
    const out = { urgency: requested, deadline: nlt, hardDeadline: U.isHardDeadline(requested), reason: '', code: 'as-requested',
      hoursLeftComputed: computed, hoursLeftReported: reported, runOutAt: null };

    function immediate(hours, code, reason) {
      const runOut = Math.floor(base + hours * 60);
      out.urgency = 'Immediate';
      out.hardDeadline = true;
      out.runOutAt = runOut;
      out.deadline = isNum(nlt) ? Math.min(nlt, runOut) : runOut;
      out.code = code;
      out.reason = reason + (isNum(nlt) && runOut < nlt ? ' Deadline moved up to the run-out time.' : ' Deadline is the NLT.');
      return out;
    }

    if (requested === 'Routine' || requested === 'Priority') {
      out.reason = requested === 'Routine' ? 'Routine: deliver by the NLT.' : 'Priority: deliver by the NLT, ahead of Routine.';
      return out;
    }
    if (requested === 'Immediate') {
      const h = [computed, reported].filter(function (x) { return x !== null && x < U.RUN_OUT_HOURS; });
      if (h.length) return immediate(Math.min.apply(null, h), 'immediate', 'Immediate.');
      out.code = 'immediate';
      out.reason = 'Immediate: deliver by the NLT.';
      return out;
    }
    // Urgent
    if (computed !== null && computed < U.RUN_OUT_HOURS) {
      // No question is asked in this case, but a report already on file (e.g. after an edit) that
      // runs out sooner wins: the run-out time is the earlier of the two estimates.
      const sooner = reported !== null && reported < computed;
      return immediate(sooner ? reported : computed, 'computed-under-24',
        'Supplies on hand last about ' + hoursText(computed) + ' (under 24 h): escalated to Immediate.' +
        (sooner ? ' Unit reports running out sooner, in about ' + hoursText(reported) + '.' : ''));
    }
    if (reported !== null && reported < U.RUN_OUT_HOURS) {
      return immediate(reported, 'reported-under-24',
        'Unit reports running out in about ' + hoursText(reported) + ' (under 24 h): escalated to Immediate.');
    }
    out.urgency = 'Urgent';
    out.hardDeadline = true;
    if (reported !== null) {
      out.code = 'reported-24-plus';
      out.reason = 'Unit reports about ' + hoursText(reported) + ' of supply left: stays Urgent, NLT is hard.';
    } else if (computed !== null) {
      out.code = 'computed-24-plus';
      out.reason = 'Supplies on hand last about ' + hoursText(computed) + ': stays Urgent, NLT is hard.';
    } else {
      out.code = 'no-hours';
      out.reason = 'Urgent: NLT is hard (hours of supply unknown).';
    }
    return out;
  };

  function hoursText(h) { return (Math.round(h * 10) / 10) + ' h'; }

  // Copy of the request with urgency, deadline and hours fields set from escalate().
  U.apply = function (request, nowMin, opts) {
    const e = U.escalate(request, nowMin, opts);
    const r = JSON.parse(JSON.stringify(request));
    r.urgency = e.urgency;
    r.deadline = e.deadline;
    r.hoursLeftComputed = e.hoursLeftComputed;
    r.hoursLeftReported = e.hoursLeftReported;
    return r;
  };

  // validate(request, ctx) -> { ok, errors: [{ code, field, lineIdx?, message }], warnings: [...] }
  // ctx = {
  //   nowMin,                         current sim minute (required for the NLT check)
  //   catalog, dailyUse,              default SRO.data.catalog; settings.dailyUse table
  //   insideTaiwan(lat, lon) -> bool  default SRO.data.scenario.insideTaiwan (rough outline, refined
  //                                   by the coastline when taiwan_coast.json is loaded)
  //   hubReachMin                     number, or function(request) -> minutes until the nearest hub
  //                                   could have a truck at the platoon (null/undefined = skip check;
  //                                   Infinity = no hub can reach it, which also warns)
  // }
  // Blocking: location (or desired pickup) outside Taiwan, NLT in the past, missing or zero quantity,
  // Urgent without on hand. Also blocked: no urgency picked (urgency-missing), unknown item, an option
  // that is not in the fixed catalog (unknown-option; may be left out when the item has only one),
  // a line whose classId or unit contradicts its item (line-mismatch), negative on hand, "other
  // part" without a description. Warnings: quantity over 5x typical daily use; NLT sooner than the
  // nearest hub can reach.
  U.validate = function (request, ctx) {
    ctx = ctx || {};
    const req = request || {};
    const catalog = ctx.catalog || defaultCatalog();
    const errors = [], warnings = [];
    const inside = typeof ctx.insideTaiwan === 'function' ? ctx.insideTaiwan
      : (SRO.data && SRO.data.scenario && SRO.data.scenario.insideTaiwan) || bboxTaiwan;

    if (!isNum(req.lat) || !isNum(req.lon) || !inside(req.lat, req.lon)) {
      errors.push({ code: 'outside-taiwan', field: 'location',
        message: 'Your location is outside Taiwan. Move the pin onto the main island or update your location.' });
    }
    if (req.desiredPickup && (!isNum(req.desiredPickup.lat) || !isNum(req.desiredPickup.lon) || !inside(req.desiredPickup.lat, req.desiredPickup.lon))) {
      errors.push({ code: 'pickup-outside-taiwan', field: 'desiredPickup',
        message: 'The pickup spot is outside Taiwan. Pick a spot on the main island, or clear it.' });
    }
    if (!isNum(req.nlt)) {
      errors.push({ code: 'nlt-missing', field: 'nlt', message: 'Pick a no-later-than (NLT) time.' });
    } else if (isNum(ctx.nowMin) && req.nlt < ctx.nowMin) {
      errors.push({ code: 'nlt-past', field: 'nlt', message: 'The NLT time has already passed. Pick a later time.' });
    }

    if (U.REQUESTABLE.indexOf(req.urgencyRequested) < 0) {
      errors.push({ code: 'urgency-missing', field: 'urgency', message: 'Pick an urgency: Routine, Priority or Urgent.' });
    }

    const lines = linesOf(req);
    if (!lines.length) {
      errors.push({ code: 'no-lines', field: 'lines', message: 'Add at least one item.' });
    }
    const urgent = req.urgencyRequested === 'Urgent';
    let missingOnHand = false;
    lines.forEach(function (line0, i) {
      const line = line0 || {};
      const it = findItem(catalog, line.itemId);
      const name = it ? it.name : 'Item ' + (i + 1);
      if (catalog && !it) {
        errors.push({ code: 'unknown-item', field: 'lines', lineIdx: i, message: 'Line ' + (i + 1) + ': pick an item from the list.' });
      }
      if (!isNum(line.qty) || line.qty <= 0) {
        errors.push({ code: 'zero-qty', field: 'qty', lineIdx: i, message: name + ': enter a quantity greater than 0.' });
      }
      if (it && it.freeText && !String(line.option || '').trim()) {
        errors.push({ code: 'missing-description', field: 'option', lineIdx: i, message: name + ': describe the part you need.' });
      }
      if (it && !it.freeText) {
        const opts = it.options || [];
        const known = opts.some(function (o) { return o.id === line.option; });
        const implied = opts.length === 1 && (line.option === null || line.option === undefined || line.option === '');
        if (!known && !implied) {
          errors.push({ code: 'unknown-option', field: 'option', lineIdx: i,
            message: name + ': pick one of the listed options (' + (it.optionLabel || 'Type') + ').' });
        }
      }
      if (it && ((line.classId !== undefined && line.classId !== it.classId) || (line.unit !== undefined && line.unit !== it.unit))) {
        errors.push({ code: 'line-mismatch', field: 'lines', lineIdx: i,
          message: 'Line ' + (i + 1) + ': the class or unit does not match ' + it.name + '. Pick the item again.' });
      }
      if (line.onHand !== null && line.onHand !== undefined && (!isNum(line.onHand) || line.onHand < 0)) {
        errors.push({ code: 'bad-onhand', field: 'onHand', lineIdx: i, message: name + ': on hand must be 0 or more.' });
      } else if (urgent && !isNum(line.onHand)) {
        missingOnHand = true;
      }
      const rate = it ? U.dailyUseFor(line, catalog, ctx.dailyUse) : null;
      if (isNum(line.qty) && isNum(rate) && rate > 0 && line.qty > U.OVER_DAILY_FACTOR * rate) {
        warnings.push({ code: 'over-daily-use', field: 'qty', lineIdx: i,
          message: name + ': ' + line.qty + ' is more than ' + U.OVER_DAILY_FACTOR + ' times what a platoon typically uses in a day (' +
            rate + '). Check the amount.' });
      }
    });
    if (urgent && missingOnHand) {
      errors.push({ code: 'urgent-no-onhand', field: 'onHand',
        message: 'Urgent requests need how much you have on hand for every item. Fill in On hand, or choose Priority.' });
    }

    if (isNum(req.nlt) && isNum(ctx.nowMin) && req.nlt >= ctx.nowMin && ctx.hubReachMin !== undefined && ctx.hubReachMin !== null) {
      const reach = typeof ctx.hubReachMin === 'function' ? ctx.hubReachMin(req) : ctx.hubReachMin;
      if (reach === Infinity) {
        // network.js reports an unreachable pair as Infinity (e.g. closed roads cut the platoon off)
        warnings.push({ code: 'nlt-unreachable', field: 'nlt',
          message: 'No hub can reach you by road right now (closed roads), so this NLT will likely be missed. ' +
            'Submit anyway; the planner will see it.' });
      } else if (isNum(reach) && ctx.nowMin + reach > req.nlt) {
        warnings.push({ code: 'nlt-unreachable', field: 'nlt',
          message: 'The nearest hub needs about ' + durationText(reach) + ' to reach you, so this NLT will likely be missed. ' +
            'Pick a later NLT if you can.' });
      }
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  };

  function durationText(min) {
    const m = Math.ceil(min);
    const h = Math.floor(m / 60), r = m % 60;
    return h ? h + ' h' + (r ? ' ' + r + ' min' : '') : r + ' min';
  }

  // Last-resort check when no outline is loaded: main-island bounding box.
  function bboxTaiwan(lat, lon) { return lat >= 21.88 && lat <= 25.32 && lon >= 120.0 && lon <= 122.03; }
})(typeof self !== 'undefined' ? self : globalThis);
