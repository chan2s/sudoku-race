/**
 * ui.js — every DOM read/write lives here.
 *
 * The UI never mutates game state directly: it renders whatever the engine and
 * the multiplayer client expose and reports user intent back through the
 * `handlers` object (onCellSelect, onValueInput, onCreateRoom, …). That keeps
 * game rules, storage and networking independent from the view.
 */

import { CELLS, DIFFICULTIES, findDuplicateCells, peersOf, rowCol } from './sudoku.js';
import { formatTime, formatPercent } from './timer.js';
import { GAME_STATUS } from './game.js';
import { CONNECTION_STATE } from './multiplayer.js';
import { SYNC_STATUS } from './sync.js';

const DIFFICULTY_LABELS = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  expert: 'Expert',
};

const SCREENS = ['home', 'difficulty', 'game', 'multiplayer', 'stats', 'settings'];

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.engine = null;
    this.settings = {};
    this.stats = null;
    this.mpStats = null;
    this.history = [];
    this.room = null;
    this.connection = { state: CONNECTION_STATE.IDLE, message: '' };
    this.opponent = { name: 'OPPONENT', progress: 0, timeMs: 0, done: false, away: false, left: false };
    this.you = { progress: 0, done: false, timeMs: 0 };
    this.disconnectCountdown = null; // { name, deadline, serverNow } while the opponent is away
    this.serverOffsetMs = 0;
    this.currentScreen = 'home';
    this.cells = [];
    this.numpadButtons = new Map();
    this.elements = {};
    this.toastTimer = null;
  }

  /* ----------------------------- mount ----------------------------- */

  mount() {
    this.elements = {
      board: $('board'),
      numpad: $('numpad'),
      overlay: $('board-overlay'),
      overlayTitle: $('overlay-title'),
      overlayText: $('overlay-text'),
      overlayActions: $('overlay-actions'),
      timer: $('game-timer'),
      difficultyLabel: $('game-difficulty'),
      mistakes: $('game-mistakes'),
      mpHud: $('mp-hud'),
      mpYouTime: $('mp-you-time'),
      mpOppTime: $('mp-opp-time'),
      mpYouBar: $('mp-you-bar'),
      mpOppBar: $('mp-opp-bar'),
      mpYouStatus: $('mp-you-status'),
      mpOppStatus: $('mp-opp-status'),
      mpOppName: $('mp-opponent-name'),
      mpDisconnect: $('mp-disconnect'),
      mpDisconnectName: $('mp-disconnect-name'),
      mpDisconnectCount: $('mp-disconnect-count'),
      statusIndicator: $('status-indicator'),
      syncStatus: $('sync-status'),
      srStatus: $('sr-status'),
      toast: $('toast'),
      resume: $('home-resume'),
      resumeMeta: $('home-resume-meta'),
      difficultyList: $('difficulty-list'),
      statsContent: $('stats-content'),
      mpConnection: $('mp-connection'),
      mpConnectPanel: $('mp-connect'),
      mpRoomPanel: $('mp-room'),
      mpRoomId: $('mp-room-id'),
      mpPlayers: $('mp-players'),
      mpRoomHint: $('mp-room-hint'),
      mpReady: $('mp-ready'),
      mpStart: $('mp-start'),
      mpError: $('mp-error'),
      mpName: $('mp-name'),
      mpDifficulty: $('mp-difficulty'),
      mpJoinForm: $('mp-join-form'),
      mpRoomCode: $('mp-room-code'),
      settings: {
        name: $('set-name'),
        mistakes: $('set-mistakes'),
        duplicates: $('set-duplicates'),
        haptics: $('set-haptics'),
        mpUrl: $('set-mp-url'),
        syncEndpoint: $('set-sync-endpoint'),
        backend: $('settings-backend'),
        pending: $('settings-pending'),
        storage: $('settings-storage'),
      },
      installHint: $('install-hint'),
    };

    this.buildBoard();
    this.buildNumpad();
    this.bindActions();
    this.bindKeyboard();
    return this;
  }

  buildBoard() {
    const board = this.elements.board;
    if (!board) return;
    const fragment = document.createDocumentFragment();
    this.cells = [];
    for (let index = 0; index < CELLS; index++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.index = String(index);
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', `Row 1 column 1, empty`);
      cell.tabIndex = -1;
      cell.addEventListener('click', () => this.handlers.onCellSelect?.(index));
      cell.addEventListener('focus', () => {
        if (this.engine && this.engine.selectedIndex !== index) {
          this.handlers.onCellSelect?.(index);
        }
      });
      fragment.appendChild(cell);
      this.cells.push(cell);
    }
    board.replaceChildren(fragment);
  }

  buildNumpad() {
    const numpad = this.elements.numpad;
    if (!numpad) return;
    numpad.replaceChildren();
    this.numpadButtons.clear();
    for (let value = 1; value <= 9; value++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.value = String(value);
      button.setAttribute('aria-label', `Enter ${value}`);
      button.innerHTML = `${value}<span class="remaining" aria-hidden="true"></span>`;
      button.addEventListener('click', () => this.handlers.onValueInput?.(value));
      numpad.appendChild(button);
      this.numpadButtons.set(value, button);
    }
  }

  bindActions() {
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target || target.disabled) return;
      this.dispatchAction(target.dataset.action, target, event);
    });

    this.elements.mpJoinForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = this.elements.mpRoomCode?.value || '';
      this.handlers.onJoinRoom?.(code, this.elements.mpName?.value || '');
    });
  }

  dispatchAction(action, element, event) {
    switch (action) {
      case 'go-home':
        this.handlers.onNavigate?.('home');
        break;
      case 'go-difficulty':
        this.handlers.onNavigate?.('difficulty');
        break;
      case 'go-multiplayer':
        this.handlers.onNavigate?.('multiplayer');
        break;
      case 'go-stats':
        this.handlers.onNavigate?.('stats');
        break;
      case 'go-settings':
        this.handlers.onNavigate?.('settings');
        break;
      case 'new-game':
        this.handlers.onNewGame?.(element.dataset.difficulty || 'easy');
        break;
      case 'resume-game':
        this.handlers.onResumeGame?.();
        break;
      case 'undo':
        this.handlers.onUndo?.();
        break;
      case 'erase':
        this.handlers.onErase?.();
        break;
      case 'pause':
        this.handlers.onPauseToggle?.();
        break;
      case 'resume':
        this.handlers.onPauseToggle?.();
        break;
      case 'restart':
        this.handlers.onRestart?.();
        break;
      case 'quit-game':
        this.handlers.onQuitGame?.();
        break;
      case 'new-same':
        this.handlers.onNewGame?.(element.dataset.difficulty || this.engine?.difficulty || 'easy');
        break;
      case 'create-room':
        this.handlers.onCreateRoom?.(
          this.elements.mpDifficulty?.value || 'medium',
          this.elements.mpName?.value || '',
        );
        break;
      case 'toggle-ready':
        this.handlers.onToggleReady?.();
        break;
      case 'start-game':
        this.handlers.onStartGame?.();
        break;
      case 'leave-room':
        this.handlers.onLeaveRoom?.();
        break;
      case 'copy-room':
        this.copyRoomCode();
        break;
      case 'save-settings':
        this.handlers.onSaveSettings?.(this.readSettingsForm());
        break;
      case 'export-data':
        this.handlers.onExportData?.();
        break;
      case 'clear-data':
        this.handlers.onClearData?.();
        break;
      case 'install':
        this.handlers.onInstall?.();
        break;
      default:
        break;
    }
    if (event) event.stopPropagation?.();
  }

  bindKeyboard() {
    document.addEventListener('keydown', (event) => {
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (this.currentScreen !== 'game' || !this.engine) return;
      const key = event.key;

      if (/^[1-9]$/.test(key)) {
        event.preventDefault();
        this.handlers.onValueInput?.(Number(key));
        return;
      }
      if (key === 'Backspace' || key === 'Delete' || key === '0') {
        event.preventDefault();
        this.handlers.onErase?.();
        return;
      }
      const moves = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -9,
        ArrowDown: 9,
      };
      if (moves[key] !== undefined) {
        event.preventDefault();
        this.moveSelection(moves[key]);
        return;
      }
      if (key === 'u' || key === 'U') {
        event.preventDefault();
        this.handlers.onUndo?.();
        return;
      }
      if (key === 'p' || key === 'P' || key === ' ') {
        if (event.target.closest('.numpad, .controls')) return;
        event.preventDefault();
        this.handlers.onPauseToggle?.();
      }
    });
  }

  moveSelection(delta) {
    if (!this.engine) return;
    const current = this.engine.selectedIndex ?? 0;
    const col = current % 9;
    let next = current;
    if (delta === -1 && col === 0) next = current + 8;
    else if (delta === 1 && col === 8) next = current - 8;
    else next = (current + delta + CELLS) % CELLS;
    this.handlers.onCellSelect?.(next);
    this.cells[next]?.focus();
  }

  async copyRoomCode() {
    const code = this.room?.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.showToast('Room code copied');
    } catch {
      this.showToast(`Room code: ${code}`);
    }
  }

  /* --------------------------- rendering --------------------------- */

  setGame(engine) {
    this.engine = engine;
    this.you.progress = engine?.progress ?? 0;
    this.you.done = engine?.status === GAME_STATUS.COMPLETED;
    this.renderGame();
  }

  showScreen(name) {
    if (!SCREENS.includes(name)) name = 'home';
    this.currentScreen = name;
    for (const screen of document.querySelectorAll('[data-screen]')) {
      screen.hidden = screen.dataset.screen !== name;
    }
    const active = document.querySelector(`[data-screen="${name}"]`);
    const heading = active?.querySelector('h1, h2');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus?.({ preventScroll: true });
  }

  renderAll() {
    this.renderGame();
    if (this.stats) this.renderStats();
    this.renderSettingsForm();
  }

  renderGame() {
    this.renderBoard();
    this.renderHeader();
    this.renderTimer();
    this.renderNumpad();
    this.renderOverlay();
  }

  renderHeader() {
    const engine = this.engine;
    if (!engine) return;
    const { difficultyLabel, mistakes } = this.elements;
    if (difficultyLabel) {
      const label = DIFFICULTY_LABELS[engine.difficulty] || engine.difficulty;
      difficultyLabel.textContent = engine.mode === 'multiplayer' ? `${label} · Race` : label;
    }
    if (mistakes) {
      const limited = engine.mistakeLimit !== Infinity && engine.mistakeLimit > 0;
      mistakes.hidden = !limited;
      mistakes.textContent = `Mistakes ${engine.mistakes}/${engine.mistakeLimit}`;
    }
    if (this.elements.mpHud) this.elements.mpHud.hidden = engine.mode !== 'multiplayer';
    if (engine.mode === 'multiplayer') this.renderMultiplayerHud();
  }

  renderBoard() {
    const engine = this.engine;
    if (!engine || !this.cells.length) return;
    const selected = engine.selectedIndex;
    const selectedValue = selected !== null ? engine.board[selected] : 0;
    const peers = selected !== null ? new Set(peersOf(selected)) : new Set();
    const duplicates = this.settings.highlightDuplicates === false ? new Set() : new Set(findDuplicateCells(engine.board));

    for (let index = 0; index < CELLS; index++) {
      const cell = this.cells[index];
      const value = engine.board[index];
      const isGiven = Boolean(engine.puzzle[index]);
      const isWrong = engine.isWrong(index);
      const classes = ['cell'];
      if (isGiven) classes.push('given');
      if (peers.has(index)) classes.push('peer');
      if (index === selected) classes.push('selected');
      else if (value && value === selectedValue) classes.push('same-value');
      if (isWrong) classes.push('wrong');
      if (duplicates.has(index)) classes.push('duplicate');
      cell.className = classes.join(' ');
      cell.textContent = value ? String(value) : '';
      cell.tabIndex = index === selected ? 0 : -1;
      cell.setAttribute('aria-selected', index === selected ? 'true' : 'false');
      const { row, col } = rowCol(index);
      const parts = [`Row ${row + 1} column ${col + 1}`, value ? `value ${value}` : 'empty'];
      if (isGiven) parts.push('given');
      if (isWrong) parts.push('incorrect');
      cell.setAttribute('aria-label', parts.join(', '));
    }
  }

  renderTimer() {
    const engine = this.engine;
    const { timer } = this.elements;
    if (!engine) return;
    const elapsed = engine.elapsedMs;
    if (timer) {
      timer.textContent = formatTime(elapsed);
      timer.setAttribute('aria-label', `Elapsed time ${formatTime(elapsed)}`);
    }
    this.you.timeMs = elapsed;
    if (engine.mode === 'multiplayer') this.renderMultiplayerHud();
  }

  renderMultiplayerHud() {
    const engine = this.engine;
    const { mpYouTime, mpOppTime, mpYouBar, mpOppBar, mpYouStatus, mpOppStatus, mpOppName } = this.elements;
    if (!engine || !mpYouTime) return;

    const myStatus = this.you.done ? 'Finished' : engine.status === GAME_STATUS.PAUSED ? 'Paused' : 'Solving';
    mpYouTime.textContent = formatTime(this.you.done && this.you.finalMs ? this.you.finalMs : engine.elapsedMs);
    mpYouStatus.textContent = `● ${myStatus}`;
    mpYouStatus.className = `mp-status${this.you.done ? ' is-done' : ''}`;
    if (mpYouBar) mpYouBar.style.width = `${Math.round(this.you.progress * 100)}%`;

    const opponentTime = this.opponent.done && this.opponent.finalMs ? this.opponent.finalMs : this.opponentTimeMs();
    if (mpOppTime) mpOppTime.textContent = formatTime(opponentTime);
    if (mpOppName) mpOppName.textContent = (this.opponent.name || 'OPPONENT').toUpperCase();
    if (mpOppStatus) {
      let label = 'Solving';
      let cls = 'mp-status';
      if (this.opponent.left) {
        label = 'Left the game';
        cls += ' is-away';
      } else if (this.opponent.away) {
        label = 'Reconnecting…';
        cls += ' is-away';
      } else if (this.opponent.done) {
        label = 'Finished';
        cls += ' is-done';
      }
      mpOppStatus.textContent = `● ${label}`;
      mpOppStatus.className = cls;
    }
    if (mpOppBar) mpOppBar.style.width = `${Math.round(this.opponent.progress * 100)}%`;
    const youPanel = this.elements.mpHud?.querySelector('#mp-you');
    youPanel?.classList.add('is-you');
    youPanel?.classList.toggle('is-done', this.you.done);
    this.elements.mpHud?.querySelector('#mp-opponent')?.classList.toggle('is-done', this.opponent.done);
  }

  opponentTimeMs() {
    if (!this.engine?.multiplayerStartedAt) return this.opponent.timeMs || 0;
    return Math.max(0, Date.now() + this.serverOffsetMs - this.engine.multiplayerStartedAt);
  }

  renderNumpad() {
    const engine = this.engine;
    if (!engine) return;
    for (const [value, button] of this.numpadButtons) {
      const placed = engine.board.filter((v) => v === value).length;
      const remaining = Math.max(0, 9 - placed);
      const badge = button.querySelector('.remaining');
      if (badge) badge.textContent = remaining > 0 ? String(remaining) : '';
      const isSelectedGiven = engine.selectedIndex !== null && engine.puzzle[engine.selectedIndex];
      button.disabled = !engine.isRunning || isSelectedGiven;
      button.classList.toggle('exhausted', remaining === 0);
    }
  }

  renderOverlay() {
    const engine = this.engine;
    if (!engine) return this.hideOverlay();

    if (engine.status === GAME_STATUS.PAUSED) {
      this.showOverlay({
        title: 'Paused',
        text: 'Your clock is stopped. Progress is saved on this device.',
        actions: [
          { label: 'Resume', action: 'resume', variant: 'btn-primary' },
          { label: 'Restart puzzle', action: 'restart' },
          { label: 'New puzzle', action: 'new-same', difficulty: engine.difficulty },
          { label: 'Quit to menu', action: 'quit-game', variant: 'btn-ghost' },
        ],
      });
      return;
    }
    if (engine.status === GAME_STATUS.FAILED) {
      this.showOverlay({
        title: 'Too many mistakes',
        text: `The puzzle ended after ${engine.mistakes} mistakes. Try again — same puzzle, new time.`,
        actions: [
          { label: 'Retry puzzle', action: 'restart', variant: 'btn-primary' },
          { label: 'New puzzle', action: 'new-same', difficulty: engine.difficulty },
          { label: 'Quit to menu', action: 'quit-game', variant: 'btn-ghost' },
        ],
      });
      return;
    }
    if (engine.status === GAME_STATUS.COMPLETED && engine.mode === 'single') {
      const best = this.stats?.bestTimes?.[engine.difficulty];
      const isBest = best !== null && best !== undefined && engine.elapsedMs <= best + 1;
      this.showOverlay({
        title: isBest ? 'New best time!' : 'Puzzle solved',
        text: `${formatTime(engine.elapsedMs)} · ${DIFFICULTY_LABELS[engine.difficulty]} · best ${formatTime(best ?? engine.elapsedMs)}`,
        actions: [
          { label: 'New puzzle', action: 'new-same', difficulty: engine.difficulty, variant: 'btn-primary' },
          { label: 'Back to menu', action: 'quit-game' },
        ],
      });
      return;
    }
    this.hideOverlay();
  }

  showOverlay({ title, text = '', actions = [] }) {
    const { overlay, overlayTitle, overlayText, overlayActions } = this.elements;
    if (!overlay) return;
    overlayTitle.textContent = title;
    overlayText.textContent = text;
    overlayActions.replaceChildren();
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn ${action.variant || ''}`.trim();
      button.dataset.action = action.action;
      if (action.difficulty) button.dataset.difficulty = action.difficulty;
      button.textContent = action.label;
      overlayActions.appendChild(button);
    }
    overlay.hidden = false;
  }

  hideOverlay() {
    if (this.elements.overlay) this.elements.overlay.hidden = true;
  }

  /* ---------------------------- screens ---------------------------- */

  renderDifficulty(stats = this.stats) {
    const list = this.elements.difficultyList;
    if (!list) return;
    list.replaceChildren();
    for (const difficulty of DIFFICULTIES) {
      const best = stats?.bestTimes?.[difficulty];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn difficulty';
      button.dataset.action = 'new-game';
      button.dataset.difficulty = difficulty;
      button.innerHTML = `<span class="level">${DIFFICULTY_LABELS[difficulty]}</span><span class="best">${
        best ? `Best ${formatTime(best)}` : 'Not played'
      }</span>`;
      list.appendChild(button);
    }
  }

  renderResumeBanner(gameState) {
    const { resume, resumeMeta } = this.elements;
    if (!resume) return;
    if (!gameState) {
      resume.hidden = true;
      return;
    }
    resume.hidden = false;
    if (resumeMeta) {
      const label = DIFFICULTY_LABELS[gameState.difficulty] || gameState.difficulty;
      resumeMeta.textContent = `(${label} · ${formatTime(gameState.elapsedMs || 0)})`;
    }
  }

  renderStats() {
    const container = this.elements.statsContent;
    if (!container) return;
    const stats = this.stats || {};
    const mp = this.mpStats || { gamesPlayed: 0, wins: 0, losses: 0 };
    const completed = stats.gamesCompleted || 0;
    const average = completed > 0 ? (stats.totalCompletedMs || 0) / completed : 0;
    const winRate = mp.gamesPlayed > 0 ? (mp.wins / mp.gamesPlayed) * 100 : 0;

    const group = (title, rows) => {
      const section = document.createElement('div');
      section.className = 'stat-group';
      const heading = document.createElement('h3');
      heading.textContent = title;
      section.appendChild(heading);
      for (const [label, value] of rows) {
        const row = document.createElement('div');
        row.className = 'stat-row';
        const name = document.createElement('span');
        name.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'value';
        valueEl.textContent = value;
        row.append(name, valueEl);
        section.appendChild(row);
      }
      return section;
    };

    container.replaceChildren(
      group('Single player', [
        ['Games Played', String(stats.gamesPlayed || 0)],
        ['Games Completed', String(completed)],
        ['Games Failed', String(stats.gamesFailed || 0)],
        ['Average Time', completed ? formatTime(average) : '—'],
      ]),
      group('Best times', [
        ['Easy', stats.bestTimes?.easy ? formatTime(stats.bestTimes.easy) : '—'],
        ['Medium', stats.bestTimes?.medium ? formatTime(stats.bestTimes.medium) : '—'],
        ['Hard', stats.bestTimes?.hard ? formatTime(stats.bestTimes.hard) : '—'],
        ['Expert', stats.bestTimes?.expert ? formatTime(stats.bestTimes.expert) : '—'],
      ]),
      group('Multiplayer', [
        ['Multiplayer Games', String(mp.gamesPlayed || 0)],
        ['Wins', String(mp.wins || 0)],
        ['Losses', String(mp.losses || 0)],
        ['Win Rate', formatPercent(winRate)],
      ]),
    );

    if (this.history?.length) {
      const section = document.createElement('div');
      section.className = 'stat-group';
      const heading = document.createElement('h3');
      heading.textContent = 'Recent games';
      section.appendChild(heading);
      for (const entry of this.history.slice(0, 8)) {
        const row = document.createElement('div');
        row.className = 'history-item';
        const label = document.createElement('span');
        label.textContent = `${DIFFICULTY_LABELS[entry.difficulty] || entry.difficulty}${
          entry.mode === 'multiplayer' ? ' · race' : ''
        }${entry.result ? ` · ${entry.result}` : ''}`;
        const value = document.createElement('span');
        value.textContent = `${formatTime(entry.elapsedMs || 0)} · ${new Date(entry.createdAt).toLocaleDateString()}`;
        row.append(label, value);
        section.appendChild(row);
      }
      container.appendChild(section);
    }
  }

  /* ------------------------- multiplayer --------------------------- */

  setRoom(room) {
    this.room = room;
    this.renderLobby();
  }

  setConnection(connection) {
    this.connection = connection;
    this.renderLobby();
  }

  setServerOffset(startedAt) {
    this.serverOffsetMs = Number(startedAt) - Date.now();
  }

  renderLobby() {
    const { mpConnection, mpConnectPanel, mpRoomPanel, mpRoomId, mpPlayers, mpRoomHint, mpReady, mpStart, mpError } =
      this.elements;
    if (!mpConnection) return;

    const state = this.connection.state;
    const labels = {
      [CONNECTION_STATE.IDLE]: 'Not connected',
      [CONNECTION_STATE.CONNECTING]: 'Connecting…',
      [CONNECTION_STATE.CONNECTED]: 'Connected',
      [CONNECTION_STATE.RECONNECTING]: 'Reconnecting…',
      [CONNECTION_STATE.OFFLINE]: 'Offline — waiting for connection',
      [CONNECTION_STATE.DISCONNECTED]: 'Disconnected',
    };
    mpConnection.innerHTML = `<span class="dot${
      state === CONNECTION_STATE.CONNECTED ? '' : ' is-offline'
    }"></span> ${labels[state] || state}${this.connection.message ? ` · ${this.connection.message}` : ''}`;

    const inRoom = Boolean(this.room);
    if (mpConnectPanel) mpConnectPanel.hidden = inRoom;
    if (mpRoomPanel) mpRoomPanel.hidden = !inRoom;
    if (mpError && !this.connection.message) mpError.hidden = true;
    if (!inRoom) return;

    if (mpRoomId) mpRoomId.textContent = this.room.code;
    if (mpPlayers) {
      mpPlayers.replaceChildren();
      for (const player of this.room.players || []) {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'player-name';
        name.textContent = player.name + (player.id === this.room.youId ? ' (you)' : '');
        const tag = document.createElement('span');
        tag.className = 'player-tag';
        if (!player.connected) {
          tag.classList.add('is-away');
          tag.textContent = '● Away';
        } else if (player.completed) {
          tag.textContent = '● Finished';
        } else if (player.ready) {
          tag.classList.add('is-ready');
          tag.textContent = '● Ready';
        } else {
          tag.textContent = '● Waiting';
        }
        item.append(name, tag);
        mpPlayers.appendChild(item);
      }
    }

    const me = (this.room.players || []).find((player) => player.id === this.room.youId);
    const others = (this.room.players || []).filter((player) => player.id !== this.room.youId);
    const readyCount = (this.room.players || []).filter((player) => player.ready).length;
    if (mpReady) {
      mpReady.textContent = me?.ready ? 'Not ready' : 'I’m ready';
      mpReady.disabled = !me?.connected;
    }
    if (mpStart) {
      const canStart = Boolean(me?.ready) && readyCount >= 2 && this.room.status !== 'finished';
      mpStart.hidden = !canStart;
    }
    if (mpRoomHint) {
      if (!others.length) mpRoomHint.textContent = 'Share the room code with a friend — the game starts when you are both ready.';
      else if (others.every((player) => !player.connected)) mpRoomHint.textContent = 'Opponent reconnecting…';
      else if (readyCount < 2) mpRoomHint.textContent = 'Waiting for both players to be ready.';
      else mpRoomHint.textContent = 'Both players ready — start the race!';
    }
  }

  showMpError(message) {
    const { mpError } = this.elements;
    if (!mpError) return;
    if (!message) {
      mpError.hidden = true;
      return;
    }
    mpError.textContent = message;
    mpError.hidden = false;
  }

  setOpponent({ name, progress, done, away, left, finalMs } = {}) {
    if (name !== undefined) this.opponent.name = name;
    if (progress !== undefined) this.opponent.progress = progress;
    if (done !== undefined) this.opponent.done = done;
    if (away !== undefined) this.opponent.away = away;
    if (left !== undefined) this.opponent.left = left;
    if (finalMs !== undefined) this.opponent.finalMs = finalMs ?? undefined;
    this.renderMultiplayerHud();
  }

  /* --------------------- opponent disconnect banner ---------------- */

  /**
   * Shows the reconnection countdown. `deadline` is a server timestamp and
   * `serverNow` the client's best estimate of server time, so the remaining
   * time is authoritative even when the device clock is off.
   */
  showDisconnectCountdown({ name, deadline, serverNow } = {}) {
    if (!Number.isFinite(Number(deadline)) || Number(deadline) <= 0) return;
    this.disconnectCountdown = {
      name: name || 'Opponent',
      deadline: Number(deadline),
      serverNow: typeof serverNow === 'function' ? serverNow : () => Date.now(),
    };
    if (this.elements.mpDisconnectName) this.elements.mpDisconnectName.textContent = this.disconnectCountdown.name;
    if (this.elements.mpDisconnect) this.elements.mpDisconnect.hidden = false;
    this.renderDisconnectCountdown();
  }

  hideDisconnectCountdown() {
    this.disconnectCountdown = null;
    if (this.elements.mpDisconnect) this.elements.mpDisconnect.hidden = true;
  }

  /** Ticks the visible reconnection countdown; clamps at 00:00. */
  renderDisconnectCountdown() {
    const countdown = this.disconnectCountdown;
    const element = this.elements.mpDisconnectCount;
    if (!countdown || !element) return;
    const remaining = Math.max(0, countdown.deadline - countdown.serverNow());
    element.textContent = formatTime(remaining);
  }

  setYou({ progress, done, finalMs } = {}) {
    if (progress !== undefined) this.you.progress = progress;
    if (done !== undefined) this.you.done = done;
    if (finalMs !== undefined) this.you.finalMs = finalMs ?? undefined;
    this.renderMultiplayerHud();
  }

  /** Clears all multiplayer HUD state when leaving a room. */
  resetOpponent() {
    this.opponent = { name: 'OPPONENT', progress: 0, timeMs: 0, done: false, away: false, left: false };
    this.you = { progress: 0, done: false, timeMs: 0 };
    this.hideDisconnectCountdown();
    this.renderMultiplayerHud();
  }

  showResult({ winnerId, youId, results = [], reason = '', resultReason = '', abandonedPlayerId = null }) {
    const youWon = winnerId && winnerId === youId;
    const draw = !winnerId;
    const byAbandonment = resultReason === 'OPPONENT_ABANDONED' || resultReason === 'PLAYER_ABANDONED';
    const describe = (result) => {
      if (byAbandonment && !result.completed) {
        const lost = result.playerId && result.playerId === abandonedPlayerId;
        return `${result.name || 'Player'} — ${lost ? 'abandoned' : 'did not finish'}`;
      }
      return `${result.name || 'Player'} — ${
        result.valid === false ? 'invalid board' : formatTime(result.elapsedMs || 0)
      }`;
    };
    const lines = results.map(describe).join('  ·  ');
    this.showOverlay({
      title: draw ? 'Race finished' : youWon ? 'You win! 🏆' : 'You lost this time',
      text: `${reason ? `${reason} ` : ''}${lines}`.trim() || 'No result recorded.',
      actions: [
        { label: 'Back to lobby', action: 'go-multiplayer', variant: 'btn-primary' },
        { label: 'Single player', action: 'quit-game' },
      ],
    });
  }

  /* --------------------------- settings ---------------------------- */

  applySettings(settings) {
    this.settings = settings;
    this.renderSettingsForm();
  }

  renderSettingsForm() {
    const { settings } = this.elements;
    if (!settings?.name) return;
    settings.name.value = this.settings.playerName || '';
    settings.mistakes.value = String(this.settings.mistakeLimit ?? 3);
    settings.duplicates.checked = this.settings.highlightDuplicates !== false;
    settings.haptics.checked = this.settings.haptics !== false;
    settings.mpUrl.value = this.settings.multiplayerUrl || '';
    settings.syncEndpoint.value = this.settings.syncEndpoint || '';
  }

  readSettingsForm() {
    const { settings } = this.elements;
    return {
      playerName: (settings.name.value || '').trim().slice(0, 18),
      mistakeLimit: Math.max(0, Math.min(10, Number(settings.mistakes.value) || 0)),
      highlightDuplicates: settings.duplicates.checked,
      haptics: settings.haptics.checked,
      multiplayerUrl: (settings.mpUrl.value || '').trim(),
      syncEndpoint: (settings.syncEndpoint.value || '').trim(),
    };
  }

  renderStorageInfo({ backend, pending, description }) {
    const { settings } = this.elements;
    if (settings.backend) settings.backend.textContent = backend || 'unknown';
    if (settings.pending) settings.pending.textContent = String(pending ?? 0);
    if (settings.storage) settings.storage.textContent = description || '';
  }

  /* --------------------- status / notifications -------------------- */

  setStatus({ online, syncStatus, message }) {
    const indicator = this.elements.statusIndicator;
    const syncEl = this.elements.syncStatus;
    if (indicator) {
      indicator.classList.toggle('is-offline', !online);
      indicator.innerHTML = `<span class="dot${online ? '' : ' is-offline'}"></span> ${
        online ? 'Online' : 'Offline'
      }`;
    }
    if (syncEl) {
      const labels = {
        [SYNC_STATUS.SYNCING]: message || 'Syncing…',
        [SYNC_STATUS.SYNCED]: '✓ Synced',
        [SYNC_STATUS.ERROR]: message || 'Sync failed',
        [SYNC_STATUS.OFFLINE]: message || 'Saved on this device',
        [SYNC_STATUS.ONLINE]: message || '',
      };
      syncEl.textContent = labels[syncStatus] ?? '';
      syncEl.className = 'sync-status';
      if (syncStatus === SYNC_STATUS.SYNCING) syncEl.classList.add('is-syncing');
      if (syncStatus === SYNC_STATUS.SYNCED) syncEl.classList.add('is-synced');
      if (syncStatus === SYNC_STATUS.ERROR) syncEl.classList.add('is-error');
    }
  }

  setInstallAvailable(available) {
    if (this.elements.installHint) this.elements.installHint.hidden = !available;
  }

  announce(text) {
    const region = this.elements.srStatus;
    if (!region) return;
    region.textContent = '';
    window.setTimeout(() => {
      region.textContent = text;
    }, 30);
  }

  showToast(text, ms = 2200) {
    const toast = this.elements.toast;
    if (!toast) return;
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, ms);
  }

  vibrate(pattern = 30) {
    if (this.settings.haptics === false) return;
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* haptics are best-effort */
    }
  }
}
