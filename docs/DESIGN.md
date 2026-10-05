# Supply Route Optimizer: Phase 1 design contract

This document is the contract every module is built against. The product decisions behind it are in `docs/spec-answers.md`; when the two disagree, `spec-answers.md` wins and this file gets fixed.

Phase 1 only: inside Taiwan, fictional hubs, up to 20 stops per window. Phase 2 (regional hubs, finite stock, sea/air legs) is held for a merge with a separate app, so keep the data model and solver interface free of Taiwan-specific assumptions where it costs nothing.

All data is notional. No real units, bases or operational data.

## 1. Repository layout

```
src/
  index.html              shell template; build.py replaces <!--INLINE:...--> markers
  styles.css              all CSS (themes via CSS custom properties)
  data/
    grid.json             ~50 grid points (hubs, towns/junctions, rally candidates); Aidan reviews/edits this file
    grid_links.json       main-road links between grid points (fallback times, arc paths, closures)
    catalog.js            supply catalog, units, pallet conversions, daily use rates
    scenario.js           hubs, default fleet, callsigns, colors, sample unit names, periods
    taiwan.geo.js         simplified Taiwan coastline GeoJSON (offline base layer)
    roads.json            (optional) precomputed leg paths from tools/fetch_osrm_paths.py
    google_matrix.json    (optional) Google travel-time matrix; absent until the user runs the script
  core/                   runs on the main thread
    ns.js                 creates the SRO namespace (must load first)
    util.js               seeded RNG, ids, deep clone, clamp
    format.js             24h time, DTG, MGRS, class labels, miles
    geo.js                haversine, point/segment-in-circle, snapping, polyline length/interpolation
    network.js            travel matrix (Google or fallback), closures, all-pairs shortest paths, risk miles
    roads.js              road path provider (layered, see section 6)
    store.js              state, actions, persistence adapter interface
    clock.js              simulated demo clock and window boundaries
    samples.js            seeded sample request generator
    urgency.js            hours-of-supply and urgency escalation logic
    planner-engine.js     builds solver instances from state, runs solver worker, applies results
  solver/                 pure JS; must run in a Web Worker AND in Node (no DOM, no window)
    instance.js           instance schema helpers
    params.js             tunable method parameters: labels, help, ranges, defaults (drives the Advanced form)
    evaluate.js           schedule simulation + cost breakdown (single source of truth for cost)
    construct.js          greedy insertion construction (internal start plan only)
    localsearch.js        shared moves: relocate, swap, 2-opt, rally-point reassignment, split
    tabu.js               tabu search
    sa.js                 simulated annealing
    aco.js                ant colony optimization
    mip.js                MIP model generator (LP format) + HiGHS runner + solution decoding
    estimate.js           run-time estimates per method
    api.js                solve(instance, opts) dispatcher + progress protocol
    worker-main.js        worker message handler
  ui/
    shell.js              top bar (role switch, theme toggle, clock controls), routing, toasts
    symbols.js            milsymbol wrappers (platoon, hub, truck), urgency rings
    map.js                Leaflet map component shared by both views
    psg/profile.js        one-time unit profile
    psg/request.js        request form (DoorDash-style picker, urgency flow, validation)
    psg/myrequests.js     status cards, truck tracking mini map
    planner/queue.js      request queue table
    planner/plan.js       plan view: map, timeline, summary strip, method picker, run/compare/approve
    planner/route.js      route detail + explanations
    planner/scenario.js   trucks, zones, rally pin/ban, settings, advanced (incl. per-method solver tuning)
    planner/outputs.js    movement table (print/PDF/CSV), pickup notices, history, snapshots
tools/
  build.py                inlines everything into prototype/supply-route-app.html
  fetch_google_matrix.py  one-time Google Routes API matrix pull (user runs it with their key)
  fetch_osrm_paths.py     one-time OSRM road path pull (user runs it)
tests/
  solver/*.test.mjs       node --test
  ui/*.spec.mjs           Playwright checks
prototype/
  supply-route-app.html   built output (committed)
```

### Module pattern

No ES modules (the file opens from `file://` and the solver must also run inside a Blob worker). Every JS file is a plain script that attaches to a shared namespace:

```js
(function (root) {
  'use strict';
  const SRO = root.SRO = root.SRO || {};
  SRO.solver = SRO.solver || {};
  SRO.solver.evaluate = function (instance, solution) { /* ... */ };
})(typeof self !== 'undefined' ? self : globalThis);
```

`build.py` concatenates files in the order listed in `tools/manifest.json` (a `.json` data file is wrapped as `SRO.data.<name> = <json>;`, so `grid.json` becomes `SRO.data.grid`). `src/core/ns.js` and `src/core/util.js` (seeded RNG `SRO.util.rng(seed)`, clamp, ids, Infinity-safe JSON) load first in both groups. Node tests use `tests/load.mjs` (`loadGroup('worker')`, `loadScripts([...])`). The solver files plus `data/*` needed by the solver are also concatenated into a worker source string that the main thread turns into a Blob URL worker. Node tests load solver files with `vm.runInThisContext` in the same order.

## 2. Time

- Simulated time is an integer number of minutes since **Day 1 00:00 local Taiwan time** (`simMin`). The demo starts at `simMin = 360` (Day 1, 0600).
- Scenario date: Day 1 = 6 Oct 2026 (notional).
- Display for platoon sergeants: 24h local time, `2000`; add `Day 2` when not today.
- Display for planners: DTG in local zone letter H (UTC+8), `061430H OCT 26`. (Decision: zone H instead of Z so planner and platoon times never differ by 8 hours.)
- Planning windows: boundaries at 0000, 0600, 1200, 1800 local. A window covers requests submitted since the previous approved plan.
- Clock: start, pause, speeds 1x, 60x, 600x. Ticks drive truck animation and window boundaries.
- Time-of-day periods (editable table): Day 0700-1800 speed x1.0 risk x1.0; Dusk 1800-1930 x0.9 / x1.2; Night 1930-0530 x0.7 / x0.8; Dawn 0530-0700 x0.9 / x1.2. A leg uses the period at its departure minute. Travel minutes = base minutes / speed factor.

## 3. Data model (state)

The whole app state is one JSON-serializable object. Only `store.js` mutates it, through actions.

```js
state = {
  version: 1,
  ui: { role: 'psg' | 'planner', theme: 'dark' | 'light' | 'night', plannerTab: 'queue' | 'plan' | 'scenario' | 'outputs' },
  clock: { simMin: 360, running: false, speed: 1 | 60 | 600 },
  profile: null | {                       // the platoon sergeant on this device
    unitName: '1st PLT, B CO, 3-21 IN',   // real-format, fictional
    designator: '1/B/3-21IN',
    lat, lon, gridId,                     // snapped grid point for routing
    mobility: 'mounted' | 'dismounted' | 'fixed'
  },
  scenario: {
    hubs: [{ id: 'HUB-GRANITE', name: 'FOB Granite', nation: 'US' | 'TW', gridId, lat, lon, callsign: 'Alpha' }],
    fleet: [{ id: 'Alpha-1', hubId, type: 'tanker' | 'cargo', capacity: 2500 | 10, color: '#hex', freq: '45.250', status: 'available' | 'out' | 'en_route', availableAt: simMin }],
    zones: [{ id, kind: 'closed' | 'risk', rating: 'Low' | 'Medium' | 'High' | null, lat, lon, radiusMi, label }],
    rally: { pinned: [gridId], banned: [gridId] },
    settings: {
      method: 'tabu' | 'sa' | 'aco' | 'mip',
      timeLimitSec: 300,
      weights: { fuel: 3, distance: 3, risk: 5, simplicity: 2 },   // 0-10 sliders
      maxRallyPoints: 8,
      maxStops: 20,                                               // soft: warn above
      convoyFactor: 1.5, mpg: 2, serviceMin: 15, loadMin: 20,
      periods: [{ name, start: 'HHMM', end: 'HHMM', speed, risk }],
      riskRatings: { Low: 1, Medium: 3, High: 6 },
      mobility: { mounted: { radiusMi: 50, costPerMi: 0.5 }, dismounted: { radiusMi: 5, costPerMi: 4 } },
      dailyUse: { /* per catalog item, see catalog.js */ },
      methodParams: { tabu: {...}, sa: {...}, aco: {...}, mip: {...} },   // see section 7, Method parameters
      sampleSeed: 20261005
    }
  },
  requests: [{
    id: 'R-0001', source: 'user' | 'sample',
    unitName, designator, lat, lon, gridId, mobility,
    maxTravelMi,                          // from mobility unless overridden
    desiredPickup: null | { lat, lon, gridId },
    directOnly: false, directReason: null | 'no-vehicles' | 'in-contact' | 'other', directReasonText,
    lines: [{ classId: 'III', itemId: 'diesel', option: 'JP-8', qty: 500, unit: 'gal', onHand: null | number }],
    urgencyRequested: 'Routine' | 'Priority' | 'Urgent',
    urgency: 'Routine' | 'Priority' | 'Urgent' | 'Immediate',    // after escalation
    hoursLeftComputed: null | number, hoursLeftReported: null | number,
    nlt: simMin, deadline: simMin,        // deadline = nlt, or min(nlt, runOutAt) for Immediate
    remarks: '',
    createdAt: simMin, windowId,
    status: 'submitted' | 'planned' | 'approved' | 'en_route' | 'delivered' | 'partial' | 'delayed' | 'cancelled',
    locks: { truckId: null, forceDirect: false },
    updated: false                         // true after a re-plan changed its ETA or pickup
  }],
  windows: [{ id: 'W-001', start: simMin, end: simMin, status: 'open' | 'planned' | 'approved', planIds: [], approvedPlanId: null }],
  plans: [Plan],
  snapshots: [{ id, name, createdAt, planId }],
  roadCache: { /* key 'gridA|gridB' -> encoded polyline, runtime OSRM cache */ }
}
```

`Plan` (produced by the solver, decorated by planner-engine):

```js
{
  id, windowId, name, method, createdAt, runtimeSec, mipGap: null | number, cancelled: false,
  parentPlanId: null | id,                 // set for contingency re-plans
  rallyPoints: [gridId],
  routes: [{
    truckId, type, color,
    loadStart, depart, returnAt,           // simMin
    stops: [{ seq, nodeKey, kind: 'rally' | 'direct', gridId, lat, lon, label,
              arrive, depart, period,
              deliveries: [{ requestId, lineIdx, qty, unit, classId }],
              pickups: [{ requestId, platoonMiles }] }],
    legs: [{ fromKey, toKey, gridPath: [gridId], depart, arrive, miles, riskUnits, period }],
    miles, gallons, riskUnits,
    cost: { fuel, distance, risk, simplicity, platoon, lateness }
  }],
  deferred: [{ requestId, lineIdx, qty, unit, reason: 'capacity' | 'time' | 'closed-road' | 'no-truck' | 'radius', note }],
  late: [{ requestId, minutesLate }],
  cost: { total, fuel, distance, risk, simplicity, platoon, lateness, deferral },
  stats: { requests, stops, trucksUsed, miles, gallons, riskUnits, late, delayed, runtimeSec },
  approved: false
}
```

### Persistence

`store.js` talks to a `PersistenceAdapter` with `load() -> state|null`, `save(state)`, `exportJson(state) -> string`, `importJson(string) -> state`. v1 ships `LocalStorageAdapter` (key `sro.v1`). A future shared online service implements the same interface. Every access to `localStorage` is wrapped in try/catch; the app works (in memory) when storage is unavailable.

### Actions (store.dispatch)

`role/set`, `theme/set`, `tab/set`, `clock/start`, `clock/pause`, `clock/speed`, `clock/tick`, `profile/save`, `request/submit`, `request/edit`, `request/cancel`, `samples/load`, `window/planNow`, `plan/store`, `plan/approve`, `plan/rename`, `truck/add`, `truck/remove`, `truck/markOut`, `truck/markAvailable`, `zone/add`, `zone/update`, `zone/remove`, `rally/pin`, `rally/ban`, `rally/clear`, `settings/update`, `settings/resetMethodParams`, `request/lock`, `snapshot/save`, `data/import`, `data/reset`.

`store.subscribe(fn)` notifies after every action. UI modules re-render from state; they never keep their own copy of domain data.

## 4. Catalog and conversions (catalog.js)

Classes in tie-break order: III (Fuel), I (Food & Water), V (Ammunition), VIII (Medical), IX (Repair Parts). Label format `Class III (Fuel)`.

Load groups:
- **Bulk fuel** (Class III diesel/JP-8 and gasoline, gallons) rides only on tankers (2,500 gal).
- **Everything else** (packaged oil & lubricants, Class I, V, VIII, IX) rides on cargo trucks, measured in pallets (10 per truck). `catalog.js` gives `palletsPerUnit` for every item/option, so a line converts to pallets.

A request with both bulk fuel and other items becomes two jobs (one per load group). A job larger than one truck is split into chunks no larger than truck capacity; chunks can go on different trucks or be deferred (partial fill).

Each item has a notional `dailyUse` per platoon (used for hours-of-supply and for the "more than 5x daily use" warning).

## 5. Grid, travel times and closures (network.js)

- `grid.json`: `[{ id, name, lat, lon, kind: 'hub' | 'town' | 'junction' | 'rally', region: 'north' | 'central' | 'south' | 'east', rallyCandidate: bool }]`, about 50 points.
- `grid_links.json`: `[{ a, b, road: 'freeway' | 'highway' | 'mountain' | 'local' }]`, the main-road adjacency between grid points (west-coast freeways, cross-island highways, east-coast and rift-valley highways, Suhua and South Link). It keeps the fallback from cutting straight across the Central Mountain Range and gives every arc a `gridPath` for drawing and for closure checks.
- Base travel minutes between grid points: Google matrix if `google_matrix.json` exists (`source: 'google'`); otherwise fallback = shortest path over `grid_links` with link miles = haversine x road factor (freeway 1.15, highway 1.3, mountain 1.8, local 1.4) at road speeds (freeway 55 mph, highway 40, mountain 22, local 30), flagged `source: 'estimate'` and labeled in the UI. The arc's `gridPath` is always the link-graph shortest path, whatever the time source.
- Convoy minutes = base x convoyFactor (1.5). Miles from the matrix (Google meters) or the estimate.
- Closed zones remove every grid arc whose drawn path (road polyline if available, else its `gridPath` of link segments) passes through the circle. All-pairs shortest paths (Floyd-Warshall, ~50 nodes) give rerouted minutes, miles and the grid-node path. Unreachable pairs = Infinity.
- Risk units for an arc = sum over risk zones of (miles of the path inside the circle x rating value). Time-of-day risk factor is applied per leg at evaluation time.
- Off-grid locations (platoons): a direct-delivery node is the platoon location, connected through its nearest grid point with an added short leg = haversine x 1.3 at 25 mph (convoy factor applied too).

## 6. Road paths for drawing (roads.js)

Layered provider `SRO.core.roads.path(gridA, gridB) -> { coords: [[lat,lon]...], source }`:
1. `precomputed`: from `roads.js` data if the user ran `fetch_osrm_paths.py` (or an offline road graph shipped in the build).
2. `osrm-live`: when online, fetch from the public OSRM demo server, at most 1 request per second, cache in `state.roadCache`.
3. `straight`: straight line, drawn dashed with a legend note "road path unavailable".

Times always come from the matrix, never from the drawn path. The planner map shows a small note: "Road lines are drawn from OpenStreetMap; times come from the travel-time table."

## 7. Solver contract (solver/*)

The solver is pure and deterministic given a seed. The main thread builds an **instance** from state, posts it to the worker, and receives progress and a **solution**.

### Instance (JSON)

```js
{
  startMin,                       // planning time (now)
  nodes: [{ key, kind: 'hub' | 'rally' | 'direct', gridId, lat, lon, label }],
  minutes: [[...]], miles: [[...]], riskUnits: [[...]],   // node x node, already rerouted around closures; Infinity if unreachable
  gridPaths: { 'i|j': [gridId...] },
  periods: [{ startMin, endMin, speed, risk }],           // day-repeating table expanded over 72h
  vehicles: [{ id, type, capacity, hubNode, availableAt, color }],
  jobs: [{ id, requestId, lineIdxs, group: 'fuel' | 'cargo', qty, unit,
           tier: 0..3 (Routine..Immediate), classRank: 0..4, deadline, hardDeadline: bool,
           candidates: [{ node, platoonMiles, platoonCost, hint: bool }],   // direct node and/or rally nodes within radius
           lockedTruck: null | id }],
  weights: { fuel, distance, risk, simplicity },
  params: { mpg, serviceMin, loadMin, maxRallyPoints, pinnedRally: [node], bannedRally: [node] },
  penalties: { latePerMin: [1, 3, 50, 500], defer: [200, 600, 5000, 50000], classFactor: [1.0, 0.9, 0.85, 0.8, 0.6] },
  fixed: null | { /* contingency: delivered stops and en-route truck states */ }
}
```

### Solution

```js
{ routes: [{ vehicle, visits: [{ node, jobs: [{ job, qty }] }] }] }
```

`vehicle`, `node` and `job` are integer indexes into `instance.vehicles`, `instance.nodes` and `instance.jobs`. A vehicle appears in at most one route (one trip per window). Anything not delivered is deferred; `evaluate` derives deferred quantities, so a solution never lists them.

### Evaluation semantics (exact rules for evaluate.js)

- **Start.** A vehicle starts at `startNode` (default `hubNode`) at `t0 = max(instance.startMin, availableAt) + (preloaded ? 0 : loadMin)`, visits its stops in order, then returns to `hubNode`. Contingency re-plans set `startNode`, `availableAt` and `preloaded: true` on en-route trucks, and lock the jobs they carry with `lockedTruck`.
- **Legs.** Leg minutes = `minutes[i][j] / period.speed`, using the period that contains the leg's departure minute. Leg risk = `riskUnits[i][j] * period.risk`. Miles and risk units are counted for every leg including the return leg. A leg with `minutes = Infinity` makes the solution infeasible.
- **Stops.** Arrival time is the delivery time for every job at that stop. Each stop adds `serviceMin` before departure. No waiting for early arrival.
- **Capacity and type.** Fuel jobs only on tankers, cargo jobs only on cargo trucks; the sum of quantities on a route is at most the vehicle capacity.
- **Splits.** A job may appear in several stops (same or different trucks). Sum of delivered quantity is at most `job.qty`; the remainder is deferred.
- **Nodes.** A job may only be delivered at a node in its `candidates`. Platoon cost is counted once per distinct (requestId, node) pair used: `weights.distance * candidate.platoonCost` (`platoonCost` already includes miles x mobility cost per mile).
- **Rally points.** Distinct rally nodes used (including pinned ones that are used) at most `maxRallyPoints`; banned rally nodes never appear in candidates.
- **Lateness** per delivered chunk = `max(0, arrive - job.deadline) * latePerMin[tier] * qty / job.qty`.
- **Deferral** per job = `deferredQty / job.qty * defer[tier] * classFactor[classRank]`.
- **Simplicity** = `5 * total stops + 25 * trucks used` (a route with no stops is not used and costs nothing).
- **Violations** (wrong vehicle type, over capacity, node not a candidate, too many rally points, unreachable leg, vehicle used twice, locked job on the wrong truck, quantity over job qty) are listed in `violations` and each adds `1e7` to `total`, so heuristics can pass through infeasible states but never prefer them. `feasible = violations.length === 0`.
- **Hard deadlines.** A late Immediate job is not a violation (sometimes it is unavoidable) but is listed in `hardLate` so the plan can flag it.

`evaluate` returns `{ total, feasible, cost: { fuel, distance, risk, simplicity, platoon, lateness, deferral }, routes: [{ vehicle, depart, returnAt, miles, gallons, riskUnits, stops: [{ node, arrive, depart, periodIdx, jobs }], legs: [{ from, to, depart, arrive, miles, riskUnits, periodIdx }], cost }], delivered: [qty per job], deferred: [{ job, qty }], late: [{ job, minutesLate }], hardLate: [job], rallyNodes: [node], violations: [{ code, detail }] }`. `SRO.solver.explainDeferred(instance, evalResult)` labels each deferred job with a reason (`no-truck`, `closed-road`, `radius`, `time`, `capacity`) for the planner's explanations.

`evaluate(instance, solution)` is the single source of truth for schedule and cost. Every method must score with it, so the compare table is apples to apples.

### Cost (evaluate.js)

```
fuel       = weights.fuel       * gallons                      (gallons = truck miles / mpg)
distance   = weights.distance   * 0.5 * truck miles
risk       = weights.risk       * riskUnits x period risk factor
simplicity = weights.simplicity * (5 * stops + 25 * trucks used)
platoon    = weights.distance   * sum(platoonMiles x mobility costPerMi)
lateness   = sum(minutes late x latePerMin[tier])
deferral   = sum(deferred job share x defer[tier] x classFactor[classRank])
total      = sum of the above
```

Penalties are sized so that a missed deadline or deferral always costs more than any routing savings, and deferral order follows Routine, Priority, Urgent, Immediate, then class rank, then cost. Immediate deadlines are hard: a solution that misses one is only accepted if no feasible alternative exists, and the plan flags it.

Constraints: capacity per truck per trip; one trip per truck per window; truck starts after `availableAt + loadMin` at its home hub and returns there; at most `maxRallyPoints` distinct rally nodes (pinned count toward it; banned never used); a job's node must be one of its candidates; `lockedTruck` respected.

### Methods

| key | name in UI | notes |
|---|---|---|
| `tabu` | Tabu search | default; relocate/swap/2-opt/rally-reassign moves, tabu tenure, aspiration |
| `sa` | Simulated annealing | same move set, geometric cooling |
| `aco` | Ant colony | pheromone on (node, node) and (job, candidate) choices, local search on best ant |
| `mip` | Exact (MIP) | HiGHS WebAssembly, time limit, returns best incumbent + gap; warm start if supported |

All methods start from `construct.js` output. Each reports progress at least every 250 ms: `{ fraction, bestCost, elapsedSec, message }`. Cancel terminates the worker; the last reported best solution is kept.

`estimate(instance, method, params) -> { seconds, low, high, basis }` from a quick timing probe on the actual instance.

### Method parameters (planner-tunable, Advanced tab)

`src/solver/params.js` is the single source of truth: `SRO.solver.PARAMS[method] = [{ key, label, help, type: 'int'|'float'|'bool'|'select', min, max, step, default, options? }]` plus `SRO.solver.defaultParams(method)` and `SRO.solver.clampParams(method, params)`. The UI builds the tuning form from this table, so a new knob needs one entry here and nothing else in the UI.

| method | key | label in UI | default | range |
|---|---|---|---|---|
| all | `seed` | Random seed | 20261005 | 1-999999999 |
| all | `timeCapSec` | Stop after (seconds) | settings.timeLimitSec | 5-1800 |
| tabu | `iterations` | Iterations | 4000 | 100-100000 |
| tabu | `tenure` | Tabu tenure (moves a change stays forbidden) | 12 | 1-200 |
| tabu | `neighborhood` | Moves checked per iteration | 200 | 10-5000 |
| tabu | `restartAfter` | Restart after this many non-improving iterations | 600 | 0 (off)-50000 |
| tabu | `aspiration` | Allow a forbidden move if it beats the best plan | true | bool |
| sa | `startTemp` | Start temperature (0 = auto) | 0 | 0-1e7 |
| sa | `autoAcceptRate` | Auto start: accept this share of worse moves | 0.5 | 0.05-0.95 |
| sa | `coolingRate` | Cooling rate (per step) | 0.995 | 0.80-0.99999 |
| sa | `itersPerTemp` | Moves per temperature step | 100 | 1-10000 |
| sa | `stopTempRatio` | Stop when temperature falls to this share of start | 0.001 | 1e-6-0.5 |
| sa | `reheats` | Reheats | 2 | 0-20 |
| aco | `ants` | Ants per iteration | 20 | 1-500 |
| aco | `iterations` | Iterations | 150 | 1-10000 |
| aco | `alpha` | Pheromone weight (alpha) | 1.0 | 0-10 |
| aco | `beta` | Distance weight (beta) | 3.0 | 0-10 |
| aco | `evaporation` | Evaporation rate (rho) | 0.10 | 0.01-0.99 |
| aco | `q` | Deposit amount (Q) | 1.0 | 0.01-1000 |
| aco | `localSearch` | Polish best ant with local search | true | bool |
| mip | `timeLimitSec` | Time limit (seconds) | settings.timeLimitSec | 5-1800 |
| mip | `mipGap` | Stop when within this gap of optimal | 0.01 | 0-0.5 |
| mip | `warmStart` | Start from heuristic plan | true | bool |

Rules: heuristics stop at whichever comes first of their own iteration budget, `timeCapSec`, or Cancel. `instance.methodParams` is the clamped copy of `settings.methodParams[method]` and is stored on the Plan (`plan.method`, `plan.params`) so snapshots record exactly what produced them. Changing any knob re-runs `estimate()`. Each method's panel has a "Reset to defaults" button; changed knobs show a dot and their default value beside them. Compare mode runs each selected method with its current params.

## 8. UI contract

- `index.html` has: `#topbar`, `#app` with `#psg-root` and `#planner-root`, `#toast-root`, `#modal-root`, `#print-root`.
- Role switch at the top. On wide screens the platoon sergeant view is a centered phone-width panel; on phones it fills the screen. The planner view uses side panels on wide screens and tabs (Map / Queue / Plan / Scenario / Outputs) on narrow screens.
- Themes via `html[data-theme="dark"|"light"|"night"]` CSS custom properties. Night mode is red-on-black and dims the map tiles.
- Each view module exports `{ mount(el), update(state) }` and registers with `SRO.ui.registerView(name, view)`.
- Map (`SRO.ui.map.create(el, opts)`) is shared by both roles. Layers: base (OSM tiles online, Taiwan coastline offline), zones, hubs, rally points (+ dismounted walking ring), platoons (2525 symbol + urgency ring), routes (truck color + direction arrows), trucks (animated by clock).
- Urgency ring colors: Routine gray, Priority yellow, Urgent orange, Immediate red pulsing. Same colors in lists and cards.
- Truck colors: 8 distinct colors, readable on dark, light and night themes; fixed per truck everywhere.
- Formats: `format.js` is the only place that formats times, DTGs, MGRS, classes and miles.
- Nothing in the app mentions medevac.

## 9. Build and tests

- `python3 tools/build.py` writes `prototype/supply-route-app.html`, fully self-contained except OSM tiles and live OSRM paths (both optional at runtime).
- `node --test tests/solver` runs solver tests: evaluate correctness on hand-checked instances, constraint checks on every method's output, brute-force optimum comparison on tiny instances, MIP on a tiny instance equals brute force.
- `tests/ui/*.spec.mjs` opens the built file from `file://` in Chromium at 390x844, 820x1180 and 1440x900 in all three themes and checks the states in section 8.3 of the skill (empty, one request, full window, infeasible window, after contingency re-plan), with zero console errors.
