/**
 * The built-in fatal error panel and boot screen of index.html. Pure DOM, no dependencies, so it keeps
 * working when a game system (including the UI system) is the thing that failed.
 */

function byId(id: string): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

/** Show the fatal panel with a plain-language message and an optional technical detail. */
export function showFatalPanel(title: string, message: string, detail = ''): void {
  const panel = byId('fatal');
  hideBootScreen();
  if (!panel) return;
  const titleEl = byId('fatal-title');
  const messageEl = byId('fatal-message');
  const detailEl = byId('fatal-detail');
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  if (detailEl) {
    detailEl.textContent = detail;
    detailEl.hidden = detail.length === 0;
  }
  panel.hidden = false;
}

export function isFatalPanelVisible(): boolean {
  const panel = byId('fatal');
  return panel !== null && !panel.hidden;
}

/** Update the boot screen (label + progress bar 0..1). */
export function setBootProgress(label: string, fraction: number): void {
  const labelEl = byId('boot-label');
  const bar = byId('boot-bar');
  if (labelEl) labelEl.textContent = label;
  if (bar) bar.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
}

/** Fade out and remove the boot screen (`immediate` skips the fade: deterministic screenshots). */
export function hideBootScreen(immediate = false): void {
  const boot = byId('boot');
  if (!boot) return;
  if (immediate) {
    boot.remove();
    return;
  }
  boot.classList.add('is-done');
  window.setTimeout(() => boot.remove(), 400);
}

/** True when the browser can create a WebGL2 context. */
export function hasWebGL2(): boolean {
  try {
    const probe = document.createElement('canvas');
    return probe.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}
