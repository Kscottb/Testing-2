// Smoke test: boots the game and walks the critical path through window.__SH.
//   node tools/smoke.mjs [--mode dev|dist] [--port 5200] [--embed sandbox]
// --embed sandbox (dist only) runs the shipped form instead: the game inside <iframe sandbox="allow-scripts">
// with no query string and the REAL frame loop, driven by real mouse and keyboard input.
// Prints a JSON report and exits non-zero when any check fails.
import { gameErrors, launchGame, parseArgs } from './harness.mjs';

const args = parseArgs();
const mode = args.mode === 'dist' ? 'dist' : 'dev';
const port = Number(args.port ?? 5200);
const embed = args.embed === 'sandbox' ? 'sandbox' : 'none';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: ok ? '' : String(detail) });
  return Boolean(ok);
};

/** The default run: test mode (manual stepping), everything through window.__SH. */
async function manualRun(game) {
  const { sh, step } = game;

  // --- boot ---------------------------------------------------------------------------------
  let s = await sh((SH) => SH.state());
  check('boots into the menu', s.mode === 'menu', `mode=${s.mode}`);
  check('manual stepping mode is active', await sh((SH) => SH.manual));
  s = await step(0.5, { render: true });
  check('menu renders something', s.drawCalls > 0, `drawCalls=${s.drawCalls}`);
  check('the UI reports the menu screen', s.uiScreen === 'menu', `uiScreen=${s.uiScreen}`);
  const budget = await sh((SH) => SH.budget());
  check('scene roots are named after their systems', budget.world && budget.world.visibleMeshes > 0 && 'enemies' in budget, JSON.stringify(Object.keys(budget)));

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
  check('the kill is counted and hit feedback was flushed', s.stats.kills === 1 && s.stats.damageDealt > 0, `kills=${s.stats.kills} dealt=${s.stats.damageDealt}`);
  await sh((SH) => SH.infiniteAmmo(false));

  // --- debug hooks of the contract: arrival, direct damage, perks, Overclock -------------------
  const arriving = await sh((SH) => {
    const p = SH.ctx.player.position;
    return SH.spawnArriving('skitter', p.x + 6, p.y, p.z);
  });
  /** [spawning, registered as a hit target] of one enemy. */
  const arrival = (id) =>
    sh((SH, enemyId) => {
      const enemy = SH.ctx.enemies.get(enemyId);
      return enemy ? [enemy.spawning, SH.ctx.combat.getTarget(enemyId) !== undefined] : null;
    }, id);
  let a = await arrival(arriving);
  s = await sh((SH) => SH.state());
  check('an arriving enemy is not yet a target', a && a[0] === true && a[1] === false && s.enemiesSpawning >= 1, JSON.stringify(a));
  s = await step(1.2);
  a = await arrival(arriving);
  check('the arrival ends by itself', a && a[0] === false && a[1] === true, JSON.stringify(a));
  const hit = await sh((SH, id) => SH.damageEnemy(id, 5), arriving);
  check('an enemy can be damaged directly', hit.dealt === 5 && !hit.killed, JSON.stringify(hit));
  check('a perk can be granted', (await sh((SH) => SH.givePerk('damage'))) && (await sh((SH) => SH.state().perks.damage)) === 1);
  check('Overclock can be forced', await sh((SH) => SH.overclock()));
  s = await step(0.2);
  check('Overclock slows the world, not the player', s.player.overclockActive && Math.abs(s.timeScale - 0.4) < 1e-6, `scale=${s.timeScale}`);
  s = await step(8);
  check('Overclock ends by itself', !s.player.overclockActive && s.timeScale === 1, `scale=${s.timeScale}`);

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
  check('world kills are never rewarded', s.stats.kills === 1, `kills=${s.stats.kills}`);
  // The perk keys double as weapon keys: they are locked for a moment after the offer appears.
  await sh((SH) => SH.press('perk1'));
  s = await step(0.2);
  check('perk keys are locked right after the offer', s.phase === 'perkSelect', `phase=${s.phase}`);
  const frozenAt = s.simTime;
  s = await step(0.6);
  check('the world is frozen while choosing', s.simTime === frozenAt && s.phase === 'perkSelect' && s.timeScale === 0, `simTime ${frozenAt} -> ${s.simTime}`);
  await sh((SH) => SH.pause());
  s = await step(0.1);
  check('the time scale keeps its value while paused', s.mode === 'paused' && s.timeScale === 0, `scale=${s.timeScale}`);
  await sh((SH) => SH.resume());
  await sh((SH) => SH.press('perk1'));
  s = await step(0.1);
  check('a perk can be chosen with its key', s.phase !== 'perkSelect' && s.stats.perks.length === 2, `phase=${s.phase} perks=${s.stats.perks}`);
  for (let i = 0; i < 120 && !(s.wave === 2 && s.phase === 'combat'); i++) s = await step(0.5);
  check('the next wave starts', s.wave === 2 && s.phase === 'combat', `wave=${s.wave} phase=${s.phase}`);

  // --- pause / resume ------------------------------------------------------------------------
  await sh((SH) => SH.pause());
  s = await step(0.1);
  const pausedAt = s.simTime;
  s = await step(0.5);
  check('pause stops the simulation', s.mode === 'paused' && s.simTime === pausedAt, `mode=${s.mode}`);
  check('the time scale is not faked to 0 by a pause', s.timeScale === 1, `scale=${s.timeScale}`);
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
  const resources = [];
  for (let run = 1; run <= 2; run++) {
    await step(0.5);
    s = await sh((SH) => SH.start('veteran'));
    s = await step(0.2, { render: true });
    const clean =
      s.mode === 'playing' &&
      s.wave === 0 &&
      s.score === 0 &&
      s.enemiesAlive === 0 &&
      s.enemiesDying === 0 &&
      s.pickups === 0 &&
      s.projectiles === 0 &&
      s.tokensInUse === 0 &&
      s.player.alive &&
      s.player.hp === 100 &&
      s.player.shield === 100 &&
      !s.player.overclockActive &&
      s.weapon.id === 'vector' &&
      s.weapon.mag > 0 &&
      s.weapon.unlocked.length === 1 &&
      s.stats.perks.length === 0 &&
      Object.keys(s.perks).length === 0 &&
      s.stats.kills === 0 &&
      s.zones.deck === true &&
      s.zones.refinery === false &&
      s.zones.spire === false &&
      s.timeScale === 1 &&
      s.simTime < 1;
    check(`restart ${run} leaves a clean state`, clean, JSON.stringify(s));
    resources.push({ geometries: s.geometries, textures: s.textures, programs: s.programs });
  }
  check('restarting leaks no geometries, textures or shader programs', JSON.stringify(resources[0]) === JSON.stringify(resources[1]), JSON.stringify(resources));

  // --- game over + menu ----------------------------------------------------------------------
  await sh((SH) => {
    SH.god(false);
    SH.damagePlayer(100000);
  });
  for (let i = 0; i < 20 && s.mode !== 'gameover'; i++) s = await step(0.5);
  check('lethal damage ends the run', s.mode === 'gameover', `mode=${s.mode} hp=${s.player.hp}`);
  await sh((SH) => SH.menu());
  s = await step(0.2, { render: true });
  check('returning to the menu resets the world', s.mode === 'menu' && s.enemiesAlive === 0 && s.timeOfDay === 'dusk', `mode=${s.mode}`);
}

/**
 * The shipped form: a sandboxed frame without query string, storage or pointer lock, on the real frame
 * loop, with real mouse and keyboard events.
 */
async function sandboxRun(game) {
  const { sh, page } = game;
  const wait = (ms) => page.waitForTimeout(ms);
  const state = () => sh((SH) => SH.state());

  let s = await state();
  check('boots into the menu inside a sandboxed frame', s.mode === 'menu', `mode=${s.mode}`);
  check('test mode stays off without an opt-in', !(await sh((SH) => SH.manual || SH.ctx.testMode)));
  check('storage falls back to memory', (await sh((SH) => SH.ctx.storage.persistent)) === false);
  const frame0 = s.frame;
  await wait(400);
  s = await state();
  check('the real frame loop runs', s.frame > frame0, `frame ${frame0} -> ${s.frame}`);

  await sh((SH) => {
    SH.start('veteran');
    SH.god(true);
    SH.freezeAi(true);
  });
  await wait(300);
  s = await state();
  check('a run starts', s.mode === 'playing' && s.player.alive, `mode=${s.mode}`);

  // A real click on the canvas: pointer lock is requested and refused by the sandbox.
  const box = await game.canvasBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await wait(500);
  s = await state();
  check('refused pointer lock falls back to free look without pausing', s.mode === 'playing' && s.lookMode === 'free', `mode=${s.mode} lookMode=${s.lookMode}`);
  check('pointer lock is not held', (await sh((SH) => SH.ctx.input.captured)) === false);

  const yaw0 = s.player.yaw;
  await page.mouse.move(cx + 160, cy, { steps: 8 });
  await wait(300);
  s = await state();
  check('mouse movement over the canvas turns the view', Math.abs(s.player.yaw - yaw0) > 0.05, `yaw ${yaw0} -> ${s.player.yaw}`);

  const yaw1 = s.player.yaw;
  await page.keyboard.down('ArrowLeft');
  await wait(400);
  await page.keyboard.up('ArrowLeft');
  await wait(100);
  s = await state();
  check('arrow keys turn the view', s.player.yaw - yaw1 > 0.2, `yaw ${yaw1} -> ${s.player.yaw}`);

  const mag0 = s.weapon.mag;
  await page.mouse.down();
  await wait(300);
  await page.mouse.up();
  await wait(100);
  s = await state();
  check('the mouse button fires in free look', s.weapon.mag < mag0 || s.weapon.reloading, `mag ${mag0} -> ${s.weapon.mag}`);

  await page.keyboard.press('KeyP');
  await wait(200);
  s = await state();
  check('the pause key pauses', s.mode === 'paused', `mode=${s.mode}`);
  await page.keyboard.press('KeyP');
  await wait(500);
  s = await state();
  check('the pause key resumes', s.mode === 'playing', `mode=${s.mode}`);

  await sh((SH) => SH.menu());
  await wait(200);
  s = await state();
  check('returning to the menu works', s.mode === 'menu', `mode=${s.mode}`);
  check('no fatal error', !(await sh((SH) => SH.fatal)));
}

let game;
let failure = '';
try {
  game = await launchGame(embed === 'sandbox' ? { mode, port, embed, test: false } : { mode, port });
  if (embed === 'sandbox') await sandboxRun(game);
  else await manualRun(game);

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
console.log(JSON.stringify({ tool: 'smoke', mode, embed, ok, failure, failed: checks.filter((c) => !c.ok), checks }, null, 2));
process.exit(ok ? 0 : 1);
