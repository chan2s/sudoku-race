/**
 * sync.js — offline-first synchronization.
 *
 * Everything the player does is written locally first. Records that should also
 * reach the backend land in the `pendingSync` store and are flushed later:
 * on `online`, on a timer, and on demand. Failures never block gameplay — the
 * queue survives and is retried with exponential backoff.
 */

import { Emitter } from './game.js';
import { StorageManager, defaultStats } from './storage.js';

export const SYNC_STATUS = {
  OFFLINE: 'offline',
  ONLINE: 'online',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  ERROR: 'error',
};

const BACKOFF_MS = [2000, 5000, 15000, 60000, 300000];

/** Merges two stat snapshots without ever losing the better achievement. */
export function mergeStats(local, remote) {
  if (!remote) return local;
  const merged = { ...defaultStats(), ...local };
  merged.gamesPlayed = Math.max(local?.gamesPlayed || 0, remote.gamesPlayed || 0);
  merged.gamesCompleted = Math.max(local?.gamesCompleted || 0, remote.gamesCompleted || 0);
  merged.gamesFailed = Math.max(local?.gamesFailed || 0, remote.gamesFailed || 0);
  merged.totalCompletedMs = Math.max(local?.totalCompletedMs || 0, remote.totalCompletedMs || 0);
  merged.bestTimes = { ...defaultStats().bestTimes };
  for (const key of Object.keys(merged.bestTimes)) {
    const a = local?.bestTimes?.[key] ?? null;
    const b = remote.bestTimes?.[key] ?? null;
    merged.bestTimes[key] = a === null ? b : b === null ? a : Math.min(a, b);
  }
  return merged;
}

/** Cross-tab notifications so a second tab refreshes when the first one saves. */
export class CrossTab {
  constructor(name = 'sudoku-app') {
    this.channel = null;
    this.handlers = new Set();
    if (typeof BroadcastChannel === 'function') {
      try {
        this.channel = new BroadcastChannel(name);
        this.channel.onmessage = (event) => {
          for (const handler of this.handlers) {
            try {
              handler(event.data);
            } catch (error) {
              console.warn('[cross-tab] handler failed', error);
            }
          }
        };
      } catch (error) {
        console.warn('[cross-tab] BroadcastChannel unavailable', error);
      }
    }
  }

  post(type, payload = {}) {
    try {
      this.channel?.postMessage({ type, payload, at: Date.now() });
    } catch (error) {
      console.warn('[cross-tab] post failed', error);
    }
  }

  onMessage(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

export class SyncManager extends Emitter {
  constructor({ storage = StorageManager, endpoint = '', retryBase = BACKOFF_MS } = {}) {
    super();
    this.storage = storage;
    this.endpoint = endpoint;
    this.retryBase = retryBase;
    this.status = SYNC_STATUS.ONLINE;
    this.message = '';
    this.failures = 0;
    this.timer = null;
    this.flushing = false;
    this.started = false;
    this.backendReachable = true;
    this.isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  }

  start() {
    if (this.started) return this;
    this.started = true;
    if (typeof window !== 'undefined') {
      this.onOnline = () => this.handleOnline();
      this.onOffline = () => this.handleOffline();
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
    }
    this.setStatus(this.isOnline() ? SYNC_STATUS.ONLINE : SYNC_STATUS.OFFLINE);
    // Retry anything left over from a previous session.
    this.scheduleFlush(500);
    return this;
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
    }
    clearTimeout(this.timer);
  }

  setEndpoint(endpoint) {
    this.endpoint = endpoint || '';
    this.failures = 0;
    this.backendReachable = true;
  }

  get online() {
    return this.isOnline();
  }

  setStatus(status, message = '') {
    if (this.status === status && this.message === message) return;
    this.status = status;
    this.message = message;
    this.emit('status', { status, message, online: this.online });
  }

  handleOffline() {
    clearTimeout(this.timer);
    this.setStatus(SYNC_STATUS.OFFLINE, 'Offline — progress is saved on this device');
  }

  handleOnline() {
    this.failures = 0;
    this.backendReachable = true;
    this.setStatus(SYNC_STATUS.ONLINE, 'Back online');
    this.emit('online');
    this.flush();
  }

  scheduleFlush(delay = 30000) {
    clearTimeout(this.timer);
    if (!this.started) return;
    this.timer = setTimeout(() => this.flush(), delay);
  }

  /** Queues a local change for later upload and kicks off a flush when online. */
  async queue(record) {
    const entry = await this.storage.queueSync(record);
    this.emit('queued', entry);
    if (this.online) this.scheduleFlush(150);
    return entry;
  }

  async flush() {
    if (this.flushing) return { ok: false, reason: 'busy' };
    if (!this.online) {
      this.setStatus(SYNC_STATUS.OFFLINE, 'Offline — will sync automatically');
      return { ok: false, reason: 'offline' };
    }
    const pending = await this.storage.getPendingSync();
    if (!pending.length) {
      this.setStatus(SYNC_STATUS.SYNCED, 'Everything is up to date');
      return { ok: true, synced: 0 };
    }

    this.flushing = true;
    this.setStatus(SYNC_STATUS.SYNCING, `Syncing ${pending.length} change(s)…`);
    const target = this.endpoint || this.defaultEndpoint();
    let synced = 0;
    let lastError = null;

    for (const record of pending) {
      if (!this.online) break;
      try {
        const remote = await this.postRecord(target, record);
        await this.storage.markSynced(record.id);
        synced++;
        if (remote?.stats) this.emit('remote-stats', remote.stats);
      } catch (error) {
        lastError = error;
        await this.storage.markSyncFailed(record.id, error?.message || error);
      }
    }

    this.flushing = false;

    if (lastError) {
      this.failures++;
      this.backendReachable = false;
      this.setStatus(
        SYNC_STATUS.ERROR,
        'Sync failed. Your local progress is safe. We’ll try again automatically.',
      );
      const delay = this.retryBase[Math.min(this.failures - 1, this.retryBase.length - 1)];
      this.scheduleFlush(delay);
      this.emit('error', { error: lastError, synced });
      return { ok: false, synced, error: lastError };
    }

    const remaining = await this.storage.pendingSyncCount();
    if (remaining > 0) {
      this.setStatus(SYNC_STATUS.SYNCING, `${remaining} change(s) waiting`);
      this.scheduleFlush(2000);
      return { ok: true, synced, pending: remaining };
    }
    this.failures = 0;
    this.backendReachable = true;
    this.setStatus(SYNC_STATUS.SYNCED, 'Synced');
    this.emit('synced', { count: synced });
    this.scheduleFlush(60000);
    return { ok: true, synced };
  }

  defaultEndpoint() {
    if (typeof location === 'undefined') return '';
    if (!/^https?:$/.test(location.protocol)) return '';
    return `${location.origin}/api/sync`;
  }

  async postRecord(endpoint, record) {
    if (!endpoint) throw new Error('no sync endpoint configured');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), 8000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: record.id,
          type: record.type,
          payload: record.payload,
          createdAt: record.createdAt,
          updatedAt: record.payload?.updatedAt || record.createdAt,
        }),
        signal: controller?.signal,
      });
      if (!response.ok) throw new Error(`sync endpoint responded ${response.status}`);
      return await response.json().catch(() => ({}));
    } finally {
      clearTimeout(timeout);
    }
  }
}
