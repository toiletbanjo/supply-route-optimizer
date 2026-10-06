// Urgency rules (spec-answers.md Section 2): hours of supply, the run-out question, escalation to
// Immediate, deadlines, tier/class ordering and request validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from '../load.mjs';

const SRO = loadScripts([
  'src/core/ns.js', 'src/core/util.js',
  'src/data/grid.json', 'src/data/catalog.js', 'src/data/scenario.js',
  'src/core/urgency.js'
]);
const U = SRO.core.urgency;
const catalog = SRO.data.catalog;
const plain = (x) => JSON.parse(JSON.stringify(x));

const NOW = 360;   // Day 1 0600
// diesel daily use = 300 gal, MRE = 9 cases, IFAK refill = 4 kits (catalog.js)
function req(over) {
  return Object.assign({
    id: 'R-0001', source: 'user', unitName: '1st PLT, B CO, 3-21 IN', designator: '1/B/3-21IN',
    lat: 24.15, lon: 120.68, gridId: 'G-TAICHUNG', mobility: 'mounted', maxTravelMi: 50,
    desiredPickup: null, directOnly: false, directReason: null, directReasonText: '',
    lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: null }],
    urgencyRequested: 'Routine', urgency: 'Routine', hoursLeftComputed: null, hoursLeftReported: null,
    nlt: NOW + 600, deadline: NOW + 600, remarks: '', createdAt: NOW, windowId: 'W-001', status: 'submitted',
    locks: { truckId: null, forceDirect: false }, updated: false
  }, over || {});
}
const diesel = (onHand, qty) => ({ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: qty || 500, unit: 'gal', onHand });
const mre = (onHand, qty) => ({ classId: 'I', itemId: 'mre', option: 'mixed', qty: qty || 27, unit: 'case', onHand });
const part = (onHand) => ({ classId: 'IX', itemId: 'other-part', option: 'Starter motor', qty: 1, unit: 'each', onHand });

// ---- tiers and ordering ---------------------------------------------------------------------
test('tiers and class ranks', () => {
  assert.deepEqual(plain(U.TIERS), ['Routine', 'Priority', 'Urgent', 'Immediate']);
  assert.deepEqual(plain(U.REQUESTABLE), ['Routine', 'Priority', 'Urgent']);
  assert.deepEqual(['Routine', 'Priority', 'Urgent', 'Immediate', 'Bogus'].map(U.tierIndex), [0, 1, 2, 3, -1]);
  assert.equal(U.tierName(3), 'Immediate');
  assert.deepEqual(['III', 'I', 'V', 'VIII', 'IX', 'II'].map(U.classRank), [0, 1, 2, 3, 4, 5]);
  assert.equal(U.requestClassRank(req({ lines: [mre(null), diesel(null)] })), 0);
  assert.equal(U.isHardDeadline('Routine'), false);
  assert.equal(U.isHardDeadline('Priority'), false);
  assert.equal(U.isHardDeadline('Urgent'), true);
  assert.equal(U.isHardDeadline('Immediate'), true);
});

test('compareRequests: urgency beats class, class breaks ties, then deadline', () => {
  const a = req({ id: 'R-A', urgency: 'Priority', lines: [part(null)], deadline: NOW + 900 });
  const b = req({ id: 'R-B', urgency: 'Routine', lines: [diesel(null)], deadline: NOW + 100 });
  const c = req({ id: 'R-C', urgency: 'Priority', lines: [diesel(null)], deadline: NOW + 900 });
  const d = req({ id: 'R-D', urgency: 'Priority', lines: [diesel(null)], deadline: NOW + 300 });
  const e = req({ id: 'R-E', urgency: 'Immediate', lines: [{ classId: 'IX', itemId: 'tires', option: 'light', qty: 4, unit: 'each', onHand: 0 }] });
  const order = [a, b, c, d, e].sort(U.compareRequests).map((r) => r.id);
  assert.deepEqual(order, ['R-E', 'R-D', 'R-C', 'R-A', 'R-B']);
});

// ---- hours of supply --------------------------------------------------------------------------
test('hoursLeft = on hand / daily use x 24, scarcest line, null when unknown', () => {
  assert.equal(U.hoursLeft([diesel(300)], catalog), 24);
  assert.equal(U.hoursLeft([diesel(150)], catalog), 12);
  assert.equal(U.hoursLeft([diesel(0)], catalog), 0);
  assert.equal(U.hoursLeft([diesel(600), mre(3)], catalog), 8);         // 3 / 9 x 24
  assert.equal(U.hoursLeft([diesel(null)], catalog), null);
  assert.equal(U.hoursLeft([part(2)], catalog), null);                   // no daily rate
  assert.equal(U.hoursLeft([diesel(null), mre(9)], catalog), 24);
  assert.equal(U.hoursLeft([], catalog), null);
  assert.equal(U.hoursLeft([diesel(300)], catalog, { diesel: 600 }), 12);  // planner override
  assert.equal(U.hoursLeft([diesel(-5)], catalog), null);
  // stored value is floored so it never crosses 24 h upward
  assert.equal(U.hoursLeft([diesel(299.99)], catalog), 23.99);
  assert.equal(U.lineHoursLeft(mre(4), catalog), 10.66);
});

test('needsRunOutQuestion: only for Urgent, after on hand, when computed >= 24 h or unknown', () => {
  const urgent = (lines) => ({ urgencyRequested: 'Urgent', lines });
  assert.equal(U.needsRunOutQuestion(urgent([diesel(300)]), catalog), true);      // exactly 24 h -> ask
  assert.equal(U.needsRunOutQuestion(urgent([diesel(450)]), catalog), true);      // 36 h -> ask
  assert.equal(U.needsRunOutQuestion(urgent([diesel(299)]), catalog), false);     // 23.92 h -> Immediate, no question
  assert.equal(U.needsRunOutQuestion(urgent([diesel(null)]), catalog), false);    // on hand first
  assert.equal(U.needsRunOutQuestion(urgent([diesel(600), mre(null)]), catalog), false);
  assert.equal(U.needsRunOutQuestion(urgent([part(1)]), catalog), true);          // no rate -> ask
  assert.equal(U.needsRunOutQuestion({ urgencyRequested: 'Priority', lines: [diesel(600)] }, catalog), false);
  assert.equal(U.needsRunOutQuestion({ urgencyRequested: 'Routine', lines: [diesel(600)] }), false);
  assert.equal(U.needsRunOutQuestion(urgent([diesel(450)])), true);               // default catalog
  // shorthand form
  assert.equal(U.needsRunOutQuestion('Urgent', 24), true);
  assert.equal(U.needsRunOutQuestion('Urgent', 23.99), false);
  assert.equal(U.needsRunOutQuestion('Urgent', null), true);
  assert.equal(U.needsRunOutQuestion('Priority', 40), false);
});

// ---- escalation -------------------------------------------------------------------------------
test('Routine and Priority keep their tier and the NLT as a soft deadline', () => {
  for (const tier of ['Routine', 'Priority']) {
    const e = U.escalate(req({ urgencyRequested: tier, lines: [diesel(30)] }), NOW);
    assert.equal(e.urgency, tier);
    assert.equal(e.deadline, NOW + 600);
    assert.equal(e.hardDeadline, false);
    assert.equal(e.hoursLeftComputed, 2.4);      // still reported for display
    assert.equal(e.runOutAt, null);
    assert.equal(e.code, 'as-requested');
  }
});

test('Urgent with computed hours under 24 goes straight to Immediate, deadline = min(NLT, run-out)', () => {
  // 150 gal = 12 h -> run-out at 0600 + 12 h = 1080; NLT 1600 (960) is earlier
  let e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(150)], nlt: 960 }), NOW);
  assert.equal(e.urgency, 'Immediate');
  assert.equal(e.hardDeadline, true);
  assert.equal(e.runOutAt, NOW + 720);
  assert.equal(e.deadline, 960);
  assert.equal(e.code, 'computed-under-24');
  // NLT later than run-out -> deadline is the run-out time
  e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(150)], nlt: 2000 }), NOW);
  assert.equal(e.deadline, NOW + 720);
  assert.match(e.reason, /Immediate/);
  // a self-reported >= 24 h does not undo it (no question asked when computed < 24)
  e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(150)], hoursLeftReported: 40, nlt: 2000 }), NOW);
  assert.equal(e.urgency, 'Immediate');
  assert.equal(e.deadline, NOW + 720);
  // boundary just under 24 h
  e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(299)], nlt: 3000 }), NOW);
  assert.equal(e.urgency, 'Immediate');
  assert.equal(e.deadline, Math.floor(NOW + 299 / 300 * 24 * 60));
});

test('Urgent at exactly 24 h computed stays Urgent unless the reported run-out is under 24 h', () => {
  let e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(300)] }), NOW);
  assert.equal(e.urgency, 'Urgent');
  assert.equal(e.hoursLeftComputed, 24);
  assert.equal(e.deadline, NOW + 600);
  assert.equal(e.hardDeadline, true);                  // Urgent NLT is hard
  assert.equal(e.code, 'computed-24-plus');
  // reported exactly 24 -> stays Urgent (no downgrade, no bump)
  e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(300)], hoursLeftReported: 24 }), NOW);
  assert.equal(e.urgency, 'Urgent');
  assert.equal(e.code, 'reported-24-plus');
  // reported just under 24 -> Immediate, deadline min(NLT, run-out)
  e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(600)], hoursLeftReported: 23.5, nlt: NOW + 2000 }), NOW);
  assert.equal(e.urgency, 'Immediate');
  assert.equal(e.code, 'reported-under-24');
  assert.equal(e.runOutAt, NOW + 1410);
  assert.equal(e.deadline, NOW + 1410);
  e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(600)], hoursLeftReported: 6, nlt: NOW + 300 }), NOW);
  assert.equal(e.deadline, NOW + 300);
  assert.equal(e.runOutAt, NOW + 360);
  // reported 0 h -> run-out now
  e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(600)], hoursLeftReported: 0 }), NOW);
  assert.equal(e.urgency, 'Immediate');
  assert.equal(e.deadline, NOW);
  // reported well above 24 -> Urgent
  e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(600)], hoursLeftReported: 30 }), NOW);
  assert.equal(e.urgency, 'Urgent');
});

test('Urgent without computable hours: the report decides; no report keeps Urgent', () => {
  let e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [part(1)] }), NOW);
  assert.equal(e.urgency, 'Urgent');
  assert.equal(e.code, 'no-hours');
  assert.equal(e.hoursLeftComputed, null);
  e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [part(1)], hoursLeftReported: 10 }), NOW);
  assert.equal(e.urgency, 'Immediate');
  assert.equal(e.deadline, NOW + 600);
  e = U.escalate(req({ urgencyRequested: 'Urgent', lines: [diesel(null)] }), NOW);
  assert.equal(e.urgency, 'Urgent');
});

test('escalate: run-out counts from nowMin, else createdAt; works without an explicit catalog', () => {
  const r = req({ urgencyRequested: 'Urgent', lines: [diesel(150)], nlt: 5000, createdAt: 300 });
  assert.equal(U.escalate(r).runOutAt, 300 + 720);
  assert.equal(U.escalate(r, 400).runOutAt, 400 + 720);
  assert.equal(U.escalate(r, 400, { catalog }).runOutAt, 400 + 720);
  assert.equal(U.escalate(r, 400, { dailyUse: { diesel: 150 } }).urgency, 'Urgent');   // 24 h with the override
  // with no catalog at all, the stored hoursLeftComputed is used
  const saved = SRO.data.catalog;
  SRO.data.catalog = null;
  try {
    const e = U.escalate(req({ urgencyRequested: 'Urgent', hoursLeftComputed: 5, nlt: 5000 }), NOW);
    assert.equal(e.urgency, 'Immediate');
    assert.equal(e.deadline, NOW + 300);
  } finally { SRO.data.catalog = saved; }
});

test('apply returns a copy with the escalation fields set', () => {
  const r = req({ urgencyRequested: 'Urgent', lines: [diesel(150)], nlt: 5000 });
  const out = U.apply(r, NOW);
  assert.equal(out.urgency, 'Immediate');
  assert.equal(out.deadline, NOW + 720);
  assert.equal(out.hoursLeftComputed, 12);
  assert.equal(r.urgency, 'Routine');            // input untouched
  assert.deepEqual(Object.keys(out), Object.keys(r));
});

// ---- validation -------------------------------------------------------------------------------
const codes = (list) => plain(list.map((x) => x.code).sort());

test('validate: a good request passes', () => {
  const v = U.validate(req(), { nowMin: NOW });
  assert.equal(v.ok, true);
  assert.deepEqual(plain(v.errors), []);
  assert.deepEqual(plain(v.warnings), []);
});

test('validate: location outside Taiwan blocks (sea, Penghu, missing), desired pickup too', () => {
  for (const [lat, lon] of [[23.57, 119.58], [24.0, 119.9], [22.66, 121.49], [null, null]]) {
    const v = U.validate(req({ lat, lon }), { nowMin: NOW });
    assert.equal(v.ok, false);
    assert.deepEqual(codes(v.errors), ['outside-taiwan']);
    assert.ok(v.errors[0].message.length > 10);
  }
  const v = U.validate(req({ desiredPickup: { lat: 23.57, lon: 119.58, gridId: 'X' } }), { nowMin: NOW });
  assert.deepEqual(codes(v.errors), ['pickup-outside-taiwan']);
  // a caller-supplied coastline check wins
  const v2 = U.validate(req(), { nowMin: NOW, insideTaiwan: () => false });
  assert.deepEqual(codes(v2.errors), ['outside-taiwan']);
});

test('validate: NLT in the past blocks; NLT equal to now does not', () => {
  assert.deepEqual(codes(U.validate(req({ nlt: NOW - 1 }), { nowMin: NOW }).errors), ['nlt-past']);
  assert.equal(U.validate(req({ nlt: NOW }), { nowMin: NOW }).ok, true);
  assert.deepEqual(codes(U.validate(req({ nlt: null }), { nowMin: NOW }).errors), ['nlt-missing']);
});

test('validate: zero, negative or missing quantity blocks; no lines blocks', () => {
  for (const qty of [0, -3, null, NaN]) {
    const v = U.validate(req({ lines: [mre(null), Object.assign(diesel(null), { qty })] }), { nowMin: NOW });
    assert.deepEqual(codes(v.errors), ['zero-qty']);
    assert.equal(v.errors[0].lineIdx, 1);
  }
  assert.deepEqual(codes(U.validate(req({ lines: [] }), { nowMin: NOW }).errors), ['no-lines']);
});

test('validate: Urgent needs on hand for every line (0 counts); other tiers do not', () => {
  let v = U.validate(req({ urgencyRequested: 'Urgent', lines: [diesel(null)] }), { nowMin: NOW });
  assert.deepEqual(codes(v.errors), ['urgent-no-onhand']);
  v = U.validate(req({ urgencyRequested: 'Urgent', lines: [diesel(100), mre(null)] }), { nowMin: NOW });
  assert.deepEqual(codes(v.errors), ['urgent-no-onhand']);
  v = U.validate(req({ urgencyRequested: 'Urgent', lines: [diesel(0), mre(2)] }), { nowMin: NOW });
  assert.equal(v.ok, true);
  for (const t of ['Routine', 'Priority']) assert.equal(U.validate(req({ urgencyRequested: t }), { nowMin: NOW }).ok, true);
  v = U.validate(req({ lines: [diesel(-1)] }), { nowMin: NOW });
  assert.deepEqual(codes(v.errors), ['bad-onhand']);
});

test('validate: other part needs a description; unknown items block', () => {
  let v = U.validate(req({ lines: [Object.assign(part(null), { option: '  ' })] }), { nowMin: NOW });
  assert.deepEqual(codes(v.errors), ['missing-description']);
  v = U.validate(req({ lines: [{ classId: 'IX', itemId: 'flux-capacitor', option: 'x', qty: 1, unit: 'each', onHand: null }] }), { nowMin: NOW });
  assert.deepEqual(codes(v.errors), ['unknown-item']);
});

test('validate: warns above 5x daily use (not at exactly 5x)', () => {
  let v = U.validate(req({ lines: [diesel(null, 1500)] }), { nowMin: NOW });     // exactly 5 x 300
  assert.deepEqual(plain(v.warnings), []);
  v = U.validate(req({ lines: [diesel(null, 1550)] }), { nowMin: NOW });
  assert.equal(v.ok, true);
  assert.deepEqual(codes(v.warnings), ['over-daily-use']);
  assert.equal(v.warnings[0].lineIdx, 0);
  v = U.validate(req({ lines: [diesel(null, 1550)] }), { nowMin: NOW, dailyUse: { diesel: 400 } });
  assert.deepEqual(plain(v.warnings), []);
  v = U.validate(req({ lines: [Object.assign(part(null), { qty: 20 })] }), { nowMin: NOW });   // no rate, no warning
  assert.deepEqual(plain(v.warnings), []);
});

test('validate: warns when the NLT is sooner than the nearest hub can reach', () => {
  const r = req({ nlt: NOW + 120 });
  let v = U.validate(r, { nowMin: NOW, hubReachMin: () => 180 });
  assert.equal(v.ok, true);
  assert.deepEqual(codes(v.warnings), ['nlt-unreachable']);
  assert.match(v.warnings[0].message, /3 h/);
  v = U.validate(r, { nowMin: NOW, hubReachMin: 120 });                  // exactly reachable
  assert.deepEqual(plain(v.warnings), []);
  v = U.validate(r, { nowMin: NOW, hubReachMin: 121 });
  assert.deepEqual(codes(v.warnings), ['nlt-unreachable']);
  v = U.validate(r, { nowMin: NOW });                                     // no reach function: skipped
  assert.deepEqual(plain(v.warnings), []);
  let seen = null;
  U.validate(r, { nowMin: NOW, hubReachMin: (x) => { seen = x; return null; } });
  assert.equal(seen.id, 'R-0001');
});
