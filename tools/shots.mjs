// Screenshot tour for visual review.
//   node tools/shots.mjs --out <dir> [--mode dev|dist] [--port 5200] [--size 1280x720]
// Writes: menu (+ the difficulty / settings / controls screens when the UI has them), gameplay in each
// zone / time of day, every enemy type, every weapon viewmodel, perk screen, pause, game over, victory,
// and a 390x844 touch layout (with real touches on the touch controls when they exist).
// The desktop tour runs on the "high" quality preset; the touch tour keeps what 'auto' gives a phone.
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
/** Results of the real-touch checks (informational: listed in the report, not part of the exit code). */
const touchChecks = [];
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

  // 'auto' resolves to 'medium' on the software renderer of the harness: the tour shows the reference
  // preset of the brief instead.
  await sh((SH) => SH.setQuality('high'));
  if ((await sh((SH) => SH.state().quality)) !== 'high') notes.push('the "high" quality preset could not be applied');

  // --- menu ---
  await step(1.5, { render: 30 });
  await shot('menu');

  // --- menu sub-screens, forced through the debug hook (a UI without them simply keeps its screen) ---
  for (const screen of ['difficulty', 'settings', 'controls']) {
    await sh((SH, name) => SH.ui(name), screen);
    await step(0.4, { render: 8 });
    if ((await sh((SH) => SH.ctx.ui.screen)) === screen) await shot(`ui-${screen}`);
    else notes.push(`the UI has no "${screen}" screen to show`);
  }
  await sh((SH) => SH.ui(null));
  await step(0.2);

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
  await realTouches(game);
  errors = errors.concat(await gameErrors(game), game.errors);
}

/**
 * Real touch input on the touch controls (found by their `data-touch` attribute, see UiSystem):
 * hold the fire button, drag the look zone, tap pause. A UI without touch controls is only noted.
 */
async function realTouches(game) {
  const { sh, step, page, frame } = game;
  const center = async (selector) => {
    const element = await frame.$(selector);
    const box = element ? await element.boundingBox() : null;
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  };
  const fire = await center('[data-touch="fire"]');
  if (!fire) {
    notes.push('no [data-touch] elements: the UI has no touch controls yet, real touches skipped');
    return;
  }
  const record = (name, ok, detail) => touchChecks.push({ name, ok: Boolean(ok), detail: ok ? '' : String(detail) });
  try {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    await sh((SH) => SH.freezeAi(true));

    let s = await sh((SH) => SH.state());
    const mag0 = s.weapon.mag;
    await touch('touchStart', [fire]);
    s = await step(0.5);
    await touch('touchEnd', []);
    s = await step(0.1);
    record('holding the fire button fires', s.weapon.mag < mag0 || s.weapon.reloading, `mag ${mag0} -> ${s.weapon.mag}`);

    const look = await center('[data-touch="look"]');
    if (look) {
      const yaw0 = s.player.yaw;
      await touch('touchStart', [look]);
      for (let i = 1; i <= 6; i++) {
        await touch('touchMove', [{ x: look.x - i * 12, y: look.y }]);
        await step(0.05);
      }
      await touch('touchEnd', []);
      s = await step(0.1);
      record('dragging the look zone turns the view', Math.abs(s.player.yaw - yaw0) > 0.05, `yaw ${yaw0} -> ${s.player.yaw}`);
    } else {
      notes.push('no [data-touch="look"] zone found');
    }

    const pause = await center('[data-touch="pause"]');
    if (pause) {
      await page.touchscreen.tap(pause.x, pause.y);
      s = await step(0.2);
      record('tapping pause pauses', s.mode === 'paused', `mode=${s.mode}`);
    } else {
      notes.push('no [data-touch="pause"] button found');
    }
  } catch (error) {
    notes.push(`real touches could not be performed: ${error && error.message ? error.message : error}`);
  }
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
console.log(JSON.stringify({ tool: 'shots', mode, ok, out, files, notes, touchChecks, errors, failure }, null, 2));
process.exit(ok ? 0 : 1);
