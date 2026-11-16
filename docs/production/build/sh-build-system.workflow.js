export const meta = {
  name: 'sh-build-system',
  description: 'Static Horizon: implement one game system against the frozen contract',
  phases: [
    { title: 'Implement', detail: 'one engineer replaces a stub with the shipping implementation' },
  ],
}

const REPO = '/home/user/Testing-2'
// Pass the session's scratch directory as args.scratch; the literal is only a fallback.
const SCRATCH = (args && args.scratch) || '/tmp/claude-0/-home-user-Testing-2/6bb73113-d5ad-55b7-9619-608c6eaa77e8/scratchpad'
const DOCS = REPO + '/docs/production'
const BRIEF = DOCS + '/BRIEF.md'

const M = {
  fx: { role: 'visual effects (FX)', assign: 'fx', owns: 'src/fx/**', stub: 'src/fx/index.ts', port: 5211, visual: true },
  combat: { role: 'combat systems', assign: 'combat', owns: 'src/combat/** and the values in src/data/projectiles.ts', stub: 'src/combat/index.ts', port: 5212, visual: true },
  world: { role: 'level / world', assign: 'world', owns: 'src/world/**', stub: 'src/world/index.ts', port: 5213, visual: true },
  render: { role: 'rendering', assign: 'render', owns: 'src/render/** and the values in src/data/timeOfDay.ts and src/data/quality.ts', stub: 'src/render/index.ts', port: 5214, visual: true },
  player: { role: 'player character', assign: 'player', owns: 'src/player/**', stub: 'src/player/index.ts', port: 5215, visual: true },
  'enemies-core': { role: 'enemy systems (manager and the three basic kinds)', assign: 'enemies-core', owns: 'the paths listed under "Files you own" in your assignment (src/enemies/index.ts, the kinds skitter / tick / riveter, shared helpers, src/enemies/kinds/index.ts) and the values of your rows in src/data/enemies.ts', stub: 'src/enemies/index.ts and src/enemies/kinds/*', port: 5216, visual: true },
  weapons: { role: 'weapons', assign: 'weapons', owns: 'src/weapons/** and the values in src/data/weapons.ts', stub: 'src/weapons/index.ts', port: 5217, visual: true },
  'enemies-elite': { role: 'elite enemies (wasp, lancer, bulwark)', assign: 'enemies-elite', owns: 'the paths listed under "Files you own" in your assignment (the kinds wasp / lancer / bulwark, your helpers and tests, your lines in src/enemies/kinds/index.ts) and the values of your rows in src/data/enemies.ts', stub: 'src/enemies/kinds/placeholder.ts (the kinds you add currently fall back to it)', port: 5218, visual: true },
  director: { role: 'game director (waves, perks, pickups, score, run flow)', assign: 'director', owns: 'src/director/** and the values in src/data/waves.ts, perks.ts, pickups.ts, difficulty.ts', stub: 'src/director/index.ts', port: 5219, visual: true },
  boss: { role: 'boss (THE CONDUCTOR)', assign: 'boss', owns: 'the paths listed under "Files you own" in your assignment (src/enemies/kinds/conductor.ts, src/enemies/boss/**, your line in src/enemies/kinds/index.ts) and the values of the conductor row in src/data/enemies.ts', stub: 'src/enemies/kinds/placeholder.ts (the conductor currently falls back to it)', port: 5220, visual: true },
  audio: { role: 'audio (synthesised sound and adaptive music)', assign: 'audio', owns: 'src/audio/** plus the one new file tools/audio-check.mjs', stub: 'src/audio/index.ts', port: 5221, visual: false },
  ui: { role: 'UI / HUD', assign: 'ui', owns: 'src/ui/** and index.html (under the rule in brief section 7)', stub: 'src/ui/index.ts', port: 5222, visual: true },
}

const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    gates: {
      type: 'object',
      properties: {
        typecheck: { type: 'string' },
        unitTests: { type: 'string' },
        smoke: { type: 'string' },
        liveCheck: { type: 'string' },
      },
    },
    contractRequests: { type: 'array', items: { type: 'string' } },
    judgementCalls: { type: 'array', items: { type: 'string' } },
    integrationNotes: { type: 'array', items: { type: 'string' } },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'files', 'gates', 'integrationNotes', 'openIssues'],
}

const key = args && args.key
const m = M[key]
if (!m) throw new Error('unknown module key: ' + key)
const done = (args && args.done) || []
const scratch = SCRATCH + '/' + key
const doneText = done.length
  ? 'these systems are already the real implementations: ' + done.join(', ') + ' (plus core, physics and nav, which are finished foundation code)'
  : 'only core, physics and nav are finished foundation code so far'

const visualLine = m.visual
  ? '- Verify for real, not by reading: the unit tests the assignment lists (npx vitest run src/<your dir>), the filtered type-check from brief section 7, and the RUNNING GAME through the harness in dev mode on your port. Take screenshots into your scratch directory and LOOK at them with the Read tool (960x540 at device scale 1 is enough for your own checks). Judge them the way an art director would and iterate until they hold up: composition, readability at a glance, the colour script, glow, silhouette, scale. For anything animated take a short sequence of frames. A feature you have not seen working in the browser is not done.'
  : '- Verify for real, not by reading: the unit tests the assignment lists (npx vitest run src/<your dir>), the filtered type-check from brief section 7, and the RUNNING GAME through the harness in dev mode on your port, using the measurement hooks your assignment names. A feature you have not measured or exercised in the browser is not done.'

const PROMPT = [
  'You are the ' + m.role + ' engineer of STATIC HORIZON, an original browser first-person shooter (TypeScript + three.js, fully procedural art and audio, no asset files). The game is being built system by system against a frozen code contract; you are building one system, alone, in one pass. Nobody rewrites your work afterwards: what you leave is what ships. Build the complete, polished, production version, not a prototype and not a subset.',
  '',
  'READ FIRST, in this order:',
  '1. The production brief: ' + BRIEF + ' (all of it; sections 7 and 8 are the working rules and the rulings).',
  '2. Your assignment: ' + DOCS + '/assign/' + m.assign + '.md . Its "Contract pointers" section tells you which parts of the contract are yours.',
  '3. The contract ' + REPO + '/src/core/types.ts (about 4,400 lines): the whole header first (conventions, frame pipeline, clocks, feedback ownership, levels / impulses / handles, error containment, rendering conventions: every sentence there binds you), then every section your Contract pointers name, completely, then the interface of every other system you call. You may skim sections that have nothing to do with you. Also read src/core/constants.ts, make.ts, math.ts, palette.ts and pool.ts: use those helpers instead of duplicating them.',
  '4. What you replace: ' + m.stub + ' , and the data tables you read or tune in src/data/.',
  '5. src/core/debug.ts (the window.__SH debug API) and tools/harness.mjs, so you can drive the real game in a headless browser.',
  '',
  'STATE OF THE REPO: ' + doneText + '. Every other system is still a tiny gray-box stub that only satisfies the interface (a stub fx system draws nothing, a stub audio system is silent, the stub world is a flat floor with a few boxes). Code only against the contract, never against the internals of a stub or of another system.',
  '',
  'YOU OWN: ' + m.owns + ' . Edit nothing else (brief section 7). Your dev-server port is ' + m.port + ' . Your scratch directory is ' + scratch + ' (create it; all temporary files and screenshots go there).',
  '',
  'HOW TO WORK',
  '- Plan the module layout first: several focused files inside your directory; the entry point keeps the factory name and signature the contract prescribes.',
  '- Implement everything in the assignment. Where the assignment, the brief and the contract disagree, the contract wins. Where the contract is silent, the rulings in brief section 8 apply, then your best judgement: record every such judgement call in your report.',
  '- Performance is part of correctness: no allocation in per-frame paths (pool, reuse scratch objects), instancing or merged geometry to stay inside the draw-call budgets of the brief, never change the number of lights, no shader recompiles at runtime, everything warmed in init().',
  visualLine,
  '- The machine has 4 cores and is shared with another engineer who is also running tests and a headless browser: give harness calls generous timeouts, run one browser at a time, close every process you start, and never kill a process you did not start.',
  '- Before you finish, review your own work once more as if a colleague had written it: lifecycle (init / reset / dispose restore a pristine state; a second run behaves exactly like the first), clocks (which dt each piece uses; behaviour while paused, hard-frozen for perk select, and during Overclock), feedback ownership (you trigger everything you own and nothing you do not), error paths, and then every bullet of the assignment, ticked off one by one against the code.',
  '- Last step: `node tools/smoke.mjs --mode dev --port ' + m.port + '` must still pass with your system in place. If a check fails because of your system, fix your system. If it fails for a reason outside your directory, report exactly which check and why.',
  '',
  'REPORT (structured): summary; files; gates (typecheck, unitTests with counts, smoke, liveCheck = what you looked at or measured in the running game: exact results); contractRequests (what you needed that the frozen contract lacks, and how you worked around each); judgementCalls; integrationNotes (assumptions about other systems that an integrator must know, including anything you could not verify because another system is still a stub); openIssues (what is not done or not verified: be exact and honest).',
].join('\n')

phase('Implement')
const report = await agent(PROMPT, { label: 'build:' + key, phase: 'Implement', schema: REPORT })
if (!report) throw new Error('build:' + key + ' returned no report (interrupted?)')
return { key, report }
