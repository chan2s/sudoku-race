/**
 * app.js — application bootstrap and glue.
 *
 * Owns the lifecycle: routing, persistence, statistics, offline sync and the
 * multiplayer session. The engine holds the rules, the UI renders, this file
 * connects the two to storage and the network.
 */

import { StorageManager, defaultStats, DEFAULT_SETTINGS } from './js/storage.js';
import { GameEngine, GAME_STATUS, CorruptGameError } from './js/game.js';
import { SyncManager, CrossTab, SYNC_STATUS, mergeStats } from './js/sync.js';
import {
  MultiplayerClient,
  CONNECTION_STATE,
  MP_ERRORS,
  defaultMultiplayerUrl,
  readStoredSession,
} from './js/multiplayer.js';
import { UI } from './js/ui.js';
import { formatTime } from './js/timer.js';

const TICK_MS = 250;
const SAVE_DEBOUNCE_MS = 350;

const MP_ERROR_MESSAGES = {
  [MP_ERRORS.ROOM_NOT_FOUND]: 'Room not found. Check the code and try again.',
  [MP_ERRORS.ROOM_FULL]: 'That room already has two players.',
  [MP_ERRORS.ROOM_IN_PROGRESS]: 'That race has already started. Ask your friend to create a new room.',
  [MP_ERRORS.INVALID_SOLUTION]: 'The server rejected your finished board — it did not match the shared puzzle.',
  [MP_ERRORS.NOT_IN_ROOM]: 'You are no longer part of that room.',
  [MP_ERRORS.SERVER_UNAVAILABLE]: 'The multiplayer server is unavailable. Single player still works offline.',
};

class SudokuApp {
  constructor() {
    this.storage = StorageManager;
    this.sync = new SyncManager({ storage: StorageManager });
    this.crossTab = new CrossTab('sudoku-app');
    this.client = null;
    this.engine = null;
    this.settings = { ...DEFAULT_SETTINGS, playerName: '' };
    this.stats = defaultStats();
    this.mpStats = { gamesPlayed: 0, wins: 0, losses: 0 };
    this.installPrompt = null;
    this.saveTimer = null;
    this.tickTimer = null;
    this.mpPuzzleId = null;
    this.screen = 'home';
    this.ui = new UI({
      onNavigate: (screen) => this.navigate(screen),
      onNewGame: (difficulty) => this.startSinglePlayer(difficulty),
      onResumeGame: () => this.resumeSavedGame(),
      onCellSelect: (index) => this.engine?.select(index),
      onValueInput: (value) => this.inputValue(value),
      onErase: () => this.erase(),
      onUndo: () => this.engine?.undo(),
      onPauseToggle: () => this.togglePause(),
      onRestart: () => this.restartGame(),
      onQuitGame: () => this.quitGame(),
      onCreateRoom: (difficulty, name) => this.createRoom(difficulty, name),
      onJoinRoom: (code, name) => this.joinRoom(code, name),
      onToggleReady: () => this.toggleReady(),
      onStartGame: () => this.startRace(),
      onLeaveRoom: () => this.leaveRoom(),
      onSaveSettings: (patch) => this.saveSettings(patch),
      onExportData: () => this.exportData(),
      onClearData: () => this.clearData(),
      onInstall: () => this.promptInstall(),
    });
  }

  /* ------------------------------ boot ----------------------------- */

  async init() {
    this.ui.mount();
    await this.storage.init();
    this.settings = await this.loadSettings();
    this.stats = await this.storage.getStats();
    this.mpStats = await this.storage.getMultiplayerStats();
    this.ui.applySettings(this.settings);
    this.ui.stats = this.stats;
    this.ui.mpStats = this.mpStats;
    this.ui.history = await this.storage.getHistory();
    this.ui.renderDifficulty();
    this.ui.renderStats();

    await this.restoreSavedGame();

    this.sync.setEndpoint(this.settings.syncEndpoint || '');
    this.sync.on('status', ({ status, message }) => {
      this.ui.setStatus({ online: navigator.onLine !== false, syncStatus: status, message });
      if (status === SYNC_STATUS.SYNCED || status === SYNC_STATUS.OFFLINE) this.refreshStorageInfo();
    });
    this.sync.on('remote-stats', (remoteStats) => this.applyRemoteStats(remoteStats));
    this.sync.start();

    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => {
      this.ui.setStatus({ online: false, syncStatus: SYNC_STATUS.OFFLINE, message: 'Offline' });
      this.ui.showToast('Offline — single player keeps working');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.persistNow();
    });
    window.addEventListener('pagehide', () => this.persistNow());
    window.addEventListener('beforeunload', () => this.persistNow());
    window.addEventListener('hashchange', () => this.applyRoute());
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.installPrompt = event;
      this.ui.setInstallAvailable(true);
    });
    window.addEventListener('appinstalled', () => {
      this.installPrompt = null;
      this.ui.setInstallAvailable(false);
    });

    this.crossTab.onMessage((message) => this.handleCrossTabMessage(message));

    this.tickTimer = window.setInterval(() => this.tick(), TICK_MS);
    this.applyRoute(true);
    this.refreshStorageInfo();
    this.registerServiceWorker();
    this.resumeMultiplayerSession();
    return this;
  }

  /**
   * A refresh in the middle of a race (or a reopened tab) rejoins the stored
   * room so the server can hand back the puzzle, the clock and the progress.
   */
  resumeMultiplayerSession() {
    const session = readStoredSession();
    if (!session?.roomCode) return;
    const client = this.ensureClient();
    client.connect().catch(() => {
      // Offline or the server is down: the lobby screen offers a retry.
      this.ui.setConnection({ state: CONNECTION_STATE.RECONNECTING, message: 'server unreachable' });
    });
  }

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return; // service workers need http(s)
    const register = () => {
      navigator.serviceWorker.register('sw.js').catch((error) => {
        console.warn('[app] service worker registration failed', error);
      });
    };
    // init() runs after `load` in most cases, so check instead of waiting blindly.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  async loadSettings() {
    const saved = await this.storage.getSettings();
    let playerName = saved.playerName || '';
    try {
      playerName = playerName || localStorage.getItem('sudoku:player-name') || '';
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_SETTINGS, ...saved, playerName };
  }

  /* ---------------------------- routing ---------------------------- */

  navigate(screen) {
    const hash = `#/${screen}`;
    if (location.hash === hash) this.showScreen(screen);
    else location.hash = hash;
  }

  applyRoute(initial = false) {
    const requested = (location.hash.replace(/^#\/?/, '') || 'home').split('/')[0];
    let target = requested;
    if (target === 'game' && !this.engine) {
      // Refreshed while playing: pick the saved game straight back up.
      if (this.engineSavedState) {
        this.resumeSavedGame();
        return;
      }
      target = 'home';
    }
    if (!initial && target === this.screen) return;
    this.showScreen(target);
  }

  showScreen(screen) {
    // Leaving the multiplayer lobby closes the socket unless a race is running.
    if (this.screen === 'multiplayer' && screen !== 'multiplayer' && screen !== 'game') {
      if (!this.engine || this.engine.mode !== 'multiplayer') this.teardownMultiplayer();
    }
    this.screen = screen;
    this.ui.showScreen(screen);
    if (screen === 'difficulty') this.ui.renderDifficulty();
    if (screen === 'stats') {
      this.ui.stats = this.stats;
      this.ui.mpStats = this.mpStats;
      this.ui.renderStats();
    }
    if (screen === 'settings') {
      this.ui.renderSettingsForm();
      this.refreshStorageInfo();
    }
    if (screen === 'multiplayer') this.openMultiplayer();
    if (screen === 'home') this.ui.renderResumeBanner(this.engineSavedState);
    if (screen === 'game') {
      this.ui.setGame(this.engine);
      this.ui.hideOverlay();
      this.ui.renderOverlay();
      window.setTimeout(() => this.ui.cells[this.engine?.selectedIndex ?? 0]?.focus(), 60);
    }
  }

  /* ------------------------- single player ------------------------- */

  mistakeLimit() {
    const configured = Number(this.settings.mistakeLimit);
    return configured > 0 ? configured : Infinity;
  }

  attachEngine(engine, { fresh = false } = {}) {
    this.detachEngine();
    this.engine = engine;
    this.engine.on('change', () => {
      this.ui.renderGame();
      this.ui.renderResumeBanner(null);
      this.schedulePersist();
    });
    this.engine.on('mistake', ({ mistakes }) => {
      this.ui.announce(`Incorrect number. Mistake ${mistakes} of ${this.engine.mistakeLimit}.`);
      this.ui.vibrate([24, 40, 24]);
    });
    this.engine.on('complete', (payload) => this.handleComplete(payload));
    this.engine.on('failed', (payload) => this.handleFailed(payload));
    this.ui.setGame(engine);
    this.ui.renderResumeBanner(null);
    if (fresh) {
      this.stats.gamesPlayed = (this.stats.gamesPlayed || 0) + 1;
      this.storage.saveStats(this.stats);
      this.ui.stats = this.stats;
      this.queueSync('stats', this.stats);
    }
    this.schedulePersist(0);
  }

  detachEngine() {
    this.engine = null;
    this.ui.engine = null;
    clearTimeout(this.saveTimer);
  }

  startSinglePlayer(difficulty = 'easy', { seed, fresh = true } = {}) {
    let engine;
    try {
      engine = GameEngine.create({ difficulty, seed, mode: 'single', mistakeLimit: this.mistakeLimit() });
    } catch (error) {
      console.error('[app] could not generate puzzle', error);
      this.ui.showToast('Could not generate a puzzle — try again');
      return null;
    }
    this.attachEngine(engine, { fresh });
    this.navigate('game');
    this.ui.announce(`New ${difficulty} puzzle. Timer started.`);
    return engine;
  }

  async restoreSavedGame() {
    const state = await this.storage.loadGame();
    if (!state) return null;
    try {
      const engine = GameEngine.fromState(state);
      // A game that was running keeps counting from its stored offset.
      if (engine.status === GAME_STATUS.PLAYING && !engine.timer.running) engine.timer.resume();
      if (engine.status === GAME_STATUS.PAUSED) engine.timer.pause();
      this.engineSavedState = engine.toState();
      this.ui.renderResumeBanner(this.engineSavedState);
      return engine;
    } catch (error) {
      const corrupt = error instanceof CorruptGameError;
      console.warn('[app] discarding saved game', error);
      await this.storage.clearGame();
      this.queueSync('game-discarded', { reason: corrupt ? 'corrupt' : 'error' });
      this.ui.showToast('Saved game was damaged — starting fresh');
      return null;
    }
  }

  resumeSavedGame() {
    const state = this.engineSavedState;
    if (!state) {
      this.navigate('difficulty');
      return null;
    }
    let engine;
    try {
      engine = GameEngine.fromState(state);
      if (engine.status === GAME_STATUS.PLAYING) engine.timer.resume();
    } catch (error) {
      console.error('[app] resume failed', error);
      this.ui.showToast('Saved game was damaged — starting fresh');
      this.engineSavedState = null;
      this.navigate('difficulty');
      return null;
    }
    this.attachEngine(engine, { fresh: false });
    this.engineSavedState = null;
    this.navigate('game');
    this.ui.announce('Game resumed');
    return engine;
  }

  inputValue(value) {
    const engine = this.engine;
    if (!engine) return;
    if (engine.status === GAME_STATUS.PAUSED) {
      this.ui.showToast('Game is paused');
      return;
    }
    if (engine.selectedIndex === null) {
      this.ui.showToast('Select a cell first');
      return;
    }
    const index = engine.selectedIndex;
    const result = engine.setValue(index, value);
    if (!result.changed) return;
    if (engine.mode === 'multiplayer') this.sendProgress(index, engine.valueAt(index));
  }

  erase() {
    const engine = this.engine;
    if (!engine || engine.selectedIndex === null) return;
    const index = engine.selectedIndex;
    const result = engine.erase(index);
    if (result.changed && engine.mode === 'multiplayer') this.sendProgress(index, 0);
  }

  togglePause() {
    const engine = this.engine;
    if (!engine || engine.mode === 'multiplayer') return; // a race cannot be paused
    if (engine.status === GAME_STATUS.PLAYING) {
      engine.pause();
      this.persistNow();
    } else if (engine.status === GAME_STATUS.PAUSED) {
      engine.resume();
    }
  }

  restartGame() {
    const engine = this.engine;
    if (!engine) return;
    engine.restart();
    if (engine.mode === 'multiplayer') this.sendProgress(0, 0);
    this.persistNow();
    this.ui.announce('Puzzle restarted');
  }

  quitGame() {
    const engine = this.engine;
    if (engine?.mode === 'multiplayer') {
      this.leaveRoom();
      return;
    }
    if (engine && engine.status === GAME_STATUS.PLAYING) {
      engine.pause();
      this.engineSavedState = engine.toState();
      this.persistNow();
    }
    this.navigate('home');
  }

  /* --------------------------- statistics -------------------------- */

  handleComplete({ elapsedMs, difficulty, mode }) {
    if (mode === 'multiplayer') {
      this.ui.setYou({ progress: 1, done: true, finalMs: elapsedMs });
      this.ui.announce('Puzzle complete — waiting for the server result.');
      this.sendCompleted();
      this.persistNow();
      return;
    }
    const stats = this.stats;
    stats.gamesCompleted = (stats.gamesCompleted || 0) + 1;
    stats.totalCompletedMs = (stats.totalCompletedMs || 0) + elapsedMs;
    const previousBest = stats.bestTimes?.[difficulty] ?? null;
    stats.bestTimes = { ...stats.bestTimes, [difficulty]: previousBest === null ? elapsedMs : Math.min(previousBest, elapsedMs) };
    this.storage.saveStats(stats);
    this.ui.stats = stats;
    this.storage.addHistory({
      difficulty,
      mode: 'single',
      elapsedMs,
      result: 'completed',
      completedAt: Date.now(),
    });
    this.queueSync('stats', stats);
    this.queueSync('game-result', { difficulty, mode: 'single', elapsedMs, result: 'completed' });
    this.refreshStatsViews();
    this.persistNow();
    this.ui.announce(`Puzzle solved in ${formatTime(elapsedMs)}.`);
    this.ui.vibrate([40, 60, 40]);
    this.crossTab.post('stats-updated', {});
  }

  handleFailed({ reason, elapsedMs, difficulty }) {
    if (this.engine?.mode === 'multiplayer') return;
    const stats = this.stats;
    stats.gamesFailed = (stats.gamesFailed || 0) + 1;
    this.storage.saveStats(stats);
    this.ui.stats = stats;
    this.storage.addHistory({ difficulty, mode: 'single', elapsedMs, result: 'failed', reason });
    this.queueSync('stats', stats);
    this.queueSync('game-result', { difficulty, mode: 'single', elapsedMs, result: 'failed', reason });
    this.refreshStatsViews();
    this.persistNow();
  }

  async refreshStatsViews() {
    this.ui.history = await this.storage.getHistory();
    this.ui.renderStats();
    this.ui.renderDifficulty();
  }

  applyRemoteStats(remoteStats) {
    if (!remoteStats) return;
    this.stats = mergeStats(this.stats, remoteStats);
    this.storage.saveStats(this.stats);
    this.ui.stats = this.stats;
    this.refreshStatsViews();
  }

  /* ---------------------------- storage ---------------------------- */

  schedulePersist(delay = SAVE_DEBOUNCE_MS) {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persistNow(), delay);
  }

  persistNow() {
    clearTimeout(this.saveTimer);
    const engine = this.engine;
    if (!engine) return;
    const state = engine.toState();
    this.engineSavedState = state.status === GAME_STATUS.COMPLETED || state.status === GAME_STATUS.FAILED
      ? null
      : state;
    this.storage.saveGame(state);
    this.queueSync('game-state', state);
    this.crossTab.post('game-updated', {});
  }

  async queueSync(type, payload) {
    try {
      await this.sync.queue({ type, payload, updatedAt: Date.now() });
    } catch (error) {
      console.warn('[app] could not queue sync record', error);
    }
  }

  async refreshStorageInfo() {
    const usage = await this.storage.usage();
    this.ui.renderStorageInfo({
      backend: usage.backend,
      pending: usage.pendingCount,
      description:
        `${usage.historyCount} game(s) in history · ` +
        `${usage.hasGame ? 'unfinished game saved' : 'no game in progress'}`,
    });
  }

  handleCrossTabMessage(message) {
    // Another tab changed persisted state: reload what affects this view.
    if (message.type === 'stats-updated') {
      this.storage.getStats().then((stats) => {
        this.stats = stats;
        this.ui.stats = stats;
        this.refreshStatsViews();
      });
    }
    if (message.type === 'game-updated' && !this.engine) {
      this.storage.loadGame().then((state) => {
        this.engineSavedState = state;
        if (this.screen === 'home') this.ui.renderResumeBanner(state);
      });
    }
    if (message.type === 'data-cleared') {
      this.ui.showToast('Local data was cleared in another tab');
    }
  }

  handleOnline() {
    this.ui.setStatus({ online: true, syncStatus: SYNC_STATUS.ONLINE, message: 'Back online' });
    this.ui.showToast('Back online — syncing…');
    this.sync.flush();
    if (this.client && !this.client.connected) {
      this.client.connect().catch(() => this.ui.setConnection({ state: CONNECTION_STATE.RECONNECTING }));
    }
  }

  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    if (patch.playerName) {
      try {
        localStorage.setItem('sudoku:player-name', patch.playerName);
      } catch {
        /* ignore */
      }
      this.client?.setPlayerName(patch.playerName);
    }
    await this.storage.saveSettings(this.settings);
    this.sync.setEndpoint(this.settings.syncEndpoint || '');
    this.client?.setUrl(this.settings.multiplayerUrl || '');
    this.ui.applySettings(this.settings);
    await this.queueSync('settings', this.settings);
    this.ui.showToast('Settings saved');
  }

  async exportData() {
    const payload = {
      exportedAt: new Date().toISOString(),
      settings: this.settings,
      stats: this.stats,
      multiplayerStats: this.mpStats,
      history: await this.storage.getHistory(500),
      currentGame: await this.storage.loadGame(),
      pendingSync: await this.storage.allSyncRecords(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sudoku-export-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    this.ui.showToast('Data exported');
  }

  async clearData() {
    const confirmed = window.confirm(
      'Delete all local Sudoku data (current game, statistics, history, sync queue)?',
    );
    if (!confirmed) return;
    await this.storage.wipe();
    this.engineSavedState = null;
    this.stats = defaultStats();
    this.mpStats = { gamesPlayed: 0, wins: 0, losses: 0 };
    this.ui.stats = this.stats;
    this.ui.mpStats = this.mpStats;
    this.ui.history = [];
    this.crossTab.post('data-cleared', {});
    this.ui.renderStats();
    this.ui.renderDifficulty();
    this.ui.renderResumeBanner(null);
    this.refreshStorageInfo();
    this.ui.showToast('Local data cleared');
  }

  async promptInstall() {
    if (!this.installPrompt) {
      this.ui.showToast('Use your browser menu → “Install app”');
      return;
    }
    this.installPrompt.prompt();
    const choice = await this.installPrompt.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') this.ui.setInstallAvailable(false);
    this.installPrompt = null;
  }

  /* -------------------------- multiplayer -------------------------- */

  openMultiplayer() {
    this.ui.setConnection({ state: CONNECTION_STATE.CONNECTING, message: '' });
    const client = this.ensureClient();
    if (client.room) this.ui.setRoom(client.room);
    else if (!client.connected) client.connect().catch(() => this.ui.setConnection({ state: CONNECTION_STATE.RECONNECTING }));
    else this.ui.setConnection({ state: CONNECTION_STATE.CONNECTED, message: '' });
    this.ui.renderLobby();
  }

  ensureClient() {
    if (this.client) return this.client;
    const client = new MultiplayerClient({
      url: this.settings.multiplayerUrl || defaultMultiplayerUrl(),
      name: this.settings.playerName || '',
    });
    this.client = client;

    client.on('status', ({ state, message }) => {
      this.ui.setConnection({ state, message });
      if (state === CONNECTION_STATE.CONNECTED && this.screen === 'multiplayer') this.ui.renderLobby();
    });
    client.on('room', (room) => {
      const withYou = { ...room, youId: client.playerId };
      this.ui.setRoom(withYou);
      const opponent = client.opponent();
      this.ui.setOpponent({
        name: opponent?.name || 'OPPONENT',
        away: opponent ? !opponent.connected : false,
      });
      if (room.status === 'lobby') this.ui.hideOverlay();
    });
    client.on('game-started', (game) => this.handleRaceStart(game));
    client.on('progress', () => this.refreshOpponentProgress());
    client.on('progress-state', () => this.refreshOpponentProgress());
    client.on('opponent-completed', (message) => {
      this.ui.setOpponent({ done: true, finalMs: message.elapsedMs, progress: 1 });
      this.ui.announce(`Opponent finished in ${formatTime(message.elapsedMs)}`);
    });
    client.on('player-disconnected', () => {
      this.ui.setOpponent({ away: true });
      this.ui.showToast('Opponent disconnected — they can rejoin');
    });
    client.on('player-reconnected', () => {
      this.ui.setOpponent({ away: false });
      this.ui.showToast('Opponent is back');
    });
    client.on('player-left', () => {
      this.ui.setOpponent({ left: true, away: false });
      this.ui.showToast('Opponent left the room');
    });
    client.on('finished', (message) => this.handleRaceFinished(message));
    client.on('server-error', ({ code, message }) => {
      const hint = MP_ERROR_MESSAGES[code] || message || 'Multiplayer error';
      this.ui.showMpError(hint);
      this.ui.showToast(hint, 3200);
      if (code === MP_ERRORS.SERVER_UNAVAILABLE) this.ui.setConnection({ state: CONNECTION_STATE.DISCONNECTED, message: hint });
    });
    client.on('socket-error', () => {
      if (this.screen === 'multiplayer') this.ui.showMpError('Could not reach the multiplayer server.');
    });
    client.on('reconnect-scheduled', ({ attempt, delay }) => {
      this.ui.setConnection({
        state: CONNECTION_STATE.RECONNECTING,
        message: `retry ${attempt} in ${Math.round(delay / 1000)}s`,
      });
    });
    return client;
  }

  createRoom(difficulty, name) {
    const client = this.ensureClient();
    if (name) {
      this.settings.playerName = client.setPlayerName(name);
      this.storage.saveSettings(this.settings);
    }
    this.ui.showMpError('');
    const attempt = () => {
      client.createRoom({ difficulty, name: this.settings.playerName });
    };
    if (client.connected) attempt();
    else client.connect().then(attempt).catch(() => {
      this.ui.showMpError(MP_ERROR_MESSAGES[MP_ERRORS.SERVER_UNAVAILABLE]);
    });
  }

  joinRoom(code, name) {
    const client = this.ensureClient();
    if (!code || code.trim().length < 3) {
      this.ui.showMpError('Enter the 5-character room code.');
      return;
    }
    if (name) {
      this.settings.playerName = client.setPlayerName(name);
      this.storage.saveSettings(this.settings);
    }
    this.ui.showMpError('');
    const attempt = () => client.joinRoom({ roomCode: code, name: this.settings.playerName });
    if (client.connected) attempt();
    else client.connect().then(attempt).catch(() => {
      this.ui.showMpError(MP_ERROR_MESSAGES[MP_ERRORS.SERVER_UNAVAILABLE]);
    });
  }

  toggleReady() {
    const client = this.client;
    if (!client?.room) return;
    const me = client.me();
    client.setReady(!me?.ready);
  }

  startRace() {
    this.client?.startGame();
  }

  leaveRoom() {
    this.teardownMultiplayer();
    this.engine = null;
    this.ui.engine = null;
    this.mpPuzzleId = null;
    this.ui.setRoom(null);
    this.ui.resetOpponent();
    this.ui.hideOverlay();
    this.navigate('multiplayer');
  }

  teardownMultiplayer() {
    this.client?.leaveRoom();
    this.client = null;
  }

  handleRaceStart(game) {
    // A race for the same seed is the same board: reuse local progress instead of
    // restarting the puzzle (this is what makes a mid-race refresh survivable).
    const matchesRace = (engineOrState) =>
      Boolean(engineOrState) && engineOrState.mode === 'multiplayer' && engineOrState.seed === game.seed;

    let engine = null;
    if (matchesRace(this.engine)) {
      engine = this.engine;
    } else if (matchesRace(this.engineSavedState)) {
      try {
        engine = GameEngine.fromState(this.engineSavedState);
        if (engine.status === GAME_STATUS.PLAYING && !engine.timer.running) engine.timer.resume();
      } catch (error) {
        console.warn('[app] multiplayer snapshot unusable', error);
        engine = null;
      }
    }

    if (!engine) {
      try {
        engine = GameEngine.create({
          difficulty: game.difficulty,
          seed: game.seed,
          mode: 'multiplayer',
          mistakeLimit: Infinity, // races are decided by finishing, never by mistakes
          roomId: game.roomId,
          roomCode: this.client?.room?.code,
          playerId: this.client?.playerId,
        });
      } catch (error) {
        console.error('[app] could not build shared puzzle', error);
        this.ui.showMpError('Could not build the shared puzzle. Ask your friend to restart the room.');
        return;
      }
      this.ui.setOpponent({ done: false, away: false, left: false, progress: 0, finalMs: null });
    }

    this.mpPuzzleId = game.puzzleId;
    engine.multiplayerStartedAt = game.startedAt;
    this.attachEngine(engine, { fresh: false });
    this.ui.setServerOffset(game.startedAt);
    this.ui.setYou({ progress: engine.progress, done: engine.status === GAME_STATUS.COMPLETED });
    this.ui.hideOverlay();
    this.ui.renderOverlay();
    if (game.status === 'finished') {
      this.ui.showToast('That race has already finished');
    } else {
      this.navigate('game');
      this.ui.announce('Race started — solve faster than your opponent.');
    }
    this.persistNow();
  }

  sendProgress(cell, value) {
    if (!this.client?.room) return;
    this.client.sendProgress(cell, value);
    this.refreshOwnProgress();
  }

  sendCompleted() {
    if (!this.client || !this.engine) return;
    this.client.sendCompleted(this.engine.board);
  }

  refreshOwnProgress() {
    if (!this.engine) return;
    this.ui.setYou({ progress: this.engine.progress, done: this.engine.status === GAME_STATUS.COMPLETED });
  }

  refreshOpponentProgress() {
    if (!this.engine || !this.client) return;
    const ratio = this.client.opponentProgressRatio(this.engine.totalEmpty);
    this.ui.setOpponent({ progress: ratio });
  }

  async handleRaceFinished({ winnerId, results = [], reason = '', roomId = '', finishedAt = 0 }) {
    const youId = this.client?.playerId;
    const youWon = winnerId && winnerId === youId;
    // A rejoin replays the stored result — only count it once.
    const raceKey = `${roomId}:${finishedAt || reason}`;
    const alreadyCounted = raceKey === this.lastRaceKey;
    this.lastRaceKey = raceKey;

    if (!alreadyCounted) {
      this.mpStats.gamesPlayed = (this.mpStats.gamesPlayed || 0) + 1;
      if (youWon) this.mpStats.wins = (this.mpStats.wins || 0) + 1;
      else if (winnerId) this.mpStats.losses = (this.mpStats.losses || 0) + 1;
      await this.storage.saveMultiplayerStats(this.mpStats);
      const yourResult = results.find((result) => result.playerId === youId);
      await this.storage.addHistory({
        difficulty: this.engine?.difficulty || 'medium',
        mode: 'multiplayer',
        elapsedMs: yourResult?.elapsedMs || this.engine?.elapsedMs || 0,
        result: winnerId ? (youWon ? 'won' : 'lost') : 'draw',
      });
      await this.queueSync('multiplayer-result', { winnerId, results, yourPlayerId: youId });
      this.queueSync('stats', this.stats);
    }

    this.ui.mpStats = this.mpStats;
    this.refreshStatsViews();
    this.ui.setOpponent({ done: true });
    this.ui.setYou({ done: true });
    this.ui.showResult({ winnerId, youId, results, reason });
    this.ui.announce(youWon ? 'You won the race!' : winnerId ? 'You lost the race.' : 'Race finished.');
    this.persistNow();
  }

  /* ------------------------------ tick ----------------------------- */

  tick() {
    const engine = this.engine;
    if (!engine) return;
    if (this.screen === 'game') {
      this.ui.renderTimer();
      if (engine.mode === 'multiplayer') this.refreshOpponentProgress();
    }
    // Persist periodically so a hard crash mid-game loses at most a few seconds.
    if (engine.isRunning && Date.now() - (this.lastPersist || 0) > 5000) {
      this.lastPersist = Date.now();
      this.storage.saveGame(engine.toState());
    }
  }
}

const app = new SudokuApp();

window.addEventListener('error', (event) => {
  console.error('[app] uncaught error', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[app] unhandled rejection', event.reason);
});

app.init().catch((error) => {
  console.error('[app] initialisation failed', error);
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<p style="padding:16px;color:#ff6b6b">Sudoku failed to start. Reload the page to try again.</p>',
  );
});

export default app;
