# Supply Route Optimizer (MA481X prototype)

Prototype app for hypothetical supply route optimization in a defense-of-Taiwan scenario. Platoon sergeants request supply (Class III, I, V, VIII, IX); a planner runs an optimizer across all requests in a 6-hour window and approves routes. All data is notional.

- Phase 1 (this repo): internal to Taiwan, fictional hubs, up to 20 stops, Google travel times, OpenStreetMap roads.
- Phase 2: neighboring nations (to be merged with a separate app).

## Contents
- `docs/spec-answers.md`: every product decision from the interview, in order.
- `docs/client-meeting-notes.md`: transcription of the client meeting notes.
- `docs/skill/SKILL.md`: the interview skill (supply-route-app-builder) used to drive the build.
- `prototype/`: the single-file HTML prototype (`supply-route-app.html`, coming next).
