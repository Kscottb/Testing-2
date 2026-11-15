// Playwright harness shared by the smoke / campaign / screenshot tools.
//
//   const game = await launchGame({ mode: 'dev', port: 5200 });
//   await game.sh((SH) => SH.start('veteran'));      // run code in the page; first arg is window.__SH
//   const state = await game.step(2);                // advance the simulation 2 s (manual mode)
//   await game.shot('/tmp/x.png');
//   await game.close();
//
// By default the page is opened with ?test=1 (manual stepping, fixed seed, no pointer lock).
//   test: false          no test mode: the real requestAnimationFrame loop runs and step() just waits
//   embed: 'sandbox'     (dist only) the game runs inside <iframe sandbox="allow-scripts"> of a host page,
//                        the way it ships: no query string, no storage, no pointer lock, no fullscreen.
//                        With test: true the frame is named 'sh-test', which is the opt-in for test mode
//                        where no query string exists.
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/** Parse `--key value` / `--flag` pairs into an object (values stay strings). */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = '1';
    else out[key] = argv[++i];
  }
  return out;
}

/** Vite dev server on its own port and cache dir so several agents can run servers side by side. */
async function startDevServer(port) {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    cacheDir: path.join(ROOT, 'node_modules', `.vite-${port}`),
    logLevel: 'error',
    clearScreen: false,
    // No HMR and no file watching: a test run must never reload because another agent saved a file.
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
    // Serve dependencies as plain ES modules: no optimiser cache to race on.
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Host page that embeds the game the way it ships: one sandboxed frame without a query string. */
function hostPage(test) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Static Horizon host</title>
    <style>
      html, body { height: 100%; margin: 0; background: #000; overflow: hidden; }
      iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    </style>
  </head>
  <body>
    <iframe id="game-frame" sandbox="allow-scripts"${test ? ' name="sh-test"' : ''} src="/index.html"></iframe>
  </body>
</html>`;
}

/** Minimal static file server for ./dist (plus the sandbox host page at /__host.html). */
function startDistServer(port, test) {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error('dist/index.html not found — run "npm run build" first');
  }
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/__host.html') {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        res.end(hostPage(test));
        return;
      }
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.normalize(path.join(dist, rel));
      if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        // A sandboxed frame has an opaque origin: its module script is a cross-origin request.
        'access-control-allow-origin': '*',
      });
      fs.createReadStream(file).pipe(res);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Console errors a sandboxed frame produces by design (the game handles both refusals). */
const SANDBOX_NOISE = [
  /Blocked pointer lock on an element because the element's frame is sandboxed/i,
  /Permissions policy violation: fullscreen/i,
];

/**
 * Launch the game in headless Chromium.
 * @param {{mode?: 'dev'|'dist', port?: number, width?: number, height?: number, touch?: boolean, query?: string,
 *   test?: boolean, embed?: 'none'|'sandbox', dpr?: number, args?: string[], reducedMotion?: 'reduce'|'no-preference'}} [options]
 * @returns {Promise<{page: import('playwright').Page, frame: import('playwright').Frame, errors: string[], url: string,
 *   test: boolean, embed: string, canvasBox: () => Promise<{x: number, y: number, width: number, height: number}>,
 *   sh: (fn: Function, ...args: any[]) => Promise<any>,
 *   step: (seconds: number, opts?: {dt?: number, render?: boolean|number}) => Promise<any>,
 *   shot: (file: string) => Promise<void>, close: () => Promise<void>}>}
 */
export async function launchGame(options = {}) {
  const {
    mode = 'dev',
    port = 5200,
    width = 1280,
    height = 720,
    touch = false,
    query = '',
    test = true,
    embed = 'none',
    dpr = 1,
    args = [],
    reducedMotion = 'reduce',
  } = options;
  if (embed !== 'none' && embed !== 'sandbox') throw new Error(`unknown embed "${embed}"`);
  if (embed === 'sandbox' && mode !== 'dist') throw new Error('embed "sandbox" needs --mode dist');
  const server = mode === 'dist' ? await startDistServer(port, test) : await startDevServer(port);
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ args });
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: dpr,
      hasTouch: touch,
      isMobile: touch,
      reducedMotion,
    });
    // The optional web fonts must never hit the network (or fail) during tests.
    await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
    );
    const page = await context.newPage();
    const errors = [];
    const noise = embed === 'sandbox' ? SANDBOX_NOISE : [];
    const record = (text) => {
      if (!noise.some((pattern) => pattern.test(text))) errors.push(text);
    };
    page.on('console', (msg) => {
      if (msg.type() === 'error') record(`console: ${msg.text()}`);
    });
    page.on('pageerror', (error) => record(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => {
      record(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });

    const params = [test ? 'test=1' : '', query.replace(/^[?&]/, '')].filter(Boolean).join('&');
    // The sandboxed frame never gets a query string: test mode is opted into through its name.
    const url = embed === 'sandbox' ? `${server.url}/__host.html` : `${server.url}/${params ? `?${params}` : ''}`;
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    /** Where the game lives: the page itself, or the sandboxed frame inside the host page. */
    let frame = page.mainFrame();
    if (embed === 'sandbox') {
      const element = await page.waitForSelector('#game-frame', { timeout: 120000 });
      frame = await element.contentFrame();
      if (!frame) throw new Error('the sandboxed game frame did not load');
    }
    try {
      await frame.waitForFunction(
        () => {
          const sh = window.__SH;
          const fatal = document.getElementById('fatal');
          return (sh && (sh.ready || sh.fatal)) || (fatal && !fatal.hidden);
        },
        null,
        { timeout: 120000 },
      );
    } catch (error) {
      throw new Error(`game did not become ready: ${error.message}\n${errors.join('\n')}`);
    }
    const ready = await frame.evaluate(() => Boolean(window.__SH && window.__SH.ready && !window.__SH.fatal));
    if (!ready) {
      const detail = await frame.evaluate(() => {
        const sh = window.__SH;
        const fromGame = sh ? sh.errors.map((e) => `${e.source}: ${e.message}\n${e.stack}`) : [];
        const panel = document.getElementById('fatal-detail');
        return [...fromGame, panel ? panel.textContent : ''].join('\n');
      });
      throw new Error(`game failed to boot:\n${detail}\n${errors.join('\n')}`);
    }

    /** Run `fn(window.__SH, ...args)` in the game's frame. `fn` must be self-contained; args must be JSON-serialisable. */
    const sh = (fn, ...list) =>
      frame.evaluate(([source, values]) => (0, eval)(`(${source})`)(window.__SH, ...values), [fn.toString(), list]);

    return {
      page,
      frame,
      errors,
      url,
      test,
      embed,
      sh,
      /** Manual stepping in test mode; with the real loop it simply lets `seconds` of wall time pass. */
      step: test
        ? (seconds, opts) => sh((SH, s, o) => SH.step(s, o ?? undefined), seconds, opts ?? null)
        : async (seconds) => {
            await page.waitForTimeout(seconds * 1000);
            return sh((SH) => SH.state());
          },
      /** Bounding box of the game canvas in page coordinates (for real mouse / touch input). */
      async canvasBox() {
        const canvas = await frame.waitForSelector('#game');
        const box = await canvas.boundingBox();
        if (!box) throw new Error('the game canvas has no box');
        return box;
      },
      async shot(file) {
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        await sh((SH) => SH.renderFrame());
        await page.screenshot({ path: file });
      },
      async close() {
        await browser.close().catch(() => undefined);
        await server.close();
      },
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => undefined);
    await server.close();
    throw error;
  }
}

/** Errors recorded by the game itself (window.__SH.errors) as strings. */
export function gameErrors(game) {
  return game.sh((SH) => SH.errors.map((e) => `${e.source}: ${e.message}`));
}
