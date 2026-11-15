/**
 * core/input.ts against a fake browser: the fallback and robustness rules of the Input contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from './events';
import { createInput } from './input';
import { DEFAULT_SETTINGS } from './settings';
import { installFakeDom } from './testkit';
import type { FakeDom } from './testkit';
import type { Input, InputAction, Settings } from './types';

const settings: Settings = {
  data: { ...DEFAULT_SETTINGS },
  defaults: DEFAULT_SETTINGS,
  set() {},
  resetToDefaults() {},
  flush() {},
};

let dom: FakeDom;
let input: Input;
let devices: string[];
let captures: { captured: boolean; intentional: boolean }[];

function make(testMode = false): Input {
  const events = createEventBus();
  events.on('input:device', (e) => devices.push(e.device));
  events.on('input:capture', (e) => captures.push({ ...e }));
  return createInput({ canvas: dom.canvas as unknown as HTMLCanvasElement, events, settings, testMode });
}

/** One frame: clear the previous edges, advance the clock, sample. */
function frame(seconds = 1 / 60): void {
  input.endFrame();
  dom.now += seconds * 1000;
  input.poll(seconds);
}

/** Let promise callbacks (pointer-lock rejections) run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const key = (code: string, target: unknown = null) => {
  const event = { code, target, ctrlKey: false, metaKey: false, altKey: false, repeat: false, prevented: false, preventDefault() { event.prevented = true; } };
  return event;
};
const mouse = (button = 0, extra: object = {}) => ({ target: dom.canvas, button, buttons: 1, movementX: 0, movementY: 0, clientX: 640, clientY: 360, preventDefault() {}, ...extra });
const click = (): void => {
  dom.now += 400;
  dom.window.dispatch('mousedown', mouse());
  dom.window.dispatch('mouseup', mouse());
};
const reject = (name: string) => (): Promise<void> => Promise.reject(Object.assign(new Error(name), { name }));

beforeEach(() => {
  dom = installFakeDom();
  devices = [];
  captures = [];
  input = make();
});

afterEach(() => {
  input.dispose();
  dom.restore();
  vi.unstubAllGlobals();
});

describe('gamepad', () => {
  it('ignores axes that rest off-centre and switches device on edges only', () => {
    dom.pad = { mapping: 'standard', axes: [1, -1, 1, -1], pressed: new Set() };
    input.requestCapture();
    const look = { yaw: 0, pitch: 0 };
    for (let i = 0; i < 10; i++) {
      frame();
      expect(input.moveX).toBe(0);
      expect(input.moveY).toBe(0);
      input.consumeLook(look);
      expect(look.yaw).toBe(0);
      expect(look.pitch).toBe(0);
    }
    expect(input.device).toBe('keyboardMouse');
    expect(devices).toEqual([]);

    // Once an axis has been seen near its centre it counts.
    dom.pad.axes = [0, 0, 0, 0];
    frame();
    dom.pad.axes = [0.9, 0, 0, 0];
    frame();
    expect(input.moveX).toBeGreaterThan(0.5);
    expect(input.device).toBe('gamepad');

    // A key takes the device back; the stick that is still HELD must not steal it again.
    dom.window.dispatch('keydown', key('KeyW'));
    for (let i = 0; i < 5; i++) frame();
    expect(input.device).toBe('keyboardMouse');
    expect(devices).toEqual(['gamepad', 'keyboardMouse']);

    // A new button press is an edge.
    dom.pad.pressed.add(0);
    frame();
    expect(input.device).toBe('gamepad');
    expect(input.justPressed('jump')).toBe(true);
  });

  it('ignores pads without the standard mapping', () => {
    dom.pad = { mapping: '', axes: [0, 0, 0, 0], pressed: new Set([0, 7]) };
    for (let i = 0; i < 3; i++) frame();
    expect(input.isDown('jump')).toBe(false);
    expect(input.isDown('fire')).toBe(false);
    expect(input.device).toBe('keyboardMouse');
  });

  it('keeps the D-pad for navigation: perks are on X / Y / B only', () => {
    dom.pad = { mapping: 'standard', axes: [0, 0, 0, 0], pressed: new Set([14, 12, 15]) };
    frame();
    expect(input.isDown('uiLeft')).toBe(true);
    expect(input.isDown('uiRight')).toBe(true);
    for (const action of ['perk1', 'perk2', 'perk3'] as InputAction[]) expect(input.isDown(action)).toBe(false);
    dom.pad.pressed = new Set([2, 3, 1]);
    frame();
    for (const action of ['perk1', 'perk2', 'perk3'] as InputAction[]) expect(input.isDown(action)).toBe(true);
  });
});

describe('wheel', () => {
  const wheel = (deltaY: number, deltaMode = 0) => dom.canvas.dispatch('wheel', { deltaY, deltaMode, preventDefault() {} });

  it('turns a trackpad gesture into a few weapon steps, a notch into exactly one', () => {
    input.requestCapture();
    let steps = 0;
    // 60 small events over one second, as a two-finger scroll sends them.
    for (let i = 0; i < 60; i++) {
      wheel(4);
      frame();
      if (input.justPressed('weaponNext')) steps++;
    }
    expect(steps).toBeGreaterThanOrEqual(1);
    expect(steps).toBeLessThanOrEqual(3);

    dom.now += 500;
    wheel(-100);
    frame();
    expect(input.justPressed('weaponPrev')).toBe(true);
    // Another notch right behind it is too soon for a second step.
    wheel(-100);
    frame();
    expect(input.justPressed('weaponPrev')).toBe(false);

    // Line-based deltas (deltaMode 1) are scaled to pixels.
    dom.now += 500;
    wheel(3, 1);
    frame();
    expect(input.justPressed('weaponNext')).toBe(true);
  });

  it('is ignored while the UI owns the pointer', () => {
    wheel(500);
    frame();
    expect(input.justPressed('weaponNext')).toBe(false);
  });
});

describe('pointer lock', () => {
  it('counts each refused request once and gives up after three real ones', async () => {
    dom.canvas.lockResult = reject('SecurityError');
    input.requestCapture();
    await settle();
    expect(dom.canvas.lockRequests.length).toBe(1);
    for (let i = 0; i < 5; i++) {
      click();
      // Browsers report the same refusal twice: the promise rejects AND 'pointerlockerror' fires.
      dom.document.dispatch('pointerlockerror');
      await settle();
    }
    // 1 request without a gesture (not counted) + exactly 3 counted ones; afterwards free look for good.
    expect(dom.canvas.lockRequests.length).toBe(4);
    expect(input.lookMode).toBe('free');
    frame();
    expect(input.wantsCapture).toBe(true);
  });

  it('never gives up because of requests made without a user gesture', async () => {
    dom.canvas.lockResult = reject('NotAllowedError');
    for (let i = 0; i < 6; i++) {
      input.releaseCapture();
      dom.now += 400;
      input.requestCapture();
      await settle();
    }
    expect(dom.canvas.lockRequests.length).toBe(6);
    click();
    expect(dom.canvas.lockRequests.length).toBe(7);
  });

  it('does not ask for the lock while a gamepad is the active device', () => {
    dom.pad = { mapping: 'standard', axes: [0, 0, 0, 0], pressed: new Set([0]) };
    frame();
    expect(input.device).toBe('gamepad');
    input.requestCapture();
    expect(dom.canvas.lockRequests.length).toBe(0);
    expect(input.lookMode).toBe('gamepad');
  });

  it('asks for raw mouse input and falls back when that is not supported', async () => {
    let calls = 0;
    dom.canvas.lockResult = () => {
      calls++;
      if (calls === 1) return reject('NotSupportedError')();
      dom.document.pointerLockElement = dom.canvas;
      dom.document.dispatch('pointerlockchange');
      return Promise.resolve();
    };
    input.requestCapture();
    await settle();
    expect(dom.canvas.lockRequests).toEqual([{ unadjustedMovement: true }, undefined]);
    expect(input.captured).toBe(true);
    expect(input.lookMode).toBe('locked');
  });

  it('a click that only re-acquires a lost lock does not fire, but clicks work again if re-locking keeps failing', async () => {
    dom.canvas.lockResult = () => {
      dom.document.pointerLockElement = dom.canvas;
      dom.document.dispatch('pointerlockchange');
      return Promise.resolve();
    };
    input.requestCapture();
    await settle();
    expect(input.captured).toBe(true);

    // The browser takes the lock away (Esc): reported as unintentional so core can pause.
    dom.document.pointerLockElement = null;
    dom.document.dispatch('pointerlockchange');
    expect(captures[captures.length - 1]).toEqual({ captured: false, intentional: false });

    dom.canvas.lockResult = reject('NotAllowedError');
    const fired: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      dom.now += 400;
      dom.window.dispatch('mousedown', mouse());
      frame();
      fired.push(input.isDown('fire'));
      dom.window.dispatch('mouseup', mouse());
      frame();
      await settle();
    }
    expect(fired).toEqual([false, false, true]);
  });

  it('is never requested in test mode', () => {
    input.dispose();
    input = make(true);
    input.requestCapture();
    click();
    expect(dom.canvas.lockRequests.length).toBe(0);
    expect(input.lookMode).toBe('free');
  });
});

describe('mouse and keyboard', () => {
  it('releases fire when the button was let go outside the frame', () => {
    input.requestCapture();
    dom.window.dispatch('mousedown', mouse());
    frame();
    expect(input.isDown('fire')).toBe(true);
    // No mouseup ever arrives; the next move reports that no button is held.
    dom.window.dispatch('mousemove', mouse(0, { buttons: 0, movementX: 3 }));
    frame();
    expect(input.isDown('fire')).toBe(false);
  });

  it('free look turns with the mouse and re-arms edge turning only after a real move', () => {
    input.requestCapture();
    const look = { yaw: 0, pitch: 0 };
    dom.window.dispatch('mousemove', mouse(0, { buttons: 0, movementX: 20, clientX: 30 }));
    frame();
    input.consumeLook(look);
    expect(look.yaw).toBeLessThan(0);
    // The cursor now rests in the left edge zone: the view keeps turning left.
    frame(0.1);
    input.consumeLook(look);
    expect(look.yaw).toBeGreaterThan(0);
    // The UI took the pointer and gave it back (perk screen): no spinning until the mouse moves again.
    input.releaseCapture();
    input.requestCapture();
    frame(0.1);
    input.consumeLook(look);
    expect(look.yaw).toBe(0);
  });

  it('never lets arrow keys scroll the page, but leaves sliders and focused buttons their keys', () => {
    class FakeElement {
      isContentEditable = false;
      constructor(readonly tagName: string, private readonly type = '') {}
      getAttribute(name: string): string | null {
        return name === 'type' && this.type ? this.type : null;
      }
      closest(): FakeElement {
        return this;
      }
    }
    vi.stubGlobal('HTMLElement', FakeElement);
    const button = new FakeElement('BUTTON');
    const slider = new FakeElement('INPUT', 'range');
    const text = new FakeElement('INPUT', 'text');

    let event = key('ArrowDown', button);
    dom.window.dispatch('keydown', event);
    expect(event.prevented).toBe(true);
    event = key('Space', button);
    dom.window.dispatch('keydown', event);
    expect(event.prevented).toBe(false);

    event = key('ArrowLeft', slider);
    dom.window.dispatch('keydown', event);
    expect(event.prevented).toBe(false);
    frame();
    expect(input.isDown('uiLeft')).toBe(true);

    // Typing into a text field is none of the game's business.
    event = key('KeyR', text);
    dom.window.dispatch('keydown', event);
    frame();
    expect(input.isDown('reload')).toBe(false);
  });

  it('labels bindings for the current or a given device', () => {
    expect(input.bindingLabel('reload')).toBe('R');
    expect(input.bindingLabel('reload', 'gamepad')).toBe('X');
    expect(input.bindingLabel('fire', 'touch')).toBe('FIRE');
    expect(input.bindingLabel('perk2', 'gamepad')).toBe('Y');
  });

  it('starts on touch prompts on a touch-only device', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }));
    input.dispose();
    input = make();
    expect(input.device).toBe('touch');
    expect(input.lookMode).toBe('touch');
  });
});
