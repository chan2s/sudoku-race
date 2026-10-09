/**
 * chat.js — real-time multiplayer chat layered on the existing room WebSocket.
 *
 * It deliberately owns no sockets of its own: every message travels through
 * MultiplayerClient's room connection, the server stamps and orders it, and
 * the sender's copy is the server's own echo (so ordering matches the other
 * player's exactly). History is server-side; localStorage is never a source
 * of truth. This module touches nothing about Sudoku gameplay.
 */

import { MP } from './multiplayer.js';
import { Emitter } from './game.js';

export const CHAT_STATUS = {
  noRoom: 'noRoom', // no room joined yet
  connected: 'connected', // room joined, socket live
  reconnecting: 'reconnecting', // room joined, socket re-establishing
  disconnected: 'disconnected', // room joined, socket down
  closed: 'closed', // room permanently gone — input disabled
};

export const CHAT_MAX_LENGTH = 250;
const MAX_MESSAGES = 200;

export class ChatClient extends Emitter {
  constructor({ client }) {
    super();
    this.client = client;
    this.messages = []; // {type:'chat'|'system', playerId?, playerName?, message|text, timestamp}
    this.status = CHAT_STATUS.noRoom;
    this.unreadCount = 0;
    this.roomId = null;
    this.bound = false;
    this.unsubs = [];
    // The UI reports whether its panel can currently be seen; unread badges
    // only make sense when the message landed out of sight.
    this.isVisible = () => false;
  }

  attach() {
    if (this.bound) return;
    this.bound = true;
    const client = this.client;
    this.unsubs = [
      client.on('chat-message', (message) => this.onChatMessage(message)),
      client.on('chat-history', (message) => this.onChatHistory(message)),
      client.on('chat-error', (error) => this.emit('chat-error', error)),
      client.on('room', () => this.syncFromClient()),
      client.on('status', () => this.onConnectionState()),
      client.on('player-disconnected', (message) =>
        this.addSystemNote(`${message.player?.name || 'Opponent'} disconnected — the race continues.`),
      ),
      client.on('player-reconnected', (message) =>
        this.addSystemNote(`${message.player?.name || 'Opponent'} reconnected.`),
      ),
    ];
  }

  detach() {
    for (const off of this.unsubs.splice(0)) off?.();
    this.bound = false;
  }

  /* ----------------------------- status ----------------------------- */

  /** Recomputes chat state from the multiplayer client's live room/status. */
  syncFromClient() {
    const client = this.client;
    const room = client?.room || null;
    if (!room) {
      if (this.roomId) this.setStatus(CHAT_STATUS.closed);
      return;
    }
    if (room.id !== this.roomId) {
      // Different room than before: clean slate — the server replays its
      // own history for this room, so nothing is lost on a fresh join.
      this.roomId = room.id;
      this.messages = [];
      this.unreadCount = 0;
      this.emit('unread', { count: 0 });
    }
    this.applyConnectionStatus();
    if (client.connected) this.requestHistory();
  }

  onConnectionState() {
    if (!this.client?.room) {
      if (this.roomId) this.setStatus(CHAT_STATUS.closed);
      return;
    }
    this.applyConnectionStatus();
    // A fresh socket may have missed messages while it was down.
    if (this.client.connected) this.requestHistory();
  }

  applyConnectionStatus() {
    if (this.client.connected) this.setStatus(CHAT_STATUS.connected);
    else if (this.client.state === 'reconnecting' || this.client.state === 'connecting') {
      this.setStatus(CHAT_STATUS.reconnecting);
    } else this.setStatus(CHAT_STATUS.disconnected);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status-change', { status });
  }

  /* ---------------------------- messages ---------------------------- */

  requestHistory() {
    try {
      this.client.requestChatHistory();
    } catch {
      /* history is optional; live messages still work */
    }
  }

  onChatMessage(message) {
    const normalized = normalizeChatMessage(message);
    if (!normalized) return;
    this.append(normalized);
  }

  /**
   * The server's history is authoritative. Merge rather than overwrite so a
   * message that landed between the snapshot and the response is not lost.
   */
  onChatHistory(message) {
    if (!message || !Array.isArray(message.messages)) return;
    const incoming = message.messages.map(normalizeChatMessage).filter(Boolean);
    const seen = new Set(incoming.map(messageKey));
    const merged = [...incoming];
    for (const live of this.messages) {
      if (live.type !== 'chat' || seen.has(messageKey(live))) continue;
      merged.push(live);
    }
    merged.sort((a, b) => a.timestamp - b.timestamp);
    this.messages = merged.slice(-MAX_MESSAGES);
    this.emit('messages', { messages: this.messages.slice() });
  }

  append(entry) {
    this.messages.push(entry);
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
    if (!this.isVisible()) {
      this.unreadCount++;
      this.emit('unread', { count: this.unreadCount });
    }
    this.emit('messages', { messages: this.messages.slice() });
    this.emit('message', entry);
  }

  /** Local, non-network note (opponent disconnect/reconnect status). */
  addSystemNote(text) {
    if (!this.client?.room) return;
    this.append({ type: 'system', text, timestamp: Date.now() });
  }

  /* ----------------------------- actions ---------------------------- */

  send(text) {
    const value = String(text ?? '').trim();
    if (!value) return { ok: false, reason: 'empty' };
    if (value.length > CHAT_MAX_LENGTH) return { ok: false, reason: 'too-long' };
    if (!this.client?.room) return { ok: false, reason: 'no-room' };
    if (this.status === CHAT_STATUS.closed) return { ok: false, reason: 'closed' };
    if (!this.client.connected) return { ok: false, reason: 'offline' };
    if (!this.client.sendChatMessage(value)) return { ok: false, reason: 'send-failed' };
    return { ok: true };
  }

  clearUnread() {
    if (!this.unreadCount) return;
    this.unreadCount = 0;
    this.emit('unread', { count: 0 });
  }
}

/* --------------------------- message shaping ------------------------- */

function normalizeChatMessage(message) {
  if (!message || typeof message !== 'object') return null;
  // Live broadcasts carry type === CHAT_MESSAGE; history entries do not.
  if (message.type && message.type !== MP.CHAT_MESSAGE) return null;
  const text = typeof message.message === 'string' ? message.message : '';
  if (!text) return null;
  const timestamp = Number(message.timestamp);
  return {
    type: 'chat',
    playerId: typeof message.playerId === 'string' ? message.playerId : null,
    playerName: typeof message.playerName === 'string' ? message.playerName : 'Player',
    message: text,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  };
}

function messageKey(message) {
  return `${message.playerId ?? ''}:${message.timestamp}:${message.message}`;
}
