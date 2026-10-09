/**
 * tools/test-multiplayer.mjs — end-to-end verification of the multiplayer service.
 *
 * Boots server/server.js on a test port and drives real WebSocket clients:
 * room creation/joining, shared puzzle seed, progress relay, server-authoritative
 * completion times and winner, cheating rejection, disconnection/reconnection,
 * rematch, rate limiting and the sync API.
 *
 * Run: node tools/test-multiplayer.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generatePuzzle, validatePuzzle } from '../js/sudoku.js';
import { MP } from '../js/multiplayer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT) || 8791;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

let passed = 0;
const failures = [];
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

/* ------------------------------- test client ---------------------------- */

class TestClient {
  constructor(playerId, name) {
    this.playerId = playerId;
    this.name = name;
    this.messages = [];
    this.waiters = [];
  }

  connect() {
    this.socket = new WebSocket(WS_URL);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.playerId}: connect timeout`)), 5000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      this.socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        this.messages.push(message);
        for (const waiter of [...this.waiters]) {
          if (waiter.match(message)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(message);
          }
        }
      });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${this.playerId}: socket error`));
      });
    });
  }

  waitFor(type, { predicate = () => true, timeout = 5000 } = {}) {
    const existing = this.messages.find((message) => message.type === type && predicate(message));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        match: (message) => message.type === type && predicate(message),
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`${this.playerId}: timed out waiting for ${type}`));
        }, timeout),
      };
      this.waiters.push(waiter);
    });
  }

  clear() {
    this.messages = [];
  }

  send(message) {
    this.socket.send(JSON.stringify({ playerId: this.playerId, ...message }));
  }

  sendRaw(payload) {
    this.socket.send(JSON.stringify(payload));
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }
}

const clients = [];
function makeClient(playerId, name) {
  const client = new TestClient(playerId, name);
  clients.push(client);
  return client;
}

/** Board the server must accept: the solution derived from the shared seed. */
function solutionFromSeed(seed, difficulty) {
  return generatePuzzle(difficulty, seed).solution;
}

/* --------------------------------- server ------------------------------- */

const server = spawn(process.execPath, [join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (data) => process.env.VERBOSE && process.stdout.write(`[server] ${data}`));
server.stderr.on('data', (data) => process.stderr.write(`[server:err] ${data}`));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      /* not ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('server did not start');
}

function shutdown() {
  for (const client of clients) client.close();
  server.kill();
}

try {
  console.log('\nSERVER BOOT');
  const health = await waitForServer();
  console.log(`  · listening on ${BASE}`);

  await test('health endpoint responds with server info', () => {
    assert.equal(health.ok, true);
    assert.ok(typeof health.uptimeSeconds === 'number');
  });

  await test('static frontend is served (index.html, app.js, manifest, icons)', async () => {
    const index = await fetch(`${BASE}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.ok(html.includes('SUDOKU'), 'index.html contains the app shell');
    assert.ok((index.headers.get('content-type') || '').includes('text/html'));

    const appJs = await fetch(`${BASE}/app.js`);
    assert.ok((appJs.headers.get('content-type') || '').includes('javascript'));

    const manifestResponse = await fetch(`${BASE}/manifest.json`);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.display, 'standalone');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);

    const icon = await fetch(`${BASE}/assets/icon-192.png`);
    const bytes = new Uint8Array(await icon.arrayBuffer());
    assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47], 'icon is a real PNG');

    const sw = await fetch(`${BASE}/sw.js`);
    assert.match(sw.headers.get('cache-control') || '', /no-cache/, 'the service worker is never cached');
  });

  await test('path traversal and server sources are blocked', async () => {
    const traversal = await fetch(`${BASE}/assets/%2e%2e/package.json`);
    assert.equal(traversal.status, 403, 'encoded traversal must not reach package.json');
    const backend = await fetch(`${BASE}/server/server.js`);
    assert.equal(backend.status, 403, 'the backend source is not public');
    const tools = await fetch(`${BASE}/tools/test-sudoku.mjs`);
    assert.equal(tools.status, 403, 'the test suite is not public');
    const shell = await fetch(`${BASE}/js/game.js`);
    assert.equal(shell.status, 200, 'the app modules are public');
  });

  /* ---------------------------- room lifecycle -------------------------- */

  console.log('\nROOM LIFECYCLE');
  const alice = makeClient('alice-player-1', 'Alice');
  await alice.connect();

  await test('invalid playerId is rejected', async () => {
    const bad = makeClient('x!', 'Nope');
    await bad.connect();
    bad.sendRaw({ type: MP.CREATE_ROOM, playerId: 'x!', name: 'Nope' });
    const error = await bad.waitFor(MP.ERROR);
    assert.equal(error.code, 'INVALID_PLAYER');
    bad.close();
  });

  await test('joining a non-existent room returns ROOM_NOT_FOUND', async () => {
    const stranger = makeClient('stranger-player', 'Stranger');
    await stranger.connect();
    stranger.send({ type: MP.JOIN_ROOM, roomId: 'ZZZZZ' });
    const error = await stranger.waitFor(MP.ERROR);
    assert.equal(error.code, 'ROOM_NOT_FOUND');
    stranger.close();
  });

  let roomCode = null;
  await test('a player can create a room and gets a shareable code', async () => {
    alice.send({ type: MP.CREATE_ROOM, name: 'Alice', difficulty: 'medium' });
    const created = await alice.waitFor(MP.ROOM_CREATED);
    roomCode = created.room.code;
    assert.match(roomCode, /^[A-Z0-9]{5}$/, `unexpected room code ${roomCode}`);
    assert.equal(created.room.status, 'lobby');
    assert.equal(created.room.players.length, 1);
    assert.equal(created.room.players[0].id, 'alice-player-1');
    assert.equal(created.room.hostId, 'alice-player-1');
  });

  const bob = makeClient('bob-player-2', 'Bob');
  await bob.connect();

  await test('a second player can join; both see two players', async () => {
    bob.send({ type: MP.JOIN_ROOM, roomId: roomCode, name: 'Bob' });
    const state = await bob.waitFor(MP.ROOM_STATE);
    assert.equal(state.room.players.length, 2);
    const names = state.room.players.map((player) => player.name).sort();
    assert.deepEqual(names, ['Alice', 'Bob']);
    const joined = await alice.waitFor(MP.PLAYER_JOINED);
    assert.equal(joined.player.name, 'Bob');
    await alice.waitFor(MP.ROOM_STATE, { predicate: (message) => message.room.players.length === 2 });
  });

  await test('a third player is rejected with ROOM_FULL', async () => {
    const carol = makeClient('carol-player-3', 'Carol');
    await carol.connect();
    carol.send({ type: MP.JOIN_ROOM, roomId: roomCode, name: 'Carol' });
    const error = await carol.waitFor(MP.ERROR);
    assert.equal(error.code, 'ROOM_FULL');
    carol.close();
  });

  /* ------------------------------- the race ----------------------------- */

  console.log('\nRACE');
  alice.clear();
  bob.clear();

  await test('the race auto-starts when both players are ready', async () => {
    alice.send({ type: MP.PLAYER_READY, roomId: roomCode, ready: true });
    bob.send({ type: MP.PLAYER_READY, roomId: roomCode, ready: true });
    const startedForAlice = await alice.waitFor(MP.GAME_STARTED);
    const startedForBob = await bob.waitFor(MP.GAME_STARTED);
    assert.equal(startedForAlice.puzzleId, startedForBob.puzzleId, 'both players get the same puzzle id');
    assert.equal(startedForAlice.seed, startedForBob.seed, 'both players get the same seed');
    assert.equal(startedForAlice.difficulty, 'medium');
    assert.ok(startedForAlice.startedAt > 0, 'the server owns the official start time');
  });

  const startedForAlice = await alice.waitFor(MP.GAME_STARTED);
  const startedForBob = await bob.waitFor(MP.GAME_STARTED);

  await test('the shared seed yields an identical, uniquely solvable puzzle', () => {
    const derived = generatePuzzle(startedForAlice.difficulty, startedForAlice.seed);
    const validation = validatePuzzle(derived.puzzle, derived.solution);
    assert.equal(validation.valid, true, validation.reason);
    assert.match(startedForAlice.puzzleId, new RegExp(`^pz-${roomCode}-`));
    assert.equal(Number(startedForAlice.seed), derived.seed);
  });

  await test('progress events are relayed to the opponent only once', async () => {
    const empty = (await (async () => {
      const { puzzle } = generatePuzzle(startedForAlice.difficulty, startedForAlice.seed);
      return puzzle.findIndex((value) => value === 0);
    })());
    bob.clear();
    alice.clear();
    alice.send({ type: MP.PLAYER_PROGRESS, roomId: roomCode, cell: empty, value: 5, timestamp: Date.now() });
    const progress = await bob.waitFor(MP.PLAYER_PROGRESS);
    assert.equal(progress.cell, empty);
    assert.equal(progress.value, 5);
    assert.equal(progress.playerId, 'alice-player-1');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(alice.messages.filter((message) => message.type === MP.PLAYER_PROGRESS).length, 0, 'no echo');
  });

  await test('a clue cell cannot be overwritten through progress messages', async () => {
    const { puzzle } = generatePuzzle(startedForAlice.difficulty, startedForAlice.seed);
    const clueIndex = puzzle.findIndex((value) => value !== 0);
    bob.clear();
    alice.send({ type: MP.PLAYER_PROGRESS, roomId: roomCode, cell: clueIndex, value: 9 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(bob.messages.filter((message) => message.type === MP.PLAYER_PROGRESS).length, 0);
  });

  await test('the server decides the winner from its own completion timestamp', async () => {
    const solution = solutionFromSeed(startedForAlice.seed, startedForAlice.difficulty);
    alice.clear();
    bob.clear();
    alice.send({ type: MP.PLAYER_COMPLETED, roomId: roomCode, board: solution, clientTimestamp: 1 });
    const finishedForAlice = await alice.waitFor(MP.GAME_FINISHED);
    const finishedForBob = await bob.waitFor(MP.GAME_FINISHED);
    assert.equal(finishedForAlice.winnerId, 'alice-player-1');
    assert.equal(finishedForBob.winnerId, 'alice-player-1');
    const aliceResult = finishedForAlice.results.find((result) => result.playerId === 'alice-player-1');
    assert.equal(aliceResult.valid, true);
    assert.ok(aliceResult.elapsedMs >= 0 && aliceResult.elapsedMs < 60_000, 'server-measured elapsed time');
    assert.ok(aliceResult.completedAt >= startedForAlice.startedAt, 'completion is after the start');
  });

  await test('opponent completion is announced, and a late finish is still recorded', async () => {
    const completedNotice = await bob.waitFor(MP.PLAYER_COMPLETED);
    assert.equal(completedNotice.playerId, 'alice-player-1');
    const solution = solutionFromSeed(startedForAlice.seed, startedForAlice.difficulty);
    bob.clear();
    bob.send({ type: MP.PLAYER_COMPLETED, roomId: roomCode, board: solution });
    const finished = await bob.waitFor(MP.GAME_FINISHED, {
      predicate: (message) => message.results.some((result) => result.playerId === 'bob-player-2' && result.valid),
    });
    assert.equal(finished.winnerId, 'alice-player-1', 'the first valid finish keeps the win');
    const bobResult = finished.results.find((result) => result.playerId === 'bob-player-2');
    assert.ok(bobResult.elapsedMs >= 0);
    assert.ok(bobResult.elapsedMs >= finished.results.find((r) => r.playerId === 'alice-player-1').elapsedMs);
  });

  await test('a rematch starts with a brand new puzzle', async () => {
    alice.clear();
    bob.clear();
    alice.send({ type: MP.PLAYER_READY, roomId: roomCode, ready: true });
    bob.send({ type: MP.PLAYER_READY, roomId: roomCode, ready: true });
    const restarted = await alice.waitFor(MP.GAME_STARTED);
    assert.notEqual(restarted.puzzleId, startedForAlice.puzzleId, 'rematch must use a new puzzle');
    assert.notEqual(restarted.seed, startedForAlice.seed);
  });

  /* ------------------------------ anti-cheat ---------------------------- */

  console.log('\nSECURITY');
  const cheater = makeClient('cheater-one', 'Cheater');
  const honest = makeClient('honest-two', 'Honest');
  await cheater.connect();
  await honest.connect();

  let cheatRoom = null;
  let cheatStart = null;
  await test('a cheating client cannot declare itself the winner', async () => {
    cheater.send({ type: MP.CREATE_ROOM, name: 'Cheater', difficulty: 'easy' });
    const created = await cheater.waitFor(MP.ROOM_CREATED);
    cheatRoom = created.room.code;
    honest.send({ type: MP.JOIN_ROOM, roomId: cheatRoom, name: 'Honest' });
    await honest.waitFor(MP.ROOM_STATE, { predicate: (message) => message.room.players.length === 2 });
    cheater.send({ type: MP.PLAYER_READY, roomId: cheatRoom, ready: true });
    honest.send({ type: MP.PLAYER_READY, roomId: cheatRoom, ready: true });
    const started = await cheater.waitFor(MP.GAME_STARTED);
    cheatStart = started;
    cheater.clear();

    // Direct claim of victory — an unknown message type the server must refuse.
    cheater.sendRaw({ type: 'WINNER', playerId: 'cheater-one', winner: true, roomId: cheatRoom });
    const unknown = await cheater.waitFor(MP.ERROR, { predicate: (m) => m.code === 'UNKNOWN_TYPE' });
    assert.equal(unknown.code, 'UNKNOWN_TYPE');

    // A board that does not match the solution is rejected, and no result is issued.
    const wrongBoard = generatePuzzle('easy', started.seed + 1).solution;
    cheater.send({ type: MP.PLAYER_COMPLETED, roomId: cheatRoom, board: wrongBoard });
    const rejection = await cheater.waitFor(MP.ERROR, { predicate: (m) => m.code === 'INVALID_SOLUTION' });
    assert.equal(rejection.code, 'INVALID_SOLUTION');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(cheater.messages.filter((message) => message.type === MP.GAME_FINISHED).length, 0, 'no winner declared');
    assert.equal(honest.messages.filter((message) => message.type === MP.GAME_FINISHED).length, 0);
  });

  await test('a board with tampered clues is rejected', async () => {
    assert.ok(cheatStart, 'the cheat room started');
    const solution = solutionFromSeed(cheatStart.seed, cheatStart.difficulty);
    const tampered = solution.slice();
    const clueIndex = generatePuzzle(cheatStart.difficulty, cheatStart.seed).puzzle.findIndex((value) => value !== 0);
    tampered[clueIndex] = tampered[clueIndex] === 1 ? 2 : 1;
    cheater.clear();
    cheater.send({ type: MP.PLAYER_COMPLETED, roomId: cheatRoom, board: tampered });
    const rejection = await cheater.waitFor(MP.ERROR, { predicate: (m) => m.code === 'INVALID_SOLUTION' });
    assert.equal(rejection.code, 'INVALID_SOLUTION');
  });

  await test('sending progress for a room you are not in is ignored', async () => {
    const outsider = makeClient('outsider-player', 'Outsider');
    await outsider.connect();
    outsider.clear();
    outsider.send({ type: MP.PLAYER_PROGRESS, roomId: cheatRoom, cell: 0, value: 1 });
    const stateError = await outsider.waitFor(MP.ERROR, { predicate: (m) => m.code === 'NOT_IN_ROOM' });
    assert.equal(stateError.code, 'NOT_IN_ROOM');
    outsider.close();
  });

  /* ---------------------------- mistake limit --------------------------- */

  console.log('\nMISTAKE LIMIT');

  async function startRacePair(idA, idB, difficulty = 'easy') {
    const a = makeClient(idA, idA);
    const b = makeClient(idB, idB);
    await a.connect();
    await b.connect();
    a.send({ type: MP.CREATE_ROOM, name: idA, difficulty });
    const created = await a.waitFor(MP.ROOM_CREATED);
    b.send({ type: MP.JOIN_ROOM, roomId: created.room.code, name: idB });
    await b.waitFor(MP.ROOM_STATE, { predicate: (message) => message.room.players.length === 2 });
    a.clear();
    b.clear();
    a.send({ type: MP.PLAYER_READY, roomId: created.room.code, ready: true });
    b.send({ type: MP.PLAYER_READY, roomId: created.room.code, ready: true });
    const started = await a.waitFor(MP.GAME_STARTED);
    await b.waitFor(MP.GAME_STARTED);
    const derived = generatePuzzle(started.difficulty, started.seed);
    const empties = derived.puzzle.map((value, index) => (value === 0 ? index : -1)).filter((i) => i >= 0);
    return { a, b, code: created.room.code, started, solution: derived.solution, empties };
  }

  const wrongValue = (solution, cell) => (solution[cell] === 9 ? 1 : solution[cell] + 1);

  await test('a correct move never increases the mistake count', async () => {
    const { a, b, code, solution, empties } = await startRacePair('mk-ok-a', 'mk-ok-b');
    const cell = empties[0];
    a.send({ type: MP.PLAYER_MOVE, roomId: code, cell, value: solution[cell] });
    const result = await a.waitFor(MP.MOVE_RESULT, { predicate: (message) => message.cell === cell });
    assert.equal(result.accepted, true);
    assert.equal(result.correct, true);
    assert.equal(result.mistakes, 0);
    assert.equal(result.remainingMistakes, 3);
    assert.equal(result.correctValue, undefined, 'the solution is never sent to the client');
    a.close();
    b.close();
  });

  await test('three incorrect moves eliminate the player and hand the win to the opponent', async () => {
    const { a, b, code, solution, empties } = await startRacePair('mk-limit-a', 'mk-limit-b');
    for (let i = 0; i < 3; i++) {
      const cell = empties[i];
      a.clear();
      a.send({ type: MP.PLAYER_MOVE, roomId: code, cell, value: wrongValue(solution, cell) });
      const result = await a.waitFor(MP.MOVE_RESULT, { predicate: (message) => message.cell === cell });
      assert.equal(result.correct, false);
      assert.equal(result.mistakes, i + 1, `mistake ${i + 1} of 3`);
      assert.equal(result.remainingMistakes, 2 - i);
      assert.equal(result.correctValue, undefined, 'the right answer is never revealed');
    }
    const finishedForA = await a.waitFor(MP.GAME_FINISHED);
    const finishedForB = await b.waitFor(MP.GAME_FINISHED);
    assert.equal(finishedForA.winnerId, 'mk-limit-b', 'the opponent wins');
    assert.equal(finishedForA.loserId, 'mk-limit-a');
    assert.equal(finishedForA.resultReason, 'OPPONENT_MISTAKE_LIMIT');
    assert.equal(finishedForB.resultReason, 'OPPONENT_MISTAKE_LIMIT', 'both players get the result');
    const loser = finishedForA.results.find((result) => result.playerId === 'mk-limit-a');
    assert.equal(loser.eliminated, true);
    assert.equal(loser.mistakes, 3);

    // A post-game move from the eliminated player is refused.
    a.clear();
    const nextCell = empties[3];
    a.send({ type: MP.PLAYER_MOVE, roomId: code, cell: nextCell, value: solution[nextCell] });
    const rejected = await a.waitFor(MP.MOVE_RESULT, { predicate: (message) => message.accepted === false });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.mistakes, 3, 'the mistake count does not change after elimination');
    a.close();
    b.close();
  });

  await test('a client cannot manipulate its own mistake count', async () => {
    const { a, b, code, solution, empties } = await startRacePair('mk-cheat-a', 'mk-cheat-b');
    a.send({ type: MP.PLAYER_MOVE, roomId: code, cell: empties[0], value: wrongValue(solution, empties[0]) });
    const first = await a.waitFor(MP.MOVE_RESULT, { predicate: (message) => message.cell === empties[0] });
    assert.equal(first.mistakes, 1);

    // Claiming a clean slate has no effect: the server owns the counter.
    const cell = empties[1];
    a.send({
      type: MP.PLAYER_MOVE,
      roomId: code,
      cell,
      value: solution[cell],
      mistakes: 0,
      remainingMistakes: 3,
    });
    const result = await a.waitFor(MP.MOVE_RESULT, { predicate: (message) => message.cell === cell });
    assert.equal(result.correct, true);
    assert.equal(result.mistakes, 1, 'client-supplied mistakes are ignored');
    assert.equal(result.remainingMistakes, 2);
    a.close();
    b.close();
  });

  await test('mistakes survive a disconnect and reconnect', async () => {
    const { a, b, code, solution, empties } = await startRacePair('mk-recon-a', 'mk-recon-b');
    for (let i = 0; i < 2; i++) {
      const cell = empties[i];
      a.clear();
      a.send({ type: MP.PLAYER_MOVE, roomId: code, cell, value: wrongValue(solution, cell) });
      await a.waitFor(MP.MOVE_RESULT, { predicate: (message) => message.cell === cell });
    }
    a.close();
    await b.waitFor(MP.PLAYER_DISCONNECTED, { predicate: (message) => message.player.id === 'mk-recon-a' });

    const a2 = makeClient('mk-recon-a', 'mk-recon-a');
    await a2.connect();
    a2.send({ type: MP.JOIN_ROOM, roomId: code, name: 'mk-recon-a' });
    const state = await a2.waitFor(MP.ROOM_STATE, { predicate: (message) => Boolean(message.game) });
    const me = state.room.players.find((player) => player.id === 'mk-recon-a');
    assert.equal(me.mistakes, 2, 'the mistake count is preserved across the reconnect');
    assert.equal(me.maxMistakes, 3);
    assert.equal(state.game.status, 'playing', 'the race is still running');
    a2.close();
    b.close();
  });

  /* --------------------------- disconnections --------------------------- */

  console.log('\nDISCONNECTION HANDLING');

  await test('an opponent disconnect is reported and does not destroy the room', async () => {
    honest.clear();
    cheater.close();
    const notice = await honest.waitFor(MP.PLAYER_DISCONNECTED);
    assert.equal(notice.player.id, 'cheater-one');
    assert.equal(notice.player.connected, false);
  });

  await test('reconnecting restores the same player, puzzle and progress', async () => {
    const cheaterAgain = makeClient('cheater-one', 'Cheater');
    await cheaterAgain.connect();
    honest.clear();
    // Must be an editable cell: clue cells are immutable on the server too.
    const cheatPuzzle = generatePuzzle(cheatStart.difficulty, cheatStart.seed).puzzle;
    const editable = cheatPuzzle.findIndex((value) => value === 0);
    const bobProgress = { cell: editable, value: 4 };
    honest.send({ type: MP.PLAYER_PROGRESS, roomId: cheatRoom, ...bobProgress });
    cheaterAgain.send({ type: MP.JOIN_ROOM, roomId: cheatRoom, name: 'Cheater' });
    const state = await cheaterAgain.waitFor(MP.ROOM_STATE, { predicate: (message) => Boolean(message.game) });
    assert.equal(state.room.players.length, 2, 'the room kept both players');
    assert.equal(state.game.status, 'playing', 'the race is still running after a reconnect');
    assert.equal(state.game.seed, cheatStart.seed, 'the reconnecting player gets the same shared puzzle');
    assert.equal(state.game.puzzleId, cheatStart.puzzleId);
    const honestProgress = state.progress['honest-two'] || [];
    assert.ok(
      honestProgress.some((entry) => entry.cell === editable && entry.value === 4),
      'missed progress is replayed on rejoin',
    );
    const reconnected = await honest.waitFor(MP.PLAYER_RECONNECTED);
    assert.equal(reconnected.player.id, 'cheater-one');
    cheaterAgain.clear();
    cheaterAgain.close();
  });

  /* ------------------------------ sync API ------------------------------ */

  console.log('\nSYNC API');

  await test('sync records are accepted once and deduplicated by id', async () => {
    const record = {
      id: 'sync-test-1',
      type: 'stats',
      payload: { gamesPlayed: 5, gamesCompleted: 4, gamesFailed: 1, totalCompletedMs: 120_000, bestTimes: { easy: 90_000 } },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const first = await (await fetch(`${BASE}/api/sync`, { method: 'POST', body: JSON.stringify(record) })).json();
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    const second = await (await fetch(`${BASE}/api/sync`, { method: 'POST', body: JSON.stringify(record) })).json();
    assert.equal(second.duplicate, true, 'duplicate submissions are idempotent');
    assert.equal(second.stats.gamesPlayed, 5);
    assert.equal(second.stats.bestTimes.easy, 90_000);
  });

  await test('sync rejects payloads without an id', async () => {
    const response = await fetch(`${BASE}/api/sync`, { method: 'POST', body: JSON.stringify({ type: 'stats' }) });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
  });

  /* -------------------------- leaving the race -------------------------- */

  console.log('\nLEAVING');

  await test('leaving mid-race awards the win to the remaining player', async () => {
    const host = makeClient('host-player-a', 'Host');
    const guest = makeClient('guest-player-b', 'Guest');
    await host.connect();
    await guest.connect();
    host.send({ type: MP.CREATE_ROOM, name: 'Host', difficulty: 'hard' });
    const created = await host.waitFor(MP.ROOM_CREATED);
    guest.send({ type: MP.JOIN_ROOM, roomId: created.room.code, name: 'Guest' });
    await guest.waitFor(MP.ROOM_STATE, { predicate: (message) => message.room.players.length === 2 });
    host.send({ type: MP.PLAYER_READY, roomId: created.room.code, ready: true });
    guest.send({ type: MP.PLAYER_READY, roomId: created.room.code, ready: true });
    await host.waitFor(MP.GAME_STARTED);
    await guest.waitFor(MP.GAME_STARTED);
    host.clear();
    guest.send({ type: MP.LEAVE_ROOM, roomId: created.room.code });
    const finished = await host.waitFor(MP.GAME_FINISHED);
    assert.equal(finished.winnerId, 'host-player-a');
    assert.match(finished.reason, /left/i);
    host.close();
    guest.close();
  });

  await test('rate limiting protects the server from message floods', async () => {
    const flooder = makeClient('flooder-player', 'Flooder');
    await flooder.connect();
    for (let i = 0; i < 200; i++) flooder.send({ type: MP.PING, t: i });
    const limited = await flooder.waitFor(MP.ERROR, { predicate: (m) => m.code === 'RATE_LIMITED' });
    assert.equal(limited.code, 'RATE_LIMITED');
    flooder.close();
  });

  const finalHealth = await (await fetch(`${BASE}/api/health`)).json();
  await test('the server stays healthy after all of the above', () => {
    assert.equal(finalHealth.ok, true);
    assert.ok(finalHealth.rooms >= 0);
  });
} catch (error) {
  failures.push({ name: 'suite', error });
  console.error('\nUnexpected failure:', error);
} finally {
  shutdown();
  await new Promise((resolve) => setTimeout(resolve, 300));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure.name}: ${failure.error.message}`);
  process.exit(1);
}
process.exit(0);
