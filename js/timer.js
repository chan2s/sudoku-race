/**
 * timer.js — a pausable game timer that survives page refreshes.
 *
 * The timer stores `accumulatedMs` (time banked while running) plus `startedAt`
 * (wall-clock mark for the current running span), so a refresh or an offline
 * period never loses or fast-forwards the count.
 */

export class Timer {
  constructor(state = {}) {
    this.running = Boolean(state.running);
    this.accumulatedMs = Number(state.accumulatedMs) || 0;
    this.startedAt = Number(state.startedAt) || 0;
    if (this.running && !this.startedAt) this.startedAt = Date.now();
  }

  /** Starts from zero (or from an explicit bank of milliseconds). */
  start(accumulatedMs = 0) {
    this.running = true;
    this.accumulatedMs = accumulatedMs;
    this.startedAt = Date.now();
    return this;
  }

  pause() {
    if (!this.running) return this;
    this.accumulatedMs = this.elapsedMs;
    this.running = false;
    this.startedAt = 0;
    return this;
  }

  resume() {
    if (this.running) return this;
    this.running = true;
    this.startedAt = Date.now();
    return this;
  }

  /** Freezes the clock (finished game). */
  stop() {
    return this.pause();
  }

  reset() {
    this.running = false;
    this.accumulatedMs = 0;
    this.startedAt = 0;
    return this;
  }

  get elapsedMs() {
    if (!this.running) return this.accumulatedMs;
    return this.accumulatedMs + Math.max(0, Date.now() - this.startedAt);
  }

  toJSON() {
    return {
      running: this.running,
      accumulatedMs: this.accumulatedMs,
      startedAt: this.startedAt,
    };
  }

  static from(state) {
    return new Timer(state);
  }
}

/** "MM:SS" (or "H:MM:SS" past an hour) — used everywhere time is displayed. */
export function formatTime(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(value)}%`;
}
