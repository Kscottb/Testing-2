// Smoke test: boots the game and walks the critical path through window.__SH.
//   node tools/smoke.mjs [--mode dev|dist] [--port 5200]
// Prints a JSON report and exits non-zero when any check fails.
import { gameErrors, launchGame, parseArgs } from './harness.mjs';

const args = parseArgs();
const mode = args.mode === 'dist' ? 'dist' : 'dev';
const port = Number(args.port ?? 5200);

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: ok ? '' : String(detail) });
  return Boolean(ok);
};

let game;
let failure = '';
try {
  game = await launchGame({ mode, port });
  const { sh, step } = game;

  // --- boot ---------------------------------------------------------------------------------
  let s = await sh((SH) => SH.state());
  check('boots into the menu', s.mode === 'menu', `mode=${s.mode}`);
  check('manual stepping mode is active', await sh((SH) => SH.manual));
  s = await step(0.5, { render: true });
  check('menu renders something', s.drawCalls > 0, `drawCalls=${s.drawCalls}`);

  // --- start --------------------------------------------------------------------------------
  s = await sh((SH) => SH.start('veteran'));
  check('a run starts', s.mode === 'playing' && s.player.alive, `mode=${s.mode}`);
  await sh((SH) => {
    SH.god(true);
    SH.freezeAi(true);
  });

  // --- movement -----------------------------------------------------------------------------
  const before = s.player;
  await sh((SH) => SH.move(0, 1));
  s = await step(1);
  await sh((SH) => SH.move(0, 0));
  const moved = Math.hypot(s.player.x - before.x, s.player.z - before.z);
  check('movement input moves the player', moved > 2, `moved ${moved.toFixed(2)} m`);
  check('the player stands on the floor', s.player.grounded && Math.abs(s.player.y - before.y) < 1.5, `y=${s.player.y}`);

  // --- look ---------------------------------------------------------------------------------
  const yaw0 = s.player.yaw;
  await sh((SH) => SH.ctx.input.addVirtualLook(0.4, 0));
  s = await step(0.05);
  check('look input turns the view', Math.abs(s.player.yaw - yaw0 - 0.4) < 0.05, `yaw ${yaw0} -> ${s.player.yaw}`);

  // --- firing -------------------------------------------------------------------------------
  const mag0 = s.weapon.mag;
  const shots0 = s.stats.shots;
  await sh((SH) => SH.press('fire', 0.4));
  s = await step(0.6);
  check('firing consumes ammo', s.weapon.mag < mag0 || s.weapon.reloading, `mag ${mag0} -> ${s.weapon.mag}`);
  check('shots are counted', s.stats.shots > shots0 || (await sh((SH) => SH.ctx.weapons.shotsFired)) > 0);

  // --- kill an enemy with the gun -------------------------------------------------------------
  await sh((SH) => SH.infiniteAmmo(true));
  const score0 = s.score;
  const enemyId = await sh((SH) => SH.spawn('skitter'));
  check('an enemy can be spawned', enemyId > 0, `id=${enemyId}`);
  let killed = false;
  for (let i = 0; i < 40 && !killed; i++) {
    killed = await sh((SH, id) => {
      const enemy = SH.ctx.enemies.get(id);
      if (!enemy || !enemy.alive) return true;
      SH.lookAtPoint(enemy.aimPoint.x, enemy.aimPoint.y, enemy.aimPoint.z);
      SH.press('fire', 0.25);
      return false;
    }, enemyId);
    if (!killed) s = await step(0.25);
  }
  s = await step(0.1);
  check('a spawned enemy can be shot dead', killed);
  check('the kill raises the score', s.score > score0, `score ${score0} -> ${s.score}`);
  await sh((SH) => SH.infiniteAmmo(false));

  // --- wave flow: clear -> perk -> next wave --------------------------------------------------
  await sh((SH) => SH.freezeAi(false));
  for (let i = 0; i < 160; i++) {
    s = await sh((SH) => SH.state());
    if (s.phase === 'perkSelect') break;
    await sh((SH) => {
      SH.killAll();
      const marker = SH.ctx.director.objective.position;
      if (marker && SH.ctx.enemies.aliveCount === 0) SH.teleport(marker.x, marker.y + 0.2, marker.z);
    });
    await step(0.5);
  }
  check('clearing the wave leads to a perk choice', s.phase === 'perkSelect' && s.perkOffer && s.perkOffer.length > 0, `phase=${s.phase} wave=${s.wave}`);
  const frozenAt = s.simTime;
  s = await step(0.5);
  check('the world is frozen while choosing', s.simTime === frozenAt && s.phase === 'perkSelect', `simTime ${frozenAt} -> ${s.simTime}`);
  const chose = await sh((SH) => SH.choosePerk(0));
  s = await step(0.1);
  check('a perk can be chosen', chose && s.phase !== 'perkSelect' && s.stats.perks.length === 1, `phase=${s.phase} perks=${s.stats.perks}`);
  for (let i = 0; i < 120 && !(s.wave === 2 && s.phase === 'combat'); i++) s = await step(0.5);
  check('the next wave starts', s.wave === 2 && s.phase === 'combat', `wave=${s.wave} phase=${s.phase}`);

  // --- pause / resume ------------------------------------------------------------------------
  await sh((SH) => SH.pause());
  s = await step(0.1);
  const pausedAt = s.simTime;
  s = await step(0.5);
  check('pause stops the simulation', s.mode === 'paused' && s.simTime === pausedAt, `mode=${s.mode}`);
  await sh((SH) => SH.resume());
  s = await step(0.3);
  check('resume continues the simulation', s.mode === 'playing' && s.simTime > pausedAt, `mode=${s.mode}`);
  await sh((SH) => SH.press('pause'));
  s = await step(0.05);
  check('the pause action pauses', s.mode === 'paused', `mode=${s.mode}`);
  await sh((SH) => SH.press('pause'));
  s = await step(0.05);
  check('the pause action resumes', s.mode === 'playing', `mode=${s.mode}`);

  // --- restart twice -------------------------------------------------------------------------
  for (let run = 1; run <= 2; run++) {
    await step(0.5);
    s = await sh((SH) => SH.start('veteran'));
    s = await step(0.2);
    const clean =
      s.mode === 'playing' &&
      s.wave === 0 &&
      s.score === 0 &&
      s.enemiesAlive === 0 &&
      s.pickups === 0 &&
      s.projectiles === 0 &&
      s.player.alive &&
      s.player.hp === 100 &&
      s.player.shield === 100 &&
      s.weapon.id === 'vector' &&
      s.weapon.mag > 0 &&
      s.weapon.unlocked.length === 1 &&
      s.stats.perks.length === 0 &&
      s.stats.kills === 0 &&
      s.zones.deck === true &&
      s.zones.refinery === false &&
      s.zones.spire === false &&
      s.simTime < 1;
    check(`restart ${run} leaves a clean state`, clean, JSON.stringify(s));
  }

  // --- game over + menu ----------------------------------------------------------------------
  await sh((SH) => {
    SH.god(false);
    SH.damagePlayer(100000);
  });
  for (let i = 0; i < 20 && s.mode !== 'gameover'; i++) s = await step(0.5);
  check('lethal damage ends the run', s.mode === 'gameover', `mode=${s.mode} hp=${s.player.hp}`);
  await sh((SH) => SH.menu());
  s = await step(0.2, { render: true });
  check('returning to the menu resets the world', s.mode === 'menu' && s.enemiesAlive === 0, `mode=${s.mode}`);

  // --- errors --------------------------------------------------------------------------------
  const errors = await gameErrors(game);
  check('no errors recorded by the game', errors.length === 0, errors.join(' | '));
  check('no console / page errors', game.errors.length === 0, game.errors.join(' | '));
} catch (error) {
  failure = error && error.stack ? error.stack : String(error);
} finally {
  if (game) await game.close();
}

const ok = failure === '' && checks.every((c) => c.ok);
console.log(JSON.stringify({ tool: 'smoke', mode, ok, failure, failed: checks.filter((c) => !c.ok), checks }, null, 2));
process.exit(ok ? 0 : 1);
