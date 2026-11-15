# Static Horizon — production status

Checkpoint taken mid-way through the foundation phase. Everything needed to resume is in this folder.

## Done

- Project scaffold: Vite + TypeScript (strict) + three.js, vitest.
- Engine contract: `src/core/types.ts` plus the core implementations (game state machine, loop, input, settings, events, debug API and autopilot bot).
- Tuning tables in `src/data/`.
- Gray-box stub of every system (`combat`, `world`, `render`, `player`, `weapons`, `enemies`, `director`, `fx`, `audio`, `ui`), so the game runs end to end.
- Playwright harness in `tools/` (`smoke.mjs`, `campaign.mjs`, `shots.mjs`).
- Hardened collision world and nav grid (`src/physics`, `src/nav`) with unit tests.

## State of the checks at this checkpoint

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | passes |
| `npm run build` | passes |
| `node tools/smoke.mjs --mode dist` | passes |
| `npx vitest run` | 80 of 81 pass |

The failing test is `src/physics/collision.test.ts` › "does not allocate per query once warmed up": it measures about 240 KB of heap growth per 15 000 queries against a 32 KB limit. The physics work was stopped while this was being investigated, so it is open whether the queries really allocate or the measurement is noisy.

## Not done yet

1. Finish the foundation phase:
   - resolve the failing physics allocation test;
   - run the presentation review of the contract (it was stopped before reporting);
   - apply the blocker and major gaps from `foundation/critic-gameplay.result.json` to `src/core/types.ts`, then freeze the contract.
2. Build the real systems against the frozen contract, one owner per directory, following `BRIEF.md` and `assign/*.md`.
3. Integrate, then run the full bot campaign to victory.
4. Review and polish rounds: gameplay balance, visuals, bugs, performance, UI at several viewport sizes, audio, input fallbacks.
5. Package a single-file build and write the README.

## Files here

- `BRIEF.md` — the production brief: vision, technical rules, game design, art and audio direction, architecture.
- `assign/` — one assignment per system.
- `foundation/architect.result.json` — what the foundation pass built and how it was verified.
- `foundation/critic-gameplay.result.json` — contract gaps found by the gameplay review, not yet applied.
- `foundation/sh-foundation.workflow.js` — the orchestration script used for the foundation phase.
