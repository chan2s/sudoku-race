/**
 * sudoku.js — pure Sudoku logic (no DOM, no browser APIs).
 * Runs both in the browser and in Node (used by the multiplayer server to
 * generate puzzles and to validate player submissions).
 *
 * A board is a flat array/typed array of 81 numbers: 0 = empty, 1..9 = value.
 */

export const SIZE = 9;
export const CELLS = SIZE * SIZE;
export const ALL_DIGITS = 0x1ff; // bitmask of digits 1..9

export const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'];

/** Target number of clues kept per difficulty (lower = harder). */
export const CLUE_TARGETS = {
  easy: 42,
  medium: 34,
  hard: 29,
  expert: 25,
};

const BIT_TO_VALUE = new Int8Array(ALL_DIGITS + 1);
for (let v = 1; v <= SIZE; v++) BIT_TO_VALUE[1 << (v - 1)] = v;

/** Digits (1..9) present in a candidate bitmask, in ascending order. */
export function valuesInMask(mask) {
  const values = [];
  let remaining = mask;
  while (remaining) {
    const bit = remaining & -remaining;
    remaining ^= bit;
    const value = BIT_TO_VALUE[bit];
    if (value) values.push(value);
  }
  return values;
}

export function boxIndex(index) {
  const row = (index / SIZE) | 0;
  const col = index % SIZE;
  return ((row / 3) | 0) * 3 + ((col / 3) | 0);
}

export function rowCol(index) {
  return { row: (index / SIZE) | 0, col: index % SIZE };
}

/* ------------------------------------------------------------------ *
 * Seeded PRNG (mulberry32) — lets clients and server derive the exact
 * same puzzle from a shared numeric seed.
 * ------------------------------------------------------------------ */

export function makeRng(seed) {
  let a = Number(seed) >>> 0;
  if (a === 0) a = 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  const buf = new Uint32Array(1);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf);
  } else {
    buf[0] = (Math.random() * 0xffffffff) >>> 0;
  }
  return buf[0] || 1;
}

function shuffled(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Solver core (bitmask + minimum-remaining-values search)
 * ------------------------------------------------------------------ */

function buildMasks(board) {
  const rows = new Int16Array(SIZE);
  const cols = new Int16Array(SIZE);
  const boxes = new Int16Array(SIZE);
  let consistent = true;
  for (let i = 0; i < CELLS; i++) {
    const v = board[i] | 0;
    if (!v) continue;
    if (v < 1 || v > SIZE) {
      consistent = false;
      continue;
    }
    const bit = 1 << (v - 1);
    const r = (i / SIZE) | 0;
    const c = i % SIZE;
    const b = boxIndex(i);
    if (rows[r] & bit || cols[c] & bit || boxes[b] & bit) consistent = false;
    rows[r] |= bit;
    cols[c] |= bit;
    boxes[b] |= bit;
  }
  // An input that already breaks the rules has no completions, and searching
  // for one would be exponential — say so immediately.
  return { rows, cols, boxes, consistent };
}

function candidateMask(masks, index) {
  const used =
    masks.rows[(index / SIZE) | 0] | masks.cols[index % SIZE] | masks.boxes[boxIndex(index)];
  return ALL_DIGITS & ~used;
}

/**
 * Counts solutions up to `limit` (default 2 → "is the solution unique?").
 */
export function countSolutions(board, limit = 2) {
  const grid = Int8Array.from(board, (v) => v | 0);
  const masks = buildMasks(grid);
  if (!masks.consistent) return 0;
  let count = 0;

  function search() {
    let best = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < CELLS; i++) {
      if (grid[i]) continue;
      const mask = candidateMask(masks, i);
      const n = popcount(mask);
      if (n === 0) return; // contradiction
      if (n < bestCount) {
        bestCount = n;
        best = i;
        bestMask = mask;
        if (n === 1) break;
      }
    }
    if (best === -1) {
      count++;
      return;
    }
    const r = (best / SIZE) | 0;
    const c = best % SIZE;
    const b = boxIndex(best);
    let mask = bestMask;
    while (mask) {
      const bit = mask & -mask;
      mask ^= bit;
      const value = BIT_TO_VALUE[bit];
      grid[best] = value;
      masks.rows[r] |= bit;
      masks.cols[c] |= bit;
      masks.boxes[b] |= bit;
      search();
      grid[best] = 0;
      masks.rows[r] &= ~bit;
      masks.cols[c] &= ~bit;
      masks.boxes[b] &= ~bit;
      if (count >= limit) return;
    }
  }

  search();
  return count;
}

function popcount(x) {
  let c = 0;
  let v = x;
  while (v) {
    v &= v - 1;
    c++;
  }
  return c;
}

/** Returns the first solution found, or null when the board is unsolvable. */
export function solve(board) {
  const grid = Int8Array.from(board, (v) => v | 0);
  const masks = buildMasks(grid);
  if (!masks.consistent) return null;
  const out = new Int8Array(CELLS);

  function search() {
    let best = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < CELLS; i++) {
      if (grid[i]) continue;
      const mask = candidateMask(masks, i);
      const n = popcount(mask);
      if (n === 0) return false;
      if (n < bestCount) {
        bestCount = n;
        best = i;
        bestMask = mask;
        if (n === 1) break;
      }
    }
    if (best === -1) {
      out.set(grid);
      return true;
    }
    const r = (best / SIZE) | 0;
    const c = best % SIZE;
    const b = boxIndex(best);
    let mask = bestMask;
    while (mask) {
      const bit = mask & -mask;
      mask ^= bit;
      const value = BIT_TO_VALUE[bit];
      grid[best] = value;
      masks.rows[r] |= bit;
      masks.cols[c] |= bit;
      masks.boxes[b] |= bit;
      if (search()) return true;
      grid[best] = 0;
      masks.rows[r] &= ~bit;
      masks.cols[c] &= ~bit;
      masks.boxes[b] &= ~bit;
    }
    return false;
  }

  return search() ? Array.from(out) : null;
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

/** Fills an empty board with a completed, randomized valid grid. */
export function generateSolvedGrid(rng = Math.random) {
  const grid = new Int8Array(CELLS);
  const rows = new Int16Array(SIZE);
  const cols = new Int16Array(SIZE);
  const boxes = new Int16Array(SIZE);

  function fill() {
    let best = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < CELLS; i++) {
      if (grid[i]) continue;
      const used = rows[(i / SIZE) | 0] | cols[i % SIZE] | boxes[boxIndex(i)];
      const mask = ALL_DIGITS & ~used;
      const n = popcount(mask);
      if (n === 0) return false;
      if (n < bestCount) {
        bestCount = n;
        best = i;
        bestMask = mask;
        if (n === 1) break;
      }
    }
    if (best === -1) return true;

    const r = (best / SIZE) | 0;
    const c = best % SIZE;
    const b = boxIndex(best);
    const values = shuffled(valuesInMask(bestMask), rng);

    for (const value of values) {
      const bit = 1 << (value - 1);
      grid[best] = value;
      rows[r] |= bit;
      cols[c] |= bit;
      boxes[b] |= bit;
      if (fill()) return true;
      grid[best] = 0;
      rows[r] &= ~bit;
      cols[c] &= ~bit;
      boxes[b] &= ~bit;
    }
    return false;
  }

  fill();
  return Array.from(grid);
}

/**
 * Generates a puzzle with a unique solution.
 * The same (difficulty, seed) pair always yields the same puzzle, which is how
 * multiplayer players and the server agree on one shared board.
 */
export function generatePuzzle(difficulty = 'easy', seed = randomSeed()) {
  const level = DIFFICULTIES.includes(difficulty) ? difficulty : 'easy';
  const target = CLUE_TARGETS[level];
  const rng = makeRng(seed);
  const solution = generateSolvedGrid(rng);
  const puzzle = Int8Array.from(solution);

  const removeIfStillUnique = (index) => {
    const value = puzzle[index];
    if (!value) return 0;
    puzzle[index] = 0;
    if (countSolutions(puzzle, 2) === 1) return 1;
    puzzle[index] = value; // removal creates ambiguity → keep the clue
    return 0;
  };

  let clues = CELLS;
  // Pass 1: 180°-rotationally symmetric removals (looks like a classic puzzle).
  const pairStarts = shuffled(
    Array.from({ length: Math.ceil(CELLS / 2) }, (_, i) => i),
    rng,
  );
  for (const start of pairStarts) {
    if (clues <= target) break;
    const mirror = CELLS - 1 - start;
    clues -= removeIfStillUnique(start);
    if (mirror !== start) clues -= removeIfStillUnique(mirror);
  }

  // Pass 2: single removals to reach the requested difficulty.
  if (clues > target) {
    const singles = shuffled(
      Array.from({ length: CELLS }, (_, i) => i),
      rng,
    );
    for (const index of singles) {
      if (clues <= target) break;
      clues -= removeIfStillUnique(index);
    }
  }

  return {
    puzzle: Array.from(puzzle),
    solution,
    difficulty: level,
    seed: Number(seed) >>> 0,
    clues,
  };
}

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

/** True when a completely filled board is a legal Sudoku grid. */
export function isValidSolution(board) {
  if (!board || board.length !== CELLS) return false;
  const rows = new Int16Array(SIZE);
  const cols = new Int16Array(SIZE);
  const boxes = new Int16Array(SIZE);
  for (let i = 0; i < CELLS; i++) {
    const v = board[i] | 0;
    if (v < 1 || v > SIZE) return false;
    const bit = 1 << (v - 1);
    const r = (i / SIZE) | 0;
    const c = i % SIZE;
    const b = boxIndex(i);
    if (rows[r] & bit || cols[c] & bit || boxes[b] & bit) return false;
    rows[r] |= bit;
    cols[c] |= bit;
    boxes[b] |= bit;
  }
  return true;
}

/** Checks a puzzle against its solution: clues agree and the solution is legal. */
export function validatePuzzle(puzzle, solution) {
  if (!puzzle || !solution || puzzle.length !== CELLS || solution.length !== CELLS) {
    return { valid: false, reason: 'invalid-dimensions' };
  }
  if (!isValidSolution(solution)) return { valid: false, reason: 'solution-invalid' };
  for (let i = 0; i < CELLS; i++) {
    if (puzzle[i] && puzzle[i] !== solution[i]) {
      return { valid: false, reason: 'clue-conflicts-with-solution', index: i };
    }
  }
  if (countSolutions(puzzle, 2) !== 1) return { valid: false, reason: 'solution-not-unique' };
  return { valid: true };
}

export function isBoardComplete(board, solution) {
  for (let i = 0; i < CELLS; i++) {
    if ((board[i] | 0) !== (solution[i] | 0)) return false;
  }
  return true;
}

/** Number of filled cells that differ from the solution. */
export function countWrongCells(board, solution) {
  let wrong = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = board[i] | 0;
    if (v && v !== solution[i]) wrong++;
  }
  return wrong;
}

/**
 * Indices of cells that duplicate another value in the same row, column or box.
 * Used for the "duplicate" highlight (independent of the known solution).
 */
export function findDuplicateCells(board) {
  const conflicts = new Set();
  const groups = [];
  for (let r = 0; r < SIZE; r++) groups.push(Array.from({ length: SIZE }, (_, c) => r * SIZE + c));
  for (let c = 0; c < SIZE; c++) groups.push(Array.from({ length: SIZE }, (_, r) => r * SIZE + c));
  for (let b = 0; b < SIZE; b++) {
    const base = ((b / 3) | 0) * 3 * SIZE + (b % 3) * 3;
    groups.push(
      Array.from({ length: SIZE }, (_, i) => base + ((i / 3) | 0) * SIZE + (i % 3)),
    );
  }
  for (const group of groups) {
    const seen = new Map();
    for (const index of group) {
      const value = board[index] | 0;
      if (!value) continue;
      if (seen.has(value)) {
        conflicts.add(index);
        conflicts.add(seen.get(value));
      } else {
        seen.set(value, index);
      }
    }
  }
  return Array.from(conflicts).sort((a, b) => a - b);
}

/** Peer indices (row, column, box) that share a unit with `index`. */
export function peersOf(index) {
  const { row, col } = rowCol(index);
  const peers = new Set();
  for (let i = 0; i < SIZE; i++) {
    peers.add(row * SIZE + i);
    peers.add(i * SIZE + col);
  }
  const boxRow = ((row / 3) | 0) * 3;
  const boxCol = ((col / 3) | 0) * 3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) peers.add((boxRow + r) * SIZE + boxCol + c);
  }
  peers.delete(index);
  return Array.from(peers);
}
