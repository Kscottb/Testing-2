// Playwright harness shared by the smoke / campaign / screenshot tools.
//
//   const game = await launchGame({ mode: 'dev', port: 5200 });
//   await game.sh((SH) => SH.start('veteran'));      // run code in the page; first arg is window.__SH
//   const state = await game.step(2);                // advance the simulation 2 s (manual mode)
//   await game.shot('/tmp/x.png');
//   await game.close();
//
// The page is always opened with ?test=1 (manual stepping, fixed seed, no pointer lock).
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

/** Minimal static file server for ./dist. */
function startDistServer(port) {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error('dist/index.html not found — run "npm run build" first');
  }
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
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

/**
 * Launch the game in headless Chromium.
 * @param {{mode?: 'dev'|'dist', port?: number, width?: number, height?: number, touch?: boolean, query?: string}} [options]
 * @returns {Promise<{page: import('playwright').Page, errors: string[], url: string,
 *   sh: (fn: Function, ...args: any[]) => Promise<any>,
 *   step: (seconds: number, opts?: {dt?: number, render?: boolean|number}) => Promise<any>,
 *   shot: (file: string) => Promise<void>, close: () => Promise<void>}>}
 */
export async function launchGame(options = {}) {
  const { mode = 'dev', port = 5200, width = 1280, height = 720, touch = false, query = '' } = options;
  const server = mode === 'dist' ? await startDistServer(port) : await startDevServer(port);
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      hasTouch: touch,
      isMobile: touch,
    });
    // The optional web fonts must never hit the network (or fail) during tests.
    await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => {
      errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });

    const url = `${server.url}/?test=1${query ? `&${query.replace(/^[?&]/, '')}` : ''}`;
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    try {
      await page.waitForFunction(
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
    const ready = await page.evaluate(() => Boolean(window.__SH && window.__SH.ready && !window.__SH.fatal));
    if (!ready) {
      const detail = await page.evaluate(() => {
        const sh = window.__SH;
        const fromGame = sh ? sh.errors.map((e) => `${e.source}: ${e.message}\n${e.stack}`) : [];
        const panel = document.getElementById('fatal-detail');
        return [...fromGame, panel ? panel.textContent : ''].join('\n');
      });
      throw new Error(`game failed to boot:\n${detail}\n${errors.join('\n')}`);
    }

    /** Run `fn(window.__SH, ...args)` in the page. `fn` must be self-contained; args must be JSON-serialisable. */
    const sh = (fn, ...args) =>
      page.evaluate(([source, list]) => (0, eval)(`(${source})`)(window.__SH, ...list), [fn.toString(), args]);

    return {
      page,
      errors,
      url,
      sh,
      step: (seconds, opts) => sh((SH, s, o) => SH.step(s, o ?? undefined), seconds, opts ?? null),
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
