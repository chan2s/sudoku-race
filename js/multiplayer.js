/**
 * multiplayer.js — WebSocket client for head-to-head races.
 *
 * The client is intentionally dumb about winning: it reports progress and its
 * completed board, and the server decides the completion time and the winner.
 * Temporary connection loss is survivable: sends are queued, reconnects use
 * exponential backoff, and a reconnect asks the server for the latest state.
 */

import { Emitter } from './game.js';

/** Message types shared by the client and the multiplayer server. */
export const MP = {
  // client → server
  CREATE_ROOM: 'CREATE_ROOM',
  JOIN_ROOM: 'JOIN_ROOM',
  PLAYER_READY: 'PLAYER_READY',
  START_GAME: 'START_GAME',
  PLAYER_PROGRESS: 'PLAYER_PROGRESS',
  PLAYER_COMPLETED: 'PLAYER_COMPLETED',
  REQUEST_STATE: 'REQUEST_STATE',
  LEAVE_ROOM: 'LEAVE_ROOM',
  PING: 'PING',
  // server → client
  ROOM_CREATED: 'ROOM_CREATED',
  ROOM_STATE: 'ROOM_STATE',
  PLAYER_JOINED: 'PLAYER_JOINED',
  PLAYER_LEFT: 'PLAYER_LEFT',
  GAME_STARTED: 'GAME_STARTED',
  PROGRESS_STATE: 'PROGRESS_STATE',
  PLAYER_COMPLETED: 'PLAYER_COMPLETED',
  PLAYER_DISCONNECTED: 'PLAYER_DISCONNECTED',
  PLAYER_RECONNECTED: 'PLAYER_RECONNECTED',
  GAME_FINISHED: 'GAME_FINISHED',
  PONG: 'PONG',
  ERROR: 'ERROR',
};

export const CONNECTION_STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  OFFLINE: 'offline',
  DISCONNECTED: 'disconnected',
};

export const MP_ERRORS = {
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_IN_PROGRESS: 'ROOM_IN_PROGRESS',
  INVALID_SOLUTION: 'INVALID_SOLUTION',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  SERVER_UNAVAILABLE: 'SERVER_UNAVAILABLE',
};

const SESSION_KEY = 'sudoku:mp-session';
const NAME_KEY = 'sudoku:player-name';

/** Reads the per-tab multiplayer session (room + identity) written on join. */
export function readStoredSession() {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SESSION_KEY) : null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function randomId(prefix) {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function defaultMultiplayerUrl() {
  if (typeof location === 'undefined') return 'ws://localhost:8787/ws';
  if (/^https?:$/.test(location.protocol)) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }
  return 'ws://localhost:8787/ws';
}

export class MultiplayerClient extends Emitter {
  constructor({ url = '', playerId = null, name = 'Player' } = {}) {
    super();
    this.url = url || defaultMultiplayerUrl();
    this.playerId = playerId || this.restoreSession()?.playerId || randomId('p');
    this.name = name || this.restoreName() || `Player ${this.playerId.slice(-4)}`;
    this.socket = null;
    this.state = CONNECTION_STATE.IDLE;
    this.room = null;
    this.game = null;
    this.progress = new Map(); // playerId → Map(cell → value)
    this.outbox = [];
    this.attempt = 0;
    this.manualClose = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  /* --------------------------- session ----------------------------- */

  restoreSession() {
    return readStoredSession();
  }

  restoreName() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(NAME_KEY) : null;
    } catch {
      return null;
    }
  }

  saveSession() {
    try {
      if (typeof sessionStorage === 'undefined' || !this.room) return;
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ roomCode: this.room.code, playerId: this.playerId, name: this.name }),
      );
    } catch (error) {
      console.warn('[multiplayer] could not persist session', error);
    }
  }

  clearSession() {
    try {
      sessionStorage?.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  setPlayerName(name) {
    this.name = (name || '').trim().slice(0, 18) || this.name;
    try {
      localStorage?.setItem(NAME_KEY, this.name);
    } catch {
      /* ignore */
    }
    return this.name;
  }

  setUrl(url) {
    if (!url || url === this.url) return;
    this.url = url;
    if (this.state === CONNECTION_STATE.CONNECTED) {
      this.disconnect();
      this.connect();
    }
  }

  /* ------------------------- connection --------------------------- */

  connect() {
    if (typeof WebSocket === 'undefined') {
      this.setState(CONNECTION_STATE.DISCONNECTED, 'WebSocket is not supported by this browser');
      return Promise.reject(new Error('WebSocket unsupported'));
    }
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) {
      return Promise.resolve(this.socket);
    }
    this.manualClose = false;
    this.setState(this.attempt === 0 ? CONNECTION_STATE.CONNECTING : CONNECTION_STATE.RECONNECTING);

    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        this.setState(CONNECTION_STATE.DISCONNECTED, error.message);
        reject(error);
        return;
      }
      this.socket = socket;
      let settled = false;

      const fail = (message) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };

      socket.onopen = () => {
        settled = true;
        this.attempt = 0;
        this.setState(CONNECTION_STATE.CONNECTED);
        this.startPing();
        // A reconnect (or a refreshed tab) rejoins the stored room first, so
        // queued messages still belong to a room we are a member of.
        if (!this.room) this.rejoinStoredSession();
        if (this.room) {
          this.flushOutbox();
          this.requestState();
        } else {
          this.outbox = [];
        }
        resolve(socket);
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => {
        this.emit('socket-error', { message: 'WebSocket error' });
      };
      socket.onclose = (event) => {
        this.stopPing();
        this.socket = null;
        if (this.manualClose) {
          this.setState(CONNECTION_STATE.DISCONNECTED);
          return;
        }
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        this.setState(offline ? CONNECTION_STATE.OFFLINE : CONNECTION_STATE.RECONNECTING);
        if (!this.online()) fail('offline');
        this.scheduleReconnect();
      };
    });
  }

  disconnect({ keepSession = false } = {}) {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    this.stopPing();
    this.attempt = 0;
    if (!keepSession) {
      this.room = null;
      this.game = null;
      this.progress.clear();
      this.clearSession();
    }
    if (this.socket) {
      try {
        this.socket.close(1000, 'client closed');
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.setState(CONNECTION_STATE.DISCONNECTED);
  }

  leaveRoom() {
    if (this.room) this.send({ type: MP.LEAVE_ROOM, roomId: this.room.id, playerId: this.playerId });
    this.disconnect();
  }

  online() {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt, 5));
    this.attempt++;
    this.emit('reconnect-scheduled', { attempt: this.attempt, delay });
    this.reconnectTimer = setTimeout(() => {
      if (this.manualClose) return;
      this.connect().catch(() => this.scheduleReconnect());
    }, delay + Math.floor(Math.random() * 250));
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: MP.PING, t: Date.now() }), 20000);
  }

  stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  setState(state, message = '') {
    this.state = state;
    this.emit('status', { state, message, online: this.online() });
  }

  get connected() {
    return Boolean(this.socket && this.socket.readyState === 1);
  }

  /* --------------------------- messaging --------------------------- */

  send(message) {
    const payload = { ...message, playerId: message.playerId || this.playerId };
    if (this.connected) {
      try {
        this.socket.send(JSON.stringify(payload));
        return true;
      } catch (error) {
        console.warn('[multiplayer] send failed, queueing', error);
      }
    }
    // Progress events are superseded by the next one, so keep only the latest
    // per cell to avoid flooding the server after a long offline stretch.
    if (payload.type === MP.PLAYER_PROGRESS) {
      this.outbox = this.outbox.filter(
        (item) => !(item.type === MP.PLAYER_PROGRESS && item.cell === payload.cell),
      );
    }
    this.outbox.push(payload);
    if (this.outbox.length > 200) this.outbox.shift();
    return false;
  }

  flushOutbox() {
    if (!this.outbox.length) return;
    const queued = this.outbox;
    this.outbox = [];
    for (const message of queued) this.send(message);
  }

  /** Rejoins the room remembered for this tab (server treats it as a reconnect). */
  rejoinStoredSession() {
    const session = readStoredSession();
    if (!session?.roomCode) return false;
    if (session.playerId && session.playerId !== this.playerId) return false;
    if (session.name) this.name = session.name;
    this.joinRoom({ roomCode: session.roomCode, name: this.name });
    return true;
  }

  createRoom({ difficulty = 'medium', name } = {}) {
    if (name) this.setPlayerName(name);
    return this.send({ type: MP.CREATE_ROOM, name: this.name, difficulty });
  }

  joinRoom({ roomCode, name } = {}) {
    if (name) this.setPlayerName(name);
    const code = String(roomCode || '').trim().toUpperCase();
    if (!code) return false;
    return this.send({ type: MP.JOIN_ROOM, roomId: code, roomCode: code, name: this.name });
  }

  setReady(ready) {
    return this.send({ type: MP.PLAYER_READY, roomId: this.roomId(), ready: Boolean(ready) });
  }

  startGame() {
    return this.send({ type: MP.START_GAME, roomId: this.roomId() });
  }

  requestState() {
    return this.send({ type: MP.REQUEST_STATE, roomId: this.roomId() });
  }

  sendProgress(cell, value, timestamp = Date.now()) {
    if (!this.room) return false;
    return this.send({ type: MP.PLAYER_PROGRESS, roomId: this.roomId(), cell, value, timestamp });
  }

  sendCompleted(board, timestamp = Date.now()) {
    if (!this.room) return false;
    return this.send({
      type: MP.PLAYER_COMPLETED,
      roomId: this.roomId(),
      board: board.slice(),
      clientTimestamp: timestamp,
    });
  }

  roomId() {
    return this.room?.id || null;
  }

  /* --------------------------- receiving --------------------------- */

  handleMessage(raw) {
    let message;
    try {
      message = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      console.warn('[multiplayer] dropped malformed message');
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    this.emit('message', message);

    switch (message.type) {
      case MP.ROOM_CREATED:
        this.room = message.room;
        this.saveSession();
        this.emit('room', this.room);
        break;
      case MP.ROOM_STATE:
        if (!message.room) break; // hello/empty snapshot — nothing to join
        this.room = message.room;
        this.saveSession();
        this.emit('room', this.room);
        if (message.game) this.applyGameStart(message.game);
        if (message.progress) this.applyProgressState(message.progress);
        if (message.room.status === 'finished' && Array.isArray(message.results) && message.results.length) {
          // Rejoining a room whose race is over: replay the stored verdict.
          this.emit('finished', {
            roomId: message.room.id,
            winnerId: message.room.winnerId,
            finishedAt: message.finishedAt,
            results: message.results,
            reason: message.reason || 'Race finished',
          });
        }
        break;
      case MP.PLAYER_JOINED:
        this.emit('player-joined', message.player);
        break;
      case MP.PLAYER_LEFT:
        this.emit('player-left', message.player);
        break;
      case MP.GAME_STARTED:
        this.applyGameStart(message);
        break;
      case MP.PROGRESS_STATE:
        this.applyProgressState(message.progress);
        break;
      case MP.PLAYER_PROGRESS:
        this.applyProgress(message.playerId, message.cell, message.value);
        this.emit('progress', message);
        break;
      case MP.PLAYER_COMPLETED:
        this.emit('opponent-completed', message);
        break;
      case MP.PLAYER_DISCONNECTED:
        this.emit('player-disconnected', message.player);
        break;
      case MP.PLAYER_RECONNECTED:
        this.emit('player-reconnected', message.player);
        break;
      case MP.GAME_FINISHED:
        this.emit('finished', message);
        break;
      case MP.PONG:
        break;
      case MP.ERROR:
        this.emit('server-error', { code: message.code, message: message.message });
        break;
      default:
        break;
    }
  }

  /** Server-authoritative game start: the shared seed defines the shared board. */
  applyGameStart(game) {
    this.game = {
      roomId: this.room?.id || game.roomId,
      puzzleId: game.puzzleId,
      seed: game.seed,
      difficulty: game.difficulty,
      startedAt: game.startedAt,
      status: game.status || 'playing',
    };
    this.emit('game-started', this.game);
  }

  applyProgressState(progress) {
    for (const [playerId, entries] of Object.entries(progress || {})) {
      const map = new Map();
      for (const entry of entries) map.set(entry.cell, entry.value);
      this.progress.set(playerId, map);
    }
    this.emit('progress-state', progress);
  }

  applyProgress(playerId, cell, value) {
    if (playerId === this.playerId) return;
    if (!this.progress.has(playerId)) this.progress.set(playerId, new Map());
    const map = this.progress.get(playerId);
    if (value) map.set(cell, value);
    else map.delete(cell);
  }

  opponentProgressRatio(totalEmpty) {
    for (const [playerId, map] of this.progress.entries()) {
      if (playerId === this.playerId) continue;
      if (!totalEmpty) return 0;
      return Math.max(0, Math.min(1, map.size / totalEmpty));
    }
    return 0;
  }

  opponent() {
    if (!this.room?.players) return null;
    return this.room.players.find((player) => player.id !== this.playerId) || null;
  }

  me() {
    return this.room?.players?.find((player) => player.id === this.playerId) || null;
  }
}
