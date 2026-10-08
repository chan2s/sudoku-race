/**
 * server/server.js — authoritative multiplayer service + static host + sync API.
 *
 * Responsibilities
 *  - Serve the Sudoku frontend (so `npm start` runs the whole thing locally).
 *  - Own every competitive fact: room membership, the shared puzzle seed, the
 *    official start time, validated completion times and the winner.
 *  - Accept offline sync records at POST /api/sync (idempotent by record id).
 *
 * The server re-uses the frontend's pure logic modules (js/sudoku.js for
 * generation/validation and js/multiplayer.js for the message vocabulary) so
 * the puzzle a player sees cannot drift from the puzzle the server validates.
 *
 * Run: npm install && npm start   (inside server/)
 */

import http from 'node:http';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { generatePuzzle, isValidSolution } from '../js/sudoku.js';
import { MP } from '../js/multiplayer.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number(process.env.PORT) || 8787;

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable characters
const ROOM_TTL_MS = 15 * 60 * 1000;
const DISCONNECT_GRACE_MS = 3 * 60 * 1000;
// How long a mid-race disconnected player may come back before the server
// awards the race to their opponent. Overridable for tests only; production
// default is the specified 10 minutes.
const RECONNECT_TIMEOUT_MS = Number(process.env.RECONNECT_TIMEOUT_MS) || 10 * 60 * 1000;
// How often the deadline sweeper re-checks every room. The per-player timeout
// is the prompt path; this sweep is the recovery path so the rule still fires
// if a timer was lost (event-loop stall, restart-restore, timer drift).
const ABANDONMENT_SWEEP_MS = Number(process.env.ABANDONMENT_SWEEP_MS) || 5000;
// Where room state is persisted so deadlines survive a server restart.
const ROOMS_FILE = process.env.ROOMS_FILE || join(HERE, 'data', 'rooms.json');
const PERSIST_DEBOUNCE_MS = 250;
const MAX_ROOM_PLAYERS = 2;
const MAX_MESSAGES_PER_WINDOW = 120;
const RATE_WINDOW_MS = 1000;
const MAX_SYNC_RECORDS = 5000;

/** Result vocabulary — `resultReason` travels with every finished race. */
const RESULT_REASONS = {
  PUZZLE_COMPLETED: 'PUZZLE_COMPLETED',
  OPPONENT_ABANDONED: 'OPPONENT_ABANDONED',
  PLAYER_ABANDONED: 'PLAYER_ABANDONED',
  DRAW: 'DRAW',
  SERVER_CANCELLED: 'SERVER_CANCELLED',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* ------------------------------- helpers -------------------------------- */

function now() {
  return Date.now();
}

function makeRoomCode(existing) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!existing.has(code)) return code;
  }
  throw new Error('could not allocate a room code');
}

function sanitizeName(name) {
  const clean = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 18);
  return clean || 'Player';
}

function isValidPlayerId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(id);
}

function send(socket, message) {
  if (!socket || socket.readyState !== socket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error('[server] send failed', error.message);
    return false;
  }
}

/* --------------------------------- rooms -------------------------------- */

/** roomId → room */
const rooms = new Map();

/* ----------------------------- persistence ------------------------------ */
/*
 * Room state (including every player's disconnectedAt / reconnectDeadline) is
 * mirrored to disk so the abandonment rule survives a restart: on boot the
 * stored deadlines are re-armed and anything that expired while the process
 * was down is finalised by the first sweep. Only the WebSocket handles are
 * transient — every competitive fact is in the file.
 */

let persistTimer = null;
let persisting = false;

function serializeRoom(room) {
  return {
    id: room.id,
    code: room.code,
    difficulty: room.difficulty,
    clues: room.clues,
    seed: room.seed,
    puzzleId: room.puzzleId,
    solution: room.solution,
    puzzle: room.puzzle,
    hostId: room.hostId,
    status: room.status,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    startedAt: room.startedAt,
    finishedAt: room.finishedAt,
    winnerId: room.winnerId,
    finishReason: room.finishReason,
    resultReason: room.resultReason,
    abandonedPlayerId: room.abandonedPlayerId,
    results: room.results,
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      ready: player.ready,
      connected: player.connected,
      completed: player.completed,
      completedAt: player.completedAt,
      elapsedMs: player.elapsedMs,
      disconnectedAt: player.disconnectedAt,
      reconnectDeadline: player.reconnectDeadline,
      progress: Array.from(player.progress.entries()),
    })),
  };
}

function serializeRooms() {
  return JSON.stringify({ savedAt: now(), rooms: Array.from(rooms.values()).map(serializeRoom) });
}

async function persistRooms() {
  if (persisting) return;
  persisting = true;
  try {
    await mkdir(dirname(ROOMS_FILE), { recursive: true });
    const payload = serializeRooms();
    // Write-then-rename so a crash mid-write cannot corrupt the previous state.
    const tmp = `${ROOMS_FILE}.tmp`;
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, ROOMS_FILE);
  } catch (error) {
    console.warn('[server] could not persist room state', error.message);
  } finally {
    persisting = false;
  }
}

/** Debounced persist for high-frequency paths. */
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistRooms();
  }, PERSIST_DEBOUNCE_MS);
  if (persistTimer.unref) persistTimer.unref();
}

/** Synchronous persist for shutdown paths. */
function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    mkdirSync(dirname(ROOMS_FILE), { recursive: true });
    writeFileSync(ROOMS_FILE, serializeRooms(), 'utf8');
  } catch (error) {
    console.warn('[server] could not flush room state', error.message);
  }
}

/** Rebuilds live room objects from disk and re-arms every stored deadline. */
async function loadRooms() {
  if (!existsSync(ROOMS_FILE)) return;
  let raw;
  try {
    raw = await readFile(ROOMS_FILE, 'utf8');
  } catch (error) {
    console.warn('[server] could not read persisted room state', error.message);
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.warn('[server] persisted room state is corrupt — starting clean', error.message);
    return;
  }
  const boot = now();
  for (const stored of data.rooms || []) {
    try {
      const room = {
        ...stored,
        players: new Map(),
      };
      for (const storedPlayer of stored.players || []) {
        const player = {
          ...storedPlayer,
          progress: new Map(storedPlayer.progress || []),
          socket: null,
          disconnectTimer: null,
        };
        if (player.connected) {
          // The socket is gone after a restart: everyone gets a fresh window,
          // except players who were already mid-window when state was saved —
          // their stored deadline carries over untouched.
          player.connected = false;
          if (!player.reconnectDeadline) {
            player.disconnectedAt = boot;
            player.reconnectDeadline = boot + RECONNECT_TIMEOUT_MS;
          }
        }
        room.players.set(player.id, player);
      }
      rooms.set(room.id, room);
    } catch (error) {
      console.warn(`[server] could not restore room ${stored.id}`, error.message);
    }
  }
  // Finalise anything that expired while the server was down. The sweep keeps
  // running afterwards; this pass just closes the gap immediately.
  for (const room of rooms.values()) {
    for (const player of room.players.values()) {
      checkAbandonment(room, player);
    }
  }
  if (rooms.size) {
    console.log(`[server] restored ${rooms.size} room(s) from disk`);
    persistRooms();
  }
}

function createRoom(playerId, name, difficulty) {
  const code = makeRoomCode(rooms);
  const { puzzle, solution, difficulty: level, seed, clues } = generatePuzzle(difficulty);
  const room = {
    id: code,
    code,
    difficulty: level,
    clues,
    seed,
    puzzleId: `pz-${code}-${seed.toString(36)}`,
    solution,
    puzzle,
    hostId: playerId,
    status: 'lobby', // lobby | playing | finished
    createdAt: now(),
    lastActivity: now(),
    startedAt: null,
    finishedAt: null,
    winnerId: null,
    finishReason: null,
    resultReason: null,
    abandonedPlayerId: null,
    results: null,
    players: new Map(),
  };
  rooms.set(code, room);
  schedulePersist();
  return room;
}

function addPlayer(room, { id, name, socket }) {
  const player = {
    id,
    name: sanitizeName(name),
    ready: false,
    connected: true,
    completed: false,
    completedAt: null,
    elapsedMs: null,
    disconnectedAt: null,
    reconnectDeadline: null,
    disconnectTimer: null,
    progress: new Map(),
    socket,
  };
  room.players.set(id, player);
  room.lastActivity = now();
  schedulePersist();
  return player;
}

function roomSnapshot(room) {
  return {
    id: room.id,
    code: room.code,
    difficulty: room.difficulty,
    clues: room.clues,
    hostId: room.hostId,
    status: room.status,
    createdAt: room.createdAt,
    puzzleId: room.puzzleId,
    seed: room.seed,
    startedAt: room.startedAt,
    winnerId: room.winnerId,
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      ready: player.ready,
      connected: player.connected,
      completed: player.completed,
      elapsedMs: player.elapsedMs,
      disconnectedAt: player.disconnectedAt,
      reconnectDeadline: player.reconnectDeadline,
    })),
  };
}

function progressSnapshot(room) {
  const snapshot = {};
  for (const player of room.players.values()) {
    snapshot[player.id] = Array.from(player.progress.entries()).map(([cell, value]) => ({ cell, value }));
  }
  return snapshot;
}

/** Adds the stored verdict so a rejoin after the race shows the real result. */
function resultSnapshot(room) {
  if (room.status !== 'finished' || !room.results) return {};
  return {
    results: room.results,
    reason: room.finishReason || 'Race finished',
    resultReason: room.resultReason || RESULT_REASONS.PUZZLE_COMPLETED,
    abandonedPlayerId: room.abandonedPlayerId ?? null,
    finishedAt: room.finishedAt,
  };
}

function gameSnapshot(room) {
  return {
    roomId: room.id,
    puzzleId: room.puzzleId,
    seed: room.seed,
    difficulty: room.difficulty,
    startedAt: room.startedAt,
    status: room.status,
  };
}

function broadcast(room, message, exceptPlayerId = null) {
  for (const player of room.players.values()) {
    if (exceptPlayerId && player.id === exceptPlayerId) continue;
    send(player.socket, message);
  }
}

function broadcastRoomState(room) {
  const state = { type: MP.ROOM_STATE, room: roomSnapshot(room) };
  broadcast(room, state);
}

/** Returns a finished room to the lobby so both players can race again. */
function resetForRematch(room) {
  room.status = 'lobby';
  room.winnerId = null;
  room.results = null;
  room.finishReason = null;
  room.resultReason = null;
  room.abandonedPlayerId = null;
  room.finishedAt = null;
  room.startedAt = null;
  for (const player of room.players.values()) {
    player.ready = false;
    player.completed = false;
    player.completedAt = null;
    player.elapsedMs = null;
    player.progress.clear();
  }
}

function startGame(room) {
  if (room.status === 'playing') return;
  if (room.players.size < MAX_ROOM_PLAYERS) return false;
  const connectedPlayers = Array.from(room.players.values()).filter((player) => player.connected);
  if (connectedPlayers.length < MAX_ROOM_PLAYERS) return false;
  if (!Array.from(room.players.values()).every((player) => player.ready)) return false;

  // Fresh puzzle for every race so a rematch is never a memory test.
  const generated = generatePuzzle(room.difficulty);
  room.puzzle = generated.puzzle;
  room.solution = generated.solution;
  room.seed = generated.seed;
  room.puzzleId = `pz-${room.code}-${generated.seed.toString(36)}`;
  room.status = 'playing';
  room.startedAt = now();
  room.finishedAt = null;
  room.winnerId = null;
  room.results = null;
  room.finishReason = null;
  room.resultReason = null;
  room.abandonedPlayerId = null;
  for (const player of room.players.values()) {
    player.ready = false;
    player.completed = false;
    player.completedAt = null;
    player.elapsedMs = null;
    player.progress.clear();
  }

  const message = {
    type: MP.GAME_STARTED,
    ...gameSnapshot(room),
    serverTime: now(),
  };
  for (const player of room.players.values()) {
    send(player.socket, message);
    send(player.socket, { type: MP.PROGRESS_STATE, progress: progressSnapshot(room) });
  }
  broadcastRoomState(room);
  schedulePersist();
  console.log(`[server] room ${room.id} race started (seed ${room.seed}, ${room.difficulty})`);
  return true;
}

/** Server decides everything here — the client only reports its board. */
function handleCompletion(room, player, message) {
  const errors = [];
  if (room.status !== 'playing') errors.push('game is not running');
  if (player.completed) errors.push('already completed');
  if (message.puzzleId && message.puzzleId !== room.puzzleId) errors.push('puzzle id mismatch');
  const board = Array.isArray(message.board) ? message.board : null;
  if (!board || board.length !== 81) errors.push('board must have 81 cells');
  if (board && !board.every((value) => Number.isInteger(value) && value >= 0 && value <= 9)) {
    errors.push('board values must be integers 0..9');
  }
  if (board && room.puzzle.some((clue, index) => clue !== 0 && clue !== board[index])) {
    errors.push('board does not contain the original clues');
  }
  if (board && !board.every((value, index) => value === room.solution[index])) {
    errors.push('board does not match the solution');
  }
  if (!isValidSolution(room.solution)) errors.push('server solution is invalid');

  if (errors.length) {
    console.warn(`[server] rejected completion from ${player.id} in ${room.id}: ${errors.join(', ')}`);
    send(player.socket, {
      type: MP.ERROR,
      code: 'INVALID_SOLUTION',
      message: `Submission rejected: ${errors.join(', ')}`,
    });
    return;
  }

  const completedAt = now(); // authoritative server timestamp
  player.completed = true;
  player.completedAt = completedAt;
  player.elapsedMs = completedAt - room.startedAt;
  room.lastActivity = completedAt;
  schedulePersist();

  broadcast(
    room,
    {
      type: MP.PLAYER_COMPLETED,
      roomId: room.id,
      playerId: player.id,
      name: player.name,
      elapsedMs: player.elapsedMs,
      serverTimestamp: completedAt,
    },
    player.id,
  );

  if (!room.winnerId) {
    room.winnerId = player.id;
    finishGame(room, `First to finish: ${player.name}`);
  } else {
    // A very close second finish still gets recorded with its real server time,
    // and GAME_FINISHED is re-broadcast so both clients see both times.
    finishGame(room, room.finishReason || 'Race finished');
  }
}

function finishGame(room, reason, { resultReason = RESULT_REASONS.PUZZLE_COMPLETED, abandonedPlayerId = null } = {}) {
  room.resultReason = resultReason;
  room.abandonedPlayerId = abandonedPlayerId;
  if (room.status === 'finished' && room.results) {
    room.results = buildResults(room);
    room.finishReason = reason;
    broadcast(room, { type: MP.GAME_FINISHED, ...roomResultsMessage(room, reason) });
    if (resultReason === RESULT_REASONS.OPPONENT_ABANDONED) broadcastGameEnded(room);
    schedulePersist();
    return;
  }
  room.status = 'finished';
  room.finishedAt = now();
  room.finishReason = reason;
  room.results = buildResults(room);
  for (const player of room.players.values()) clearDisconnectTimer(player);
  broadcast(room, { type: MP.GAME_FINISHED, ...roomResultsMessage(room, reason) });
  if (resultReason === RESULT_REASONS.OPPONENT_ABANDONED || resultReason === RESULT_REASONS.PLAYER_ABANDONED) {
    broadcastGameEnded(room);
  }
  schedulePersist();
  console.log(`[server] room ${room.id} finished. winner=${room.winnerId} reason=${resultReason}`);
}

function buildResults(room) {
  return Array.from(room.players.values()).map((player) => ({
    playerId: player.id,
    name: player.name,
    completed: player.completed,
    valid: player.completed,
    elapsedMs: player.elapsedMs,
    completedAt: player.completedAt,
    connected: player.connected,
  }));
}

function roomResultsMessage(room, reason) {
  return {
    roomId: room.id,
    puzzleId: room.puzzleId,
    winnerId: room.winnerId,
    finishedAt: room.finishedAt,
    reason,
    resultReason: room.resultReason || RESULT_REASONS.PUZZLE_COMPLETED,
    abandonedPlayerId: room.abandonedPlayerId ?? null,
    results: room.results,
  };
}

function playerPublic(player) {
  return {
    id: player.id,
    name: player.name,
    ready: player.ready,
    connected: player.connected,
    completed: player.completed,
    elapsedMs: player.elapsedMs,
    disconnectedAt: player.disconnectedAt,
    reconnectDeadline: player.reconnectDeadline,
  };
}

/**
 * The disconnect grace window: a dropped socket during a race starts a
 * server-owned countdown instead of ending the game. The deadline lives in the
 * room state (and on disk) so it survives timers being lost or the process
 * restarting; the timeout handle is only an optimisation for promptness.
 */
function markDisconnected(room, player) {
  clearDisconnectTimer(player);
  player.connected = false;
  player.disconnectedAt = now();
  player.reconnectDeadline = player.disconnectedAt + RECONNECT_TIMEOUT_MS;
  player.socket = null;
  room.lastActivity = player.disconnectedAt;
  schedulePersist();

  if (room.status === 'playing') {
    player.disconnectTimer = setTimeout(() => {
      player.disconnectTimer = null;
      checkAbandonment(room, player);
    }, RECONNECT_TIMEOUT_MS);
    // The timer may have been delayed by an idle event loop — re-check now.
    if (player.disconnectTimer.unref) player.disconnectTimer.unref();
  }

  broadcast(room, {
    type: MP.PLAYER_DISCONNECTED,
    player: playerPublic(player),
    reconnectTimeoutMs: RECONNECT_TIMEOUT_MS,
    serverTime: now(),
  });
}

function clearDisconnectTimer(player) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
}

function restoreConnected(room, player) {
  clearDisconnectTimer(player);
  player.connected = true;
  player.disconnectedAt = null;
  player.reconnectDeadline = null;
  room.lastActivity = now();
}

/**
 * Deadline check for one disconnected player. Runs from the per-player timeout
 * and from the periodic sweep; both are safe to call at any time.
 */
function checkAbandonment(room, player) {
  if (room.status !== 'playing') return;
  if (player.connected || !player.reconnectDeadline) return;
  if (now() < player.reconnectDeadline) return; // reconnected or clock not up yet

  const opponent = Array.from(room.players.values()).find((other) => other.id !== player.id);
  if (opponent && (opponent.connected || opponent.completed)) {
    // The opponent stayed (or already finished): they win by abandonment.
    room.winnerId = opponent.id;
    finishGame(room, 'Opponent did not reconnect within 10 minutes', {
      resultReason: RESULT_REASONS.OPPONENT_ABANDONED,
      abandonedPlayerId: player.id,
    });
  } else if (opponent && opponent.reconnectDeadline && opponent.reconnectDeadline > now()) {
    // Both are gone but the opponent still has window left — wait for it.
    return;
  } else {
    // Everyone's window expired: nobody wins, the race is void.
    finishGame(room, 'Both players left the race', {
      resultReason: RESULT_REASONS.PLAYER_ABANDONED,
    });
  }
  schedulePersist();
}

/** Broadcasts the abandonment verdict to whoever is still listening. */
function broadcastGameEnded(room) {
  broadcast(room, {
    type: MP.GAME_ENDED,
    roomId: room.id,
    reason: room.finishReason,
    resultReason: room.resultReason,
    abandonedPlayerId: room.abandonedPlayerId ?? null,
    winnerId: room.winnerId,
    finishedAt: room.finishedAt,
    results: room.results,
    serverTime: now(),
  });
}

function removePlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return;
  markDisconnected(room, player);
  console.log(
    `[server] ${playerId} disconnected from ${room.id}` +
      (room.status === 'playing' ? ` (reconnect window until ${new Date(player.reconnectDeadline).toISOString()})` : ''),
  );
}

/* ------------------------------ sync API -------------------------------- */

/** Idempotent store: the same record id never creates a duplicate entry. */
const syncStore = new Map();

function aggregateStats() {
  const stats = {
    gamesPlayed: 0,
    gamesCompleted: 0,
    gamesFailed: 0,
    totalCompletedMs: 0,
    bestTimes: { easy: null, medium: null, hard: null, expert: null },
  };
  for (const record of syncStore.values()) {
    if (record.type !== 'stats' || !record.payload) continue;
    const payload = record.payload;
    stats.gamesPlayed = Math.max(stats.gamesPlayed, Number(payload.gamesPlayed) || 0);
    stats.gamesCompleted = Math.max(stats.gamesCompleted, Number(payload.gamesCompleted) || 0);
    stats.gamesFailed = Math.max(stats.gamesFailed, Number(payload.gamesFailed) || 0);
    stats.totalCompletedMs = Math.max(stats.totalCompletedMs, Number(payload.totalCompletedMs) || 0);
    for (const key of Object.keys(stats.bestTimes)) {
      const value = payload.bestTimes?.[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      stats.bestTimes[key] = stats.bestTimes[key] === null ? value : Math.min(stats.bestTimes[key], value);
    }
  }
  return stats;
}

async function readJsonBody(request, limitBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleSyncRequest(request, response) {
  try {
    const body = await readJsonBody(request);
    const id = String(body.id || '').slice(0, 128);
    if (!id) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'record id is required' }));
      return;
    }
    const duplicate = syncStore.has(id);
    if (!duplicate) {
      if (syncStore.size >= MAX_SYNC_RECORDS) {
        const oldest = syncStore.keys().next().value;
        syncStore.delete(oldest);
      }
      syncStore.set(id, {
        id,
        type: String(body.type || 'unknown').slice(0, 48),
        payload: body.payload ?? null,
        createdAt: Number(body.createdAt) || now(),
        updatedAt: Number(body.updatedAt) || now(),
        receivedAt: now(),
      });
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        ok: true,
        duplicate,
        stored: syncStore.size,
        stats: aggregateStats(),
      }),
    );
  } catch (error) {
    console.warn('[server] sync request failed', error.message);
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: error.message }));
  }
}

/* --------------------------- static file host --------------------------- */

const BLOCKED_SEGMENTS = new Set(['server', 'tools', 'node_modules', '.git', '.qodo', '.vscode']);
const BLOCKED_FILES = new Set(['package.json', 'package-lock.json']);

/** Only the public app shell may be served — never the tooling or the backend. */
function isBlockedPath(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment) || segment === '..')) return true;
  const base = segments[segments.length - 1] || '';
  return BLOCKED_FILES.has(base);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  if (isBlockedPath(pathname)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  const target = normalize(join(ROOT, pathname));
  if (!target.startsWith(ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error('directory');
    const body = await readFile(target);
    const type = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type };
    // The service worker must never be served stale or updates would never land.
    headers['Cache-Control'] = pathname === '/sw.js' ? 'no-cache' : 'public, max-age=60';
    response.writeHead(200, headers);
    response.end(body);
  } catch {
    if (pathname.startsWith('/api/')) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'unknown API endpoint' }));
      return;
    }
    // Unknown paths fall back to the app shell so deep links keep working.
    const index = join(ROOT, 'index.html');
    if (existsSync(index)) {
      response.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
      response.end(await readFile(index));
      return;
    }
    response.writeHead(404).end('Not found');
  }
}

const server = http.createServer((request, response) => {
  if (request.method === 'POST' && request.url?.startsWith('/api/sync')) {
    handleSyncRequest(request, response);
    return;
  }
  if (request.method === 'GET' && request.url?.startsWith('/api/health')) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        ok: true,
        uptimeSeconds: Math.round(process.uptime()),
        rooms: rooms.size,
        roomCodes: Array.from(rooms.keys()),
        syncRecords: syncStore.size,
        serverTime: now(),
      }),
    );
    return;
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    serveStatic(request, response);
    return;
  }
  response.writeHead(405, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
});

/* ------------------------------- websocket ------------------------------ */

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, request) => {
  socket.roomId = null;
  socket.playerId = null;
  socket.messageCount = 0;
  socket.rateWindowStart = now();
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    // Simple rate limit: a client never needs more than ~60 messages per second.
    const stamp = now();
    if (stamp - socket.rateWindowStart > RATE_WINDOW_MS) {
      socket.rateWindowStart = stamp;
      socket.messageCount = 0;
    }
    socket.messageCount++;
    if (socket.messageCount > MAX_MESSAGES_PER_WINDOW) {
      send(socket, { type: MP.ERROR, code: 'RATE_LIMITED', message: 'Too many messages' });
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: MP.ERROR, code: 'BAD_MESSAGE', message: 'Malformed JSON' });
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    try {
      handleClientMessage(socket, message);
    } catch (error) {
      console.error('[server] message handler failed', error);
      send(socket, { type: MP.ERROR, code: 'INTERNAL', message: 'Server error' });
    }
  });

  socket.on('close', () => {
    const room = socket.roomId ? rooms.get(socket.roomId) : null;
    if (!room || !socket.playerId) return;
    const player = room.players.get(socket.playerId);
    if (!player || player.socket !== socket) return;
    // A dropped socket never ends a race by itself: the player gets a
    // server-owned reconnection window, then the game is decided.
    removePlayer(room, socket.playerId);
  });

  socket.on('error', (error) => console.warn('[server] socket error', error.message));

  send(socket, { type: MP.PONG, hello: true, serverTime: now() });
});

function handleClientMessage(socket, message) {
  const playerId = message.playerId;
  if (!isValidPlayerId(playerId)) {
    send(socket, { type: MP.ERROR, code: 'INVALID_PLAYER', message: 'playerId is required' });
    return;
  }
  socket.playerId = playerId;

  switch (message.type) {
    case MP.PING:
      send(socket, { type: MP.PONG, t: message.t, serverTime: now() });
      break;

    case MP.CREATE_ROOM: {
      const room = createRoom(playerId, message.name, message.difficulty || 'medium');
      const player = addPlayer(room, { id: playerId, name: message.name, socket });
      socket.roomId = room.id;
      send(socket, { type: MP.ROOM_CREATED, roomId: room.id, playerId, room: roomSnapshot(room) });
      console.log(`[server] room ${room.id} created by ${playerId} (${room.difficulty})`);
      break;
    }

    case MP.JOIN_ROOM: {
      const code = String(message.roomId || message.roomCode || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(socket, { type: MP.ERROR, code: 'ROOM_NOT_FOUND', message: 'Room not found' });
        return;
      }
      const existing = room.players.get(playerId);
      if (!existing && room.players.size >= MAX_ROOM_PLAYERS) {
        send(socket, { type: MP.ERROR, code: 'ROOM_FULL', message: 'Room is full' });
        return;
      }
      if (!existing && room.status !== 'lobby') {
        send(socket, { type: MP.ERROR, code: 'ROOM_IN_PROGRESS', message: 'Race already started' });
        return;
      }

      if (existing) {
        // Reconnect: restore the authoritative state for this player.
        restoreConnected(room, existing);
        existing.socket = socket;
        existing.name = sanitizeName(message.name || existing.name);
        socket.roomId = room.id;
        schedulePersist();
        broadcast(room, {
          type: MP.PLAYER_RECONNECTED,
          player: playerPublic(existing),
          serverTime: now(),
        });
        send(socket, {
          type: MP.ROOM_STATE,
          room: roomSnapshot(room),
          game: room.status !== 'lobby' ? gameSnapshot(room) : null,
          progress: progressSnapshot(room),
          ...resultSnapshot(room),
          serverTime: now(),
        });
        // Someone coming back after their window expired gets the verdict
        // spelled out: the race is over, it cannot be resumed.
        if (
          room.status === 'finished' &&
          (room.resultReason === RESULT_REASONS.OPPONENT_ABANDONED ||
            room.resultReason === RESULT_REASONS.PLAYER_ABANDONED) &&
          room.abandonedPlayerId === existing.id
        ) {
          broadcastGameEnded(room);
        }
        console.log(`[server] ${playerId} reconnected to ${room.id}`);
        return;
      }

      const player = addPlayer(room, { id: playerId, name: message.name, socket });
      socket.roomId = room.id;
      broadcast(room, { type: MP.PLAYER_JOINED, player: playerPublic(player) }, playerId);
      send(socket, {
        type: MP.ROOM_STATE,
        room: roomSnapshot(room),
        game: room.status !== 'lobby' ? gameSnapshot(room) : null,
        progress: progressSnapshot(room),
        ...resultSnapshot(room),
        serverTime: now(),
      });
      broadcastRoomState(room);
      console.log(`[server] ${playerId} joined ${room.id}`);
      break;
    }

    case MP.REQUEST_STATE: {
      const room = rooms.get(String(message.roomId || '').toUpperCase());
      if (!room || !room.players.has(playerId)) {
        send(socket, { type: MP.ERROR, code: 'NOT_IN_ROOM', message: 'Not in that room' });
        return;
      }
      send(socket, {
        type: MP.ROOM_STATE,
        room: roomSnapshot(room),
        game: room.status !== 'lobby' ? gameSnapshot(room) : null,
        progress: progressSnapshot(room),
        ...resultSnapshot(room),
        serverTime: now(),
      });
      break;
    }

    case MP.PLAYER_READY: {
      const room = rooms.get(String(message.roomId || '').toUpperCase());
      const player = room?.players.get(playerId);
      if (!room || !player) {
        send(socket, { type: MP.ERROR, code: 'NOT_IN_ROOM', message: 'Not in that room' });
        return;
      }
      // Readiness after a finished race means "rematch".
      if (room.status === 'finished') resetForRematch(room);
      player.ready = Boolean(message.ready);
      player.socket = socket;
      room.lastActivity = now();
      schedulePersist();
      broadcastRoomState(room);
      const others = Array.from(room.players.values()).filter((other) => other.id !== playerId);
      if (others.length && others.every((other) => other.ready && other.connected) && player.ready && room.status === 'lobby') {
        startGame(room);
      }
      break;
    }

    case MP.START_GAME: {
      const room = rooms.get(String(message.roomId || '').toUpperCase());
      if (!room || !room.players.has(playerId)) {
        send(socket, { type: MP.ERROR, code: 'NOT_IN_ROOM', message: 'Not in that room' });
        return;
      }
      if (room.status === 'finished') {
        // Rematch: both players must be ready again for a new puzzle.
        resetForRematch(room);
        broadcastRoomState(room);
      }
      if (!startGame(room)) {
        send(socket, { type: MP.ERROR, code: 'NOT_READY', message: 'Both players must be ready' });
      }
      break;
    }

    case MP.PLAYER_PROGRESS: {
      const room = rooms.get(String(message.roomId || '').toUpperCase());
      if (!room || !room.players.has(playerId)) {
        send(socket, { type: MP.ERROR, code: 'NOT_IN_ROOM', message: 'Not in that room' });
        return;
      }
      const player = room.players.get(playerId);
      if (room.status !== 'playing' || player.completed) return;
      const cell = Number(message.cell);
      const value = Number(message.value);
      if (!Number.isInteger(cell) || cell < 0 || cell > 80) return;
      if (!Number.isInteger(value) || value < 0 || value > 9) return;
      if (room.puzzle[cell] !== 0) return; // a clue can never change
      if (value === 0) player.progress.delete(cell);
      else player.progress.set(cell, value);
      player.socket = socket;
      room.lastActivity = now();
      schedulePersist();
      broadcast(
        room,
        {
          type: MP.PLAYER_PROGRESS,
          roomId: room.id,
          playerId,
          cell,
          value,
          serverTimestamp: now(),
        },
        playerId,
      );
      break;
    }

    case MP.PLAYER_COMPLETED: {
      const room = rooms.get(String(message.roomId || '').toUpperCase());
      const player = room?.players.get(playerId);
      if (!room || !player) {
        send(socket, { type: MP.ERROR, code: 'NOT_IN_ROOM', message: 'Not in that room' });
        return;
      }
      player.socket = socket;
      handleCompletion(room, player, message);
      break;
    }

    case MP.LEAVE_ROOM: {
      const room = rooms.get(String(message.roomId || '').toUpperCase());
      if (!room) return;
      const wasPlaying = room.status === 'playing';
      const player = room.players.get(playerId);
      if (wasPlaying && player && !player.completed) {
        // An explicit quit is a forfeit — no reconnection window is owed.
        const remaining = Array.from(room.players.values()).find((other) => other.id !== playerId);
        if (remaining) {
          room.winnerId = remaining.id;
          finishGame(room, 'Opponent left the race', {
            resultReason: RESULT_REASONS.OPPONENT_ABANDONED,
            abandonedPlayerId: playerId,
          });
        } else {
          finishGame(room, 'Both players left', { resultReason: RESULT_REASONS.PLAYER_ABANDONED });
        }
      }
      if (player) clearDisconnectTimer(player);
      room.players.delete(playerId);
      schedulePersist();
      broadcast(room, { type: MP.PLAYER_LEFT, player: { id: playerId } });
      if (!room.players.size) {
        rooms.delete(room.id);
        schedulePersist();
        console.log(`[server] room ${room.id} disposed (empty)`);
      } else {
        broadcastRoomState(room);
      }
      socket.roomId = null;
      break;
    }

    default:
      send(socket, { type: MP.ERROR, code: 'UNKNOWN_TYPE', message: `Unknown message ${message.type}` });
  }
}

/* ------------------------------- upkeep --------------------------------- */

// Heartbeat: drop half-open sockets so the opponent sees an honest status.
// A terminated dead socket fires 'close', which starts the player's
// reconnection window — a brief network blip never ends the game outright.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    try {
      socket.ping();
    } catch {
      /* ignore */
    }
  }
}, 30000);

// Deadline sweeper: the authoritative backstop for the abandonment rule. Every
// room's reconnectDeadline lives in room state (and on disk), so this check
// makes the rule fire even if a per-player setTimeout was lost — including
// deadlines that expired while the server was down.
const abandonmentSweep = setInterval(() => {
  for (const room of rooms.values()) {
    if (room.status !== 'playing') continue;
    for (const player of room.players.values()) {
      checkAbandonment(room, player);
    }
  }
}, ABANDONMENT_SWEEP_MS);

// Expire stale rooms and prune players that never came back.
const cleanup = setInterval(() => {
  const stamp = now();
  let mutated = false;
  for (const room of rooms.values()) {
    for (const player of Array.from(room.players.values())) {
      if (
        !player.connected &&
        player.disconnectedAt &&
        stamp - player.disconnectedAt > DISCONNECT_GRACE_MS &&
        room.status !== 'playing'
      ) {
        clearDisconnectTimer(player);
        room.players.delete(player.id);
        mutated = true;
      }
    }
    const anyConnected = Array.from(room.players.values()).some((player) => player.connected);
    if (!room.players.size || (!anyConnected && stamp - room.lastActivity > ROOM_TTL_MS)) {
      rooms.delete(room.id);
      mutated = true;
      console.log(`[server] room ${room.id} expired`);
    }
  }
  if (mutated) schedulePersist();
}, 60000);

server.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(abandonmentSweep);
  clearInterval(cleanup);
});

// Restore persisted rooms (and re-arm their deadlines) before accepting
// connections so a restart can never resurrect a race that already expired.
await loadRooms();

server.listen(PORT, () => {
  console.log(`[server] Sudoku multiplayer server listening on http://localhost:${PORT}`);
  console.log(`[server] WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`[server] serving static frontend from ${ROOT}`);
  console.log(
    `[server] reconnection window: ${RECONNECT_TIMEOUT_MS}ms, room state: ${ROOMS_FILE}`,
  );
});

process.on('SIGINT', () => {
  console.log('\n[server] shutting down');
  flushPersist();
  server.close(() => process.exit(0));
});
