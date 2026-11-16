# Static Horizon — production status

Everything needed to resume is in this folder.

## Done

- Project scaffold: Vite + TypeScript (strict) + three.js, vitest.
- **Frozen engine contract**: `src/core/types.ts` plus the core implementations (game state machine, loop,
  input, settings, events, debug API and autopilot bot). Reviewed twice, revised, independently verified.
- Tuning tables in `src/data/`.
- Hardened collision world and nav grid (`src/physics`, `src/nav`) with unit tests.
- Gray-box stub of every system (`combat`, `world`, `render`, `player`, `weapons`, `enemies`, `director`, `fx`,
  `audio`, `ui`), so the game runs end to end.
- Playwright harness in `tools/` (`smoke.mjs`, `campaign.mjs`, `shots.mjs`), including a sandboxed-embed mode.
- Per-system assignments aligned with the frozen contract (`assign/*.md`), rulings in `BRIEF.md` section 8.

## State of the checks (combat and effects built, the other ten systems still stubs)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | passes |
| `npx vitest run` | 372 of 372 pass |
| `npm run build` | passes |
| `node tools/smoke.mjs --mode dist` | 48 of 48 checks |
| `node tools/campaign.mjs --mode dist --god 1` | bot reaches victory |

Each system's report (contract requests, judgement calls, integration notes, open issues) is saved as
`build/<system>.report.json` and feeds the integration phase.

## How the work is paced

One push per weekly usage reset. A push builds **two** systems side by side and nothing else; every system is
finished, checked, committed and pushed inside the same session. Nothing is ever left half-built: a part that
cannot finish cleanly in one session is split into smaller parts first.

| Push | Work | State |
| --- | --- | --- |
| 0 | foundation, combat, fx | done |
| 1 | world + render | next |
| 2 | player + enemies-core (manager, skitter, tick, riveter) | |
| 3 | weapons + enemies-elite (wasp, lancer, bulwark) | |
| 4 | director + boss (conductor) | |
| 5 | ui + audio | |
| 6 | integration: resolve the systems' contract requests and integration notes, full bot campaign without god mode, first playable single-file build | |
| 7 | review and fix round 1: gameplay / balance, bug hunt | |
| 8 | review and fix round 2: visuals, UI at several viewport sizes, input fallbacks | |
| 9 | performance and audio pass, README, final single-file build | |

### Procedure for one push

1. **Prepare the checkout.** `git fetch origin claude/aaa-shooting-game-scratch-d6mlll` and check that branch
   out (a fresh container starts from a new clone). `npm ci` if `node_modules` is missing. Create the
   session's scratch directory.
2. **Baseline gates** (must be green before anything starts): `npx tsc --noEmit`, `npx vitest run`,
   `npm run build`, `node tools/smoke.mjs --mode dist`.
3. **Launch the two systems of this push**, each as its own run of `build/sh-build-system.workflow.js` with
   `args: { key, done: [systems already built], scratch }`. Keys: `world`, `render`, `player`,
   `enemies-core`, `weapons`, `enemies-elite`, `director`, `boss`, `ui`, `audio`.
4. **When a system reports back**: save its report as `build/<key>.report.json`, mark it in the tables here,
   commit and push. A system that returns no report was interrupted: it is the first thing the next push
   finishes, before anything new starts.
5. **When both are in**: run all gates on the combined tree (step 2 plus
   `node tools/campaign.mjs --mode dist --god 1`), fix or record any failure, mark the push done here, commit,
   push, and stop. Never start a third system in the same push.

## Not done yet

1. Build the real systems against the frozen contract, one owner per directory, following `BRIEF.md` and
   `assign/*.md`. Progress per system is tracked in the table below.
2. Integrate, then run the full bot campaign to victory without god mode on Recruit.
3. Review and polish rounds: gameplay balance, visuals, bugs, performance, UI at several viewport sizes, audio,
   input fallbacks.
4. Package a single-file build and write the README.

## System progress

| System | State |
| --- | --- |
| world | stub |
| render | stub |
| player | stub |
| weapons | stub |
| combat | built (141 unit tests; smoke and god-mode campaign pass) |
| director | stub |
| enemies (manager + skitter, tick, riveter) | stub |
| enemies (wasp, lancer, bulwark) | stub |
| boss (conductor) | stub |
| fx | built (44 unit tests; smoke passes) |
| audio | stub |
| ui | stub |

## Files here

- `BRIEF.md` — the production brief: vision, technical rules, game design, art and audio direction,
  architecture, working rules, rulings.
- `assign/` — one assignment per system, each with pointers into the contract.
- `build/` — the build workflow script and one report per finished system.
- `foundation/` — results of the foundation phase (architect, reviews, verification) and the orchestration
  script used for it.
