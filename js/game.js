/**
 * game.js — the Sudoku game engine.
 *
 * Pure game state and rules: board mutations, undo, mistake detection, pause,
 * restart, completion. It knows nothing about the DOM, storage or the network;
 * the app layer subscribes to its events and persists its `toState()` snapshot.
 */

import { CELLS, DIFFICULTIES, generatePuzzle, isBoardComplete, isValidSolution } from './sudoku.js';
import { Timer } from './timer.js';

export const GAME_STATUS = {
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  // A multiplayer race the *server* decided: the board is locked, the clock is
  // stopped and the result overlay is owned by the app, not this engine.
  FINISHED: 'finished',
};

/** Minimal event emitter so the engine stays dependency-free. */
export class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of Array.from(handlers)) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[game] listener for "${event}" failed`, error);
      }
    }
  }
}

export class CorruptGameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptGameError';
  }
}

const MAX_UNDO = 200;

function normalizeBoard(values) {
  const board = new Array(CELLS).fill(0);
  for (let i = 0; i < CELLS; i++) {
    const v = Number(values?.[i]) || 0;
    board[i] = v >= 1 && v <= 9 ? Math.trunc(v) : 0;
  }
  return board;
}

export class GameEngine extends Emitter {
  constructor(options) {
    super();
    const {
      puzzle,
      solution,
      difficulty = 'easy',
      seed = 0,
      mode = 'single',
      mistakeLimit = 3,
      id = null,
      roomId = null,
      roomCode = null,
      playerId = null,
      startedAt = Date.now(),
      completedAt = null,
      status = null,
      board = null,
      mistakes = 0,
      eliminated = false,
      undoStack = [],
      wrongCells = [],
      timerState = null,
      timer = null, // `toState()` writes the timer under this key
    } = options;

    if (!Array.isArray(puzzle) || puzzle.length !== CELLS) {
      throw new CorruptGameError('puzzle is missing or malformed');
    }
    if (!Array.isArray(solution) || solution.length !== CELLS || !isValidSolution(solution)) {
      throw new CorruptGameError('solution is missing or invalid');
    }
    for (let i = 0; i < CELLS; i++) {
      if (puzzle[i] && puzzle[i] !== solution[i]) {
        throw new CorruptGameError(`clue at ${i} contradicts the solution`);
      }
    }

    this.id = id || `game-${Date.now().toString(36)}`;
    this.mode = mode;
    this.difficulty = DIFFICULTIES.includes(difficulty) ? difficulty : 'easy';
    this.seed = Number(seed) >>> 0;
    this.puzzle = normalizeBoard(puzzle);
    this.solution = normalizeBoard(solution);
    this.board = board ? normalizeBoard(board) : this.puzzle.slice();
    // Givens can never be overwritten, even if a corrupted snapshot says so.
    for (let i = 0; i < CELLS; i++) {
      if (this.puzzle[i]) this.board[i] = this.puzzle[i];
    }
    this.mistakeLimit = Number.isFinite(mistakeLimit) && mistakeLimit > 0 ? mistakeLimit : Infinity;
    this.mistakes = Number(mistakes) || 0;
    this.eliminated = Boolean(eliminated);
    this.wrongCells = new Set(wrongCells.filter((index) => this.board[index] && this.board[index] !== this.solution[index]));
    this.undoStack = Array.isArray(undoStack) ? undoStack.slice(-MAX_UNDO) : [];
    this.selectedIndex = null;
    this.status = status || GAME_STATUS.PLAYING;
    this.roomId = roomId;
    this.roomCode = roomCode;
    this.playerId = playerId;
    this.startedAt = startedAt;
    this.completedAt = completedAt;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.timer = Timer.from(
      timerState ||
        timer || { running: this.status === GAME_STATUS.PLAYING, accumulatedMs: 0, startedAt: Date.now() },
    );
    if (
      this.status === GAME_STATUS.COMPLETED ||
      this.status === GAME_STATUS.FAILED ||
      this.status === GAME_STATUS.FINISHED
    ) {
      this.timer.stop();
    }
  }

  /** Builds a fresh game from a difficulty (and optional shared seed). */
  static create({
    difficulty = 'easy',
    seed,
    mode = 'single',
    mistakeLimit = 3,
    roomId = null,
    roomCode = null,
    playerId = null,
  } = {}) {
    const generated = generatePuzzle(difficulty, seed);
    return new GameEngine({
      ...generated,
      seed: generated.seed,
      mode,
      mistakeLimit,
      roomId,
      roomCode,
      playerId,
      status: GAME_STATUS.PLAYING,
      timerState: { running: true, accumulatedMs: 0, startedAt: Date.now() },
    });
  }

  /** Rehydrates a persisted snapshot, throwing CorruptGameError when unusable. */
  static fromState(state) {
    if (!state || typeof state !== 'object') throw new CorruptGameError('empty snapshot');
    return new GameEngine({ ...state, id: state.gameId || state.id });
  }

  /* ----------------------------- queries ---------------------------- */

  get isGiven() {
    return (index) => Boolean(this.puzzle[index]);
  }

  get clues() {
    return this.puzzle.reduce((count, v) => count + (v ? 1 : 0), 0);
  }

  get filledCount() {
    return this.board.reduce((count, v) => count + (v ? 1 : 0), 0);
  }

  get totalEmpty() {
    return CELLS - this.clues;
  }

  get progress() {
    const filledCorrectly = this.board.reduce(
      (count, v, index) => count + (v && v === this.solution[index] ? 1 : 0),
      0,
    );
    return Math.max(0, Math.min(1, (filledCorrectly - this.clues) / Math.max(1, this.totalEmpty)));
  }

  get elapsedMs() {
    return this.timer.elapsedMs;
  }

  get isRunning() {
    return this.status === GAME_STATUS.PLAYING;
  }

  /** No board edits while paused, finished or failed. */
  get isLocked() {
    return this.status !== GAME_STATUS.PLAYING;
  }

  /**
   * In a multiplayer race the server owns the mistake counter and the
   * elimination rule — the client only renders what the server reports.
   */
  get countsMistakes() {
    return this.mode !== 'multiplayer';
  }

  isWrong(index) {
    return this.wrongCells.has(index);
  }

  /* ----------------------------- mutations -------------------------- */

  select(index) {
    if (index === null || index < 0 || index >= CELLS) return;
    this.selectedIndex = index;
    this.emit('select', { index });
    this.emit('change', { reason: 'select' });
  }

  moveSelection(delta) {
    const current = this.selectedIndex ?? 0;
    let next = current + delta;
    next = ((next % CELLS) + CELLS) % CELLS;
    this.select(next);
  }

  /**
   * Places a value in a cell. `value` 0 clears the cell.
   * Returns a small result object describing what happened.
   */
  setValue(index, value, { remote = false } = {}) {
    const result = { changed: false, accepted: false, correct: false, mistake: null };
    if (this.isLocked) return result;
    if (index === null || index < 0 || index >= CELLS) return result;
    if (this.puzzle[index]) return result; // givens are immutable
    const next = Number(value) || 0;
    if (next < 0 || next > 9) return result;
    const previous = this.board[index];
    if (previous === next) return result;

    this.board[index] = next;
    result.changed = true;
    result.accepted = true;
    this.undoStack.push({ index, previous });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();

    if (!next) {
      this.wrongCells.delete(index);
      this.emit('value', { index, value: next, previous, correct: true, remote });
    } else if (next === this.solution[index]) {
      this.wrongCells.delete(index);
      result.correct = true;
      this.emit('value', { index, value: next, previous, correct: true, remote });
    } else {
      this.wrongCells.add(index);
      // Multiplayer: flag the cell for immediate feedback, but never count the
      // mistake or end the game locally — the server decides both.
      if (this.countsMistakes) {
        this.mistakes += 1;
        result.mistake = { index, value: next, mistakes: this.mistakes };
        this.emit('mistake', result.mistake);
      }
      this.emit('value', { index, value: next, previous, correct: false, remote });
    }

    this.updatedAt = Date.now();
    this.emit('change', { reason: 'value', index });

    if (this.countsMistakes && this.mistakes >= this.mistakeLimit && this.mistakeLimit !== Infinity) {
      this.fail('too-many-mistakes');
      return result;
    }
    this.checkCompletion();
    return result;
  }

  /**
   * Applies the server's verdict for a multiplayer move. The board was already
   * updated optimistically; this reconciles the authoritative mistake count,
   * the wrong-cell marker and the mistake feedback. The server is the only
   * source of `correct` and `mistakes`.
   */
  applyServerMove(message) {
    if (this.mode !== 'multiplayer') return false;
    if (!message || message.accepted === false) return false;
    const cell = Number(message.cell);
    const value = Number(message.value) || 0;
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return false;
    const previous = this.board[cell];
    this.board[cell] = value;
    if (!value || message.correct) this.wrongCells.delete(cell);
    else this.wrongCells.add(cell);
    if (Number.isFinite(Number(message.mistakes))) this.mistakes = Number(message.mistakes);
    if (Number.isFinite(Number(message.maxMistakes)) && Number(message.maxMistakes) > 0) {
      this.mistakeLimit = Number(message.maxMistakes);
    }
    this.updatedAt = Date.now();
    this.emit('value', { index: cell, value, previous, correct: Boolean(message.correct), remote: true });
    if (value && !message.correct) {
      this.emit('mistake', {
        index: cell,
        value,
        mistakes: this.mistakes,
        remaining:
          this.mistakeLimit === Infinity ? 0 : Math.max(0, this.mistakeLimit - this.mistakes),
        serverAuthoritative: true,
      });
    }
    this.emit('change', { reason: 'value', index: cell });
    if (value && message.correct && this.status === GAME_STATUS.PLAYING) this.checkCompletion();
    return true;
  }

  /**
   * Locks a multiplayer race whose result the server has already decided. The
   * board and clock stop; the winner/loser overlay is rendered by the app.
   */
  finishRace({ eliminated = false } = {}) {
    if (this.mode !== 'multiplayer') return;
    this.timer.stop();
    this.eliminated = Boolean(eliminated);
    if (this.status === GAME_STATUS.PLAYING || this.status === GAME_STATUS.PAUSED) {
      this.status = GAME_STATUS.FINISHED;
      this.emit('status', { status: this.status });
      this.emit('change', { reason: 'finished' });
    }
  }

  /** Value currently shown in a cell (used by the eraser and by multiplayer sync). */
  valueAt(index) {
    return this.board[index] || 0;
  }

  erase(index = this.selectedIndex) {
    return this.setValue(index, 0);
  }

  undo() {
    if (!this.undoStack.length) return false;
    if (this.isLocked) return false;
    const entry = this.undoStack.pop();
    this.board[entry.index] = entry.previous || 0;
    if (!entry.previous || entry.previous !== this.solution[entry.index]) {
      if (entry.previous) this.wrongCells.add(entry.index);
      else this.wrongCells.delete(entry.index);
    } else {
      this.wrongCells.delete(entry.index);
    }
    this.updatedAt = Date.now();
    this.emit('change', { reason: 'undo', index: entry.index });
    return true;
  }

  pause() {
    if (this.status !== GAME_STATUS.PLAYING) return false;
    this.status = GAME_STATUS.PAUSED;
    this.timer.pause();
    this.updatedAt = Date.now();
    this.emit('status', { status: this.status });
    this.emit('change', { reason: 'status' });
    return true;
  }

  resume() {
    if (this.status !== GAME_STATUS.PAUSED) return false;
    this.status = GAME_STATUS.PLAYING;
    this.timer.resume();
    this.updatedAt = Date.now();
    this.emit('status', { status: this.status });
    this.emit('change', { reason: 'status' });
    return true;
  }

  togglePause() {
    return this.status === GAME_STATUS.PAUSED ? this.resume() : this.pause();
  }

  /** Restarts the same puzzle: clears entries, mistakes and clock. */
  restart() {
    this.board = this.puzzle.slice();
    this.wrongCells.clear();
    this.undoStack = [];
    this.mistakes = 0;
    this.completedAt = null;
    this.status = GAME_STATUS.PLAYING;
    this.timer.reset().start();
    this.updatedAt = Date.now();
    this.emit('status', { status: this.status });
    this.emit('change', { reason: 'restart' });
  }

  /** Finishes the game as lost (too many mistakes). */
  fail(reason = 'failed') {
    if (this.status === GAME_STATUS.COMPLETED || this.status === GAME_STATUS.FAILED) return;
    this.status = GAME_STATUS.FAILED;
    this.timer.stop();
    this.updatedAt = Date.now();
    this.emit('status', { status: this.status, reason });
    this.emit('failed', { reason, elapsedMs: this.elapsedMs, difficulty: this.difficulty });
    this.emit('change', { reason: 'failed' });
  }

  checkCompletion() {
    if (this.status === GAME_STATUS.COMPLETED || this.status === GAME_STATUS.FAILED) return false;
    if (!isBoardComplete(this.board, this.solution)) return false;
    this.status = GAME_STATUS.COMPLETED;
    this.completedAt = Date.now();
    this.timer.stop();
    this.wrongCells.clear();
    this.updatedAt = Date.now();
    this.emit('status', { status: this.status });
    this.emit('complete', {
      elapsedMs: this.elapsedMs,
      difficulty: this.difficulty,
      mode: this.mode,
      completedAt: this.completedAt,
    });
    this.emit('change', { reason: 'complete' });
    return true;
  }

  /* --------------------------- serialization ------------------------ */

  toState() {
    return {
      id: this.id,
      mode: this.mode,
      difficulty: this.difficulty,
      seed: this.seed,
      puzzle: this.puzzle.slice(),
      solution: this.solution.slice(),
      board: this.board.slice(),
      status: this.status,
      mistakes: this.mistakes,
      eliminated: this.eliminated,
      mistakeLimit: this.mistakeLimit === Infinity ? 0 : this.mistakeLimit,
      wrongCells: Array.from(this.wrongCells),
      undoStack: this.undoStack.slice(-MAX_UNDO),
      timer: this.timer.toJSON(),
      elapsedMs: this.elapsedMs,
      progress: this.progress,
      roomId: this.roomId,
      roomCode: this.roomCode,
      playerId: this.playerId,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /** Flat progress map used by multiplayer sync (only user-entered cells). */
  progressEntries() {
    const entries = [];
    for (let i = 0; i < CELLS; i++) {
      if (!this.puzzle[i] && this.board[i]) entries.push({ cell: i, value: this.board[i] });
    }
    return entries;
  }
}
