/**
 * tools/test-standalone.mjs — proves the frontend works with no backend at all.
 *
 * The multiplayer server is never started. A plain static file host (this file's
 * built-in http server: no /api, no /ws) serves the project, and headless Chrome
 * plays a real single-player game through the UI. This is the "the Sudoku game
 * itself must still function without that backend" requirement.
 *
 * Run: node tools/test-standalone.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.STANDALONE_PORT) || 8793;
const DEBUG_PORT = Number(process.env.CDP_PORT) || 9334;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
const failures = [];
const consoleErrors = [];
const networkNoise = [];
const NETWORK_NOISE = /net::ERR_|Failed to load resource|WebSocket connection to/i;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, { timeout = 10000, interval = 120, label = 'condition' } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (${last.message})` : ''}`);
}

/* --------------------- static-only host (no backend) --------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const staticHost = http.createServer((request, response) => {
  const url = new URL(request.url, BASE);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const target = normalize(join(root, pathname));
  if (!target.startsWith(root) || !existsSync(target)) {
    // No API, no WebSocket route — just like a plain static host.
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream' });
  response.end(readFileSync(target));
});
await new Promise((resolve) => staticHost.listen(PORT, resolve));

const chromePath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome',
].filter(Boolean).find((candidate) => existsSync(candidate));

if (!chromePath) {
  console.error('Chrome was not found; set CHROME_PATH to run this check.');
  staticHost.close();
  process.exit(2);
}

const userDataDir = join(tmpdir(), `sudoku-static-${Date.now()}`);
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);

/* ------------------------------- CDP client ----------------------------- */

let ws;
let id = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const message = { id: ++id, method, params };
    if (sessionId) message.sessionId = sessionId;
    pending.set(message.id, { resolve, reject });
    ws.send(JSON.stringify(message));
    setTimeout(() => {
      if (pending.has(message.id)) {
        pending.delete(message.id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30000);
  });

function cleanup() {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  staticHost.close();
  setTimeout(() => {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* windows may hold the profile */
    }
  }, 400);
}

try {
  await sleep(2500);
  const version = await (
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
  ).json();
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('devtools attach failed')), { once: true });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(`uncaught: ${message.params.exceptionDetails.exception?.description}`);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(`console.error: ${message.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      const text = message.params.entry.text;
      if (NETWORK_NOISE.test(text)) networkNoise.push(text);
      else consoleErrors.push(`log: ${text}`);
    }
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);

  const walk = async (expression) => {
    const result = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description}`);
    }
    return result.result.value;
  };
  const click = async (selector) => {
    const ok = await walk(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!ok) throw new Error(`not found: ${selector}`);
    await sleep(90);
  };
  const savedGame = () =>
    walk(`(async () => {
      const m = await import('/js/storage.js');
      const g = await m.StorageManager.loadGame();
      return g ? { status: g.status, difficulty: g.difficulty } : null;
    })()`);

  console.log('\nSTATIC HOST ONLY (no /api, no /ws)');

  await test('the app loads and plays with no backend reachable', async () => {
    await send('Page.navigate', { url: `${BASE}/` }, sessionId);
    await waitFor(() => walk(`document.readyState === 'complete'`), { label: 'page load' });
    await waitFor(() => walk(`Boolean(document.querySelector('#home-title'))`), { label: 'app shell' });
    assert.equal(await walk(`document.querySelector('#home-title').textContent`), 'SUDOKU');
    assert.equal(await walk(`document.querySelectorAll('.cell').length`), 81);
  });

  await test('a single-player game starts and is fully playable', async () => {
    await click('[data-action="go-difficulty"]');
    await click('[data-action="new-game"][data-difficulty="hard"]');
    await waitFor(() => walk(`!document.querySelector('#screen-game').hidden`), { label: 'game screen' });
    const before = await walk(`document.querySelector('#game-timer').textContent`);
    const cell = await walk(`Array.from(document.querySelectorAll('.cell')).findIndex((c) => !c.textContent.trim())`);
    const solution = await walk(`(async () => {
      const m = await import('/js/storage.js');
      const g = await m.StorageManager.loadGame();
      return { value: g.solution[${cell}], difficulty: g.difficulty };
    })()`);
    await click(`.cell[data-index="${cell}"]`);
    await click(`.numpad button[data-value="${solution.value}"]`);
    assert.equal(
      await walk(`document.querySelector('.cell[data-index="${cell}"]').textContent`),
      String(solution.value),
      'the entered number rendered',
    );
    assert.equal(solution.difficulty, 'hard');
    await sleep(1200);
    const after = await walk(`document.querySelector('#game-timer').textContent`);
    const toSeconds = (value) => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
    assert.ok(toSeconds(after) > toSeconds(before), `timer advanced offline: ${before} → ${after}`);
  });

  await test('a missing sync backend never breaks the game', async () => {
    const status = await waitFor(
      async () => {
        const text = await walk(`document.querySelector('#sync-status').textContent.trim()`);
        return /Sync failed|safe|Saved on this device/i.test(text) ? text : false;
      },
      { timeout: 20000, label: 'sync failure surfaced in the status bar' },
    );
    assert.match(status, /safe|Sync failed|Saved/i);
    // The game is still running and editable after the sync failure.
    const cell = await walk(`Array.from(document.querySelectorAll('.cell')).findIndex((c) => !c.textContent.trim())`);
    assert.ok(cell >= 0, 'the board is still playable');
    const stillPlaying = await savedGame();
    assert.equal(stillPlaying.status, 'playing');
  });

  await test('refresh restores the game from local storage alone', async () => {
    const board = await walk(`Array.from(document.querySelectorAll('.cell')).map((c) => c.textContent).join('|')`);
    const sentinel = board;
    await send('Page.reload', {}, sessionId);
    await waitFor(() => walk(`document.readyState === 'complete'`), { label: 'reload' });
    await waitFor(() => walk(`!document.querySelector('#screen-game').hidden`), { label: 'game restored' });
    assert.equal(
      await walk(`Array.from(document.querySelectorAll('.cell')).map((c) => c.textContent).join('|')`),
      sentinel,
      'the same board came back with no server involved',
    );
  });

  await test('the multiplayer screen degrades gracefully when the server is absent', async () => {
    await walk(`location.hash = '#/multiplayer'`);
    await waitFor(() => walk(`!document.querySelector('#screen-multiplayer').hidden`), { label: 'multiplayer screen' });
    const state = await waitFor(
      async () => {
        const text = await walk(`document.querySelector('#mp-connection').textContent.trim()`);
        return /Disconnected|Reconnecting|Connecting|Offline|error/i.test(text) ? text : false;
      },
      { timeout: 20000, label: 'connection status reported' },
    );
    assert.match(state, /Disconnected|Reconnecting|Offline|Connecting/i);
    // And the core game still works afterwards.
    await click('[data-action="go-difficulty"]');
    await click('[data-action="new-game"][data-difficulty="easy"]');
    await waitFor(() => walk(`!document.querySelector('#screen-game').hidden`), { label: 'new game after failure' });
    assert.equal(await savedGame().then((g) => g.status), 'playing');
  });

  await test('no console errors beyond the expected unreachable-backend noise', () => {
    assert.deepEqual(consoleErrors, [], `browser reported errors:\n${consoleErrors.join('\n')}`);
  });
} catch (error) {
  failures.push({ name: 'suite', error });
  console.error('\nUnexpected failure:', error);
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (networkNoise.length) {
  console.log(`(filtered ${networkNoise.length} expected network-failure log entries: no /api, no /ws)`);
}
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure.name}: ${failure.error.message}`);
  process.exit(1);
}
process.exit(0);
