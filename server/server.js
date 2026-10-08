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
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
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
const MAX_ROOM_PLAYERS = 2;
const MAX_MESSAGES_PER_WINDOW = 120;
const RATE_WINDOW_MS = 1000;
const MAX_SYNC_RECORDS = 5000;

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
    results: null,
    players: new Map(),
  };
  rooms.set(code, room);
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
    progress: new Map(),
    socket,
  };
  room.players.set(id, player);
  room.lastActivity = now();
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
  console.log(`[server] room ${room.id} race started (seed ${room.seed}, ${room.difficulty})`);
  return true;
}

/** Server decides everything here — the client only reports its board. */
function handleCompletion(room, player, message) {
  const errors = [];
  if (room.status === 'lobby') errors.push('game is not running');
  if (room.finishReason && room.finishReason.startsWith('Opponent left')) {
    errors.push('race already decided');
  }
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

function finishGame(room, reason) {
  if (room.status === 'finished' && room.results) {
    room.results = buildResults(room);
    room.finishReason = reason;
    broadcast(room, { type: MP.GAME_FINISHED, ...roomResultsMessage(room, reason) });
    return;
  }
  room.status = 'finished';
  room.finishedAt = now();
  room.finishReason = reason;
  room.results = buildResults(room);
  broadcast(room, { type: MP.GAME_FINISHED, ...roomResultsMessage(room, reason) });
  console.log(`[server] room ${room.id} finished. winner=${room.winnerId}`);
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
  };
}

function removePlayer(room, playerId, { keepGrace = false } = {}) {
  const player = room.players.get(playerId);
  if (!player) return;
  player.connected = false;
  player.disconnectedAt = now();
  player.socket = null;
  room.lastActivity = now();
  broadcast(room, { type: MP.PLAYER_DISCONNECTED, player: playerPublic(player) });

  if (room.status === 'playing' && !keepGrace) {
    // The opponent is gone for good: award the race to the remaining player.
    const remaining = Array.from(room.players.values()).find((other) => other.id !== playerId && other.connected);
    if (remaining && !remaining.completed) {
      room.winnerId = remaining.id;
      finishGame(room, 'Opponent left the race');
    } else if (!remaining) {
      finishGame(room, 'Both players left');
    }
  }
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
    removePlayer(room, socket.playerId, { keepGrace: true });
    console.log(`[server] ${socket.playerId} disconnected from ${room.id} (grace period active)`);
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
        existing.socket = socket;
        existing.connected = true;
        existing.disconnectedAt = null;
        existing.name = sanitizeName(message.name || existing.name);
        socket.roomId = room.id;
        broadcast(room, { type: MP.PLAYER_RECONNECTED, player: playerPublic(existing) });
        send(socket, {
          type: MP.ROOM_STATE,
          room: roomSnapshot(room),
          game: room.status !== 'lobby' ? gameSnapshot(room) : null,
          progress: progressSnapshot(room),
          ...resultSnapshot(room),
          serverTime: now(),
        });
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
        const remaining = Array.from(room.players.values()).find((other) => other.id !== playerId);
        if (remaining) {
          room.winnerId = remaining.id;
          finishGame(room, 'Opponent left the race');
        } else {
          finishGame(room, 'Both players left');
        }
      }
      room.players.delete(playerId);
      broadcast(room, { type: MP.PLAYER_LEFT, player: { id: playerId } });
      if (!room.players.size) {
        rooms.delete(room.id);
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

// Expire stale rooms and prune players that never came back.
const cleanup = setInterval(() => {
  const stamp = now();
  for (const room of rooms.values()) {
    for (const player of Array.from(room.players.values())) {
      if (
        !player.connected &&
        player.disconnectedAt &&
        stamp - player.disconnectedAt > DISCONNECT_GRACE_MS &&
        room.status !== 'playing'
      ) {
        room.players.delete(player.id);
      }
    }
    const anyConnected = Array.from(room.players.values()).some((player) => player.connected);
    if (!room.players.size || (!anyConnected && stamp - room.lastActivity > ROOM_TTL_MS)) {
      rooms.delete(room.id);
      console.log(`[server] room ${room.id} expired`);
    }
  }
}, 60000);

server.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(cleanup);
});

server.listen(PORT, () => {
  console.log(`[server] Sudoku multiplayer server listening on http://localhost:${PORT}`);
  console.log(`[server] WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`[server] serving static frontend from ${ROOT}`);
});

process.on('SIGINT', () => {
  console.log('\n[server] shutting down');
  server.close(() => process.exit(0));
});
