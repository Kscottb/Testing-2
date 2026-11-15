// Campaign soak: the autopilot bot plays the whole campaign in manual stepping.
//   node tools/campaign.mjs [--mode dev|dist] [--port 5200] [--god 0|1] [--difficulty veteran]
//                           [--max-sim 3600] [--render-every 240]
// Rendering is mostly skipped (one frame every --render-every simulation frames).
// Prints a JSON report; fails on errors, NaN positions, a stall, or (with --god 1) anything but victory.
import { gameErrors, launchGame, parseArgs } from './harness.mjs';

const args = parseArgs();
const mode = args.mode === 'dist' ? 'dist' : 'dev';
const port = Number(args.port ?? 5200);
const god = (args.god ?? '1') !== '0';
const difficulty = ['recruit', 'veteran', 'nightmare'].includes(args.difficulty) ? args.difficulty : 'veteran';
const maxSim = Number(args['max-sim'] ?? 3600);
const renderEvery = Math.max(1, Number(args['render-every'] ?? 240));

const CHUNK = 2; // simulated seconds per page round-trip
const STALL_SECONDS = 120; // no progress for this long -> assist once (god mode), then fail

const report = {
  tool: 'campaign',
  mode,
  god,
  difficulty,
  ok: false,
  finalMode: '',
  failure: '',
  simSeconds: 0,
  wallSeconds: 0,
  waves: [],
  assists: 0,
  nanFrames: 0,
  maxEnemies: 0,
  finalState: null,
  errors: [],
};

const started = Date.now();
let game;
try {
  game = await launchGame({ mode, port });
  const { sh, step } = game;

  await sh(
    (SH, g, d) => {
      SH.god(g);
      SH.bot(true, { perkDelay: 0.25 });
      SH.start(d);
    },
    god,
    difficulty,
  );

  let sim = 0;
  let wave = 0;
  let waveStart = 0;
  let lastProgress = 0;
  let progressKey = '';
  let assisted = false;
  let s = await sh((SH) => SH.state());

  while (sim < maxSim) {
    s = await step(CHUNK, { render: renderEvery });
    sim += CHUNK;

    // Wave bookkeeping.
    if (s.wave !== wave) {
      if (wave > 0) report.waves.push({ wave, seconds: Number((sim - waveStart).toFixed(1)) });
      wave = s.wave;
      waveStart = sim;
    }
    report.maxEnemies = Math.max(report.maxEnemies, s.enemiesAlive);

    // NaN guards on everything that feeds a transform.
    const enemies = await sh((SH) => SH.enemies());
    const finite = (v) => typeof v === 'number' && Number.isFinite(v);
    const bad =
      !finite(s.player.x) || !finite(s.player.y) || !finite(s.player.z) || !finite(s.player.yaw) || !finite(s.player.pitch) ||
      enemies.some((e) => !finite(e.x) || !finite(e.y) || !finite(e.z) || !finite(e.hp));
    if (bad) {
      report.nanFrames++;
      report.failure = `non-finite transform at sim ${sim}s: ${JSON.stringify({ player: s.player, enemies: enemies.filter((e) => !finite(e.x + e.y + e.z + e.hp)) })}`;
      break;
    }

    if (s.errors > 0 || game.errors.length > 0) {
      report.failure = 'errors were recorded';
      break;
    }
    if (s.mode === 'victory' || s.mode === 'gameover') break;
    if (s.mode !== 'playing') {
      report.failure = `unexpected mode ${s.mode}`;
      break;
    }

    // Stall detection: something must change (wave, phase, kills, score, boss health).
    const key = `${s.wave}|${s.phase}|${s.stats.kills}|${s.score}|${s.boss ? Math.round(s.boss.hp) : ''}`;
    if (key !== progressKey) {
      progressKey = key;
      lastProgress = sim;
      assisted = false;
    } else if (sim - lastProgress >= STALL_SECONDS) {
      if (god && !assisted) {
        // One helping hand per stall: top up ammo in case the bot ran dry against something it cannot melee.
        assisted = true;
        report.assists++;
        lastProgress = sim;
        await sh((SH) => SH.ctx.weapons.refill());
      } else {
        report.failure = `stalled for ${STALL_SECONDS}s at wave ${s.wave} phase ${s.phase} (enemies ${s.enemiesAlive}, remaining ${s.enemiesRemaining})`;
        break;
      }
    }
  }

  if (wave > 0) report.waves.push({ wave, seconds: Number((sim - waveStart).toFixed(1)) });
  report.simSeconds = sim;
  report.finalMode = s.mode;
  report.finalState = {
    wave: s.wave,
    phase: s.phase,
    score: s.score,
    kills: s.stats.kills,
    accuracy: Number(s.stats.accuracy.toFixed(3)),
    perks: s.stats.perks,
    grade: s.stats.grade,
    hp: s.player.hp,
    weapons: s.weapon.unlocked,
  };
  if (!report.failure && sim >= maxSim && s.mode === 'playing') report.failure = `did not finish within ${maxSim} simulated seconds`;
  report.errors = [...(await gameErrors(game)), ...game.errors];
  const finished = god ? s.mode === 'victory' : s.mode === 'victory' || s.mode === 'gameover';
  if (!report.failure && !finished) report.failure = `final mode ${s.mode}`;
  report.ok = report.failure === '' && report.errors.length === 0 && finished;
} catch (error) {
  report.failure = error && error.stack ? error.stack : String(error);
  if (game) report.errors = [...game.errors];
} finally {
  if (game) await game.close();
}

report.wallSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
