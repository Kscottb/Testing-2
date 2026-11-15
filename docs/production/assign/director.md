# Assignment: DIRECTOR  (you own `src/director/**`)

The game master: waves, spawning, pacing, pickups, perks, score, progression, objectives, win/lose. Replace the
stub in `src/director/index.ts`; keep the factory signature. You own the wave/perk/difficulty/pickup data tables
if the contract says the director does; tune them into a 15–22 minute campaign with a real difficulty curve.

- **Wave flow**: warmup banner → combat → cleared → supply drop (when a weapon is due) → perk select (world
  frozen via the layered time scale; capture released/re-acquired per the input contract) → intermission
  countdown (skippable) → next wave. Wave 10 = boss: objective to reach the Core Spire, intro when the player
  enters the arena, spawn the Conductor, victory a few seconds after the boss-defeated event.
- **Spawning**: timed groups from the wave table, a cap on simultaneously alive enemies (queue the rest),
  spawn-point choice (unlocked zones only, weighted to the player's zone and neighbours, 16–45 m from the
  player, prefer out of sight, spread packs across nearby points, right kind of point for flyers/heavies).
  Each wave introduces or recombines enemy types so it teaches: 1 skitters → 2 +riveters → 3 +ticks → 4 wasps
  → 5 lancers → 6 first bulwark → 7–9 mixed elites with denser packs.
- **Anti-stall**: if a few stragglers remain far away for long, mark them as the objective and, after a while,
  re-deploy them near the player through the normal arrival effect. A wave can never soft-lock.
- **Progression**: unlock zones after waves 3 and 6 (gate open, banner, objective), drive time-of-day per the
  schedule, weapon unlocks after waves 1/4/6 by **supply drop** (a pod streaks down onto a drop pad near the
  player, beacon beam, collect by touching: unlock + switch prompt + ammo refill).
- **Perks**: offer 3 distinct perks weighted by rarity, respecting max stacks; apply to `ctx.mods` plus any
  immediate effect (e.g. +max health also heals that amount). All perks from the brief must really work
  end-to-end — coordinate only through the documented modifier fields.
- **Pickups**: drop tables per enemy type with pity logic (guaranteed health when the player is hurt and
  unlucky, ammo when reserves are low), bobbing glowing pickup meshes (instanced per type, friendly cyan /
  health green-white / ammo amber as the contract allows), magnetise, collect effects, expiry with blink,
  FX + sound + events.
- **Score**: base × combo (4 s window, up to ×8), multikill callouts (1.2 s window), crit-kill bonus, wave-clear
  bonus, flawless-wave bonus, run stats, grade, best score/wave persisted through the storage wrapper.
- **Difficulty**: Recruit / Veteran / Nightmare multipliers and density; gentle ramp inside each run.
- **Music/intensity**: feed the audio system's intensity from combat heat if the contract assigns that to you.
- Lose: on the player-died event, short slow-motion, then game over. Everything resets cleanly for a new run.
- Vitest with fake/minimal context: wave runner timing and alive-cap queueing, spawn-point scoring, anti-stall,
  perk offer rules and modifier application, combo/multikill/score maths, grade thresholds, pickup pity logic,
  full flow from wave 1 to victory with a simulated "kill everything" loop, reset.
