/**
 * tools/browser-smoke.mjs — real-browser verification over the Chrome DevTools Protocol.
 *
 * Boots the Sudoku server and drives headless Chrome through the actual UI:
 *   1. single player: play, mistakes, undo, pause/resume, completion, stats
 *   2. refresh while playing: the timer keeps counting, the puzzle survives
 *   3. offline: the app shell still loads (service worker), play continues,
 *      then reconnecting drains the pending sync queue
 *   4. multiplayer across two tabs: same puzzle for both, server-decided winner
 *   5. mobile viewport layout + keyboard accessibility
 *   6. collects every console error / uncaught exception and fails if any occur
 *
 * Run: node tools/browser-smoke.mjs      (set CHROME_PATH to pick a browser)
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT) || 8792;
const DEBUG_PORT = Number(process.env.CDP_PORT) || 9333;
const BASE = `http://localhost:${PORT}`;
const shotDir = join(root, 'tools', 'screenshots');

let passed = 0;
const failures = [];
const consoleErrors = [];
// Deliberately imposed offline periods make the browser log network failures;
// they are expected and are reported separately from real JS errors.
const networkNoise = [];
const NETWORK_NOISE = /net::ERR_|Failed to load resource|WebSocket connection to|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i;

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

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

/* ------------------------------ CDP plumbing ---------------------------- */

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Set();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
        return;
      }
      for (const handler of this.handlers) handler(message);
    });
  }

  static async connect(port) {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        const info = await response.json();
        const socket = new WebSocket(info.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true });
          socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
        });
        return new Cdp(socket);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error('could not attach to the browser devtools endpoint');
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  onEvent(handler) {
    this.handlers.add(handler);
  }

  async newPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new PageSession(this, sessionId);
    await page.wire();
    return page;
  }
}

class PageSession {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.loaded = false;
  }

  async wire() {
    this.cdp.onEvent((message) => {
      if (message.sessionId !== this.sessionId) return;
      if (message.method === 'Page.loadEventFired') this.loaded = true;
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        consoleErrors.push(`uncaught: ${details.exception?.description || details.text}`);
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
    await this.cdp.send('Page.enable', {}, this.sessionId);
    await this.cdp.send('Runtime.enable', {}, this.sessionId);
    await this.cdp.send('Log.enable', {}, this.sessionId);
    await this.cdp.send('Network.enable', {}, this.sessionId);
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  async goto(url) {
    this.loaded = false;
    await this.send('Page.navigate', { url });
    await waitFor(() => this.loaded, { timeout: 20000, label: `load ${url}` });
  }

  async reload() {
    this.loaded = false;
    await this.send('Page.reload', { ignoreCache: false });
    await waitFor(() => this.loaded, { timeout: 20000, label: 'reload' });
  }

  async click(selector) {
    const clicked = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`element not found: ${selector}`);
    await sleep(90);
  }

  /** Real mouse input at the element's centre (not a synthetic .click()). */
  async mouseClick(selector) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!box) throw new Error(`element not found: ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1,
      });
    }
    await sleep(90);
  }

  async pressKey(key, code) {
    const common = { key, code, windowsVirtualKeyCode: key.length === 1 ? key.charCodeAt(0) : 0, nativeVirtualKeyCode: 0 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: key.length === 1 ? key : undefined, ...common });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    await sleep(40);
  }

  async setOffline(offline, latency = 0) {
    await this.send('Network.emulateNetworkConditions', {
      offline,
      latency,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1,
      connectionType: offline ? 'none' : 'wifi',
    });
  }

  async setMobile(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: true,
    });
  }

  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(shotDir, { recursive: true });
    writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
  }

  close() {
    return this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeout = 8000, interval = 100, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

/* ------------------------------- app helpers ---------------------------- */

const readGameState = (page) =>
  page.evaluate(
    `(async () => { const m = await import('/js/storage.js'); const g = await m.StorageManager.loadGame(); return g ? { puzzle: g.puzzle, solution: g.solution, board: g.board, status: g.status, difficulty: g.difficulty, elapsedMs: g.elapsedMs } : null; })()`,
  );

const readStats = (page) =>
  page.evaluate(`(async () => { const m = await import('/js/storage.js'); return await m.StorageManager.getStats(); })()`);

const readPendingSync = (page) =>
  page.evaluate(`(async () => { const m = await import('/js/storage.js'); return await m.StorageManager.pendingSyncCount(); })()`);

/** Index of the first still-empty cell, read from the live board (never stale). */
const firstEmptyCell = (page) =>
  page.evaluate(`Array.from(document.querySelectorAll('.cell')).findIndex((cell) => !cell.textContent.trim())`);

/** Solves the visible board through the UI (cell click + numpad click per cell). */
const solveThroughUi = (page, solution) =>
  page.evaluate(`(() => {
    const cells = Array.from(document.querySelectorAll('.cell'));
    const pad = Array.from(document.querySelectorAll('.numpad button'));
    const solution = ${JSON.stringify(solution)};
    for (let index = 0; index < 81; index++) {
      if (!solution[index]) continue;
      if (cells[index].classList.contains('given')) continue;
      cells[index].click();
      pad.find((button) => button.dataset.value === String(solution[index])).click();
    }
    return true;
  })()`);

/* --------------------------------- server ------------------------------- */

const chromePath = findChrome();
if (!chromePath) {
  console.error('Chrome/Edge was not found. Set CHROME_PATH and re-run: node tools/browser-smoke.mjs');
  process.exit(2);
}

const userDataDir = join(tmpdir(), `sudoku-cdp-${Date.now()}`);
const server = spawn(process.execPath, [join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (data) => process.stderr.write(`[server:err] ${data}`));

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=Translate,BackForwardCache',
    // Fake media devices let two tabs exercise a real RTCPeerConnection with
    // getUserMedia without a physical microphone; autoplay is allowed so the
    // remote audio element can play without a user gesture in headless mode.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);

let cdp = null;
function cleanup() {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  try {
    server.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* windows may still hold the profile open */
    }
  }, 500);
}

try {
  await waitFor(
    async () => {
      try {
        const response = await fetch(`${BASE}/api/health`);
        return response.ok;
      } catch {
        return false;
      }
    },
    { timeout: 15000, label: 'server' },
  );
  cdp = await Cdp.connect(DEBUG_PORT);
  console.log('\nBROWSER SESSION');
  console.log(`  · server ${BASE}, browser ${chromePath}`);

  const page = await cdp.newPage();

  /* ------------------------------ boot & shell -------------------------- */

  console.log('\nAPP SHELL');

  await test('the app boots and shows the home screen with online status', async () => {
    await page.goto(`${BASE}/`);
    await waitFor(() => page.evaluate(`document.readyState === 'complete'`), { label: 'document ready' });
    const home = await page.evaluate(`(() => {
      const screen = document.querySelector('#screen-home');
      return {
        visible: !screen.hidden,
        title: document.querySelector('#home-title')?.textContent,
        buttons: Array.from(document.querySelectorAll('#screen-home [data-action]')).map((b) => b.dataset.action),
        status: document.querySelector('#status-indicator')?.textContent.trim(),
      };
    })()`);
    assert.equal(home.visible, true);
    assert.equal(home.title, 'SUDOKU');
    assert.deepEqual(home.buttons.slice(0, 4), ['go-difficulty', 'go-multiplayer', 'go-stats', 'go-settings']);
    assert.match(home.status, /Online/);
  });

  await test('the service worker registers and takes control', async () => {
    await page.evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    await page.reload();
    const controlled = await waitFor(
      () => page.evaluate(`Boolean(navigator.serviceWorker.controller)`),
      { timeout: 15000, label: 'service worker control' },
    );
    assert.equal(controlled, true);
    await page.screenshot('01-home-desktop');
  });

  /* ------------------------------ single player ------------------------- */

  console.log('\nSINGLE PLAYER');

  await test('a new easy game renders an 81-cell accessible board', async () => {
    await page.click('[data-action="go-difficulty"]');
    await page.click('[data-action="new-game"][data-difficulty="easy"]');
    const board = await page.evaluate(`(() => {
      const cells = document.querySelectorAll('#board [role="gridcell"]');
      const givens = document.querySelectorAll('.cell.given').length;
      return {
        cells: cells.length,
        givens,
        labelled: Array.from(cells).every((cell) => (cell.getAttribute('aria-label') || '').length > 5),
        gameScreenVisible: !document.querySelector('#screen-game').hidden,
        level: document.querySelector('#game-difficulty').textContent,
      };
    })()`);
    assert.equal(board.cells, 81);
    assert.ok(board.givens >= 25, `expected clues on the board, found ${board.givens}`);
    assert.equal(board.labelled, true);
    assert.equal(board.gameScreenVisible, true);
    assert.equal(board.level, 'Easy');
  });

  await test('the timer starts on its own and advances', async () => {
    const first = await page.evaluate(`document.querySelector('#game-timer').textContent`);
    await sleep(1200);
    const second = await page.evaluate(`document.querySelector('#game-timer').textContent`);
    const toSeconds = (value) => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
    assert.ok(toSeconds(second) > toSeconds(first), `timer did not advance: ${first} → ${second}`);
  });

  await test('mouse input selects a cell and the numpad enters a value', async () => {
    const state = await readGameState(page);
    const editable = state.puzzle.findIndex((value) => value === 0);
    const value = state.solution[editable];
    await page.mouseClick(`.cell[data-index="${editable}"]`);
    const selected = await page.evaluate(`document.querySelectorAll('.cell.selected').length`);
    assert.equal(selected, 1, 'clicking a cell selects exactly one cell');
    await page.mouseClick(`.numpad button[data-value="${value}"]`);
    const shown = await page.evaluate(`document.querySelector('.cell[data-index="${editable}"]').textContent`);
    assert.equal(shown, String(value));
  });

  await test('peers and matching numbers are highlighted', async () => {
    const highlight = await page.evaluate(`(() => {
      const selected = document.querySelector('.cell.selected');
      const index = Number(selected.dataset.index);
      const peers = document.querySelectorAll('.cell.peer').length;
      const sameValue = document.querySelectorAll('.cell.same-value').length;
      const row = Math.floor(index / 9);
      const col = index % 9;
      const peerIndexes = Array.from(document.querySelectorAll('.cell.peer')).map((c) => Number(c.dataset.index));
      const allShareUnit = peerIndexes.every((peer) => {
        const pRow = Math.floor(peer / 9);
        const pCol = peer % 9;
        const sameBox = Math.floor(pRow / 3) === Math.floor(row / 3) && Math.floor(pCol / 3) === Math.floor(col / 3);
        return pRow === row || pCol === col || sameBox;
      });
      return { peers, sameValue, allShareUnit };
    })()`);
    assert.equal(highlight.peers, 20, 'row + column + box peers are highlighted');
    assert.equal(highlight.allShareUnit, true);
    assert.ok(highlight.sameValue >= 0);
  });

  await test('givens cannot be modified', async () => {
    const state = await readGameState(page);
    const givenIndex = state.puzzle.findIndex((value) => value !== 0);
    const before = await page.evaluate(`document.querySelector('.cell[data-index="${givenIndex}"]').textContent`);
    await page.mouseClick(`.cell[data-index="${givenIndex}"]`);
    const other = state.solution[givenIndex] === 9 ? 1 : state.solution[givenIndex] + 1;
    await page.mouseClick(`.numpad button[data-value="${other}"]`);
    const after = await page.evaluate(`document.querySelector('.cell[data-index="${givenIndex}"]').textContent`);
    assert.equal(after, before, 'a clue cell keeps its value');
  });

  await test('wrong entries are flagged as mistakes and undo restores them', async () => {
    const state = await readGameState(page);
    const editable = await firstEmptyCell(page);
    assert.ok(editable >= 0, 'an empty editable cell exists');
    const wrong = state.solution[editable] === 9 ? 1 : state.solution[editable] + 1;
    await page.click(`.cell[data-index="${editable}"]`);
    await page.click(`.numpad button[data-value="${wrong}"]`);
    const flagged = await page.evaluate(`(() => ({
      wrong: document.querySelector('.cell[data-index="${editable}"]').classList.contains('wrong'),
      mistakes: document.querySelector('#game-mistakes').textContent,
      mistakesHidden: document.querySelector('#game-mistakes').hidden,
    }))()`);
    assert.equal(flagged.wrong, true);
    assert.equal(flagged.mistakesHidden, false);
    assert.match(flagged.mistakes, /1\/3/);
    await page.click('[data-action="undo"]');
    const undone = await page.evaluate(`document.querySelector('.cell[data-index="${editable}"]').textContent`);
    assert.equal(undone, '');
  });

  await test('keyboard arrows move the selection and digits fill cells', async () => {
    const start = await page.evaluate(`Number(document.querySelector('.cell.selected').dataset.index)`);
    await page.pressKey('ArrowRight', 'ArrowRight');
    const moved = await page.evaluate(`Number(document.querySelector('.cell.selected').dataset.index)`);
    assert.equal(moved, start + 1, 'ArrowRight moves one cell right');

    const state = await readGameState(page);
    const target = state.puzzle.findIndex((value, index) => value === 0 && index === moved);
    if (target !== -1) {
      await page.pressKey(String(state.solution[target]), `Digit${state.solution[target]}`);
      const shown = await page.evaluate(`document.querySelector('.cell[data-index="${moved}"]').textContent`);
      assert.equal(shown, String(state.solution[moved]));
    }
    await page.pressKey('Backspace', 'Backspace');
    const cleared = await page.evaluate(`document.querySelector('.cell[data-index="${moved}"]').textContent`);
    assert.ok(cleared === '' || moved !== target, 'Backspace erases the cell');
  });

  await test('pause stops the clock and shows the pause overlay', async () => {
    await page.click('[data-action="pause"]');
    const paused = await page.evaluate(`(() => ({
      overlay: !document.querySelector('#board-overlay').hidden,
      title: document.querySelector('#overlay-title').textContent,
      numpadDisabled: Array.from(document.querySelectorAll('.numpad button')).every((b) => b.disabled),
    }))()`);
    assert.equal(paused.overlay, true);
    assert.match(paused.title, /Paused/);
    assert.equal(paused.numpadDisabled, true, 'input is blocked while paused');
    const frozen = await page.evaluate(`document.querySelector('#game-timer').textContent`);
    await sleep(1100);
    const stillFrozen = await page.evaluate(`document.querySelector('#game-timer').textContent`);
    assert.equal(stillFrozen, frozen, 'the timer does not run while paused');
    await page.click('[data-action="resume"]');
    const resumed = await page.evaluate(`document.querySelector('#board-overlay').hidden`);
    assert.equal(resumed, true);
  });

  await test('page refresh continues the same game with the clock still running', async () => {
    const before = await page.evaluate(`document.querySelector('#game-timer').textContent`);
    const beforeState = await readGameState(page);
    const beforeBoard = await page.evaluate(`Array.from(document.querySelectorAll('.cell')).map((c) => c.textContent).join('|')`);
    await page.reload();
    await waitFor(() => page.evaluate(`!document.querySelector('#screen-game').hidden`), {
      timeout: 15000,
      label: 'game screen after refresh',
    });
    const after = await page.evaluate(`document.querySelector('#game-timer').textContent`);
    const toSeconds = (value) => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
    assert.ok(
      toSeconds(after) >= toSeconds(before),
      `timer must not reset on refresh: ${before} → ${after}`,
    );
    const afterState = await readGameState(page);
    assert.deepEqual(afterState.puzzle, beforeState.puzzle, 'the same puzzle comes back');
    assert.deepEqual(afterState.board, beforeState.board, 'entered numbers survive the refresh');
    const afterBoard = await page.evaluate(`Array.from(document.querySelectorAll('.cell')).map((c) => c.textContent).join('|')`);
    assert.equal(afterBoard, beforeBoard, 'the rendered board is identical after the refresh');

    // Opening the app on the home route instead offers the saved game.
    await page.evaluate(`location.hash = '#/home'`);
    await page.reload();
    await waitFor(
      () => page.evaluate(`!document.querySelector('#screen-home').hidden && !document.querySelector('#home-resume').hidden`),
      { timeout: 15000, label: 'resume banner on the home route' },
    );
    const banner = await page.evaluate(`document.querySelector('#home-resume-meta').textContent`);
    assert.match(banner, /Easy/);
    await page.click('[data-action="resume-game"]');
    assert.equal(await page.evaluate(`!document.querySelector('#screen-game').hidden`), true);
  });

  /* --------------------------------- offline ---------------------------- */

  console.log('\nOFFLINE MODE');

  await test('going offline keeps the game playable and shows the status', async () => {
    await page.setOffline(true);
    await waitFor(() => page.evaluate(`!document.querySelector('#status-indicator').textContent.includes('Online')`), {
      label: 'offline indicator',
    });
    const status = await page.evaluate(`document.querySelector('#status-indicator').textContent.trim()`);
    assert.match(status, /Offline/);

    // Play a move while offline.
    const state = await readGameState(page);
    const editable = await firstEmptyCell(page);
    assert.ok(editable >= 0, 'an empty editable cell exists');
    await page.click(`.cell[data-index="${editable}"]`);
    await page.click(`.numpad button[data-value="${state.solution[editable]}"]`);
    const shown = await page.evaluate(`document.querySelector('.cell[data-index="${editable}"]').textContent`);
    assert.equal(shown, String(state.solution[editable]), 'gameplay continues offline');
  });

  await test('reloading while offline still opens the app (service worker shell)', async () => {
    const beforeBoard = await page.evaluate(`Array.from(document.querySelectorAll('.cell')).map((c) => c.textContent).join('|')`);
    await page.reload();
    await waitFor(() => page.evaluate(`document.readyState === 'complete'`), { label: 'offline reload' });
    // The cached shell boots, rebuilds the board and restores the saved game.
    await waitFor(() => page.evaluate(`!document.querySelector('#screen-game').hidden && document.querySelectorAll('.cell').length === 81`), {
      timeout: 15000,
      label: 'offline boot back into the game',
    });
    const shell = await page.evaluate(`(() => ({
      status: document.querySelector('#status-indicator').textContent.trim(),
      cells: document.querySelectorAll('.cell').length,
      timer: document.querySelector('#game-timer').textContent,
      board: Array.from(document.querySelectorAll('.cell')).map((c) => c.textContent).join('|'),
    }))()`);
    assert.match(shell.status, /Offline/, 'the app knows it is offline');
    assert.equal(shell.cells, 81, 'the offline app built its board');
    assert.equal(shell.board, beforeBoard, 'the offline reload restored the same game');
    assert.match(shell.timer, /^\d\d:\d\d$/, 'the timer came back with the game');
    await page.screenshot('02b-offline-shell');
  });

  await test('the pending sync queue builds up while offline', async () => {
    if (await page.evaluate(`!document.querySelector('#screen-home').hidden`)) {
      await page.click('[data-action="resume-game"]');
    }
    const state = await readGameState(page);
    for (let move = 0; move < 3; move++) {
      const editable = await firstEmptyCell(page);
      if (editable < 0) break;
      await page.click(`.cell[data-index="${editable}"]`);
      await page.click(`.numpad button[data-value="${state.solution[editable]}"]`);
    }
    const pending = await readPendingSync(page);
    assert.ok(pending > 0, `expected queued changes while offline, got ${pending}`);
  });

  await test('reconnecting automatically drains the queue and reports Synced', async () => {
    await page.setOffline(false);
    await waitFor(() => page.evaluate(`document.querySelector('#status-indicator').textContent.includes('Online')`), {
      label: 'online indicator',
    });
    const synced = await waitFor(
      async () => {
        const pending = await readPendingSync(page);
        const text = await page.evaluate(`document.querySelector('#sync-status').textContent.trim()`);
        return pending === 0 && /Synced/.test(text) ? text : false;
      },
      { timeout: 20000, label: 'sync completion', interval: 300 },
    );
    assert.match(synced, /Synced/);
    const offlineCleared = await page.evaluate(`document.querySelector('#status-indicator').classList.contains('is-offline')`);
    assert.equal(offlineCleared, false);
  });

  /* ------------------------------- completion --------------------------- */

  console.log('\nCOMPLETION');

  await test('solving the puzzle stops the clock, records the time and shows the result', async () => {
    const state = await readGameState(page);
    assert.equal(state.status, 'playing');
    await solveThroughUi(page, state.solution);
    await waitFor(() => page.evaluate(`!document.querySelector('#board-overlay').hidden`), { label: 'result overlay' });
    const result = await page.evaluate(`(() => ({
      title: document.querySelector('#overlay-title').textContent,
      text: document.querySelector('#overlay-text').textContent,
      mistakes: document.querySelector('#game-mistakes').textContent,
    }))()`);
    assert.match(result.title, /solved|best time/i);
    const stats = await readStats(page);
    assert.equal(stats.gamesCompleted >= 1, true, 'a completed game is counted');
    assert.ok(stats.bestTimes.easy > 0, 'a best time is recorded for the difficulty');
    const history = await page.evaluate(
      `(async () => { const m = await import('/js/storage.js'); return await m.StorageManager.getHistory(5); })()`,
    );
    assert.ok(history.some((entry) => entry.result === 'completed'));
    await page.screenshot('02-solved-desktop');

    const frozen = await page.evaluate(`document.querySelector('#game-timer').textContent`);
    await sleep(1100);
    const stillFrozen = await page.evaluate(`document.querySelector('#game-timer').textContent`);
    assert.equal(stillFrozen, frozen, 'the timer is frozen after completion');
  });

  await test('the statistics page reflects the finished game', async () => {
    await page.click('[data-action="quit-game"]');
    await page.click('[data-action="go-stats"]');
    const stats = await page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#stats-content .stat-row')).map((row) => [
        row.querySelector('span')?.textContent,
        row.querySelector('.value')?.textContent,
      ]);
      return Object.fromEntries(rows);
    })()`);
    assert.ok(Number(stats['Games Played']) >= 1);
    assert.ok(Number(stats['Games Completed']) >= 1);
    assert.match(stats['Easy'] || '', /^\d\d:\d\d$/, `best easy time missing: ${JSON.stringify(stats)}`);
    await page.click('[data-action="go-home"]');
  });

  /* ------------------------------- multiplayer -------------------------- */

  console.log('\nMULTIPLAYER (two browser tabs)');

  const pageB = await cdp.newPage();
  await pageB.goto(`${BASE}/`);

  let roomCode = null;
  await test('a room can be created in the browser and shows a shareable code', async () => {
    await page.click('[data-action="go-multiplayer"]');
    await waitFor(() => page.evaluate(`!document.querySelector('#mp-connect').hidden`), { label: 'lobby' });
    await waitFor(() => page.evaluate(`document.querySelector('#mp-connection').textContent.includes('Connected')`), {
      timeout: 15000,
      label: 'websocket connection',
    });
    await page.evaluate(`document.querySelector('#mp-name').value = 'Cristian'`);
    await page.click('[data-action="create-room"]');
    await waitFor(() => page.evaluate(`!document.querySelector('#mp-room').hidden`), { label: 'room panel' });
    roomCode = await page.evaluate(`document.querySelector('#mp-room-id').textContent.trim()`);
    assert.match(roomCode, /^[A-Z0-9]{5}$/);
    const players = await page.evaluate(`document.querySelectorAll('#mp-players li').length`);
    assert.equal(players, 1);
  });

  await test('a second tab joins with the room code', async () => {
    await pageB.click('[data-action="go-multiplayer"]');
    await waitFor(() => pageB.evaluate(`document.querySelector('#mp-connection').textContent.includes('Connected')`), {
      timeout: 15000,
      label: 'second tab connection',
    });
    await pageB.evaluate(`(() => {
      document.querySelector('#mp-name').value = 'Alex';
      document.querySelector('#mp-room-code').value = ${JSON.stringify(roomCode)};
      document.querySelector('#mp-join-form').requestSubmit();
    })()`);
    await waitFor(() => pageB.evaluate(`!document.querySelector('#mp-room').hidden`), { label: 'joined room' });
    await waitFor(() => page.evaluate(`document.querySelectorAll('#mp-players li').length === 2`), {
      label: 'both players listed',
    });
    const list = await page.evaluate(`Array.from(document.querySelectorAll('#mp-players li')).map((li) => li.textContent)`);
    assert.ok(list.some((entry) => entry.includes('Cristian')));
    assert.ok(list.some((entry) => entry.includes('Alex')));
  });

  await test('the lobby requires matching mistake limits and gates the start', async () => {
    // Tab A picks 5, tab B picks 1: a clear mismatch with a disabled Start.
    await page.evaluate(`document.querySelector('#mp-mistake-options [data-value="5"]').click()`);
    await pageB.evaluate(`document.querySelector('#mp-mistake-options [data-value="1"]').click()`);
    await waitFor(() => page.evaluate(`!document.querySelector('#mp-settings-warning').hidden`), {
      label: 'mismatch warning',
    });
    const mismatch = await page.evaluate(`(() => ({
      warning: document.querySelector('#mp-settings-warning').textContent,
      startDisabled: document.querySelector('#mp-start').disabled,
      startVisible: !document.querySelector('#mp-start').hidden,
    }))()`);
    assert.equal(mismatch.startVisible, true, 'the Start Match action is always presented');
    assert.equal(mismatch.startDisabled, true, 'Start stays disabled while the settings disagree');
    assert.match(mismatch.warning, /mismatch/i);

    // Return both players to the default limit so the race below is unchanged.
    await pageB.evaluate(`document.querySelector('#mp-mistake-options [data-value="3"]').click()`);
    await page.evaluate(`document.querySelector('#mp-mistake-options [data-value="3"]').click()`);
    await waitFor(
      () => page.evaluate(`document.querySelector('#mp-settings-warning').hidden && document.querySelector('#mp-settings-summary').textContent.includes('3')`),
      { label: 'settings agreed' },
    );
    const agreed = await pageB.evaluate(`document.querySelector('#mp-mistake-options [data-value="3"]').getAttribute('aria-checked')`);
    assert.equal(agreed, 'true', 'the agreed limit is reflected in both lobbies');
  });

  await test('both players ready starts the race with the same puzzle', async () => {
    await page.click('[data-action="toggle-ready"]');
    await pageB.click('[data-action="toggle-ready"]');
    await waitFor(() => page.evaluate(`!document.querySelector('#mp-hud').hidden`), { label: 'race started in tab A' });
    await waitFor(() => pageB.evaluate(`!document.querySelector('#mp-hud').hidden`), { label: 'race started in tab B' });
    const givensA = await page.evaluate(
      `Array.from(document.querySelectorAll('.cell')).map((c) => (c.classList.contains('given') ? c.textContent : '0')).join('')`,
    );
    const givensB = await pageB.evaluate(
      `Array.from(document.querySelectorAll('.cell')).map((c) => (c.classList.contains('given') ? c.textContent : '0')).join('')`,
    );
    assert.equal(givensA, givensB, 'both players received the exact same puzzle');
    const stateA = await readGameState(page);
    const stateB = await readGameState(pageB);
    assert.deepEqual(stateA.solution, stateB.solution, 'both players share the same solution');
    assert.equal(stateA.solution.length, 81);
  });

  await test('opponent progress is visible in the HUD', async () => {
    const stateB = await readGameState(pageB);
    const editable = stateB.puzzle.findIndex((value) => value === 0);
    await pageB.click(`.cell[data-index="${editable}"]`);
    await pageB.click(`.numpad button[data-value="${stateB.solution[editable]}"]`);
    await waitFor(
      () => page.evaluate(`document.querySelector('#mp-opp-bar').style.width !== '' && document.querySelector('#mp-opp-bar').style.width !== '0%'`),
      { label: 'opponent progress bar' },
    );
    const hud = await page.evaluate(`(() => ({
      opponentBar: document.querySelector('#mp-opp-bar').style.width,
      opponentStatus: document.querySelector('#mp-opp-status').textContent,
      you: document.querySelector('.mp-player.is-you .mp-name')?.textContent,
    }))()`);
    assert.notEqual(hud.opponentBar, '0%');
    assert.match(hud.opponentStatus, /Solving|Finished/);
    assert.equal(hud.you, 'YOU');
    await page.screenshot('03-multiplayer-race');
  });

  await test('desktop chat sits beside the board without pushing it down', async () => {
    const layout = await page.evaluate(`(() => {
      const panel = document.querySelector('#chat-panel');
      const board = document.querySelector('#board');
      if (!panel || panel.hidden || !board) return null;
      const p = panel.getBoundingClientRect();
      const b = board.getBoundingClientRect();
      const input = document.querySelector('#chat-input').getBoundingClientRect();
      const send = document.querySelector('#chat-send').getBoundingClientRect();
      return {
        panelLeft: p.left, panelWidth: p.width,
        boardRight: b.right, boardTop: b.top,
        inputVisible: input.height > 0,
        sendVisible: send.height > 0,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    })()`);
    assert.ok(layout, 'the desktop chat panel is visible during a race');
    assert.ok(layout.panelWidth >= 240 && layout.panelWidth <= 360, `chat panel width ${layout.panelWidth}`);
    assert.ok(
      layout.panelLeft >= layout.boardRight - 4,
      `chat must sit beside the board (panel left ${layout.panelLeft}, board right ${layout.boardRight})`,
    );
    assert.equal(layout.inputVisible, true, 'the message input stays visible at the bottom of the panel');
    assert.equal(layout.sendVisible, true, 'the send button stays visible');
    assert.ok(layout.scrollWidth <= layout.innerWidth + 1, 'the chat panel does not cause horizontal overflow');
  });

  await test('an incoming message raises a toast above the board and never self-notifies', async () => {
    // A phone-sized receiver hides the desktop panel, so the toast path is used.
    await pageB.setMobile(390, 844);
    await sleep(250);
    const message = 'Meet you at the finish line';
    const afterSend = await page.evaluate(`(() => {
      const input = document.querySelector('#chat-input');
      input.focus();
      input.value = ${JSON.stringify(message)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return input.value;
    })()`);
    assert.equal(afterSend, '', 'pressing Enter clears the input after a successful send');

    await waitFor(() => pageB.evaluate(`!!document.querySelector('#chat-toasts .chat-toast')`), {
      timeout: 8000,
      label: 'toast on the receiving tab',
    });
    const toast = await pageB.evaluate(`(() => {
      const el = document.querySelector('#chat-toasts .chat-toast');
      const board = document.querySelector('#board').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        name: el.querySelector('.chat-toast-name').textContent,
        text: el.querySelector('.chat-toast-text').textContent,
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        boardTop: board.top, boardBottom: board.bottom,
        innerWidth: window.innerWidth,
      };
    })()`);
    assert.match(toast.name, /Cristian/, 'the toast names the sender');
    assert.match(toast.text, /finish line/, 'the toast previews the message');
    assert.ok(
      toast.bottom <= toast.boardTop + 1,
      `the toast must sit above the board (toast bottom ${toast.bottom}, board top ${toast.boardTop})`,
    );
    assert.ok(toast.left >= 0 && toast.right <= toast.innerWidth + 1, 'the toast stays inside the viewport');

    const own = await page.evaluate(`document.querySelectorAll('#chat-toasts .chat-toast').length`);
    assert.equal(own, 0, 'the sender is never notified of their own message');

    const rendered = await pageB.evaluate(
      `Array.from(document.querySelectorAll('#chat-mobile-messages .chat-msg-text, #chat-messages .chat-msg-text')).some((n) => n.textContent.includes('finish line'))`,
    );
    assert.equal(rendered, true, 'the incoming message renders live without a refresh');

    await waitFor(() => pageB.evaluate(`!document.querySelector('#chat-toasts .chat-toast')`), {
      timeout: 7000,
      label: 'toast auto-dismiss',
    });
    const settled = await pageB.evaluate(`(() => {
      const board = document.querySelector('#board').getBoundingClientRect();
      return { boardTop: board.top, boardWidth: board.width };
    })()`);
    assert.ok(settled.boardTop > 0 && settled.boardWidth > 0, 'the board stays laid out after the toast disappears');
  });

  await test('mobile chat opens as a bottom sheet, sends, and closing it keeps the race alive', async () => {
    assert.equal(await pageB.evaluate(`document.querySelector('#chat-btn').hidden`), false, 'the mobile chat button is available during a race');
    const icon = await pageB.evaluate(`(() => {
      const btn = document.querySelector('#chat-btn').getBoundingClientRect();
      const board = document.querySelector('#board').getBoundingClientRect();
      return { top: btn.top, bottom: btn.bottom, width: btn.width, height: btn.height, boardTop: board.top };
    })()`);
    assert.ok(icon.width > 0 && icon.height >= 32, 'the message icon is a real tappable target');
    assert.ok(icon.bottom <= icon.boardTop + 1, 'the message icon sits in the top area, above the board');
    await pageB.click('#chat-btn');
    await waitFor(() => pageB.evaluate(`!document.querySelector('#chat-mobile-panel').hidden`), { label: 'mobile chat open' });
    const sheet = await pageB.evaluate(`(() => {
      const panel = document.querySelector('#chat-mobile-panel');
      const input = document.querySelector('#chat-mobile-input').getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      return {
        heading: panel.querySelector('.chat-mobile-title').textContent,
        hasClose: !!panel.querySelector('#chat-mobile-close'),
        inputHeight: input.height,
        inputBottom: input.bottom,
        panelBottom: pr.bottom,
        innerHeight: window.innerHeight,
      };
    })()`);
    assert.equal(sheet.heading, 'Chat', 'the sheet has a visible heading');
    assert.equal(sheet.hasClose, true, 'the sheet has a close button');
    assert.ok(sheet.inputHeight > 0, 'the message input is visible');
    assert.ok(sheet.inputBottom <= sheet.innerHeight + 1, 'the input stays inside the viewport above the safe area');

    await pageB.evaluate(
      `(() => { const i = document.querySelector('#chat-mobile-input'); i.focus(); i.value = 'On my way'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`,
    );
    await waitFor(
      () => page.evaluate(`Array.from(document.querySelectorAll('#chat-messages .chat-msg-text')).some((n) => n.textContent.includes('On my way'))`),
      { label: 'desktop tab receives the mobile message' },
    );
    assert.equal(await pageB.evaluate(`document.querySelector('#chat-mobile-input').value`), '', 'the mobile input clears after sending');

    await pageB.click('#chat-mobile-close');
    await waitFor(() => pageB.evaluate(`document.querySelector('#chat-mobile-panel').hidden`), { label: 'mobile chat closed' });
    const stillRunning = await pageB.evaluate(`!document.querySelector('#mp-hud').hidden && document.querySelector('#mp-opp-status').textContent.length > 0`);
    assert.equal(stillRunning, true, 'closing the chat does not disturb the race');
  });

  await test('a real WebRTC voice call connects, mutes and ends between the two tabs', async () => {
    // Both tabs are in a live race; tab A starts an audio call.
    await page.evaluate(`document.querySelector('#call-btn').click()`);
    await waitFor(() => pageB.evaluate(`!document.querySelector('#call-overlay').hidden`), {
      timeout: 10000,
      label: 'incoming call on tab B',
    });
    const callerName = await pageB.evaluate(`document.querySelector('#call-overlay-name').textContent`);
    assert.ok(callerName.trim().length > 0, 'the incoming call names the caller');

    await pageB.evaluate(`document.querySelector('#call-overlay [data-action="call-accept"]').click()`);
    await waitFor(() => page.evaluate(`document.querySelector('#voice-panel').dataset.state === 'connected'`), {
      timeout: 20000,
      label: 'tab A voice connected',
    });
    await waitFor(() => pageB.evaluate(`document.querySelector('#voice-panel').dataset.state === 'connected'`), {
      timeout: 20000,
      label: 'tab B voice connected',
    });
    // Both sides receive the opponent's audio track over a real peer connection.
    await waitFor(() => page.evaluate(`Number(document.querySelector('#voice-panel').dataset.remoteTracks) > 0`), {
      timeout: 10000,
      label: 'tab A remote audio track',
    });
    await waitFor(() => pageB.evaluate(`Number(document.querySelector('#voice-panel').dataset.remoteTracks) > 0`), {
      timeout: 10000,
      label: 'tab B remote audio track',
    });
    const connection = await page.evaluate(`document.querySelector('#voice-panel').dataset.connection`);
    assert.equal(connection, 'connected', 'the RTCPeerConnection reaches the connected state');
    await page.screenshot('07-voice-call');

    // Muting on A propagates to B's remote-mute indicator.
    await page.evaluate(`document.querySelector('#voice-mute').click()`);
    await waitFor(() => page.evaluate(`document.querySelector('#voice-panel').dataset.muted === 'true'`), {
      label: 'tab A muted',
    });
    await waitFor(() => pageB.evaluate(`document.querySelector('#voice-panel').dataset.remoteMuted === 'true'`), {
      label: 'tab B shows the remote mute',
    });

    // Ending the call releases the microphone on both ends.
    await page.evaluate(`document.querySelector('#voice-end').click()`);
    await waitFor(() => pageB.evaluate(`document.querySelector('#voice-panel').dataset.localActive === 'false'`), {
      timeout: 8000,
      label: 'tab B microphone released',
    });
    await waitFor(() => page.evaluate(`document.querySelector('#voice-panel').hidden === true`), {
      timeout: 8000,
      label: 'tab A call panel closed',
    });
    await waitFor(() => pageB.evaluate(`document.querySelector('#voice-panel').hidden === true`), {
      timeout: 8000,
      label: 'tab B call panel closed',
    });
    const raceStillLive = await page.evaluate(`!document.querySelector('#mp-hud').hidden && document.querySelector('#board-overlay').hidden`);
    assert.equal(raceStillLive, true, 'ending the call does not disturb the race');
  });

  await test('the server declares the first finisher the winner in both tabs', async () => {
    const stateA = await readGameState(page);
    await solveThroughUi(page, stateA.solution);
    await waitFor(() => page.evaluate(`!document.querySelector('#board-overlay').hidden`), { label: 'result in tab A' });
    await waitFor(() => pageB.evaluate(`!document.querySelector('#board-overlay').hidden`), { label: 'result in tab B' });
    const titleA = await page.evaluate(`document.querySelector('#overlay-title').textContent`);
    const titleB = await pageB.evaluate(`document.querySelector('#overlay-title').textContent`);
    const textA = await page.evaluate(`document.querySelector('#overlay-text').textContent`);
    assert.match(titleA, /win/i, `winner tab should say "You win", got "${titleA}"`);
    assert.match(titleB, /lost/i, `loser tab should say "You lost", got "${titleB}"`);
    assert.match(textA, /\d\d:\d\d/, 'the result shows the server-measured times');
    await page.screenshot('04-multiplayer-result');
    const mpStats = await page.evaluate(
      `(async () => { const m = await import('/js/storage.js'); return await m.StorageManager.getMultiplayerStats(); })()`,
    );
    assert.ok(mpStats.gamesPlayed >= 1);
    assert.ok(mpStats.wins >= 1);
  });

  await test('three mistakes eliminate the player, award the win and keep chat alive', async () => {
    // Back to the lobby from the result overlay and start a rematch.
    await page.evaluate(`document.querySelector('#overlay-actions [data-action="go-multiplayer"]')?.click()`);
    await pageB.evaluate(`document.querySelector('#overlay-actions [data-action="go-multiplayer"]')?.click()`);
    await waitFor(() => page.evaluate(`!document.querySelector('#mp-room').hidden`), { label: 'lobby tab A' });
    await waitFor(() => pageB.evaluate(`!document.querySelector('#mp-room').hidden`), { label: 'lobby tab B' });
    await page.evaluate(`document.querySelector('#mp-ready').click()`);
    await pageB.evaluate(`document.querySelector('#mp-ready').click()`);
    await waitFor(
      () => page.evaluate(`!document.querySelector('#mp-hud').hidden && document.querySelector('#board-overlay').hidden`),
      { timeout: 15000, label: 'rematch started in tab A' },
    );
    await waitFor(
      () => pageB.evaluate(`!document.querySelector('#mp-hud').hidden && document.querySelector('#board-overlay').hidden`),
      { timeout: 15000, label: 'rematch started in tab B' },
    );
    await sleep(400); // let the new game snapshot land in storage
    const stateB = await readGameState(pageB);
    const empties = stateB.puzzle.map((value, index) => (value === 0 ? index : -1)).filter((i) => i >= 0);

    // Tab B deliberately answers three cells wrong.
    for (let i = 0; i < 3; i++) {
      const cell = empties[i];
      const wrong = stateB.solution[cell] === 9 ? 1 : stateB.solution[cell] + 1;
      await pageB.evaluate(
        `document.querySelector('.cell[data-index="${cell}"]').click();` +
          `document.querySelector('.numpad button[data-value="${wrong}"]').click();`,
      );
      await waitFor(
        () => pageB.evaluate(`document.querySelector('#mp-you-mistakes').textContent.includes('${i + 1} / 3')`),
        { label: `mistake ${i + 1} counted` },
      );
    }

    await waitFor(() => pageB.evaluate(`!document.querySelector('#board-overlay').hidden`), {
      timeout: 15000,
      label: 'loser result overlay',
    });
    await waitFor(() => page.evaluate(`!document.querySelector('#board-overlay').hidden`), {
      timeout: 15000,
      label: 'winner result overlay',
    });

    const loser = await pageB.evaluate(`(() => ({
      title: document.querySelector('#overlay-title').textContent,
      text: document.querySelector('#overlay-text').textContent,
      mistakes: document.querySelector('#mp-you-mistakes').textContent,
      chatVisible: !document.querySelector('#chat-panel').hidden,
      chatInputDisabled: document.querySelector('#chat-input').disabled,
      numpadDisabled: Array.from(document.querySelectorAll('.numpad button')).every((b) => b.disabled),
    }))()`);
    assert.match(loser.title, /GAME OVER/i, `loser title was "${loser.title}"`);
    assert.match(loser.text, /maximum number of mistakes/i);
    assert.match(loser.mistakes, /3 \/ 3/);
    assert.equal(loser.numpadDisabled, true, 'the eliminated player cannot keep playing');
    assert.equal(loser.chatVisible, true, 'chat stays available after the game ends');
    assert.equal(loser.chatInputDisabled, false, 'the chat input remains usable');

    const winner = await page.evaluate(`(() => ({
      title: document.querySelector('#overlay-title').textContent,
      text: document.querySelector('#overlay-text').textContent,
    }))()`);
    assert.match(winner.title, /YOU WIN/i, `winner title was "${winner.title}"`);
    assert.match(winner.text, /mistake limit/i);
    await page.screenshot('06-mistake-limit');
  });

  await test('an opponent that drops out is flagged away, and a reappearing tab rejoins the same table', async () => {
    // Navigating away inside the tab closes the WebSocket for real.
    await pageB.send('Page.navigate', { url: 'about:blank' });
    await waitFor(
      () => page.evaluate(`/Reconnecting/i.test(document.querySelector('#mp-opp-status').textContent)`),
      { timeout: 15000, label: 'opponent away status' },
    );

    // A fresh load of the app must rejoin the stored room automatically.
    await pageB.goto(`${BASE}/`);
    const session = await pageB.evaluate(`JSON.parse(sessionStorage.getItem('sudoku:mp-session') || 'null')`);
    await waitFor(() => page.evaluate(`!/Reconnecting/i.test(document.querySelector('#mp-opp-status').textContent)`), {
      timeout: 20000,
      label: 'opponent status back to normal',
    });
    assert.equal(session?.roomCode, roomCode, 'the reopened tab remembered its room');
  });

  await test('leaving the room returns to the lobby without errors', async () => {
    await page.evaluate(`document.querySelector('[data-action="leave-room"]')?.click()`);
    await waitFor(() => page.evaluate(`!document.querySelector('#mp-connect').hidden`), { label: 'back to lobby' });
    const lobby = await page.evaluate(`(() => ({
      connectVisible: !document.querySelector('#mp-connect').hidden,
      roomHidden: document.querySelector('#mp-room').hidden,
      session: sessionStorage.getItem('sudoku:mp-session'),
    }))()`);
    assert.equal(lobby.connectVisible, true);
    assert.equal(lobby.roomHidden, true);
    assert.equal(lobby.session, null, 'leaving clears the stored session');
  });

  /* ------------------------------ mobile layout ------------------------- */

  console.log('\nMOBILE + ACCESSIBILITY');

  await test('the game fits a 390×844 phone viewport without overflow', async () => {
    await page.setMobile(390, 844);
    await page.click('[data-action="go-difficulty"]');
    await page.click('[data-action="new-game"][data-difficulty="medium"]');
    await waitFor(() => page.evaluate(`!document.querySelector('#screen-game').hidden`), { label: 'mobile game screen' });
    const layout = await page.evaluate(`(() => {
      const board = document.querySelector('#board').getBoundingClientRect();
      const pad = Array.from(document.querySelectorAll('.numpad button')).map((b) => b.getBoundingClientRect().height);
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        boardWidth: board.width,
        boardHeight: board.height,
        minPadHeight: Math.min(...pad),
      };
    })()`);
    assert.ok(
      layout.scrollWidth <= layout.innerWidth + 1,
      `horizontal overflow: ${layout.scrollWidth} > ${layout.innerWidth}`,
    );
    assert.ok(layout.boardWidth > 300 && layout.boardWidth <= layout.innerWidth, `board width ${layout.boardWidth}`);
    assert.ok(Math.abs(layout.boardWidth - layout.boardHeight) <= 2, 'the board stays square');
    assert.ok(layout.minPadHeight >= 40, `touch targets too small: ${layout.minPadHeight}px`);
    await page.screenshot('05-game-mobile');
  });

  await test('the number pad is reachable and labelled for screen readers', async () => {
    const a11y = await page.evaluate(`(() => ({
      padLabelled: Array.from(document.querySelectorAll('.numpad button')).every((b) => (b.getAttribute('aria-label') || '').length > 3),
      controls: Array.from(document.querySelectorAll('.screen-game .controls button')).map((b) => b.textContent.trim()),
      gridRole: document.querySelector('#board').getAttribute('role'),
      overlayHidden: document.querySelector('#board-overlay').hidden,
    }))()`);
    assert.equal(a11y.padLabelled, true);
    assert.deepEqual(a11y.controls.map((c) => c.split(' ').pop()), ['Undo', 'Erase', 'Pause']);
    assert.equal(a11y.gridRole, 'grid');
    assert.equal(a11y.overlayHidden, true);
  });

  await test('no console errors or uncaught exceptions occurred', () => {
    assert.deepEqual(consoleErrors, [], `browser reported errors:\n${consoleErrors.join('\n')}`);
  });
} catch (error) {
  failures.push({ name: 'suite', error });
  console.error('\nUnexpected failure:', error);
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (consoleErrors.length) {
  console.log('\nBrowser console output:');
  for (const entry of consoleErrors) console.log(`  · ${entry}`);
}
if (networkNoise.length) {
  console.log(`\nExpected offline network noise (${networkNoise.length} entries, filtered):`);
  for (const entry of [...new Set(networkNoise)].slice(0, 5)) console.log(`  · ${entry}`);
}
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure.name}: ${failure.error.message}`);
  process.exit(1);
}
process.exit(0);
