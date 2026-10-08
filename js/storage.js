/**
 * storage.js — local persistence behind a single async API.
 *
 * The rest of the app never touches IndexedDB directly: it calls
 * StorageManager.saveGame(...) / loadGame() / saveStats(...) / getPendingSync()
 * / markSynced(id) and so on. If IndexedDB is unavailable (private mode, old
 * browser) the module transparently falls back to localStorage.
 */

const DB_NAME = 'sudoku-offline-db';
const DB_VERSION = 1;
const STORES = ['games', 'stats', 'history', 'settings', 'pendingSync'];
const KEY_PREFIX = 'sudoku:';

class IndexedDbBackend {
  constructor() {
    this.db = null;
  }

  static get available() {
    try {
      return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch {
      return false;
    }
  }

  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        this.db = db;
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
    });
  }

  async run(store, mode, work) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const objectStore = tx.objectStore(store);
      let result;
      try {
        result = work(objectStore);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result && result.__request ? result.__request.result : result);
      tx.onerror = () => reject(tx.error || new Error('Transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  put(store, value) {
    return this.run(store, 'readwrite', (os) => ({ __request: os.put(value) }));
  }

  get(store, id) {
    return this.run(store, 'readonly', (os) => ({ __request: os.get(id) }));
  }

  getAll(store) {
    return this.run(store, 'readonly', (os) => ({ __request: os.getAll() }));
  }

  delete(store, id) {
    return this.run(store, 'readwrite', (os) => ({ __request: os.delete(id) }));
  }

  clear(store) {
    return this.run(store, 'readwrite', (os) => ({ __request: os.clear() }));
  }
}

class LocalStorageBackend {
  static read(store) {
    try {
      return JSON.parse(localStorage.getItem(`${KEY_PREFIX}${store}`) || '{}');
    } catch {
      return {};
    }
  }

  static write(store, data) {
    try {
      localStorage.setItem(`${KEY_PREFIX}${store}`, JSON.stringify(data));
    } catch (error) {
      console.warn('[storage] localStorage write failed', error);
    }
  }

  open() {
    return Promise.resolve();
  }

  async put(store, value) {
    const data = LocalStorageBackend.read(store);
    data[value.id] = value;
    LocalStorageBackend.write(store, data);
  }

  async get(store, id) {
    return LocalStorageBackend.read(store)[id];
  }

  async getAll(store) {
    return Object.values(LocalStorageBackend.read(store));
  }

  async delete(store, id) {
    const data = LocalStorageBackend.read(store);
    delete data[id];
    LocalStorageBackend.write(store, data);
  }

  async clear(store) {
    LocalStorageBackend.write(store, {});
  }
}

const DEFAULT_SETTINGS = {
  highlightDuplicates: true,
  autoRemoveNotes: true,
  mistakeLimit: 3,
  syncEndpoint: '',
  multiplayerUrl: '',
  theme: 'dark',
};

export function defaultStats() {
  return {
    gamesPlayed: 0,
    gamesCompleted: 0,
    gamesFailed: 0,
    bestTimes: { easy: null, medium: null, hard: null, expert: null },
    totalCompletedMs: 0,
  };
}

export function defaultMultiplayerStats() {
  return { gamesPlayed: 0, wins: 0, losses: 0 };
}

let idCounter = 0;
function newId(prefix = 'rec') {
  idCounter = (idCounter + 1) % 1000;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

class LocalStore {
  constructor() {
    this.backend = null;
    this.backendName = 'memory';
    this.memory = new Map();
  }

  async init() {
    if (this.backend) return this;
    if (IndexedDbBackend.available) {
      try {
        const backend = new IndexedDbBackend();
        await backend.open();
        this.backend = backend;
        this.backendName = 'indexeddb';
        return this;
      } catch (error) {
        console.warn('[storage] IndexedDB unavailable, falling back to localStorage', error);
      }
    }
    if (typeof localStorage !== 'undefined') {
      this.backend = new LocalStorageBackend();
      this.backendName = 'localstorage';
    } else {
      this.backend = new LocalStorageBackend(); // memory-only shim for tests
    }
    return this;
  }

  /** Never throws: corrupted or half-written records simply read as absent. */
  async safe(work, fallback = null) {
    try {
      await this.init();
      return await work();
    } catch (error) {
      console.warn('[storage] operation failed', error);
      return fallback;
    }
  }

  /* ----------------------------- games ----------------------------- */

  saveGame(game) {
    // `id` must win over the caller's object so there is exactly one active game
    // slot; the game's own identifier is kept as `gameId`.
    return this.safe(() => this.backend.put('games', { ...game, gameId: game.id, id: 'current' }));
  }

  loadGame() {
    return this.safe(async () => {
      const record = await this.backend.get('games', 'current');
      return record ? { ...record } : null;
    });
  }

  clearGame() {
    return this.safe(() => this.backend.delete('games', 'current'));
  }

  /* ----------------------------- stats ----------------------------- */

  async getStats() {
    const stats = await this.safe(() => this.backend.get('stats', 'single'));
    const merged = { ...defaultStats(), ...(stats || {}) };
    merged.bestTimes = { ...defaultStats().bestTimes, ...(stats?.bestTimes || {}) };
    return merged;
  }

  saveStats(stats) {
    return this.safe(() => this.backend.put('stats', { ...stats, id: 'single' }));
  }

  async getMultiplayerStats() {
    const stats = await this.safe(() => this.backend.get('stats', 'multiplayer'));
    return { ...defaultMultiplayerStats(), ...(stats || {}) };
  }

  saveMultiplayerStats(stats) {
    return this.safe(() => this.backend.put('stats', { ...stats, id: 'multiplayer' }));
  }

  /* ---------------------------- history ---------------------------- */

  addHistory(record) {
    const entry = { id: record.id || newId('game'), createdAt: Date.now(), ...record };
    return this.safe(async () => {
      await this.backend.put('history', entry);
      return entry;
    }, entry);
  }

  async getHistory(limit = 50) {
    const rows = await this.safe(() => this.backend.getAll('history'), []);
    return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  /* ---------------------------- settings --------------------------- */

  async getSettings() {
    const saved = await this.safe(() => this.backend.get('settings', 'app'));
    return { ...DEFAULT_SETTINGS, ...(saved || {}) };
  }

  saveSettings(settings) {
    return this.safe(() => this.backend.put('settings', { ...settings, id: 'app' }));
  }

  /* -------------------------- sync queue --------------------------- */

  /** Queues a mutation for the backend; the record stays until markSynced(). */
  queueSync(record) {
    const entry = {
      id: record.id || newId('sync'),
      createdAt: Date.now(),
      attempts: 0,
      synced: false,
      lastError: null,
      ...record,
    };
    entry.id = record.id || entry.id;
    return this.safe(async () => {
      await this.backend.put('pendingSync', entry);
      return entry;
    }, entry);
  }

  async getPendingSync() {
    const rows = await this.safe(() => this.backend.getAll('pendingSync'), []);
    return rows.filter((row) => row && !row.synced).sort((a, b) => a.createdAt - b.createdAt);
  }

  async allSyncRecords() {
    return this.safe(() => this.backend.getAll('pendingSync'), []);
  }

  markSynced(id) {
    return this.safe(async () => {
      const record = await this.backend.get('pendingSync', id);
      if (!record) return false;
      await this.backend.put('pendingSync', { ...record, synced: true, syncedAt: Date.now() });
      return true;
    }, false);
  }

  markSyncFailed(id, error) {
    return this.safe(async () => {
      const record = await this.backend.get('pendingSync', id);
      if (!record) return false;
      await this.backend.put('pendingSync', {
        ...record,
        attempts: (record.attempts || 0) + 1,
        lastError: String(error || 'unknown error'),
      });
      return true;
    }, false);
  }

  async pendingSyncCount() {
    return (await this.getPendingSync()).length;
  }

  /* ------------------------------ misc ----------------------------- */

  async wipe() {
    await this.safe(async () => {
      for (const store of STORES) await this.backend.clear(store);
    });
  }

  async usage() {
    const [game, history, pending] = await Promise.all([
      this.loadGame(),
      this.getHistory(500),
      this.getPendingSync(),
    ]);
    return {
      backend: this.backendName,
      hasGame: Boolean(game),
      historyCount: history.length,
      pendingCount: pending.length,
    };
  }
}

/** Shared singleton — `StorageManager.saveGame(game)` etc. */
export const StorageManager = new LocalStore();
export { DEFAULT_SETTINGS, newId };
