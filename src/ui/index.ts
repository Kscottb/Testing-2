// STUB: replaced by the ui team
import { DIFFICULTIES } from '../core/constants';
import { DIFFICULTY } from '../data/difficulty';
import { PERKS } from '../data/perks';
import type { GameContext, UiSystem } from '../core/types';

const STYLE = `
.sh-hud{position:absolute;left:max(16px,env(safe-area-inset-left,0px));bottom:max(16px,env(safe-area-inset-bottom,0px));font:14px/1.5 var(--sh-font-mono);color:var(--sh-text);white-space:pre;text-shadow:0 1px 2px #000}
.sh-top{position:absolute;top:max(16px,env(safe-area-inset-top,0px));left:0;right:0;text-align:center;font:600 18px var(--sh-font-ui);letter-spacing:.2em;color:var(--sh-cyan)}
.sh-cross{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px;border-radius:50%;background:var(--sh-cyan)}
.sh-panel{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--sh-scrim);pointer-events:auto;padding:16px;text-align:center}
.sh-panel[hidden]{display:none}
.sh-panel h1{font:700 clamp(32px,7vw,64px) var(--sh-font-display);letter-spacing:.14em;margin:0;color:var(--sh-text)}
.sh-panel p{margin:0;color:var(--sh-text-dim);font:16px var(--sh-font-ui);letter-spacing:.08em}
.sh-btn{font:600 16px var(--sh-font-ui);letter-spacing:.16em;color:var(--sh-cyan);background:var(--sh-panel);border:1px solid var(--sh-cyan);padding:12px 22px;min-width:240px;cursor:pointer}
.sh-btn:hover,.sh-btn:focus-visible{background:var(--sh-cyan);color:var(--sh-bg);outline:none}`;

/** Gray-box UI: text HUD plus one full-screen panel per state (menu, perk choice, pause, end screens). */
export function createUiSystem(ctx: GameContext): UiSystem {
  const style = document.createElement('style');
  const hud = document.createElement('div');
  const top = document.createElement('div');
  const cross = document.createElement('div');
  const panel = document.createElement('div');
  let panelKey = '';
  let banner = '';
  let bannerLeft = 0;

  const button = (label: string, onClick: () => void, id: string): HTMLButtonElement => {
    const el = document.createElement('button');
    el.className = 'sh-btn';
    el.textContent = label;
    el.dataset.action = id;
    el.addEventListener('click', onClick);
    return el;
  };
  const show = (key: string, title: string, sub: string, buttons: HTMLButtonElement[]): void => {
    if (key === panelKey) return;
    panelKey = key;
    panel.replaceChildren();
    panel.hidden = key === '';
    if (key === '') return;
    const h = document.createElement('h1');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = sub;
    panel.append(h, p, ...buttons);
  };
  const endButtons = (): HTMLButtonElement[] => [button('RESTART', () => ctx.game.restart(), 'restart'), button('MAIN MENU', () => ctx.game.toMenu(), 'menu')];

  const ui: UiSystem = {
    showFatal(): void {
      hud.hidden = top.hidden = cross.hidden = panel.hidden = true;
    },
    wantsPointer: () => ctx.director.phase === 'perkSelect',
    consumesPauseAction: () => false,
    init(): void {
      style.textContent = STYLE;
      hud.className = 'sh-hud';
      top.className = 'sh-top';
      cross.className = 'sh-cross';
      panel.className = 'sh-panel';
      panel.hidden = true;
      document.head.append(style);
      ctx.uiRoot.append(hud, top, cross, panel);
      ctx.events.on('announce', (e) => {
        banner = e.sub ? `${e.text} — ${e.sub}` : e.text;
        bannerLeft = e.seconds;
      });
    },
    reset(): void {
      banner = '';
      bannerLeft = 0;
    },
    update(realDt: number): void {
      const { game, director, player, weapons } = ctx;
      const mode = game.mode;
      const playing = mode === 'playing' || mode === 'paused';
      hud.hidden = top.hidden = !playing;
      cross.hidden = mode !== 'playing';
      if (playing) {
        const w = weapons.current;
        const boss = ctx.enemies.boss;
        hud.textContent = [
          `HP ${Math.ceil(player.hp)}/${player.maxHp}   SHIELD ${Math.ceil(player.shield)}/${player.maxShield}`,
          `${w.def.name}  ${w.reloading ? 'RELOADING' : `${w.mag}/${w.reserve}`}   GRENADES ${weapons.grenades}`,
          `OVERCLOCK ${player.overclock.active ? 'ACTIVE' : `${Math.floor(player.overclock.charge)}%`}   DASH ${player.dash.charges}`,
          `SCORE ${director.score}   x${director.combo.multiplier}`,
        ].join('\n');
        bannerLeft -= realDt;
        const countdown = director.intermissionLeft > 0 ? `  ${Math.ceil(director.intermissionLeft)}` : '';
        const bossLine = boss ? `   ${boss.name} ${Math.ceil(boss.hp)}/${Math.ceil(boss.maxHp)}` : '';
        top.textContent = bannerLeft > 0 ? banner : `WAVE ${director.wave}/${director.totalWaves}   ${director.objective.text}${countdown}   LEFT ${director.enemiesRemaining}${bossLine}`;
      }
      const offer = director.perkOffer;
      if (mode === 'menu') {
        show('menu', 'STATIC HORIZON', `BEST ${game.best.score}  ·  WAVE ${game.best.wave}`, DIFFICULTIES.map((d) => button(DIFFICULTY[d].name, () => ctx.game.startRun(d), `start-${d}`)));
      } else if (mode === 'paused') {
        show('paused', 'PAUSED', 'ESC TO RESUME', [button('RESUME', () => ctx.game.resume(), 'resume'), ...endButtons()]);
      } else if (mode === 'gameover') {
        show('gameover', 'SIGNAL LOST', `SCORE ${director.score}  ·  WAVE ${director.wave}`, endButtons());
      } else if (mode === 'victory') {
        show('victory', 'RIG SECURED', `SCORE ${director.score}  ·  GRADE ${director.stats.grade}`, endButtons());
      } else if (offer) {
        show(`perk-${director.wave}`, 'CHOOSE A PERK', 'PRESS 1 / 2 / 3', offer.map((id, i) => button(`${i + 1}  ${PERKS[id].name} — ${PERKS[id].description}`, () => ctx.director.choosePerk(i), `perk-${i}`)));
      } else {
        show('', '', '', []);
      }
    },
    dispose(): void {
      style.remove();
      hud.remove();
      top.remove();
      cross.remove();
      panel.remove();
    },
  };
  return ui;
}
