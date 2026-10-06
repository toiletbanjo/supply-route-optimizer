import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScripts, ROOT } from '../load.mjs';

const SRO = loadScripts(['src/core/ns.js', 'src/core/util.js', 'src/core/format.js']);
const f = SRO.core.format;
const require = createRequire(ROOT + '/package.json');

test('time24: 24h local time without colon', () => {
  assert.equal(f.time24(1200), '2000');
  assert.equal(f.time24(0), '0000');
  assert.equal(f.time24(360), '0600');
  assert.equal(f.time24(1439), '2359');
  assert.equal(f.time24(1440), '0000');          // Day 2 midnight
  assert.equal(f.time24(1200.7), '2000');        // fractional clock values truncate
  assert.equal(f.time24(1440 + 545), '0905');
  assert.equal(f.time24(Infinity), 'n/a');
});

test('dayTime adds the day only when it is not today', () => {
  assert.equal(f.dayTime(1200, 400), '2000');
  assert.equal(f.dayTime(1530, 400), '0130 Day 2');
  assert.equal(f.dayTime(1530, 1500), '0130');
  assert.equal(f.dayTime(300, 1500), '0500 Day 1');
  assert.equal(f.dayTime(360), '0600 Day 1');    // no "now": always show the day
  assert.equal(f.dayOf(0), 1);
  assert.equal(f.dayOf(1439), 1);
  assert.equal(f.dayOf(1440), 2);
});

test('dtg in local zone H from Day 1 = 6 Oct 2026', () => {
  assert.equal(f.dtg(14 * 60 + 30), '061430H OCT 26');           // Day 1 1430
  assert.equal(f.dtg(0), '060000H OCT 26');
  assert.equal(f.dtg(1439), '062359H OCT 26');
  assert.equal(f.dtg(1440 + 360), '070600H OCT 26');              // Day 2 0600
  assert.equal(f.dtg(25 * 1440 + 600), '311000H OCT 26');         // Day 26 = 31 Oct
  assert.equal(f.dtg(26 * 1440), '010000H NOV 26');               // Day 27 = 1 Nov
  assert.equal(f.dtg(87 * 1440), '010000H JAN 27');               // Day 88 = 1 Jan 2027
  assert.equal(f.dtg(870.9), '061430H OCT 26');
});

test('windowLabel', () => {
  assert.equal(f.windowLabel({ start: 360, end: 720 }), 'Day 1, 0600-1200');
  assert.equal(f.windowLabel(1080, 1440), 'Day 1, 1800-2400');
  assert.equal(f.windowLabel(1440, 1800), 'Day 2, 0000-0600');
});

test('classLabel', () => {
  assert.equal(f.classLabel('III'), 'Class III (Fuel)');
  assert.equal(f.classLabel('I'), 'Class I (Food & Water)');
  assert.equal(f.classLabel('V'), 'Class V (Ammunition)');
  assert.equal(f.classLabel('VIII'), 'Class VIII (Medical)');
  assert.equal(f.classLabel('IX'), 'Class IX (Repair Parts)');
  assert.equal(f.classLabel('iii'), 'Class III (Fuel)');
  assert.equal(f.classLabel('Class IX'), 'Class IX (Repair Parts)');
  assert.equal(f.classLabel('XV'), 'Class XV');
  assert.deepEqual(Array.from(f.CLASS_ORDER), ['III', 'I', 'V', 'VIII', 'IX']);
});

test('miles, gallons, number, qty', () => {
  assert.equal(f.miles(12.34), '12.3 mi');
  assert.equal(f.miles(12.35 + 1e-9), '12.4 mi');
  assert.equal(f.miles(0), '0.0 mi');
  assert.equal(f.miles(1234.56), '1,234.6 mi');
  assert.equal(f.miles(Infinity), 'n/a');
  assert.equal(f.gallons(2500), '2,500 gal');
  assert.equal(f.gallons(12.6), '13 gal');
  assert.equal(f.number(-1234567.891, 2), '-1,234,567.89');
  assert.equal(f.number(-0.001, 1), '0.0');
  assert.equal(f.qty(500, 'gal'), '500 gal');
  assert.equal(f.qty(2.5, 'pallets'), '2.5 pallets');
});

test('duration', () => {
  assert.equal(f.duration(85), '1 h 25 min');
  assert.equal(f.duration(45), '45 min');
  assert.equal(f.duration(120), '2 h');
  assert.equal(f.duration(0), '0 min');
  assert.equal(f.duration(59.6), '1 h');
  assert.equal(f.duration(1505), '25 h 5 min');
  assert.equal(f.duration(-30), '-30 min');
  assert.equal(f.duration(Infinity), 'n/a');
});

test('UTM: textbook values', () => {
  // (0N, 0E) lies 3 degrees west of zone 31's central meridian: easting 166021.443 m.
  const u = f.utm(0, 0);
  assert.equal(u.zone, 31);
  assert.ok(Math.abs(u.easting - 166021.4431) < 0.001, String(u.easting));
  assert.ok(Math.abs(u.northing) < 1e-6);
  const cm = f.utm(0, 3);
  assert.ok(Math.abs(cm.easting - 500000) < 1e-6);
  // southern hemisphere false northing
  assert.ok(f.utm(-10, 3).northing > 8800000 && f.utm(-10, 3).northing < 9000000);
  assert.equal(f.utm(85, 0), null);
  assert.equal(f.utm(-81, 0), null);
});

test('MGRS: Taiwan points (zones 50/51, bands Q/R)', () => {
  assert.equal(f.mgrs(25.0330, 121.5654), '51R UH 55263 69368');   // Taipei
  assert.equal(f.mgrs(22.6273, 120.3014), '51Q TF 22617 04777');   // Kaohsiung
  assert.equal(f.mgrs(23.5711, 119.5793), '50Q QM 63266 09113');   // Penghu (zone 50)
  assert.equal(f.mgrs(25.0330, 121.5654, 3), '51R UH 552 693');
  assert.equal(f.mgrs(25.0330, 121.5654, 0), '51R UH');
  assert.equal(f.mgrs({ lat: 25.0330, lon: 121.5654 }, 1), '51R UH 5 6');
  assert.equal(f.mgrs(85, 0), '');
  // band boundary at 24N and zone boundary at 120E
  assert.ok(f.mgrs(23.9999, 121).startsWith('51Q'));
  assert.ok(f.mgrs(24.0001, 121).startsWith('51R'));
  assert.ok(f.mgrs(23.5, 119.9999).startsWith('50Q'));
  assert.ok(f.mgrs(23.5, 120.0001).startsWith('51Q'));
});

test('MGRS matches the npm mgrs package on random points across Taiwan', () => {
  const mgrs = require('mgrs');
  const rng = SRO.util.rng(20261006);
  const norm = (s) => s.replace(/\s+/g, '');
  const points = [];
  // fixed edge cases: zone and band boundaries, island extremes
  points.push([24.0, 121.0], [23.9999999, 120.9], [21.9, 120.85], [25.3, 121.56], [23.5, 119.99999], [23.5, 120.00001], [22.05, 121.55]);
  while (points.length < 60) points.push([21.9 + rng() * 3.4, 119.3 + rng() * 2.8]);
  let checked = 0;
  for (const [lat, lon] of points) {
    const ours = f.mgrs(lat, lon, 5);
    const ref = mgrs.forward([lon, lat], 5);
    assert.equal(norm(ours), ref, `MGRS mismatch at ${lat}, ${lon}`);
    // and the spaced form has the documented shape
    assert.match(ours, /^5[01][QR] [A-Z]{2} \d{5} \d{5}$/);
    // lower precision is a prefix-truncation of the full reference
    assert.equal(norm(f.mgrs(lat, lon, 3)), mgrs.forward([lon, lat], 3));
    checked++;
  }
  assert.ok(checked >= 30);
});
