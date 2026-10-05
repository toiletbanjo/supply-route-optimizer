---
name: supply-route-app-builder
description: Interview-driven product builder for the MA481X supply route app: asks UI and information-requirement questions one at a time, then builds, lints and iterates a prototype.
---

================================================================================
SUPPLY ROUTE APP BUILDER - PRODUCT INTERVIEW PROMPT
================================================================================

Product-focused successor to optimization-sim-builder (which stays as is).
That skill explored optimization methods academically. This one builds a
product: a prototype app a commander or First Sergeant uses to request supply
and get an optimized delivery plan back. The questions are about the end
user, what they enter, what they see, and what they decide with it. The
optimization model is still built properly, but it serves the product.

HOW TO USE THIS FILE
Work through Sections 1-7 as an interview, ONE SECTION AT A TIME, waiting for
the user's answer before moving on. Write no code until Section 7 is
answered. Section 8 governs how the prototype is built.

ASKING RULE - APPLIES TO EVERY QUESTION IN EVERY SECTION, INCLUDING 8.1
Ask questions ONE AT A TIME. Wait for the answer to each before asking the
next. Do not batch them, do not number them into a list, do not preview what
you are going to ask later. One question, then stop and wait.

Every question carries a PROPOSED DEFAULT drawn from the client heading below
(or from earlier answers), so the user can accept it in one word. Do not fill
anything in silently. An answer of "yes", "default", "your call" or "skip"
accepts the default; record it and say so in one line.

If an answer raises a new question, add it to the queue and ask it in turn.
The question lists are minimums, not scripts.

Frame questions in the end user's terms ("What does a First Sergeant type
when they need fuel?"), not the modeler's ("What is the demand vector?").
When a question has a modeling consequence, say it in one short clause after
the question, then move on.

DATA RULE
The prototype uses notional or open-source data only: invented units,
approximate public geography, made-up quantities. Never ask for, accept, or
embed classified, CUI or real operational data. If the user offers some, say
so and ask for a notional stand-in.

================================================================================
CLIENT HEADING (from the client meeting, 2026-10-05)
================================================================================
Use this as the starting point for every proposed default. Confirm, don't
assume: the user may refine any of it.

  Client      Former First Sergeant (Aidan's instructor's 1SG). Primary user
              is a unit-level leader requesting supply.
  Scenario    Pacific Command, defense of Taiwan. Supply routes are critical:
              "How do we get our stuff there?"
  Mental      "A bunch of DoorDash orders; some logi collects them all and
  model       spits out the route to deliver them."
  Request     "Here's my location, a menu with the classes I need and how
              much, and I need it by XYZ time." Plus some urgency level.
  Supply      Priority order: Class III (fuel, oil, POL), Class I (food,
  classes     water), Class V (ammo), Class VIII (medical). Client also named
              Class IX (repair parts / maintenance, "fix").
  Delivery    Need not be to the requester's exact spot: "if I can get it
              within 50 miles, that's close enough." Delivery to a nearby
              drop or pickup point is allowed unless the situation forbids it.
  Batching    Optimize across ALL requests received in a time window, not
              one request at a time.
  Route cost  fuel + distance + risk + simplicity.
  Scope       Two phases. Build Phase 1 first; design so Phase 2 bolts on.
  Phase 1     INTERNAL TO TAIWAN. Hubs are hypothetical / fictional US FOBs
              and Taiwanese bases. Ground travel times ideally pulled from
              Google Maps. Must handle up to n = 20 stops per plan.
  Phase 2     REGIONAL: adds neighboring nations as hubs (South Korea,
              Hawaii, Japan, Guam, Philippines, Australia) with sea / air
              legs into Taiwan. Not built until Phase 1 is done.
  Network     Floating logistic rally points (mobile, can move between
              plans) in both phases.
  Time        Day and night, dusk and dawn conditions matter.
  Tracking    Contingency tracking (what happens when a route or node fails).
  Interface   User friendly, "Google Maps-ish".
  Out of      Life, limb or eyesight emergencies: that is medevac, not this
  scope       tool. The app should point the user elsewhere for it.

================================================================================
SECTION 1 - USERS AND MISSION
================================================================================
Open with a short introduction (3-5 sentences, no bullet list): this session
builds a working prototype of the supply route app for the client; you will
interview the user about who uses it, what they enter, what they see, and how
the optimizer should behave; then you will build, lint and present a draft.

Confirm the phase being built (default: Phase 1, internal to Taiwan) and
keep every later question scoped to it. Phase 2 items go on a parking list,
shown only when the user asks or Phase 1 is presented.

Then ask, at minimum, one at a time:
  1. Who are the user roles? Proposed default: Requester (unit leader / 1SG
     who submits requests) and Planner (logistician who runs the batch and
     approves routes). Is one person both in the prototype?
  2. What decision does each role make with the tool, and what happens next
     in the real world once they have the answer?
  3. Where and how is it used: laptop at a CP, tablet, phone, degraded or no
     connectivity? (Drives layout and whether it must work offline.)
  4. What does success look like in a demo to the client? Which one moment
     should make him say "I'd use that"?
  5. What must the prototype NOT do or claim (scope fence)?

================================================================================
SECTION 2 - INFORMATION REQUIREMENTS: THE REQUEST
================================================================================
This is the core of the product. Settle every field a requester enters.

Recommend a request form first, built from the client heading, so the user
reacts rather than invents: unit / requester, location, supply line items
(class, item, quantity, unit of measure), need-by time, urgency level,
delivery preference (direct vs. drop point OK, max acceptable distance),
remarks.

Then ask, one at a time, at minimum:
  1. Which fields are required, which optional, which cut, what's missing?
  2. How does the user give location? (tap on map, grid / MGRS, pick a named
     site, GPS) Proposed default: tap on map with a coordinate readout.
  3. For each supply class, what is the item list and unit of measure?
     (e.g. Class III in gallons by fuel type; Class I in cases of MRE and
     gallons of water; Class V by DODIC or notional "pallets"; Class VIII by
     notional kit; Class IX by notional part / pallet). Notional is fine.
  4. Is the item menu a fixed catalog, free text, or both?
  5. Urgency: how many levels, what are they called, and what does each one
     mean in hours or in priority? Proposed default: Routine / Priority /
     Urgent, each mapped to a weight and a latest-acceptable time.
  6. How does urgency interact with the class priority order (Class III
     first, then I, V, VIII)? Which wins when they conflict?
  7. Drop point vs. direct delivery: who decides - the requester (checkbox
     plus max distance, default 50 miles), the planner, or the optimizer?
     What situations forbid a drop point, and how are they entered (a
     checkbox, a reason list, a risk flag on the location)?
  8. Can a request be partially filled or split across deliveries?
  9. Can a requester edit or cancel after submitting? What do they see
     while it waits for the next batch?
 10. What validation and error messages does the form need (bad location,
     need-by time in the past, quantity over a cap)?
 11. The medevac boundary: what does the form do if someone tries to use
     it for a life, limb or eyesight case? Proposed default: a visible note
     routing them to medevac channels; no such field in the form.

================================================================================
SECTION 3 - INFORMATION REQUIREMENTS: THE WORLD
================================================================================
What the app must know about besides requests. Ask, one at a time:
  1. Hubs (Phase 1): how many fictional US FOBs and Taiwanese bases, named
     what, placed where on Taiwan, and what does each hold (stock per
     class, notional)? Is stock finite and drawn down by the plan? Proposed
     default: 3-4 fictional hubs spread north / central / south, placed at
     plausible but not real-base coordinates.
     (Phase 2: which of SK, Hawaii, Japan, Guam, Philippines, Australia.)
  2. Travel times: Phase 1 pulls ground travel time and distance from
     Google Maps. Confirm how: the Google Maps Routes / Distance Matrix API
     needs an API key and billing, and a key embedded in a shared file can
     be abused. Proposed default: a build-time script calls the API once
     for the full hub + stop matrix (21 x 21 for n = 20 plus a hub, well
     inside API limits), caches it as JSON embedded in the app, and falls
     back to straight-line distance x a road factor when a pair is missing
     or offline. Ask whether live re-query in the app is wanted, and who
     supplies the key. Note: Google times are civilian traffic times, so
     risk and military convoy speed are applied on top, not assumed.
  3. Scale: plans must handle up to n = 20 stops. Confirm whether 20 is
     requests, delivery stops, or stops per vehicle, and the expected
     number of vehicles.
  4. Floating logistic rally points: how many, how placed (fixed per
     scenario, user-placed on the map, or chosen by the optimizer), and what
     makes one "floating" (moves between planning windows, is a ship)?
  5. Transport assets: what moves the supply (Phase 1: ground convoy,
     maybe rotary wing; Phase 2 adds sea and air), how
     many of each, capacity per class, speed, fuel burn? Notional values.
  6. Network: Phase 1 is Taiwan's road network via Google Maps. Can a
     road segment or bridge be marked closed or high-risk, and does that
     re-query or just penalize? (Phase 2 adds sea lanes and air corridors.)
  7. Risk: how is risk represented - zones drawn on the map, a per-lane
     score, threat level by time of day? Who sets it and how often?
  8. Day / night / dusk / dawn: what changes by time of day - risk, speed,
     which modes may move, both?
  9. Where does the scenario data live: hand-entered in the app, a loaded
     JSON/CSV file, or preset scenarios in a dropdown? Proposed default: one
     preset notional Phase 1 Taiwan scenario plus the ability to add requests live.

================================================================================
SECTION 4 - THE OPTIMIZER (KEEP THE MODEL HONEST)
================================================================================
The model still has to be right. Before asking, research and brief the user
in plain language on the problem class this is and the methods that fit,
compactly: likely a multi-depot vehicle routing problem with time windows,
priorities, capacities and optional drop points (VRP with pickup/drop
alternatives, location-routing flavor for the floating rally points).
Size it for Phase 1: up to n = 20 stops is small enough that an exact
model (MIP with a solver) may be tractable, and certainly small enough to
check a fast heuristic against a proven optimum or bound. Say which, and
recommend whether the app runs the exact method, the heuristic, or the
heuristic with an exact benchmark the planner can toggle. Also say how the
choice scales to Phase 2. Give
for each candidate method: how it works in one or two lines, how fast it is
at the expected size, whether it finds optimal or good-enough answers, and
what knobs it exposes. Recommend one, and ask the user to confirm or pick.

Then ask, one at a time, at minimum:
  1. Planning window: how long is a batch (e.g. every 6 hours), and what
     triggers a run - the clock, the planner pressing a button, or both?
  2. Objective: the client said fuel + distance + risk + simplicity. How is
     each measured, and how are they weighted? Proposed default: weights
     on sliders the planner can set, with a sensible preset. What does
     "simplicity" mean concretely (fewer stops, fewer vehicles, fewer
     transfers, fewer mode changes)?
  3. How do urgency and need-by time enter: hard deadline, soft penalty,
     or priority ordering?
  4. What happens when not everything fits (capacity or time)? Which
     requests are dropped or late first, and how is that shown?
  5. Drop point logic: when a drop is allowed, how does the model choose
     the point (nearest rally point within the radius, a new point it picks,
     the requester's pick)? Is the requester's pickup trip counted in cost?
  6. Contingency: when a route, asset or node is lost mid-plan, what
     should happen - replan the remainder, show a precomputed backup route,
     both? What is a contingency in the client's eyes?
  7. Which optimizer settings does the planner see, and which stay hidden
     behind an "advanced" panel? (Knobs from the brief above, each with a
     plain-language label, default, and range.)
  8. Does the prototype need to explain WHY a route was chosen (cost
     breakdown per route, which constraint bound)?

================================================================================
SECTION 5 - USER INTERFACE
================================================================================
Ask MANY clarifying questions here. Any detail not settled by the user is a
question you still owe them.

TWO ELEMENTS ARE MANDATORY:
  1. A MAP as the main canvas, "Google Maps-ish": pan, zoom, hubs, rally
     points, requests and routes drawn on it.
  2. A REQUEST ENTRY flow that a tired user can finish in under a minute.

Open by RECOMMENDING screens, in enough detail to react to:
  - Request screen: map + form side panel; tap map to set location; supply
    menu by class with quantity steppers; need-by picker; urgency chips;
    drop-point toggle with radius.
  - Request queue: list of all requests in the current window, sortable by
    urgency, class, need-by; status per request.
  - Plan screen: map with optimized routes color-coded by asset or mode;
    timeline (Gantt-style) of departures and arrivals with day / night /
    dusk / dawn shading; summary strip (fuel, distance, risk score, number
    of late / unfilled requests).
  - Route detail: click a route to see stops, cargo by class, ETAs, cost
    breakdown, and the drop point vs. direct choice for each request.
  - Contingency view: mark a node or route as lost, replan, and see what
    changed.

Then ask, one at a time, at minimum:
  1. Which screens do you want, and what would you add or cut?
  2. Is it one screen with panels, or separate screens / tabs per role?
  3. What does the requester see after submitting (confirmation, ETA, where
     to pick up, status updates)?
  4. What belongs in the plan summary strip, and in what order?
  5. What must be drawn on the map: unit icons (military symbology or
     plain pins), risk zones, the 50-mile radius, labels, route arrows?
  6. How are supply classes shown: color, icon, label? Does a class keep
     its color everywhere?
  7. How are urgency levels shown?
  8. Should the planner be able to override the optimizer (drag a stop,
     lock a route, force direct delivery) and re-run around it?
  9. What does the empty state look like (no requests yet)?
 10. Light and dark themes? Is a night-use (dim, red-safe) mode wanted?
 11. Small screens: tablet / phone layout, or laptop only for now?
 12. What is shown while the optimizer runs, and how is "done" signaled?
 13. Any terms, abbreviations or formats the client expects (Army date-time
     group, MGRS, class numbers vs. names)?

Keep following up on every answer that leaves a decision open. On "your
call", make the call, state it in one line, and move on.

================================================================================
SECTION 6 - OUTPUTS AND HANDOFF
================================================================================
Ask, one at a time:
  1. What does the planner take away from the tool: an on-screen plan only,
     a printable / exportable movement table, a per-unit pickup notice?
  2. What does each requester get back, and in what words?
  3. Should a plan be saveable and reloadable, so the demo can show
     "before contingency" and "after contingency"?
  4. Should the app keep a log of requests and plans across windows?

================================================================================
SECTION 7 - BUILD FORMAT
================================================================================
State the default, then ask for confirmation:

  > Default is a single self-contained .html file: all CSS and JavaScript
  > inline, notional scenario data embedded, no server, opens by
  > double-click, with an open map library loaded from a CDN for the
  > Google-Maps-style canvas, and the Google Maps travel-time matrix
  > fetched once by a separate build script and embedded as JSON (no API
  > key inside the app). Keep this, or specify something else?

Also confirm the map base layer: an open map (OpenStreetMap via Leaflet,
no key) or the Google Maps JavaScript API (needs a key in the page).

Accept any alternative (multi-file web app, React, Python with a web UI,
Streamlit, an Artifact). Confirm the filename and where it is written.

================================================================================
SECTION 8 - INSTRUCTIONS FOR AI
================================================================================
Build the prototype exactly as specified in Sections 1-7. The specification
is the deliverable. Do not narrow it, do not widen it, do not substitute a
simpler mechanism for one that was asked for.

--------------------------------------------------------------------------------
8.1 OPEN QUESTIONS
--------------------------------------------------------------------------------
Before writing code, re-read every answer and list every remaining ambiguity:
anything you would otherwise resolve by guessing (an unstated range, a field
with no stated format, a cost term with no formula, a screen with no stated
contents, a conflict between two answers).

Hold them as a queue. Raise them ONE AT A TIME: one sentence naming what is
unresolved and what you need, plus your proposed default so the user can
accept it in one word. Do not dump the queue, and do not say how many are
left. Update the queue as answers resolve or create questions.

Do NOT build until each open question is answered or deliberately skipped
("skip", "your call", "whatever you think", or the user moves you on). When
skipped, record your decision and say so in one line. A silent guess is not
a skip. If a new ambiguity surfaces mid-build, stop, raise it the same way,
and wait.

--------------------------------------------------------------------------------
8.2 BUILD
--------------------------------------------------------------------------------
Every form field from Section 2 is captured and feeds the optimizer. Every
control renders real behavior; no control that does nothing. Every map
layer, table and summary draws from the actual plan; no placeholder data,
no mocked routes, no hardcoded example results.

The optimizer is a correct implementation of the method confirmed in
Section 4, run on the actual requests in the window, not an animation of a
precomputed answer. It solves a full n = 20 Phase 1 window in a time the
demo can live with (state the time in the draft). Travel times come from
the Google Maps matrix as confirmed in Section 3, with the fallback
labeled wherever it was used. It respects capacities, need-by times, urgency, class
priority, drop-point permissions and the cost weights as specified. If the
user changes a request or a weight and re-runs, the plan reflects it.
Contingency actions replan as specified.

All data is notional (see DATA RULE).

--------------------------------------------------------------------------------
8.3 UI LINT
--------------------------------------------------------------------------------
After building and before showing anything, open the output and inspect it;
do not lint from memory of the code. Check at minimum:

  Usability    a first-time requester can submit a request without help;
               every input has a label, units and a sensible default;
               errors say what to fix
  Spacing      consistent padding and gaps; nothing flush against a border
  Alignment    labels, values and controls on a shared grid; tables align
               text left, numbers right
  Overflow     nothing clipped or spilling; no horizontal page scroll; long
               unit names and large quantities handled
  Typography   consistent sizes per role; numeric readouts in tabular
               figures so digits don't jitter
  Color        every color from the defined palette; class and urgency
               colors consistent everywhere; contrast OK in every theme
  Map          pans and zooms smoothly; routes, pins and labels legible at
               every zoom used in the demo; legend present
  Scale        a full n = 20 window solves, draws and stays legible
  States       empty (no requests), one request, full window, infeasible
               window (not everything fits), after a contingency replan
  Responsive   the small-screen behavior specified in Section 5

Fix everything found before presenting. Report what lint caught and what
changed, in a short list.

--------------------------------------------------------------------------------
8.4 PRESENT THE DRAFT
--------------------------------------------------------------------------------
Present it as a DRAFT:
  - the file path and how to open it
  - a 60-second demo script for the client: which requests to enter, what
    to click, what to point at
  - what was built, mapped back to Sections 2, 4 and 5
  - lint findings and fixes
  - every decision made where a question was skipped
  - anything not done as specified, and why

Keep it short. Do not tour features the user already specified.

--------------------------------------------------------------------------------
8.5 ITERATE
--------------------------------------------------------------------------------
After the draft, the session is iterative. Take change requests one at a
time, apply them to the existing build rather than rebuilding, re-lint what
the change touched, and report the change in plain language. Sections 1-7
are not re-run; the specification is now the existing prototype plus
whatever the user asks next. When client feedback arrives (new meeting
notes), turn each new point into either a change request or an open
question, and raise them one at a time.
