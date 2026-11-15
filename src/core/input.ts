/**
 * Device-independent input: keyboard, mouse, wheel, pointer lock (with free-look fallback), gamepad
 * and virtual inputs (touch UI, bot, tests). See the Input interface in core/types.ts.
 */
import { INPUT_ACTIONS } from './constants';
import { clamp } from './math';
import type { EventBus, Input, InputAction, InputDevice, LookDelta, LookMode, Settings } from './types';

export interface InputOptions {
  canvas: HTMLCanvasElement;
  events: EventBus;
  settings: Settings;
  /** Test mode: never use pointer lock, never auto-interrupt on blur. */
  testMode: boolean;
}

// --- tuning ---------------------------------------------------------------------------------------
const MOUSE_RAD_PER_PX = 0.0022;
const TOUCH_RAD_PER_PX = 0.0052;
const KEY_YAW_RATE = 2.4;
const KEY_PITCH_RATE = 1.5;
const PAD_YAW_RATE = 3.6;
const PAD_PITCH_RATE = 2.4;
const PAD_DEADZONE = 0.16;
const PAD_TRIGGER_THRESHOLD = 0.3;
const EDGE_ZONE_X = 0.14;
const EDGE_ZONE_Y = 0.1;
const EDGE_YAW_RATE = 2.6;
const EDGE_PITCH_RATE = 1.4;
const LOCK_RETRY_MS = 300;
/** Mouse deltas are ignored for this long after pointer lock is gained or lost (browsers emit a bogus jump). */
const LOCK_SETTLE_MS = 80;
/** A single mouse event that would turn the view further than this (radians) is a glitch, not a flick. */
const MAX_LOOK_PER_EVENT = 1.0;
const TOUCH_MOUSE_GUARD_MS = 800;
const MAX_LOCK_FAILURES = 3;

// --- bindings -------------------------------------------------------------------------------------
const KEY_BINDINGS: Readonly<Record<string, readonly InputAction[]>> = {
  KeyW: ['moveForward'],
  KeyS: ['moveBack'],
  KeyA: ['moveLeft'],
  KeyD: ['moveRight'],
  ArrowLeft: ['lookLeft', 'uiLeft'],
  ArrowRight: ['lookRight', 'uiRight'],
  ArrowUp: ['lookUp', 'uiUp'],
  ArrowDown: ['lookDown', 'uiDown'],
  KeyR: ['reload'],
  Space: ['jump'],
  ShiftLeft: ['sprint'],
  ShiftRight: ['sprint'],
  KeyC: ['crouch'],
  KeyQ: ['dash'],
  KeyF: ['overclock'],
  KeyV: ['melee'],
  KeyG: ['grenade'],
  Digit1: ['weapon1', 'perk1'],
  Digit2: ['weapon2', 'perk2'],
  Digit3: ['weapon3', 'perk3'],
  Digit4: ['weapon4'],
  Numpad1: ['weapon1', 'perk1'],
  Numpad2: ['weapon2', 'perk2'],
  Numpad3: ['weapon3', 'perk3'],
  Numpad4: ['weapon4'],
  Escape: ['pause', 'uiBack'],
  KeyP: ['pause'],
  Enter: ['uiConfirm'],
  NumpadEnter: ['uiConfirm'],
  Backspace: ['uiBack'],
};

/** Mouse button index -> actions. */
const MOUSE_BINDINGS: Readonly<Record<number, readonly InputAction[]>> = {
  0: ['fire'],
  2: ['ads'],
};

/** Standard-mapping gamepad button index -> actions. */
const PAD_BINDINGS: readonly (readonly InputAction[])[] = [
  ['jump', 'uiConfirm'], // 0 A
  ['crouch', 'uiBack', 'perk3'], // 1 B
  ['reload', 'perk1'], // 2 X
  ['weaponNext', 'perk2'], // 3 Y
  ['dash'], // 4 LB
  ['grenade'], // 5 RB
  ['ads'], // 6 LT
  ['fire'], // 7 RT
  [], // 8 Back
  ['pause'], // 9 Start
  [], // 10 L3 (sprint latch, handled separately)
  ['melee'], // 11 R3
  ['overclock', 'uiUp', 'perk2'], // 12 D-pad up
  ['weaponPrev', 'uiDown'], // 13 D-pad down
  ['uiLeft', 'perk1'], // 14 D-pad left
  ['uiRight', 'perk3'], // 15 D-pad right
];
const PAD_L3 = 10;

const KEY_LABELS: Readonly<Partial<Record<InputAction, string>>> = {
  moveForward: 'W',
  moveBack: 'S',
  moveLeft: 'A',
  moveRight: 'D',
  lookLeft: 'LEFT',
  lookRight: 'RIGHT',
  lookUp: 'UP',
  lookDown: 'DOWN',
  fire: 'LMB',
  ads: 'RMB',
  reload: 'R',
  jump: 'SPACE',
  sprint: 'SHIFT',
  crouch: 'C',
  dash: 'Q',
  overclock: 'F',
  melee: 'V',
  grenade: 'G',
  weapon1: '1',
  weapon2: '2',
  weapon3: '3',
  weapon4: '4',
  weaponNext: 'WHEEL',
  weaponPrev: 'WHEEL',
  pause: 'ESC',
  perk1: '1',
  perk2: '2',
  perk3: '3',
  uiUp: 'UP',
  uiDown: 'DOWN',
  uiLeft: 'LEFT',
  uiRight: 'RIGHT',
  uiConfirm: 'ENTER',
  uiBack: 'ESC',
};

const PAD_LABELS: Readonly<Partial<Record<InputAction, string>>> = {
  moveForward: 'LS',
  moveBack: 'LS',
  moveLeft: 'LS',
  moveRight: 'LS',
  lookLeft: 'RS',
  lookRight: 'RS',
  lookUp: 'RS',
  lookDown: 'RS',
  fire: 'RT',
  ads: 'LT',
  reload: 'X',
  jump: 'A',
  sprint: 'L3',
  crouch: 'B',
  dash: 'LB',
  overclock: 'D-UP',
  melee: 'R3',
  grenade: 'RB',
  weaponNext: 'Y',
  weaponPrev: 'D-DOWN',
  pause: 'START',
  perk1: 'X',
  perk2: 'Y',
  perk3: 'B',
  uiUp: 'D-UP',
  uiDown: 'D-DOWN',
  uiLeft: 'D-LEFT',
  uiRight: 'D-RIGHT',
  uiConfirm: 'A',
  uiBack: 'B',
};

const TOUCH_LABELS: Readonly<Partial<Record<InputAction, string>>> = {
  fire: 'FIRE',
  ads: 'AIM',
  reload: 'RELOAD',
  jump: 'JUMP',
  dash: 'DASH',
  overclock: 'OVERCLOCK',
  melee: 'MELEE',
  grenade: 'GRENADE',
  weaponNext: 'SWAP',
  pause: 'PAUSE',
  crouch: 'SLIDE',
  uiConfirm: 'TAP',
};

const ACTION_COUNT = INPUT_ACTIONS.length;
const ACTION_INDEX = {} as Record<InputAction, number>;
INPUT_ACTIONS.forEach((action, i) => {
  ACTION_INDEX[action] = i;
});

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('button,a,input,select,textarea,[role="button"],[role="slider"],[tabindex]') !== null;
}

function applyDeadzone(x: number, y: number, out: { x: number; y: number }): void {
  const len = Math.sqrt(x * x + y * y);
  if (!(len > PAD_DEADZONE)) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const scaled = Math.min(1, (len - PAD_DEADZONE) / (1 - PAD_DEADZONE)) / len;
  out.x = x * scaled;
  out.y = y * scaled;
}

export function createInput(options: InputOptions): Input {
  const { canvas, events, settings, testMode } = options;

  // Per-action state.
  const down = new Uint8Array(ACTION_COUNT);
  const prev = new Uint8Array(ACTION_COUNT);
  const pressed = new Uint8Array(ACTION_COUNT);
  const released = new Uint8Array(ACTION_COUNT);
  const analog = new Float32Array(ACTION_COUNT);
  const latchPressed = new Uint8Array(ACTION_COUNT);
  const latchReleased = new Uint8Array(ACTION_COUNT);
  const keyHeld = new Uint8Array(ACTION_COUNT); // number of keys/buttons holding the action
  const padHeld = new Uint8Array(ACTION_COUNT);
  const padAnalog = new Float32Array(ACTION_COUNT);
  const virtualHeld = new Uint8Array(ACTION_COUNT);
  const virtualTap = new Uint8Array(ACTION_COUNT);
  const virtualTimer = new Float32Array(ACTION_COUNT);

  const heldCodes = new Set<string>();
  const heldButtons = new Set<number>();

  let edgesVisible = true;
  let moveX = 0;
  let moveY = 0;
  let virtualMoveX = 0;
  let virtualMoveY = 0;
  let lookYaw = 0;
  let lookPitch = 0;

  let device: InputDevice = 'keyboardMouse';
  let lookMode: LookMode = 'free';
  let wantsCapture = false;
  let locked = false;
  let everLocked = false;
  let lockFailures = 0;
  let lockDisabled = testMode || typeof canvas.requestPointerLock !== 'function';
  let lastLockAttempt = -Infinity;
  let lastLockChange = -Infinity;
  let lastTouchTime = -Infinity;

  // Free-look pointer tracking (normalised canvas coordinates).
  let pointerInside = false;
  let pointerSeen = false;
  let pointerNx = 0.5;
  let pointerNy = 0.5;

  // Gamepad.
  let padIndex = -1;
  let padSprintLatch = false;
  let padPrevL3 = false;
  const stick = { x: 0, y: 0 };
  let padMoveX = 0;
  let padMoveY = 0;
  let padStickUiX = 0;
  let padStickUiY = 0;

  const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // --- device / look mode ---------------------------------------------------------------------
  const refreshLookMode = (): void => {
    const next: LookMode =
      device === 'touch' ? 'touch' : device === 'gamepad' ? 'gamepad' : locked ? 'locked' : 'free';
    if (next === lookMode) return;
    const prevMode = lookMode;
    lookMode = next;
    events.emit('input:lookMode', { mode: next, prev: prevMode });
  };

  const setDevice = (next: InputDevice): void => {
    if (next === device) return;
    const prevDevice = device;
    device = next;
    events.emit('input:device', { device: next, prev: prevDevice });
    refreshLookMode();
  };

  // --- pointer lock ---------------------------------------------------------------------------
  const onLockFailed = (): void => {
    // Rejections after a successful lock are the browser's re-lock cooldown: keep trying on clicks.
    if (!everLocked) {
      lockFailures++;
      if (lockFailures >= MAX_LOCK_FAILURES) lockDisabled = true;
    }
    refreshLookMode();
  };

  const tryLock = (): void => {
    if (lockDisabled || locked || !wantsCapture || device === 'touch') return;
    const t = nowMs();
    if (t - lastLockAttempt < LOCK_RETRY_MS) return;
    lastLockAttempt = t;
    try {
      const result = canvas.requestPointerLock() as unknown;
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(onLockFailed);
      }
    } catch {
      onLockFailed();
    }
  };

  const onPointerLockChange = (): void => {
    const isLocked = document.pointerLockElement === canvas;
    if (isLocked === locked) return;
    locked = isLocked;
    lastLockChange = nowMs();
    if (locked) {
      everLocked = true;
      lockFailures = 0;
      events.emit('input:capture', { captured: true, intentional: true });
    } else {
      // Lost while gameplay still wanted it = the user or the browser took it (Esc, alt-tab).
      const intentional = !wantsCapture;
      releaseHeldMouse();
      events.emit('input:capture', { captured: false, intentional });
    }
    refreshLookMode();
  };

  const onPointerLockError = (): void => {
    onLockFailed();
  };

  // --- keyboard -------------------------------------------------------------------------------
  const pressActions = (actions: readonly InputAction[] | undefined): void => {
    if (!actions) return;
    for (const action of actions) {
      const i = ACTION_INDEX[action];
      keyHeld[i] = (keyHeld[i] as number) + 1;
      latchPressed[i] = 1;
    }
  };

  const releaseActions = (actions: readonly InputAction[] | undefined): void => {
    if (!actions) return;
    for (const action of actions) {
      const i = ACTION_INDEX[action];
      if ((keyHeld[i] as number) > 0) keyHeld[i] = (keyHeld[i] as number) - 1;
      latchReleased[i] = 1;
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isEditable(e.target)) return;
    const modifier = e.ctrlKey || e.metaKey || e.altKey;
    const actions = KEY_BINDINGS[e.code];
    if (!modifier) {
      const functionKey = /^F\d{1,2}$/.test(e.code);
      const scrollKey = e.code === 'Space' || e.code.startsWith('Arrow');
      if (e.code !== 'Escape' && !functionKey) {
        // While gameplay owns the input every key is ours; in menus only stop page scrolling and
        // leave focused buttons/sliders their native keys.
        if (wantsCapture || (scrollKey && !isInteractive(e.target))) e.preventDefault();
      }
    }
    if (!actions || modifier || e.repeat || heldCodes.has(e.code)) return;
    heldCodes.add(e.code);
    pressActions(actions);
    setDevice('keyboardMouse');
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (!heldCodes.delete(e.code)) return;
    releaseActions(KEY_BINDINGS[e.code]);
  };

  // --- mouse ----------------------------------------------------------------------------------
  const fromTouch = (): boolean => nowMs() - lastTouchTime < TOUCH_MOUSE_GUARD_MS;

  const releaseHeldMouse = (): void => {
    for (const button of heldButtons) releaseActions(MOUSE_BINDINGS[button]);
    heldButtons.clear();
  };

  const onMouseDown = (e: MouseEvent): void => {
    if (fromTouch()) return;
    const onCanvas = e.target === canvas;
    if (!locked && !onCanvas) return;
    setDevice('keyboardMouse');
    if (!wantsCapture) return;
    if (e.button !== 0) e.preventDefault();
    if (!locked) tryLock();
    if (heldButtons.has(e.button)) return;
    heldButtons.add(e.button);
    pressActions(MOUSE_BINDINGS[e.button]);
  };

  const onMouseUp = (e: MouseEvent): void => {
    if (!heldButtons.delete(e.button)) return;
    releaseActions(MOUSE_BINDINGS[e.button]);
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (fromTouch()) return;
    const mx = Number.isFinite(e.movementX) ? e.movementX : 0;
    const my = Number.isFinite(e.movementY) ? e.movementY : 0;
    // Browsers dispatch synthetic zero-movement mousemoves after style/layout changes: those must
    // neither count as activity nor arm edge-turn.
    if (mx === 0 && my === 0) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      pointerNx = (e.clientX - rect.left) / rect.width;
      pointerNy = (e.clientY - rect.top) / rect.height;
      pointerInside = pointerNx >= 0 && pointerNx <= 1 && pointerNy >= 0 && pointerNy <= 1;
      pointerSeen = true;
    }
    if (Math.abs(mx) + Math.abs(my) > 2) setDevice('keyboardMouse');
    if (!wantsCapture || device !== 'keyboardMouse') return;
    if (!locked && e.target !== canvas) return;
    // Guard against the bogus jumps browsers report around (un)locking and the occasional spike.
    if (nowMs() - lastLockChange < LOCK_SETTLE_MS) return;
    const scale = MOUSE_RAD_PER_PX * settings.data.sensitivity;
    if (Math.abs(mx) * scale > MAX_LOOK_PER_EVENT || Math.abs(my) * scale > MAX_LOOK_PER_EVENT) return;
    lookYaw -= mx * scale;
    lookPitch -= my * scale * (settings.data.invertY ? -1 : 1);
  };

  const onMouseLeave = (): void => {
    pointerInside = false;
  };

  const onWheel = (e: WheelEvent): void => {
    if (!wantsCapture) return;
    e.preventDefault();
    if (e.deltaY === 0) return;
    latchPressed[ACTION_INDEX[e.deltaY > 0 ? 'weaponNext' : 'weaponPrev']] = 1;
    setDevice('keyboardMouse');
  };

  const onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  const onTouchStart = (): void => {
    lastTouchTime = nowMs();
    setDevice('touch');
  };

  const onTouchEnd = (): void => {
    lastTouchTime = nowMs();
  };

  // --- focus ----------------------------------------------------------------------------------
  const releaseAllPhysical = (): void => {
    for (const code of heldCodes) releaseActions(KEY_BINDINGS[code]);
    heldCodes.clear();
    releaseHeldMouse();
    keyHeld.fill(0);
  };

  const interrupt = (): void => {
    releaseAllPhysical();
    if (testMode || !wantsCapture) return;
    events.emit('input:capture', { captured: locked, intentional: false });
  };

  const onBlur = (): void => {
    interrupt();
  };

  const onVisibility = (): void => {
    if (document.hidden) interrupt();
  };

  // --- gamepad --------------------------------------------------------------------------------
  const pollGamepad = (realDt: number): void => {
    padHeld.fill(0);
    padAnalog.fill(0);
    padMoveX = 0;
    padMoveY = 0;
    padStickUiX = 0;
    padStickUiY = 0;
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    let pads: (Gamepad | null)[];
    try {
      pads = navigator.getGamepads();
    } catch {
      return;
    }
    let pad: Gamepad | null = null;
    if (padIndex >= 0 && pads[padIndex] && pads[padIndex]?.connected) pad = pads[padIndex] ?? null;
    if (!pad) {
      padIndex = -1;
      for (let i = 0; i < pads.length; i++) {
        const candidate = pads[i];
        if (candidate && candidate.connected && candidate.buttons.length >= 10) {
          pad = candidate;
          padIndex = i;
          break;
        }
      }
    }
    if (!pad) {
      padSprintLatch = false;
      return;
    }

    let active = false;
    const buttons = pad.buttons;
    for (let b = 0; b < PAD_BINDINGS.length && b < buttons.length; b++) {
      const button = buttons[b];
      if (!button) continue;
      const isTrigger = b === 6 || b === 7;
      const value = button.value ?? (button.pressed ? 1 : 0);
      const isDown = isTrigger ? value > PAD_TRIGGER_THRESHOLD : button.pressed;
      if (!isDown) continue;
      active = true;
      for (const action of PAD_BINDINGS[b] as readonly InputAction[]) {
        const i = ACTION_INDEX[action];
        padHeld[i] = 1;
        padAnalog[i] = Math.max(padAnalog[i] as number, isTrigger ? value : 1);
      }
    }

    // Left stick: movement (y axis is down-positive on gamepads).
    applyDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0, stick);
    padMoveX = stick.x;
    padMoveY = -stick.y;
    padStickUiX = stick.x;
    padStickUiY = stick.y;
    const moveMag = Math.sqrt(stick.x * stick.x + stick.y * stick.y);
    if (moveMag > 0.5) active = true;

    // L3 toggles a sprint latch that holds while the stick stays pushed.
    const l3 = buttons[PAD_L3]?.pressed ?? false;
    if (l3 && !padPrevL3) padSprintLatch = !padSprintLatch;
    padPrevL3 = l3;
    if (l3) active = true;
    if (moveMag < 0.35) padSprintLatch = false;
    if (padSprintLatch) padHeld[ACTION_INDEX.sprint] = 1;

    // Stick as menu navigation.
    if (padStickUiY < -0.6) padHeld[ACTION_INDEX.uiUp] = 1;
    if (padStickUiY > 0.6) padHeld[ACTION_INDEX.uiDown] = 1;
    if (padStickUiX < -0.6) padHeld[ACTION_INDEX.uiLeft] = 1;
    if (padStickUiX > 0.6) padHeld[ACTION_INDEX.uiRight] = 1;

    // Right stick: look, with a response curve for fine aim.
    applyDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0, stick);
    const lookMag = Math.sqrt(stick.x * stick.x + stick.y * stick.y);
    if (lookMag > 0) {
      if (lookMag > 0.5) active = true;
      if (wantsCapture && (device === 'gamepad' || active)) {
        const curve = 0.35 + 0.65 * lookMag;
        const sens = settings.data.sensitivity;
        lookYaw -= stick.x * curve * PAD_YAW_RATE * sens * realDt;
        lookPitch -= stick.y * curve * PAD_PITCH_RATE * sens * realDt * (settings.data.invertY ? -1 : 1);
      }
    }

    if (active) setDevice('gamepad');
  };

  // --- listeners ------------------------------------------------------------------------------
  const passiveFalse: AddEventListenerOptions = { passive: false };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('blur', onBlur);
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('mouseleave', onMouseLeave);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('pointerlockerror', onPointerLockError);
  canvas.addEventListener('wheel', onWheel, passiveFalse);
  canvas.addEventListener('contextmenu', onContextMenu);

  // --- public API -----------------------------------------------------------------------------
  const input: Input = {
    isDown(action: InputAction): boolean {
      return down[ACTION_INDEX[action]] === 1;
    },
    justPressed(action: InputAction): boolean {
      return edgesVisible && pressed[ACTION_INDEX[action]] === 1;
    },
    justReleased(action: InputAction): boolean {
      return edgesVisible && released[ACTION_INDEX[action]] === 1;
    },
    value(action: InputAction): number {
      return analog[ACTION_INDEX[action]] as number;
    },
    get moveX(): number {
      return moveX;
    },
    get moveY(): number {
      return moveY;
    },
    consumeLook(out: LookDelta): LookDelta {
      if (!edgesVisible) {
        out.yaw = 0;
        out.pitch = 0;
        return out;
      }
      out.yaw = lookYaw;
      out.pitch = lookPitch;
      lookYaw = 0;
      lookPitch = 0;
      return out;
    },

    requestCapture(): void {
      wantsCapture = true;
      // Free look keeps the cursor visible (edge-turn needs it); a crosshair reads as "aiming".
      canvas.style.cursor = 'crosshair';
      tryLock();
    },
    releaseCapture(): void {
      wantsCapture = false;
      canvas.style.cursor = '';
      releaseHeldMouse();
      lookYaw = 0;
      lookPitch = 0;
      if (locked) {
        try {
          document.exitPointerLock();
        } catch {
          // Nothing to do: the lock is gone or the document is detached.
        }
      }
    },
    get wantsCapture(): boolean {
      return wantsCapture;
    },
    get captured(): boolean {
      return locked;
    },
    get lookMode(): LookMode {
      return lookMode;
    },
    get device(): InputDevice {
      return device;
    },
    get aimAssist(): boolean {
      return settings.data.aimAssist && device !== 'keyboardMouse';
    },

    setVirtualButton(action: InputAction, isDown: boolean): void {
      const i = ACTION_INDEX[action];
      if (isDown && virtualHeld[i] === 0) latchPressed[i] = 1;
      if (!isDown && virtualHeld[i] === 1) latchReleased[i] = 1;
      virtualHeld[i] = isDown ? 1 : 0;
    },
    pressVirtual(action: InputAction, seconds?: number): void {
      const i = ACTION_INDEX[action];
      latchPressed[i] = 1;
      if (seconds !== undefined && seconds > 0) {
        virtualTimer[i] = Math.max(virtualTimer[i] as number, seconds);
      } else {
        virtualTap[i] = 1;
      }
    },
    setVirtualMove(x: number, y: number): void {
      virtualMoveX = Number.isFinite(x) ? clamp(x, -1, 1) : 0;
      virtualMoveY = Number.isFinite(y) ? clamp(y, -1, 1) : 0;
    },
    addVirtualLook(yaw: number, pitch: number): void {
      if (Number.isFinite(yaw)) lookYaw += yaw;
      if (Number.isFinite(pitch)) lookPitch += pitch;
    },
    addVirtualLookPixels(dx: number, dy: number): void {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const scale = TOUCH_RAD_PER_PX * settings.data.sensitivity;
      lookYaw -= dx * scale;
      lookPitch -= dy * scale * (settings.data.invertY ? -1 : 1);
    },
    notifyDevice(next: InputDevice): void {
      if (next === 'touch') lastTouchTime = nowMs();
      setDevice(next);
    },
    clearVirtual(): void {
      for (let i = 0; i < ACTION_COUNT; i++) {
        if (virtualHeld[i] === 1 || (virtualTimer[i] as number) > 0) latchReleased[i] = 1;
      }
      virtualHeld.fill(0);
      virtualTap.fill(0);
      virtualTimer.fill(0);
      virtualMoveX = 0;
      virtualMoveY = 0;
    },

    bindingLabel(action: InputAction): string {
      const table = device === 'gamepad' ? PAD_LABELS : device === 'touch' ? TOUCH_LABELS : KEY_LABELS;
      return table[action] ?? '';
    },
    rumble(strength: number, seconds: number): void {
      if (device !== 'gamepad' || padIndex < 0 || !(strength > 0) || !(seconds > 0)) return;
      try {
        const pad = navigator.getGamepads()[padIndex];
        const actuator = pad?.vibrationActuator;
        if (!actuator) return;
        const s = clamp(strength, 0, 1);
        void actuator
          .playEffect('dual-rumble', {
            duration: Math.min(seconds, 2) * 1000,
            strongMagnitude: s,
            weakMagnitude: s * 0.6,
          })
          .catch(() => undefined);
      } catch {
        // Rumble is a nicety; ignore unsupported browsers.
      }
    },

    poll(realDt: number): void {
      const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 0.1) : 0;
      pollGamepad(dt);

      for (let i = 0; i < ACTION_COUNT; i++) {
        const held =
          (keyHeld[i] as number) > 0 ||
          padHeld[i] === 1 ||
          virtualHeld[i] === 1 ||
          virtualTap[i] === 1 ||
          (virtualTimer[i] as number) > 0;
        const was = prev[i] === 1;
        pressed[i] = (held && !was) || latchPressed[i] === 1 ? 1 : 0;
        released[i] = (!held && was) || (latchReleased[i] === 1 && !held) ? 1 : 0;
        down[i] = held ? 1 : 0;
        prev[i] = down[i] as number;
        // Analog amount: any digital source saturates it; otherwise the trigger value.
        const digital =
          (keyHeld[i] as number) > 0 ||
          virtualHeld[i] === 1 ||
          virtualTap[i] === 1 ||
          (virtualTimer[i] as number) > 0;
        analog[i] = !held ? 0 : digital ? 1 : (padAnalog[i] as number);
        latchPressed[i] = 0;
        latchReleased[i] = 0;
        virtualTap[i] = 0;
        if ((virtualTimer[i] as number) > 0) virtualTimer[i] = Math.max(0, (virtualTimer[i] as number) - dt);
      }

      // Move axes: keyboard + stick + virtual, clamped to the unit disc.
      let mx = (down[ACTION_INDEX.moveRight] as number) - (down[ACTION_INDEX.moveLeft] as number);
      let my = (down[ACTION_INDEX.moveForward] as number) - (down[ACTION_INDEX.moveBack] as number);
      mx += padMoveX + virtualMoveX;
      my += padMoveY + virtualMoveY;
      const len = Math.sqrt(mx * mx + my * my);
      if (len > 1) {
        mx /= len;
        my /= len;
      }
      moveX = mx;
      moveY = my;

      if (!wantsCapture) {
        // The UI owns the pointer: no gameplay look at all.
        lookYaw = 0;
        lookPitch = 0;
        return;
      }

      // Arrow keys always turn the view (fallback look).
      const sens = settings.data.sensitivity;
      const keyYaw = (down[ACTION_INDEX.lookLeft] as number) - (down[ACTION_INDEX.lookRight] as number);
      const keyPitch = (down[ACTION_INDEX.lookUp] as number) - (down[ACTION_INDEX.lookDown] as number);
      lookYaw += keyYaw * KEY_YAW_RATE * sens * dt;
      lookPitch += keyPitch * KEY_PITCH_RATE * sens * dt;

      // Free look: the cursor resting near a screen edge keeps turning the view.
      if (lookMode === 'free' && pointerInside && pointerSeen && !testMode) {
        let ex = 0;
        let ey = 0;
        if (pointerNx < EDGE_ZONE_X) ex = (EDGE_ZONE_X - pointerNx) / EDGE_ZONE_X;
        else if (pointerNx > 1 - EDGE_ZONE_X) ex = -(pointerNx - (1 - EDGE_ZONE_X)) / EDGE_ZONE_X;
        if (pointerNy < EDGE_ZONE_Y) ey = (EDGE_ZONE_Y - pointerNy) / EDGE_ZONE_Y;
        else if (pointerNy > 1 - EDGE_ZONE_Y) ey = -(pointerNy - (1 - EDGE_ZONE_Y)) / EDGE_ZONE_Y;
        lookYaw += clamp(ex, -1, 1) * EDGE_YAW_RATE * sens * dt;
        lookPitch += clamp(ey, -1, 1) * EDGE_PITCH_RATE * sens * dt;
      }

      if (!Number.isFinite(lookYaw)) lookYaw = 0;
      if (!Number.isFinite(lookPitch)) lookPitch = 0;
    },
    setEdgesVisible(visible: boolean): void {
      edgesVisible = visible;
    },
    endFrame(): void {
      pressed.fill(0);
      released.fill(0);
      lookYaw = 0;
      lookPitch = 0;
      edgesVisible = true;
    },
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('mouseleave', onMouseLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('pointerlockerror', onPointerLockError);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };

  return input;
}
