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

## State of the checks at the freeze

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | passes |
| `npx vitest run` | 187 of 187 pass |
| `npm run build` | passes |
| `node tools/smoke.mjs --mode dist` | 48 of 48 checks |
| `node tools/smoke.mjs --mode dist --embed sandbox` | 17 of 17 checks |
| `node tools/campaign.mjs --mode dist --god 1` | bot reaches victory |

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
| fx | stub |
| audio | stub |
| ui | stub |

## Files here

- `BRIEF.md` — the production brief: vision, technical rules, game design, art and audio direction,
  architecture, working rules, rulings.
- `assign/` — one assignment per system, each with pointers into the contract.
- `foundation/` — results of the foundation phase (architect, reviews, verification) and the orchestration
  script used for it.
