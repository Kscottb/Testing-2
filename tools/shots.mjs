// Screenshot tour for visual review.
//   node tools/shots.mjs --out <dir> [--mode dev|dist] [--port 5200] [--size 1280x720]
// Writes: menu, gameplay in each zone / time of day, every enemy type, every weapon viewmodel,
// perk screen, pause, game over, victory, and a 390x844 touch layout.
import path from 'node:path';
import { gameErrors, launchGame, parseArgs } from './harness.mjs';

const args = parseArgs();
if (!args.out) {
  console.error('usage: node tools/shots.mjs --out <dir> [--mode dev|dist] [--port N] [--size WxH]');
  process.exit(2);
}
const mode = args.mode === 'dist' ? 'dist' : 'dev';
const port = Number(args.port ?? 5200);
const [width, height] = (args.size ?? '1280x720').split('x').map((v) => Number(v));
const out = path.resolve(args.out);

const ZONES = ['deck', 'refinery', 'spire'];
const TIMES = ['dusk', 'twilight', 'stormnight', 'eclipse'];
const ENEMIES = ['skitter', 'riveter', 'wasp', 'tick', 'lancer', 'bulwark', 'conductor'];
const WEAPONS = ['vector', 'breaker', 'lance', 'hornet'];

const files = [];
const notes = [];
let failure = '';
let errors = [];

async function tour(game) {
  const { sh, step } = game;
  let index = 0;
  const shot = async (name) => {
    const file = path.join(out, `${String(++index).padStart(2, '0')}-${name}.png`);
    await game.shot(file);
    files.push(file);
  };
  /** Step until predicate(state) holds or `seconds` of simulation passed. */
  const until = async (predicate, seconds, each) => {
    let s = await sh((SH) => SH.state());
    for (let t = 0; t < seconds && !predicate(s); t += 0.25) {
      if (each) await each(s);
      s = await step(0.25);
    }
    return s;
  };

  // --- menu ---
  await step(1.5, { render: 30 });
  await shot('menu');

  // --- gameplay: each zone at its time of day (plus the remaining times on the last zone) ---
  await sh((SH) => {
    SH.start('veteran');
    SH.god(true);
    SH.giveAll();
  });
  await step(0.5);
  const scenes = [
    ['deck', 'dusk'],
    ['refinery', 'twilight'],
    ['spire', 'stormnight'],
    ['spire', 'eclipse'],
  ];
  for (const [zone, time] of scenes) {
    await sh(
      (SH, z, t) => {
        const info = SH.ctx.world.zone(z);
        const c = info.center;
        const y = SH.ctx.world.groundHeightAt(c.x - 14, c.z + 6);
        SH.ctx.enemies.killAll(true);
        SH.freezeAi(true);
        SH.teleport(c.x - 14, (Number.isFinite(y) ? y : 0) + 0.1, c.z + 6);
        SH.lookAtPoint(c.x, 1.5, c.z);
        SH.setTimeOfDay(t, 0);
        for (const [type, dx, dz] of [['skitter', -3, -2], ['riveter', 2, 3], ['wasp', 0, -5], ['tick', 4, -3]]) {
          const gy = SH.ctx.world.groundHeightAt(c.x + dx, c.z + dz);
          SH.spawn(type, c.x + dx, (Number.isFinite(gy) ? gy : 0) + (type === 'wasp' ? 5 : 0), c.z + dz);
        }
      },
      zone,
      time,
    );
    await step(0.6, { render: 12 });
    await shot(`gameplay-${zone}-${time}`);
  }
  if (TIMES.length !== 4 || ZONES.length !== 3) notes.push('zone/time tables changed: update the scene list');

  // --- every enemy type, lined up in front of a free camera ---
  await sh((SH) => {
    SH.ctx.enemies.killAll(true);
    SH.hideUi(true);
    SH.setTimeOfDay('dusk', 0);
  });
  for (const type of ENEMIES) {
    const framing = await sh((SH, t) => {
      SH.ctx.enemies.killAll(true);
      SH.freezeAi(true);
      const c = SH.ctx.world.zone('deck').center;
      const gy = SH.ctx.world.groundHeightAt(c.x + 8, c.z + 8);
      const ground = Number.isFinite(gy) ? gy : 0;
      const big = t === 'conductor' || t === 'bulwark';
      const flying = t === 'wasp' || t === 'conductor';
      const id = SH.spawn(t, c.x + 8, ground + (flying ? (t === 'conductor' ? 9 : 3) : 0), c.z + 8);
      const e = SH.ctx.enemies.get(id);
      if (!e) return null;
      const d = t === 'conductor' ? 26 : big ? 9 : 4.5;
      return { x: e.aimPoint.x, y: e.aimPoint.y, z: e.aimPoint.z, d, h: e.height };
    }, type);
    if (!framing) {
      notes.push(`could not spawn ${type}`);
      continue;
    }
    await step(0.4);
    await sh(
      (SH, f) => {
        const e = SH.ctx.enemies.list[0];
        const p = e ? e.aimPoint : f;
        SH.setCamera([p.x - f.d * 0.8, p.y + f.h * 0.25 + 0.6, p.z + f.d * 0.6], [p.x, p.y, p.z], 50);
      },
      framing,
    );
    await step(0.1, { render: true });
    await shot(`enemy-${type}`);
  }
  await sh((SH) => {
    SH.releaseCamera();
    SH.ctx.enemies.killAll(true);
    SH.hideUi(false);
  });

  // --- every weapon viewmodel ---
  await sh((SH) => {
    const c = SH.ctx.world.zone('deck').center;
    SH.teleport(c.x - 14, 0.2, c.z + 6);
    SH.lookAtPoint(c.x, 1.5, c.z);
  });
  for (const id of WEAPONS) {
    await sh((SH, w) => SH.ctx.weapons.switchTo(w), id);
    await step(1.2, { render: 24 });
    await shot(`weapon-${id}`);
  }

  // --- perk screen ---
  await sh((SH) => {
    SH.freezeAi(false);
    SH.setWave(1);
  });
  await until(
    (s) => s.phase === 'perkSelect',
    60,
    () =>
      sh((SH) => {
        SH.killAll();
        const marker = SH.ctx.director.objective.position;
        if (marker && SH.ctx.enemies.aliveCount === 0) SH.teleport(marker.x, marker.y + 0.2, marker.z);
      }),
  );
  await step(0.6, { render: 12 });
  await shot('perk-select');
  await sh((SH) => SH.choosePerk(0));
  await step(0.5);

  // --- pause ---
  await sh((SH) => SH.pause());
  await step(0.5, { render: 10 });
  await shot('pause');
  await sh((SH) => SH.resume());
  await step(0.2);

  // --- game over ---
  await sh((SH) => {
    SH.god(false);
    SH.damagePlayer(100000);
  });
  let s = await until((state) => state.mode === 'gameover', 10);
  if (s.mode !== 'gameover') notes.push(`game over not reached (mode ${s.mode})`);
  await step(1, { render: 20 });
  await shot('gameover');

  // --- victory: the real path (kill the boss), falling back to a forced end ---
  await sh((SH) => {
    SH.start('veteran');
    SH.god(true);
    SH.setWave(10);
  });
  s = await until((state) => state.boss !== null, 20);
  await sh((SH) => SH.killAll());
  s = await until((state) => state.mode === 'victory', 30);
  if (s.mode !== 'victory') {
    notes.push(`victory not reached through the boss (mode ${s.mode}, phase ${s.phase}); forcing endRun`);
    await sh((SH) => SH.endRun(true));
  }
  await step(1, { render: 20 });
  await shot('victory');
  errors = errors.concat(await gameErrors(game), game.errors);
}

async function touchTour(game) {
  const { sh, step } = game;
  await sh((SH) => SH.ctx.input.notifyDevice('touch'));
  await step(1, { render: 20 });
  const menu = path.join(out, '90-touch-menu.png');
  await game.shot(menu);
  files.push(menu);
  await sh((SH) => {
    SH.start('veteran');
    SH.god(true);
    SH.ctx.input.notifyDevice('touch');
  });
  await step(5, { render: 60 });
  const play = path.join(out, '91-touch-gameplay.png');
  await game.shot(play);
  files.push(play);
  errors = errors.concat(await gameErrors(game), game.errors);
}

for (const [label, options, run] of [
  ['desktop', { mode, port, width, height }, tour],
  ['touch', { mode, port, width: 390, height: 844, touch: true }, touchTour],
]) {
  let game;
  try {
    game = await launchGame(options);
    await run(game);
  } catch (error) {
    failure += `${label}: ${error && error.stack ? error.stack : String(error)}\n`;
  } finally {
    if (game) await game.close();
  }
}

const ok = failure === '' && errors.length === 0;
console.log(JSON.stringify({ tool: 'shots', mode, ok, out, files, notes, errors, failure }, null, 2));
process.exit(ok ? 0 : 1);
