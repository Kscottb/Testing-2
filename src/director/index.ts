// STUB: replaced by the director team
import * as THREE from 'three';
import { SCORING } from '../core/constants';
import { makeRunStats, resetRunStats } from '../core/make';
import { DIFFICULTY } from '../data/difficulty';
import { ENEMIES } from '../data/enemies';
import { PERK_CHOICES, PERK_LIST, PERKS } from '../data/perks';
import { PICKUPS } from '../data/pickups';
import { BOSS_INTRO_SECONDS, CLEARED_SECONDS, DEATH_DELAY_SECONDS, TOTAL_WAVES, WARMUP_SECONDS, waveDef } from '../data/waves';
import type { AnnounceStyle, Difficulty, DirectorPhase, DirectorSystem, GameContext, PerkId, PickupState, PickupType, ScoreReason, Vec3Like } from '../core/types';

type Pickup = { -readonly [K in keyof PickupState]: PickupState[K] } & { mesh: THREE.Mesh };

/** Gray-box run flow: wave table -> clear -> supply (instant) -> perk -> intermission -> ... -> boss -> victory. */
export function createDirectorSystem(ctx: GameContext): DirectorSystem {
  const stats = makeRunStats();
  const combo = { multiplier: 1, count: 0, timeLeft: 0, window: SCORING.COMBO_WINDOW };
  const objective = { text: '', position: null as THREE.Vector3 | null };
  const perks = new Map<PerkId, number>();
  const pickups: Pickup[] = [];
  const pickupGeometry = new THREE.OctahedronGeometry(0.3);
  const spawnAt = new THREE.Vector3();
  let difficulty: Difficulty = 'veteran', phase: DirectorPhase = 'idle', wave = 0, score = 0, timer = 0, timerTotal = 0, waveTime = 0, pending: { type: keyof typeof ENEMIES; at: number }[] = [], offer: PerkId[] | null = null, endTimer = -1, endVictory = false;

  const setPhase = (next: DirectorPhase, seconds = 0): void => {
    const prev = phase;
    phase = next; timer = timerTotal = seconds;
    ctx.events.emit('director:phase', { phase: next, prev, wave });
  };
  const announce = (text: string, sub = '', style: AnnounceStyle = 'info'): void => ctx.events.emit('announce', { text, sub, style, seconds: 2.5 });
  const startWave = (): void => {
    wave++;
    const def = waveDef(wave);
    stats.wave = wave; waveTime = 0; pending = [];
    for (const g of def.groups) {
      const count = def.boss ? g.count : Math.ceil(g.count * ctx.mods.enemyCountMul);
      for (let i = 0; i < count; i++) pending.push({ type: g.type, at: g.at + i * g.interval });
    }
    pending.sort((a, b) => a.at - b.at);
    ctx.render.setTimeOfDay(def.timeOfDay, 6);
    setPhase(def.boss ? 'boss' : 'combat');
    objective.text = def.boss ? 'DESTROY THE CONDUCTOR' : 'ELIMINATE THE STATIC';
    ctx.events.emit('wave:start', { wave, total: TOTAL_WAVES, isBoss: def.boss, zone: def.zone });
    announce(def.boss ? 'THE CONDUCTOR' : `WAVE ${wave}`, def.name, def.boss ? 'boss' : 'wave');
  };
  const offerPerks = (): void => {
    offer = ctx.rng.shuffle(PERK_LIST.filter((p) => (perks.get(p.id) ?? 0) < p.maxStacks).map((p) => p.id)).slice(0, PERK_CHOICES);
    setPhase('perkSelect');
    ctx.time.setScale('perkSelect', 0);
    ctx.events.emit('perk:offered', { choices: offer });
  };
  const removePickup = (p: Pickup): void => { ctx.scene.remove(p.mesh); (p.mesh.material as THREE.Material).dispose(); pickups.splice(pickups.indexOf(p), 1); };

  const director: DirectorSystem = {
    get difficulty() { return difficulty; },
    get difficultyDef() { return DIFFICULTY[difficulty]; },
    get wave() { return wave; },
    totalWaves: TOTAL_WAVES,
    get phase() { return phase; },
    get enemiesRemaining() { return pending.length + ctx.enemies.waveCount; },
    get intermissionLeft() { return phase === 'warmup' || phase === 'intermission' || phase === 'bossIntro' ? Math.max(0, timer) : 0; },
    get intermissionTotal() { return timerTotal; },
    get score() { return score; },
    combo, stats, objective, pickups,
    get perkOffer() { return offer; },
    perkStacks: (id) => perks.get(id) ?? 0,
    startRun(d: Difficulty): void {
      difficulty = d;
      const def = DIFFICULTY[d];
      Object.assign(ctx.mods, { damageTakenMul: def.enemyDamageMul, enemyHealthMul: def.enemyHealthMul, bossHealthMul: def.bossHealthMul, enemySpeedMul: def.enemySpeedMul, enemyCountMul: def.enemyCountMul, scoreMul: def.scoreMul, attackTokens: def.attackTokens });
      objective.text = 'GET READY';
      setPhase('warmup', WARMUP_SECONDS);
    },
    choosePerk(index: number): boolean {
      const id = offer?.[index];
      if (phase !== 'perkSelect' || !id) return false;
      const stacks = (perks.get(id) ?? 0) + 1;
      perks.set(id, stacks);
      PERKS[id].apply(ctx.mods);
      stats.perks.push(id);
      if (id === 'maxHealth') ctx.player.heal(9999);
      offer = null;
      ctx.time.clearScale('perkSelect');
      ctx.events.emit('perk:chosen', { perk: id, index, stacks });
      const next = waveDef(wave + 1);
      setPhase(next.boss ? 'bossIntro' : 'intermission', next.boss ? BOSS_INTRO_SECONDS : waveDef(wave).intermissionSeconds);
      ctx.events.emit('intermission:start', { seconds: timer, nextWave: wave + 1 });
      return true;
    },
    spawnPickup(type: PickupType, position: Vec3Like, amount?: number): void {
      const def = PICKUPS[type];
      const mesh = new THREE.Mesh(pickupGeometry, new THREE.MeshBasicMaterial({ color: def.color }));
      mesh.position.set(position.x, position.y + 0.6, position.z);
      ctx.scene.add(mesh);
      const pickup: Pickup = { id: ctx.nextId(), type, position: mesh.position, amount: amount ?? def.amount, age: 0, lifetime: def.lifetime, weapon: null, mesh };
      pickups.push(pickup);
      ctx.events.emit('pickup:spawned', { pickup });
    },
    addScore(amount: number, reason: ScoreReason, position?: Vec3Like): void {
      const delta = Math.round(amount * ctx.mods.scoreMul);
      score += delta; stats.score = score;
      ctx.events.emit('score:changed', { score, delta, reason, position: position ? spawnAt.set(position.x, position.y, position.z) : null });
    },
    debugSkipToWave(target: number): void {
      ctx.enemies.killAll(true);
      wave = Math.min(TOTAL_WAVES, Math.max(1, Math.floor(target))) - 1;
      pending = []; offer = null;
      ctx.time.clearScale('perkSelect');
      for (let w = 1; w <= wave; w++) {
        const def = waveDef(w);
        if (def.unlocksZone) ctx.world.unlockZone(def.unlocksZone);
        if (def.supply) ctx.weapons.unlock(def.supply, false);
      }
      setPhase('warmup', 1);
    },
    init(): void {
      ctx.events.on('enemy:killed', (e) => {
        if (ctx.game.mode !== 'playing' || e.score <= 0) return;
        stats.kills++;
        if (e.byPlayer) {
          if (e.crit) stats.crits++;
          combo.count++; combo.timeLeft = combo.window;
          combo.multiplier = Math.min(SCORING.COMBO_MAX, 1 + Math.floor(combo.count / SCORING.COMBO_STEP));
          stats.bestCombo = Math.max(stats.bestCombo, combo.count);
          ctx.events.emit('combo:changed', combo);
          director.addScore(e.score * combo.multiplier * (e.crit ? 1 + SCORING.CRIT_BONUS : 1), e.crit ? 'crit' : 'kill', e.position);
        }
        const drop = ENEMIES[e.type].dropChance * DIFFICULTY[difficulty].dropMul + ctx.mods.dropChanceBonus;
        if (ctx.rng.chance(drop)) director.spawnPickup(ctx.rng.pick(['ammo', 'ammo', 'health', 'shield', 'grenade'] as const), e.enemy.position);
      });
      ctx.events.on('hit:confirmed', (e) => { stats.damageDealt += e.amount; });
      ctx.events.on('player:damaged', (e) => { stats.damageTaken += e.amount; });
      ctx.events.on('player:died', () => { endTimer = DEATH_DELAY_SECONDS; endVictory = false; });
      ctx.events.on('boss:defeated', (e) => { if (phase === 'boss') { setPhase('done'); endTimer = e.sequenceSeconds; endVictory = true; } });
    },
    reset(): void {
      for (const p of [...pickups]) removePickup(p);
      resetRunStats(stats); perks.clear();
      Object.assign(combo, { multiplier: 1, count: 0, timeLeft: 0 });
      phase = 'idle'; wave = 0; score = 0; timer = 0; timerTotal = 0; pending = []; offer = null; endTimer = -1; objective.text = '';
    },
    update(dt: number): void {
      if (phase === 'perkSelect') {
        (['perk1', 'perk2', 'perk3'] as const).forEach((action, i) => { if (ctx.input.justPressed(action)) director.choosePerk(i); });
        return;
      }
      stats.seconds = ctx.time.runTime; stats.shots = ctx.weapons.shotsFired; stats.hits = ctx.weapons.shotsHit;
      stats.accuracy = stats.shots > 0 ? stats.hits / stats.shots : 0;
      if (endTimer >= 0 && (endTimer -= ctx.time.unscaledDt) < 0) {
        stats.victory = endVictory;
        stats.grade = endVictory ? (stats.accuracy > 0.5 ? 'S' : 'A') : wave >= 7 ? 'B' : wave >= 4 ? 'C' : 'D';
        ctx.game.endRun(endVictory);
        return;
      }
      if (combo.count > 0 && (combo.timeLeft -= dt) <= 0) { Object.assign(combo, { multiplier: 1, count: 0, timeLeft: 0 }); ctx.events.emit('combo:changed', combo); }
      for (let i = pickups.length - 1; i >= 0; i--) {
        const p = pickups[i] as Pickup;
        p.age += dt;
        const d = p.position.distanceTo(ctx.player.eye);
        if (d < PICKUPS[p.type].magnetRadius) p.position.lerp(ctx.player.eye, Math.min(1, dt * 8));
        if (d < PICKUPS[p.type].collectRadius + 0.6 && ctx.player.alive) {
          if (p.type === 'ammo') ctx.weapons.addAmmo('all', p.amount * ctx.mods.ammoPickupMul, true);
          else if (p.type === 'health') ctx.player.heal(p.amount);
          else if (p.type === 'shield') ctx.player.addShield(p.amount);
          else if (p.type === 'grenade') ctx.weapons.addGrenades(p.amount);
          ctx.events.emit('pickup:collected', { pickup: p, type: p.type, amount: p.amount });
          removePickup(p);
        } else if (p.age > p.lifetime) removePickup(p);
      }
      timer -= dt;
      if (phase === 'combat' || phase === 'boss') {
        waveTime += dt;
        const def = waveDef(wave);
        while (pending.length > 0 && (pending[0] as { at: number }).at <= waveTime && ctx.enemies.waveCount < def.maxAlive) {
          const next = pending.shift() as { type: keyof typeof ENEMIES; at: number };
          const enemyDef = ENEMIES[next.type];
          if (def.boss) spawnAt.copy(ctx.world.bossArena.center).setY(ctx.world.bossArena.center.y + ctx.world.bossArena.hoverHeight);
          else spawnAt.copy(ctx.rng.pick(ctx.world.spawnPoints(def.zone, enemyDef.spawnKind)).position);
          ctx.enemies.spawn(next.type, spawnAt);
        }
        if (pending.length === 0 && ctx.enemies.waveCount === 0 && phase === 'combat') {
          director.addScore(def.clearBonus, 'waveClear');
          ctx.events.emit('wave:clear', { wave, total: TOTAL_WAVES, seconds: waveTime, bonus: def.clearBonus, flawless: false });
          announce('WAVE CLEAR', '', 'clear');
          objective.text = 'STAND BY';
          setPhase('cleared', CLEARED_SECONDS);
        }
      } else if (phase === 'cleared' && timer <= 0) {
        const def = waveDef(wave);
        if (def.supply) {
          ctx.weapons.unlock(def.supply, true);
          ctx.events.emit('supply:collected', { weapon: def.supply });
          announce('WEAPON ACQUIRED', def.supply.toUpperCase(), 'reward');
        }
        if (def.unlocksZone) { ctx.world.unlockZone(def.unlocksZone); announce('ZONE UNLOCKED', ctx.world.zone(def.unlocksZone).name, 'zone'); }
        offerPerks();
      } else if ((phase === 'warmup' || phase === 'intermission' || phase === 'bossIntro') && timer <= 0) startWave();
    },
    dispose(): void { director.reset(); pickupGeometry.dispose(); },
  };
  return director;
}
