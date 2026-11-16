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

Build order for the remaining systems (two at a time; each is launched with
`build/sh-build-system.workflow.js` and the module key):

- Lane A: world -> player -> weapons -> director -> ui
- Lane B: render -> enemies-core -> enemies-elite -> boss -> audio

Each system's report (contract requests, judgement calls, integration notes, open issues) is saved as
`build/<system>.report.json` and feeds the integration phase.

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
