/**
 * core/input.ts against a fake browser: the fallback and robustness rules of the Input contract.
 * Sign conventions under test (core/types.ts): positive yaw turns LEFT, positive pitch looks UP, so
 * "mouse right" and "stick right" are negative yaw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from './events';
import { createInput } from './input';
import { DEFAULT_SETTINGS } from './settings';
import { installFakeDom } from './testkit';
import type { FakeDom } from './testkit';
import type { Input, InputAction, Settings, SettingsData } from './types';

/** Mirrors of the tuning constants in input.ts that the exact assertions below rely on. */
const MOUSE_RAD_PER_PX = 0.0022;
const TOUCH_RAD_PER_PX = 0.0052;
const KEY_YAW_RATE = 2.4;
const KEY_PITCH_RATE = 1.5;

const data: SettingsData = { ...DEFAULT_SETTINGS };
const settings: Settings = {
  data,
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

/**
 * One frame in core's order: the previous frame ends, the browser delivers what happened in between
 * (`arrivals`), the clock advances and input is sampled. The frame then stays open for the assertions.
 * Keys, buttons and the wheel are latched, so tests may also dispatch them BEFORE calling frame(). A look
 * delta (mouse travel, virtual look) must arrive inside `arrivals`: endFrame() drops whatever nobody
 * consumed, exactly as it does between two real frames.
 */
function frame(seconds = 1 / 60, arrivals?: () => void): void {
  input.endFrame();
  arrivals?.();
  dom.now += seconds * 1000;
  input.poll(seconds);
}

/** Let promise callbacks (pointer-lock rejections) run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const key = (code: string, target: unknown = null, extra: object = {}) => {
  const event = { code, target, ctrlKey: false, metaKey: false, altKey: false, repeat: false, prevented: false, preventDefault() { event.prevented = true; }, ...extra };
  return event;
};
const mouse = (button = 0, extra: object = {}) => ({ target: dom.canvas, button, buttons: 1, movementX: 0, movementY: 0, clientX: 640, clientY: 360, preventDefault() {}, ...extra });
/** Mouse travel without a button, as a callback for frame(). */
const travel = (extra: object) => (): void => dom.window.dispatch('mousemove', mouse(0, { buttons: 0, ...extra }));
const click = (): void => {
  dom.now += 400;
  dom.window.dispatch('mousedown', mouse());
  dom.window.dispatch('mouseup', mouse());
};
const reject = (name: string) => (): Promise<void> => Promise.reject(Object.assign(new Error(name), { name }));
/** The browser grants pointer lock at once. */
const grant = (): Promise<void> => {
  dom.document.pointerLockElement = dom.canvas;
  dom.document.dispatch('pointerlockchange');
  return Promise.resolve();
};
const look = { yaw: 0, pitch: 0 };

beforeEach(() => {
  dom = installFakeDom();
  Object.assign(data, DEFAULT_SETTINGS);
  devices = [];
  captures = [];
  look.yaw = look.pitch = 0;
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

  it('sticks move and turn (right = negative yaw), L3 latches sprint, a lost pad releases everything', () => {
    dom.pad = { mapping: 'standard', axes: [0, 0, 0, 0], pressed: new Set() };
    input.requestCapture();
    frame();
    // Left stick forward (pad y axes are down-positive), right stick to the right.
    dom.pad.axes = [0, -1, 1, 0];
    frame(0.1);
    expect(input.device).toBe('gamepad');
    expect(input.lookMode).toBe('gamepad');
    expect(input.moveY).toBeCloseTo(1);
    input.consumeLook(look);
    expect(look.yaw).toBeLessThan(-0.1);
    expect(look.pitch).toBeCloseTo(0);

    dom.pad.pressed.add(10);
    frame();
    expect(input.isDown('sprint')).toBe(true);
    dom.pad.pressed.delete(10);
    frame();
    expect(input.isDown('sprint')).toBe(true);
    // The latch lets go when the stick returns to the centre.
    dom.pad.axes = [0, 0, 0, 0];
    frame();
    expect(input.isDown('sprint')).toBe(false);

    dom.pad.pressed.add(7);
    dom.pad.axes = [0, -1, 0, 0];
    frame();
    expect(input.isDown('fire')).toBe(true);
    dom.pad = null;
    frame();
    expect(input.isDown('fire')).toBe(false);
    expect(input.justReleased('fire')).toBe(true);
    expect(input.moveY).toBe(0);
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

  it('counts a refusal when the request was made during a user gesture (a keyboard-started run)', async () => {
    dom.canvas.lockResult = reject('SecurityError');
    dom.navigator.userActivation.isActive = true;
    for (let i = 0; i < 5; i++) {
      input.releaseCapture();
      dom.now += 400;
      input.requestCapture();
      await settle();
    }
    // Three counted refusals: locking does not work here, stop asking.
    expect(dom.canvas.lockRequests.length).toBe(3);
    expect(input.lookMode).toBe('free');
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
      return calls === 1 ? reject('NotSupportedError')() : grant();
    };
    input.requestCapture();
    await settle();
    expect(dom.canvas.lockRequests).toEqual([{ unadjustedMovement: true }, undefined]);
    expect(input.captured).toBe(true);
    expect(input.lookMode).toBe('locked');
  });

  it('a click that only re-acquires a lost lock does not fire, but clicks work again if re-locking keeps failing', async () => {
    dom.canvas.lockResult = grant;
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

  it('reports a lock given up on purpose as intentional (the UI took the pointer: no auto-pause)', async () => {
    dom.canvas.lockResult = grant;
    input.requestCapture();
    await settle();
    expect(captures).toEqual([{ captured: true, intentional: true }]);
    input.releaseCapture();
    dom.document.dispatch('pointerlockchange');
    expect(captures[1]).toEqual({ captured: false, intentional: true });
    expect(input.captured).toBe(false);
    expect(input.wantsCapture).toBe(false);
    expect(input.lookMode).toBe('free');
  });

  it('drops the bogus mouse jump around a lock change and single-event spikes', async () => {
    dom.canvas.lockResult = grant;
    input.requestCapture();
    await settle();
    // Right after the lock was gained browsers report a jump: ignored.
    frame(1 / 60, travel({ movementX: 300 }));
    expect(input.consumeLook(look).yaw).toBe(0);
    dom.now += 100;
    frame(1 / 60, travel({ movementX: 300 }));
    expect(input.consumeLook(look).yaw).toBeCloseTo(-300 * MOUSE_RAD_PER_PX, 6);
    // One event that would turn the view by more than a radian is a glitch, not a flick.
    frame(1 / 60, travel({ movementX: 600 }));
    expect(input.consumeLook(look).yaw).toBe(0);
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

describe('look', () => {
  it('free look: the mouse turns the view, and the cursor resting at an edge keeps turning that way', () => {
    input.requestCapture();
    // 20 px right and 10 px down in the middle of the canvas: yaw and pitch both go negative.
    frame(1 / 60, travel({ movementX: 20, movementY: 10 }));
    input.consumeLook(look);
    expect(look.yaw).toBeCloseTo(-20 * MOUSE_RAD_PER_PX, 6);
    expect(look.pitch).toBeCloseTo(-10 * MOUSE_RAD_PER_PX, 6);

    // The cursor travels into the left edge zone: mouse delta plus edge turn, both to the LEFT (positive).
    frame(1 / 60, travel({ movementX: -40, clientX: 30 }));
    input.consumeLook(look);
    expect(look.yaw).toBeGreaterThan(40 * MOUSE_RAD_PER_PX);
    // It rests there: the view keeps turning left without any further mouse event.
    frame(0.1);
    input.consumeLook(look);
    expect(look.yaw).toBeGreaterThan(0.1);
    expect(look.pitch).toBe(0);

    // The UI took the pointer and gave it back (perk screen): no spinning until the mouse really moves.
    input.releaseCapture();
    input.requestCapture();
    frame(0.1);
    expect(input.consumeLook(look).yaw).toBe(0);
    // Synthetic zero-movement mousemoves (browsers send them after layout changes) do not re-arm it.
    frame(0.1, travel({ movementX: 0, clientX: 30 }));
    expect(input.consumeLook(look).yaw).toBe(0);
    frame(0.1, travel({ movementX: -3, clientX: 27 }));
    expect(input.consumeLook(look).yaw).toBeGreaterThan(0.1);

    // The cursor left the frame: nothing to rest on.
    dom.document.dispatch('mouseleave');
    frame(0.1);
    expect(input.consumeLook(look).yaw).toBe(0);
  });

  it('applies sensitivity and invertY to the mouse; a look delta nobody consumed dies with its frame', () => {
    data.sensitivity = 2;
    data.invertY = true;
    input.requestCapture();
    frame(1 / 60, travel({ movementX: 10, movementY: 10 }));
    input.consumeLook(look);
    expect(look.yaw).toBeCloseTo(-10 * MOUSE_RAD_PER_PX * 2, 6);
    expect(look.pitch).toBeCloseTo(10 * MOUSE_RAD_PER_PX * 2, 6);
    // Not consumed (the player was dead, the game paused ...): it must not turn the view a frame later.
    frame(1 / 60, travel({ movementX: 50 }));
    frame();
    expect(input.consumeLook(look).yaw).toBe(0);
  });

  it('arrow keys always turn the view: left = positive yaw, up = positive pitch', () => {
    input.requestCapture();
    dom.window.dispatch('keydown', key('ArrowLeft'));
    dom.window.dispatch('keydown', key('ArrowUp'));
    frame(0.1);
    input.consumeLook(look);
    expect(look.yaw).toBeCloseTo(KEY_YAW_RATE * 0.1, 6);
    expect(look.pitch).toBeCloseTo(KEY_PITCH_RATE * 0.1, 6);
    dom.window.dispatch('keyup', key('ArrowLeft'));
    dom.window.dispatch('keydown', key('ArrowRight'));
    frame(0.1);
    expect(input.consumeLook(look).yaw).toBeCloseTo(-KEY_YAW_RATE * 0.1, 6);
  });

  it('gives no look at all while the UI owns the pointer', () => {
    dom.window.dispatch('keydown', key('ArrowLeft'));
    frame(0.1, () => {
      travel({ movementX: 40 })();
      input.addVirtualLook(0.5, 0.5);
    });
    input.consumeLook(look);
    expect(look.yaw).toBe(0);
    expect(look.pitch).toBe(0);
    // The same key still navigates menus.
    expect(input.isDown('uiLeft')).toBe(true);
  });

  it('shows edges and the look delta in the first substep only', () => {
    input.requestCapture();
    frame(1 / 60, () => {
      input.pressVirtual('jump');
      input.addVirtualLook(0.3, 0.1);
    });
    expect(input.justPressed('jump')).toBe(true);
    // Substeps after the first: levels stay, edges and look are hidden (and not consumed).
    input.setEdgesVisible(false);
    expect(input.justPressed('jump')).toBe(false);
    expect(input.isDown('jump')).toBe(true);
    expect(input.consumeLook(look).yaw).toBe(0);
    // Core shows them again for render / audio / ui.
    input.setEdgesVisible(true);
    expect(input.justPressed('jump')).toBe(true);
    input.consumeLook(look);
    expect(look.yaw).toBeCloseTo(0.3);
    expect(look.pitch).toBeCloseTo(0.1);
    expect(input.consumeLook(look).yaw).toBe(0);
    frame();
    expect(input.justPressed('jump')).toBe(false);
    expect(input.justReleased('jump')).toBe(true);
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

  it('never lets arrow keys scroll the page; value controls keep only their horizontal arrows', () => {
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
    const checkbox = new FakeElement('INPUT', 'checkbox');
    const select = new FakeElement('SELECT');
    const text = new FakeElement('INPUT', 'text');
    /** Press and release one key on a target; returns whether its default action was cancelled. */
    const cancelled = (code: string, target: unknown): boolean => {
      const event = key(code, target);
      dom.window.dispatch('keydown', event);
      dom.window.dispatch('keyup', key(code, target));
      return event.prevented;
    };

    // A focused button: arrows only navigate, Space keeps clicking it.
    expect(cancelled('ArrowDown', button)).toBe(true);
    expect(cancelled('ArrowLeft', button)).toBe(true);
    expect(cancelled('Space', button)).toBe(false);
    expect(cancelled('Enter', button)).toBe(false);
    // Space outside any control would scroll the page.
    expect(cancelled('Space', null)).toBe(true);

    // A slider keeps ArrowLeft / ArrowRight (its value) ...
    expect(cancelled('ArrowLeft', slider)).toBe(false);
    expect(cancelled('ArrowRight', slider)).toBe(false);
    expect(cancelled('ArrowRight', select)).toBe(false);
    // ... but the vertical arrows only move focus there: one press must not also change the value.
    expect(cancelled('ArrowUp', slider)).toBe(true);
    expect(cancelled('ArrowDown', slider)).toBe(true);
    expect(cancelled('ArrowDown', select)).toBe(true);
    // A checkbox has no use for arrows at all.
    expect(cancelled('ArrowRight', checkbox)).toBe(true);

    // The game still receives the navigation action for a key it left to the control.
    dom.window.dispatch('keydown', key('ArrowLeft', slider));
    frame();
    expect(input.isDown('uiLeft')).toBe(true);
    expect(input.justPressed('uiLeft')).toBe(true);

    // Typing into a text field is none of the game's business.
    const typed = key('KeyR', text);
    dom.window.dispatch('keydown', typed);
    frame();
    expect(typed.prevented).toBe(false);
    expect(input.isDown('reload')).toBe(false);
  });

  it('owns every game key while playing, but leaves shortcuts, function keys and Escape to the browser', () => {
    input.requestCapture();
    const plain = key('KeyR');
    dom.window.dispatch('keydown', plain);
    expect(plain.prevented).toBe(true);
    dom.window.dispatch('keyup', key('KeyR'));
    frame();

    const shortcut = key('KeyR', null, { ctrlKey: true });
    const reload = key('F5');
    const escape = key('Escape');
    for (const event of [shortcut, reload, escape]) dom.window.dispatch('keydown', event);
    frame();
    expect(shortcut.prevented).toBe(false);
    expect(reload.prevented).toBe(false);
    expect(escape.prevented).toBe(false);
    // Ctrl+R is the browser's, not a reload of the gun; Escape still reaches the game.
    expect(input.isDown('reload')).toBe(false);
    expect(input.justPressed('pause')).toBe(true);
  });

  it('ignores key auto-repeat: one press is one edge', () => {
    dom.window.dispatch('keydown', key('Digit1'));
    frame();
    expect(input.justPressed('weapon1')).toBe(true);
    expect(input.justPressed('perk1')).toBe(true);
    dom.window.dispatch('keydown', key('Digit1', null, { repeat: true }));
    frame();
    expect(input.justPressed('weapon1')).toBe(false);
    expect(input.isDown('weapon1')).toBe(true);
    dom.window.dispatch('keyup', key('Digit1'));
    frame();
    expect(input.justReleased('weapon1')).toBe(true);
  });

  it('blur and a hidden tab release every held input and report the interruption, except in test mode', () => {
    input.requestCapture();
    dom.window.dispatch('keydown', key('KeyW'));
    dom.window.dispatch('mousedown', mouse());
    frame();
    expect(input.moveY).toBe(1);
    expect(input.isDown('fire')).toBe(true);
    dom.window.dispatch('blur');
    frame();
    expect(input.moveY).toBe(0);
    expect(input.justReleased('moveForward')).toBe(true);
    expect(input.isDown('fire')).toBe(false);
    expect(captures).toEqual([{ captured: false, intentional: false }]);
    dom.document.hidden = true;
    dom.document.dispatch('visibilitychange');
    expect(captures.length).toBe(2);
    // Nothing to interrupt while the UI owns the pointer.
    input.releaseCapture();
    dom.window.dispatch('blur');
    expect(captures.length).toBe(2);

    input.dispose();
    captures = [];
    input = make(true);
    input.requestCapture();
    dom.window.dispatch('keydown', key('KeyW'));
    frame();
    dom.window.dispatch('blur');
    frame();
    expect(input.isDown('moveForward')).toBe(false);
    expect(captures).toEqual([]);
  });

  it('labels bindings for the current or a given device', () => {
    expect(input.bindingLabel('reload')).toBe('R');
    expect(input.bindingLabel('reload', 'gamepad')).toBe('X');
    expect(input.bindingLabel('fire', 'touch')).toBe('FIRE');
    expect(input.bindingLabel('perk2', 'gamepad')).toBe('Y');
  });

  it('dispose removes every listener', () => {
    expect(dom.window.count('keydown')).toBe(1);
    expect(dom.canvas.count('wheel')).toBe(1);
    input.dispose();
    for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup', 'mousemove', 'blur', 'touchstart', 'touchend']) {
      expect(dom.window.count(type)).toBe(0);
    }
    for (const type of ['mouseleave', 'visibilitychange', 'pointerlockchange', 'pointerlockerror']) {
      expect(dom.document.count(type)).toBe(0);
    }
    for (const type of ['wheel', 'contextmenu']) expect(dom.canvas.count(type)).toBe(0);
  });
});

describe('touch and virtual input', () => {
  it('starts on touch prompts on a touch-only device', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }));
    input.dispose();
    input = make();
    expect(input.device).toBe('touch');
    expect(input.lookMode).toBe('touch');
  });

  it('a touch switches to touch look, and the mouse events a browser fakes after it are ignored', () => {
    input.requestCapture();
    dom.window.dispatch('touchstart');
    expect(input.device).toBe('touch');
    expect(input.lookMode).toBe('touch');
    expect(input.aimAssist).toBe(true);
    expect(devices).toEqual(['touch']);
    // A tap is followed by compatibility mouse events: they must neither fire nor steal the device.
    dom.window.dispatch('mousedown', mouse());
    dom.window.dispatch('mousemove', mouse(0, { movementX: 30 }));
    frame();
    expect(input.isDown('fire')).toBe(false);
    expect(input.device).toBe('touch');

    // Finger travel on the look zone: right = negative yaw, up = positive pitch.
    frame(1 / 60, () => input.addVirtualLookPixels(100, -50));
    input.consumeLook(look);
    expect(look.yaw).toBeCloseTo(-100 * TOUCH_RAD_PER_PX, 6);
    expect(look.pitch).toBeCloseTo(50 * TOUCH_RAD_PER_PX, 6);

    // A real mouse a moment later takes over again.
    dom.now += 1000;
    dom.window.dispatch('mousedown', mouse());
    expect(input.device).toBe('keyboardMouse');
    expect(input.aimAssist).toBe(false);
  });

  it('virtual input: a tap lasts one frame, a timed press holds, clearVirtual releases everything', () => {
    input.pressVirtual('reload');
    frame();
    expect(input.justPressed('reload')).toBe(true);
    expect(input.isDown('reload')).toBe(true);
    frame();
    expect(input.isDown('reload')).toBe(false);
    expect(input.justReleased('reload')).toBe(true);

    input.pressVirtual('fire', 0.1);
    frame();
    expect(input.justPressed('fire')).toBe(true);
    frame();
    expect(input.isDown('fire')).toBe(true);
    for (let i = 0; i < 10; i++) frame();
    expect(input.isDown('fire')).toBe(false);

    input.setVirtualButton('sprint', true);
    input.setVirtualMove(0.6, 0.8);
    frame();
    expect(input.isDown('sprint')).toBe(true);
    expect(input.moveX).toBeCloseTo(0.6);
    expect(input.moveY).toBeCloseTo(0.8);
    // Out-of-range and broken values are clamped, and all devices together never exceed the unit disc.
    input.setVirtualMove(3, Number.NaN);
    dom.window.dispatch('keydown', key('KeyW'));
    frame();
    expect(Math.hypot(input.moveX, input.moveY)).toBeCloseTo(1);
    expect(input.moveX).toBeGreaterThan(0);
    dom.window.dispatch('keyup', key('KeyW'));

    input.clearVirtual();
    frame();
    expect(input.isDown('sprint')).toBe(false);
    expect(input.justReleased('sprint')).toBe(true);
    expect(input.moveX).toBe(0);
    expect(input.moveY).toBe(0);
  });
});
