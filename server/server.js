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
import { createHmac } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { generatePuzzle, isValidSolution } from '../js/sudoku.js';
import { MP, MAX_MISTAKES } from '../js/multiplayer.js';

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
const MAX_CHAT_LENGTH = 250;
const MAX_CHAT_PER_SECOND = 5;
// Pre-game settings: 0 means "unlimited mistakes" (no elimination). The
// default matches the historical 3-mistake rule so a room that never opens
// the lobby settings behaves exactly as before.
const MISTAKE_LIMIT_OPTIONS = [1, 2, 3, 5, 0];
const CHAT_RATE_WINDOW_MS = 1000;
const MAX_CHAT_HISTORY = 200;
const MAX_SYNC_RECORDS = 5000;
// Voice calls: ICE configuration is delivered per-player over the authenticated
// socket. The public STUN list is safe to share; TURN uses short-lived HMAC
// credentials derived from `TURN_STATIC_SECRET`, so the shared secret itself is
// never sent to a client. See README "Voice calls" for deployment notes.
const STUN_URLS = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
const TURN_URLS = (process.env.TURN_URLS || '')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
const TURN_STATIC_SECRET = process.env.TURN_STATIC_SECRET || '';
const TURN_TTL_SECONDS = Math.max(60, Math.min(24 * 3600, Number(process.env.TURN_TTL_SECONDS) || 3600));
const CALL_RING_TIMEOUT_MS = Number(process.env.CALL_RING_TIMEOUT_MS) || 45 * 1000;
const MAX_SIGNAL_BYTES = 20 * 1024;

/** Result vocabulary — `resultReason` travels with every finished race. */
const RESULT_REASONS = {
  PUZZLE_COMPLETED: 'PUZZLE_COMPLETED',
  PLAYER_COMPLETED: 'PLAYER_COMPLETED',
  OPPONENT_COMPLETED: 'OPPONENT_COMPLETED',
  OPPONENT_MISTAKE_LIMIT: 'OPPONENT_MISTAKE_LIMIT',
  OPPONENT_ABANDONED: 'OPPONENT_ABANDONED',
  PLAYER_ABANDONED: 'PLAYER_ABANDONED',
  DRAW: 'DRAW',
  SERVER_CANCELLED: 'SERVER_CANCELLED',
};

/** Player lifecycle inside a race. */
const PLAYER_STATUS = {
  PLAYING: 'playing',
  ELIMINATED: 'eliminated',
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
    loserId: room.loserId,
    finishReason: room.finishReason,
    resultReason: room.resultReason,
    abandonedPlayerId: room.abandonedPlayerId,
    eliminatedPlayerId: room.eliminatedPlayerId,
    results: room.results,
    chatHistory: Array.isArray(room.chatHistory) ? room.chatHistory.slice(-MAX_CHAT_HISTORY) : [],
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
      preferredMaxMistakes: player.preferredMaxMistakes,
      mistakes: player.mistakes,
      maxMistakes: player.maxMistakes,
      eliminated: player.eliminated,
      status: player.status,
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
        chatHistory: Array.isArray(stored.chatHistory) ? stored.chatHistory.slice(-MAX_CHAT_HISTORY) : [],
        // A restart tears every call down; signaling is socket-bound anyway.
        call: null,
      };
      for (const storedPlayer of stored.players || []) {
        const player = {
          ...storedPlayer,
          // Mistake state is part of the authoritative race; older snapshots
          // that predate it simply start everyone clean.
          preferredMaxMistakes:
            Number.isInteger(storedPlayer.preferredMaxMistakes) && MISTAKE_LIMIT_OPTIONS.includes(storedPlayer.preferredMaxMistakes)
              ? storedPlayer.preferredMaxMistakes
              : MAX_MISTAKES,
          mistakes: Number(storedPlayer.mistakes) || 0,
          maxMistakes: Number(storedPlayer.maxMistakes) || MAX_MISTAKES,
          eliminated: Boolean(storedPlayer.eliminated),
          status: storedPlayer.eliminated ? PLAYER_STATUS.ELIMINATED : PLAYER_STATUS.PLAYING,
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
    loserId: null,
    finishReason: null,
    resultReason: null,
    abandonedPlayerId: null,
    eliminatedPlayerId: null,
    results: null,
    maxMistakes: MAX_MISTAKES,
    chatHistory: [],
    // Active voice call (transient: never persisted, never survives a restart).
    call: null,
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
    // Pre-game lobby: each player's preferred mistake limit. Both must pick
    // the same value before the server will start the race.
    preferredMaxMistakes: MAX_MISTAKES,
    // Server-owned mistake state — never taken from the client.
    mistakes: 0,
    maxMistakes: MAX_MISTAKES,
    eliminated: false,
    status: PLAYER_STATUS.PLAYING,
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
    // The agreed pre-game settings. `maxMistakes` is null until both players
    // pick the same limit; `settingsLocked` freezes them while a race runs but
    // reopens for a rematch.
    maxMistakes: room.status === 'playing' ? room.maxMistakes ?? MAX_MISTAKES : agreedMistakeLimit(room),
    settingsLocked: room.status === 'playing',
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      ready: player.ready,
      connected: player.connected,
      completed: player.completed,
      elapsedMs: player.elapsedMs,
      disconnectedAt: player.disconnectedAt,
      reconnectDeadline: player.reconnectDeadline,
      preferredMaxMistakes: player.preferredMaxMistakes,
      mistakes: player.mistakes,
      maxMistakes: player.maxMistakes,
      eliminated: player.eliminated,
      status: player.status,
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
    eliminatedPlayerId: room.eliminatedPlayerId ?? null,
    loserId: room.loserId ?? null,
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
    maxMistakes: Number.isFinite(room.maxMistakes) ? room.maxMistakes : MAX_MISTAKES,
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
  room.loserId = null;
  room.results = null;
  room.finishReason = null;
  room.resultReason = null;
  room.abandonedPlayerId = null;
  room.eliminatedPlayerId = null;
  room.finishedAt = null;
  room.startedAt = null;
  endCall(room, 'match-ended');
  for (const player of room.players.values()) {
    player.ready = false;
    player.completed = false;
    player.completedAt = null;
    player.elapsedMs = null;
    player.mistakes = 0;
    player.maxMistakes = MAX_MISTAKES;
    player.eliminated = false;
    player.status = PLAYER_STATUS.PLAYING;
    player.progress.clear();
  }
}

/**
 * The pre-game agreement. Returns the shared mistake limit when both players
 * have picked the same option, or null while they still disagree (or before a
 * second player has joined). 0 means "unlimited".
 */
function agreedMistakeLimit(room) {
  const players = Array.from(room.players.values());
  if (players.length < MAX_ROOM_PLAYERS) return null;
  const first = players[0].preferredMaxMistakes;
  return players.every((player) => player.preferredMaxMistakes === first) ? first : null;
}

function startGame(room) {
  if (room.status === 'playing') return;
  if (room.players.size < MAX_ROOM_PLAYERS) return false;
  const connectedPlayers = Array.from(room.players.values()).filter((player) => player.connected);
  if (connectedPlayers.length < MAX_ROOM_PLAYERS) return false;
  if (!Array.from(room.players.values()).every((player) => player.ready)) return false;
  // Both players must agree on the mistake limit before the server validates a start.
  const agreed = agreedMistakeLimit(room);
  if (agreed === null) return false;
  room.maxMistakes = agreed;

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
  room.loserId = null;
  room.results = null;
  room.finishReason = null;
  room.resultReason = null;
  room.abandonedPlayerId = null;
  room.eliminatedPlayerId = null;
  for (const player of room.players.values()) {
    player.ready = false;
    player.completed = false;
    player.completedAt = null;
    player.elapsedMs = null;
    // Every race starts clean: mistakes never carry across a rematch, and the
    // limit both players agreed to in the lobby is applied to each of them.
    player.mistakes = 0;
    player.maxMistakes = agreed;
    player.eliminated = false;
    player.status = PLAYER_STATUS.PLAYING;
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
  const completedReason =
    room.resultReason === RESULT_REASONS.PLAYER_COMPLETED ||
    room.resultReason === RESULT_REASONS.PUZZLE_COMPLETED;
  // A very close second finish arrives after the room is already finished; it
  // is still recorded with its real server time (a race is not invalidated by
  // losing it). Abandonment/elimination finishes do not accept late boards.
  const lateFinish = room.status === 'finished' && completedReason;
  if (room.status !== 'playing' && !lateFinish) errors.push('game is not running');
  if (player.completed) errors.push('already completed');
  if (player.eliminated) errors.push('player is eliminated');
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
    finishGame(room, `First to finish: ${player.name}`, {
      resultReason: RESULT_REASONS.PLAYER_COMPLETED,
    });
  } else {
    // A very close second finish still gets recorded with its real server time,
    // and GAME_FINISHED is re-broadcast so both clients see both times.
    finishGame(room, room.finishReason || 'Race finished', {
      resultReason: RESULT_REASONS.PLAYER_COMPLETED,
    });
  }
}

/**
 * Server-authoritative move validation for a running race.
 *
 * The client only submits "cell X = value Y"; the server looks up its own
 * solution, decides correctness and owns the mistake counter. On the third
 * mistake the player is eliminated and the race is awarded to the opponent.
 * The correct value is never sent back — a wrong answer only reports that it
 * was wrong and how many attempts remain.
 */
function handlePlayerMove(room, player, message) {
  const cell = Number(message.cell);
  const value = Number(message.value);
  const opponent = Array.from(room.players.values()).find((other) => other.id !== player.id) || null;

  const reject = (code) =>
    send(player.socket, {
      type: MP.MOVE_RESULT,
      accepted: false,
      code,
      cell: Number.isInteger(cell) ? cell : null,
      value: null,
      correct: false,
      mistakes: player.mistakes,
      remainingMistakes: remainingMistakes(player),
      maxMistakes: player.maxMistakes,
      gameStatus: room.status,
    });

  if (room.status !== 'playing') return reject('GAME_NOT_RUNNING');
  if (player.eliminated) return reject('ELIMINATED');
  if (player.completed) return reject('ALREADY_COMPLETED');
  if (!Number.isInteger(cell) || cell < 0 || cell > 80) return;
  if (!Number.isInteger(value) || value < 0 || value > 9) return;
  if (room.puzzle[cell] !== 0) return reject('CLUE_LOCKED'); // givens are immutable over the wire too

  room.lastActivity = now();

  // Deleting a number is never a mistake and is not validated against the solution.
  if (value === 0) {
    player.progress.delete(cell);
    schedulePersist();
    send(player.socket, moveResult(room, player, { cell, value: 0, correct: true }));
    broadcastProgress(room, player.id, cell, 0);
    return;
  }

  if (room.solution[cell] === value) {
    player.progress.set(cell, value);
    schedulePersist();
    send(player.socket, moveResult(room, player, { cell, value, correct: true }));
    broadcastProgress(room, player.id, cell, value);
    return;
  }

  // Incorrect: increment the server-owned counter and tell the player only that
  // the value was wrong. The solution is never revealed.
  player.mistakes += 1;
  player.progress.delete(cell);
  schedulePersist();
  send(player.socket, moveResult(room, player, { cell, value, correct: false }));
  // A limit of 0 means unlimited: mistakes are still counted, but they never
  // eliminate the player.
  if (player.maxMistakes > 0 && player.mistakes >= player.maxMistakes) {
    eliminatePlayer(room, player, opponent);
  }
}

/** Lobby-configured mistake budget left for a player; null when unlimited. */
function remainingMistakes(player) {
  return player.maxMistakes > 0 ? Math.max(0, player.maxMistakes - player.mistakes) : null;
}

/** The per-move reply carrying the authoritative mistake state. */
function moveResult(room, player, { cell, value, correct }) {
  return {
    type: MP.MOVE_RESULT,
    accepted: true,
    correct,
    cell,
    value,
    mistakes: player.mistakes,
    remainingMistakes: remainingMistakes(player),
    maxMistakes: player.maxMistakes,
    gameStatus: player.eliminated ? 'eliminated' : room.status,
  };
}

function broadcastProgress(room, playerId, cell, value) {
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
}

/** Third mistake: the player is out, the opponent wins, deterministically. */
function eliminatePlayer(room, player, opponent) {
  if (player.eliminated) return;
  player.eliminated = true;
  player.status = PLAYER_STATUS.ELIMINATED;
  room.winnerId = opponent ? opponent.id : null;
  finishGame(room, `${player.name} reached the ${player.maxMistakes}-mistake limit`, {
    resultReason: RESULT_REASONS.OPPONENT_MISTAKE_LIMIT,
    eliminatedPlayerId: player.id,
  });
}

function finishGame(
  room,
  reason,
  { resultReason = RESULT_REASONS.PUZZLE_COMPLETED, abandonedPlayerId = null, eliminatedPlayerId = null } = {},
) {
  room.resultReason = resultReason;
  room.abandonedPlayerId = abandonedPlayerId;
  room.eliminatedPlayerId = eliminatedPlayerId;
  // A finished match cannot keep an audio call alive.
  endCall(room, 'match-ended');
  // The loser is whoever did not win — stored explicitly for the result message.
  if (room.winnerId) {
    const other = Array.from(room.players.values()).find((player) => player.id !== room.winnerId);
    room.loserId = other ? other.id : null;
  } else {
    room.loserId = null;
  }
  if (room.status === 'finished' && room.results) {
    room.results = buildResults(room);
    room.finishReason = reason;
    broadcast(room, { type: MP.GAME_FINISHED, ...roomResultsMessage(room, reason) });
    // Keep the clients' lobby snapshot honest: it must read `finished` so a
    // rematch can reopen readiness and settings.
    broadcastRoomState(room);
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
  broadcastRoomState(room);
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
    mistakes: player.mistakes,
    maxMistakes: player.maxMistakes,
    eliminated: player.eliminated,
    status: player.status,
  }));
}

function roomResultsMessage(room, reason) {
  return {
    roomId: room.id,
    puzzleId: room.puzzleId,
    winnerId: room.winnerId,
    loserId: room.loserId ?? null,
    finishedAt: room.finishedAt,
    reason,
    resultReason: room.resultReason || RESULT_REASONS.PUZZLE_COMPLETED,
    abandonedPlayerId: room.abandonedPlayerId ?? null,
    eliminatedPlayerId: room.eliminatedPlayerId ?? null,
    maxMistakes: Number.isFinite(room.maxMistakes) ? room.maxMistakes : MAX_MISTAKES,
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
    mistakes: player.mistakes,
    maxMistakes: player.maxMistakes,
    eliminated: player.eliminated,
    status: player.status,
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
  // A peer cannot relay audio while its socket is gone; end any live call.
  if (room.call && (room.call.callerId === player.id || room.call.calleeId === player.id)) {
    endCall(room, 'peer-disconnected');
  }
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
    eliminatedPlayerId: room.eliminatedPlayerId ?? null,
    winnerId: room.winnerId,
    loserId: room.loserId ?? null,
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
  socket.chatRateWindowStart = now();
  socket.chatCountInWindow = 0;
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

    case MP.CHAT_MESSAGE:
      handleChatMessage(socket, message);
      break;

    case MP.CHAT_HISTORY:
      handleChatHistoryRequest(socket);
      break;

    case MP.CALL_CONFIG:
      handleCallConfig(socket);
      break;

    case MP.CALL_INVITE:
      handleCallInvite(socket);
      break;

    case MP.CALL_ACCEPT:
      handleCallAccept(socket);
      break;

    case MP.CALL_DECLINE:
      handleCallDecline(socket);
      break;

    case MP.CALL_END:
      handleCallEnd(socket, message);
      break;

    case MP.CALL_SIGNAL:
      handleCallSignal(socket, message);
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

    case MP.PLAYER_SETTINGS: {
      // Pre-game only: the limit is locked the moment the race starts so one
      // player can never change the rules mid-match.
      const room = rooms.get(String(message.roomId || '').toUpperCase());
      const player = room?.players.get(playerId);
      if (!room || !player) {
        send(socket, { type: MP.ERROR, code: 'NOT_IN_ROOM', message: 'Not in that room' });
        return;
      }
      if (room.status !== 'lobby') {
        send(socket, { type: MP.ERROR, code: 'SETTINGS_LOCKED', message: 'Settings are locked once the match starts' });
        return;
      }
      const value = Number(message.maxMistakes);
      if (!MISTAKE_LIMIT_OPTIONS.includes(value)) {
        send(socket, { type: MP.ERROR, code: 'INVALID_SETTINGS', message: 'Unsupported mistake limit' });
        return;
      }
      player.preferredMaxMistakes = value;
      // Changing a setting invalidates that player's readiness so both sides
      // must agree again before the server will start.
      player.ready = false;
      player.socket = socket;
      room.lastActivity = now();
      schedulePersist();
      broadcastRoomState(room);
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
        const agreed = agreedMistakeLimit(room);
        send(socket, {
          type: MP.ERROR,
          code: agreed === null ? 'SETTINGS_MISMATCH' : 'NOT_READY',
          message:
            agreed === null
              ? 'Both players must agree on the mistake limit'
              : 'Both players must be connected and ready',
        });
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
      if (room.status !== 'playing' || player.completed || player.eliminated) return;
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

    case MP.PLAYER_MOVE: {
      // Resolve membership from the socket itself: a client can never submit a
      // move (or a mistake count) on behalf of the opponent.
      const member = roomForSocket(socket);
      if (!member) {
        send(socket, { type: MP.ERROR, code: 'NOT_IN_ROOM', message: 'Not in that room' });
        return;
      }
      handlePlayerMove(member.room, member.player, message);
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
      if (room.call && (room.call.callerId === playerId || room.call.calleeId === playerId)) {
        endCall(room, 'peer-left');
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

/* -------------------------------- chat ---------------------------------- */
/*
 * Chat rides the room WebSocket. Identity and room membership are always
 * resolved from the socket itself (set on CREATE_ROOM / JOIN_ROOM) — never
 * from client-supplied fields — and every accepted message is stamped and
 * ordered by the server before it is broadcast to the whole room.
 */

/** The socket's own room + player, or null when it is not an authenticated member. */
function roomForSocket(socket) {
  const room = socket.roomId ? rooms.get(socket.roomId) : null;
  const player = room?.players.get(socket.playerId);
  if (!room || !player || player.socket !== socket) return null;
  return { room, player };
}

function sanitizeChatMessage(raw) {
  if (typeof raw !== 'string') return null;
  // HTML is never interpreted anywhere (clients render textContent only), but
  // control characters are still stripped so a message cannot fake UI chrome.
  const cleaned = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const trimmed = cleaned.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_CHAT_LENGTH) return null;
  return trimmed;
}

/** Sliding 1-second per-socket window; hard ceiling of MAX_CHAT_PER_SECOND. */
function isChatRateLimited(socket) {
  const stamp = now();
  if (stamp - socket.chatRateWindowStart > CHAT_RATE_WINDOW_MS) {
    socket.chatRateWindowStart = stamp;
    socket.chatCountInWindow = 0;
  }
  if (socket.chatCountInWindow >= MAX_CHAT_PER_SECOND) return true;
  socket.chatCountInWindow++;
  return false;
}

function handleChatMessage(socket, message) {
  const member = roomForSocket(socket);
  if (!member) {
    send(socket, { type: MP.CHAT_ERROR, code: 'NOT_IN_ROOM', message: 'Chat is not available here.' });
    return;
  }
  if (isChatRateLimited(socket)) {
    send(socket, { type: MP.ERROR, code: 'CHAT_RATE_LIMITED', message: 'You are sending messages too quickly.' });
    return;
  }
  const content = sanitizeChatMessage(message.message);
  if (!content) {
    send(socket, {
      type: MP.CHAT_ERROR,
      code: 'INVALID_MESSAGE',
      message: `Messages must be 1–${MAX_CHAT_LENGTH} characters of text.`,
    });
    return;
  }

  const { room, player } = member;
  const entry = {
    playerId: player.id,
    playerName: player.name, // server-authoritative name, never the client's claim
    message: content,
    timestamp: now(), // server-authoritative ordering
  };
  room.chatHistory.push(entry);
  if (room.chatHistory.length > MAX_CHAT_HISTORY) room.chatHistory.shift();
  room.lastActivity = now();
  schedulePersist();
  broadcast(room, { type: MP.CHAT_MESSAGE, ...entry });
}

function handleChatHistoryRequest(socket) {
  const member = roomForSocket(socket);
  if (!member) {
    send(socket, { type: MP.CHAT_ERROR, code: 'NOT_IN_ROOM', message: 'Chat is not available here.' });
    return;
  }
  send(socket, {
    type: MP.CHAT_HISTORY,
    roomId: member.room.id,
    messages: member.room.chatHistory.slice(-MAX_CHAT_HISTORY),
  });
}

/* ------------------------------ voice calls ----------------------------- */
/*
 * Signaling rides the same authenticated room socket as chat. The server never
 * inspects or stores SDP/ICE payloads — it only enforces *who may talk to whom*:
 * both participants must be members of the same room, resolved from the socket
 * itself (never from a client-supplied id), and the call must be in a valid
 * state. Media flows peer-to-peer via WebRTC; no audio touches this server.
 */

function sendCallError(socket, code, message) {
  send(socket, { type: MP.ERROR, code, message });
}

function otherPlayer(room, playerId) {
  return Array.from(room.players.values()).find((player) => player.id !== playerId) || null;
}

function clearCallTimer(call) {
  if (call?.ringTimer) {
    clearTimeout(call.ringTimer);
    call.ringTimer = null;
  }
}

/** Ends the room's live call (if any) and tells both participants. */
function endCall(room, reason, { endedBy = null } = {}) {
  const call = room.call;
  if (!call) return;
  clearCallTimer(call);
  room.call = null;
  broadcast(room, {
    type: MP.CALL_ENDED,
    roomId: room.id,
    reason,
    endedBy,
    callerId: call.callerId,
    calleeId: call.calleeId,
    serverTime: now(),
  });
}

/**
 * Per-player ICE servers. STUN is public; TURN credentials are ephemeral
 * (coturn REST API style) so the shared secret never leaves the server.
 */
function buildIceServers(playerId) {
  const servers = [];
  if (STUN_URLS.length) servers.push({ urls: STUN_URLS });
  if (TURN_URLS.length && TURN_STATIC_SECRET) {
    const expiry = Math.floor(now() / 1000) + TURN_TTL_SECONDS;
    const username = `${expiry}:${playerId}`;
    const credential = createHmac('sha1', TURN_STATIC_SECRET).update(username).digest('base64');
    servers.push({ urls: TURN_URLS, username, credential });
  }
  return servers;
}

function handleCallConfig(socket) {
  const member = roomForSocket(socket);
  if (!member) {
    sendCallError(socket, 'CALL_NOT_IN_ROOM', 'Join a room before requesting call settings');
    return;
  }
  // Only the ICE configuration is returned — never the TURN shared secret.
  send(socket, { type: MP.CALL_CONFIG, roomId: member.room.id, iceServers: buildIceServers(member.player.id) });
}

function handleCallInvite(socket) {
  const member = roomForSocket(socket);
  if (!member) {
    sendCallError(socket, 'CALL_NOT_IN_ROOM', 'Voice calls require an active room');
    return;
  }
  const { room, player } = member;
  if (room.status !== 'playing') {
    sendCallError(socket, 'CALL_UNAVAILABLE', 'Voice calls are available during a match');
    return;
  }
  if (room.call) {
    sendCallError(socket, 'CALL_BUSY', 'A call is already in progress');
    return;
  }
  const opponent = otherPlayer(room, player.id);
  if (!opponent || !opponent.connected || !opponent.socket) {
    sendCallError(socket, 'CALL_PEER_UNAVAILABLE', 'Your opponent is not connected');
    return;
  }

  const call = { status: 'ringing', callerId: player.id, calleeId: opponent.id, startedAt: now(), ringTimer: null };
  room.call = call;
  call.ringTimer = setTimeout(() => {
    if (room.call === call && call.status === 'ringing') endCall(room, 'no-answer');
  }, CALL_RING_TIMEOUT_MS);
  if (call.ringTimer.unref) call.ringTimer.unref();

  send(opponent.socket, {
    type: MP.CALL_INCOMING,
    roomId: room.id,
    from: { id: player.id, name: player.name },
    serverTime: now(),
  });
  send(socket, {
    type: MP.CALL_STATE,
    roomId: room.id,
    state: 'ringing',
    role: 'caller',
    peer: { id: opponent.id, name: opponent.name },
    serverTime: now(),
  });
}

function handleCallAccept(socket) {
  const member = roomForSocket(socket);
  if (!member) {
    sendCallError(socket, 'CALL_NOT_IN_ROOM', 'Voice calls require an active room');
    return;
  }
  const { room, player } = member;
  const call = room.call;
  if (!call || call.status !== 'ringing' || call.calleeId !== player.id) {
    sendCallError(socket, 'CALL_INVALID_STATE', 'There is no incoming call to accept');
    return;
  }
  clearCallTimer(call);
  call.status = 'active';
  const caller = room.players.get(call.callerId);
  send(socket, {
    type: MP.CALL_STATE,
    roomId: room.id,
    state: 'active',
    role: 'callee',
    peer: caller ? { id: caller.id, name: caller.name } : null,
    serverTime: now(),
  });
  if (caller?.socket) {
    send(caller.socket, {
      type: MP.CALL_ACCEPTED,
      roomId: room.id,
      from: { id: player.id, name: player.name },
      serverTime: now(),
    });
  }
}

function handleCallDecline(socket) {
  const member = roomForSocket(socket);
  if (!member) return;
  const { room, player } = member;
  const call = room.call;
  if (!call || call.calleeId !== player.id) {
    sendCallError(socket, 'CALL_INVALID_STATE', 'There is no incoming call to decline');
    return;
  }
  clearCallTimer(call);
  room.call = null;
  const caller = room.players.get(call.callerId);
  if (caller?.socket) {
    send(caller.socket, {
      type: MP.CALL_DECLINED,
      roomId: room.id,
      from: { id: player.id, name: player.name },
      serverTime: now(),
    });
  }
  send(socket, { type: MP.CALL_STATE, roomId: room.id, state: 'idle', serverTime: now() });
}

function handleCallEnd(socket, message) {
  const member = roomForSocket(socket);
  if (!member) return;
  const { room, player } = member;
  const call = room.call;
  if (!call) return;
  if (call.callerId !== player.id && call.calleeId !== player.id) return;
  const reason = typeof message.reason === 'string' ? message.reason.slice(0, 40) : 'ended';
  endCall(room, reason, { endedBy: player.id });
}

function handleCallSignal(socket, message) {
  const member = roomForSocket(socket);
  if (!member) return;
  const { room, player } = member;
  const call = room.call;
  if (!call) return;
  if (call.callerId !== player.id && call.calleeId !== player.id) return;
  const signal = message.signal;
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return;
  let serialized;
  try {
    serialized = JSON.stringify(signal);
  } catch {
    return; // circular / unserializable payloads are dropped, never relayed
  }
  if (serialized.length > MAX_SIGNAL_BYTES) return;
  // The payload is opaque and forwarded only to the opponent in this room.
  const target = otherPlayer(room, player.id);
  if (!target?.socket) return;
  send(target.socket, {
    type: MP.CALL_SIGNAL,
    roomId: room.id,
    from: { id: player.id, name: player.name },
    signal,
    serverTime: now(),
  });
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
      if (room.call) endCall(room, 'room-closed');
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
