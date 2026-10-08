/**
 * tools/test-sudoku.mjs — verification suite for the pure game logic.
 *
 * Run: node tools/test-sudoku.mjs
 * Covers puzzle generation/validity/uniqueness, solver, conflict detection, the
 * timer's refresh safety, the engine's rules and the StorageManager API (with a
 * localStorage shim, since Node has no IndexedDB).
 */

import assert from 'node:assert/strict';

/* ---------- minimal localStorage shim so the storage fallback can run ------ */
const memoryStore = new Map();
globalThis.localStorage = {
  getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key, value) => memoryStore.set(key, String(value)),
  removeItem: (key) => memoryStore.delete(key),
  clear: () => memoryStore.clear(),
};

const { generatePuzzle, generateSolvedGrid, countSolutions, solve, isValidSolution, validatePuzzle, findDuplicateCells, peersOf, isBoardComplete, makeRng } =
  await import('../js/sudoku.js');
const { Timer, formatTime } = await import('../js/timer.js');
const { GameEngine, GAME_STATUS, CorruptGameError } = await import('../js/game.js');
const { StorageManager, defaultStats } = await import('../js/storage.js');
const { mergeStats } = await import('../js/sync.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

/* ------------------------------- puzzles -------------------------------- */

console.log('\nPUZZLE GENERATION');

const PER_DIFFICULTY = 6;
const generated = [];
const clueRanges = { easy: [30, 46], medium: [26, 40], hard: [22, 36], expert: [20, 34] };

for (const difficulty of ['easy', 'medium', 'hard', 'expert']) {
  const started = Date.now();
  for (let i = 0; i < PER_DIFFICULTY; i++) {
    const puzzle = generatePuzzle(difficulty);
    generated.push({ difficulty, ...puzzle });
  }
  const elapsed = Date.now() - started;
  console.log(`  · ${difficulty}: ${PER_DIFFICULTY} puzzles in ${elapsed}ms (${Math.round(elapsed / PER_DIFFICULTY)}ms each)`);
}

test('every generated puzzle has exactly one solution', () => {
  for (const { difficulty, puzzle } of generated) {
    const count = countSolutions(puzzle, 2);
    assert.equal(count, 1, `${difficulty} puzzle has ${count} solutions`);
  }
});

test('every generated puzzle has a valid solution that matches the clues', () => {
  for (const { difficulty, puzzle, solution } of generated) {
    assert.ok(isValidSolution(solution), `${difficulty} solution invalid`);
    const result = validatePuzzle(puzzle, solution);
    assert.equal(result.valid, true, `${difficulty} puzzle validation failed: ${result.reason}`);
  }
});

test('solver reproduces the stored solution', () => {
  for (const { puzzle, solution } of generated) {
    assert.deepEqual(solve(puzzle), solution);
  }
});

test('clue counts respect the difficulty bands', () => {
  for (const { difficulty, clues } of generated) {
    const [min, max] = clueRanges[difficulty];
    assert.ok(clues >= min && clues <= max, `${difficulty} clue count ${clues} outside ${min}..${max}`);
  }
});

test('harder difficulties on average give fewer clues', () => {
  const average = (difficulty) => {
    const rows = generated.filter((row) => row.difficulty === difficulty);
    return rows.reduce((sum, row) => sum + row.clues, 0) / rows.length;
  };
  assert.ok(average('easy') > average('medium'), 'easy should have more clues than medium');
  assert.ok(average('medium') >= average('hard'), 'medium should have at least as many clues as hard');
  assert.ok(average('hard') >= average('expert'), 'hard should have at least as many clues as expert');
});

test('puzzles are randomized (two generated puzzles differ)', () => {
  const signatures = new Set(generated.map((row) => row.puzzle.join('')));
  assert.ok(signatures.size > 1, 'puzzles should not always be identical');
});

test('generation is deterministic for a shared seed', () => {
  const seed = 123456789;
  const a = generatePuzzle('hard', seed);
  const b = generatePuzzle('hard', seed);
  assert.deepEqual(a.puzzle, b.puzzle);
  assert.deepEqual(a.solution, b.solution);
  assert.equal(a.puzzleIdHint ?? a.seed, seed);
  const other = generatePuzzle('hard', seed + 1);
  assert.notDeepEqual(a.puzzle, other.puzzle);
});

test('seeded PRNG produces a stable sequence', () => {
  const first = Array.from({ length: 5 }, makeRng(42));
  const second = Array.from({ length: 5 }, makeRng(42));
  assert.deepEqual(first, second);
  assert.ok(first.every((value) => value >= 0 && value < 1));
});

test('solved grids are valid and unsolvable boards return null', () => {
  for (let i = 0; i < 5; i++) assert.ok(isValidSolution(generateSolvedGrid()));
  const contradiction = new Array(81).fill(0);
  contradiction[0] = 5;
  contradiction[1] = 5; // two 5s in the same row
  assert.equal(solve(contradiction), null);
  assert.equal(countSolutions(contradiction, 2), 0);
});

test('an empty board has many solutions (limit is respected)', () => {
  assert.equal(countSolutions(new Array(81).fill(0), 2), 2);
});

/* ------------------------------ validation ------------------------------ */

console.log('\nVALIDATION HELPERS');

test('detects duplicates in rows, columns and boxes', () => {
  const board = new Array(81).fill(0);
  board[0] = 7;
  board[4] = 7; // duplicate in row 0 (and box 1)
  board[36] = 3;
  board[63] = 3; // duplicate in column 0
  const duplicates = findDuplicateCells(board);
  assert.deepEqual(duplicates, [0, 4, 36, 63]);
});

test('peersOf returns 20 unique peers including the box', () => {
  for (const index of [0, 40, 80, 17]) {
    const peers = peersOf(index);
    assert.equal(peers.length, 20);
    assert.equal(new Set(peers).size, 20);
    assert.ok(!peers.includes(index));
  }
  const corner = peersOf(0);
  assert.ok(corner.includes(1) && corner.includes(9) && corner.includes(10));
});

test('isBoardComplete only accepts the exact solution', () => {
  const { puzzle, solution } = generated[0];
  assert.equal(isBoardComplete(puzzle, solution), false);
  assert.equal(isBoardComplete(solution, solution), true);
});

/* --------------------------------- timer -------------------------------- */

console.log('\nTIMER');

test('formatTime renders MM:SS and H:MM:SS', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(37_000), '00:37');
  assert.equal(formatTime(277_000), '04:37');
  assert.equal(formatTime(3_723_000), '1:02:03');
});

test('timer counts up, freezes on pause and resumes', async () => {
  const timer = new Timer().start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const afterRun = timer.elapsedMs;
  assert.ok(afterRun >= 100, `expected >=100ms, got ${afterRun}`);
  timer.pause();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(timer.elapsedMs, afterRun, 'paused timer must not advance');
  timer.resume();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(timer.elapsedMs > afterRun, 'resumed timer must advance');
});

test('timer survives a simulated refresh without losing time', async () => {
  const timer = new Timer().start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const snapshot = JSON.parse(JSON.stringify(timer.toJSON()));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const restored = Timer.from(snapshot);
  assert.ok(restored.elapsedMs >= timer.elapsedMs, 'restored timer keeps counting');
  assert.equal(restored.running, true);

  const paused = new Timer().start();
  paused.pause();
  const pausedSnapshot = paused.toJSON();
  const restoredPaused = Timer.from(pausedSnapshot);
  assert.equal(restoredPaused.running, false);
  assert.equal(restoredPaused.elapsedMs, paused.accumulatedMs);
});

/* -------------------------------- engine -------------------------------- */

console.log('\nGAME ENGINE');

function freshEngine(options = {}) {
  return GameEngine.create({ difficulty: 'easy', seed: 4242, mistakeLimit: 3, ...options });
}

test('givens cannot be overwritten', () => {
  const engine = freshEngine();
  const givenIndex = engine.puzzle.findIndex((value) => value !== 0);
  const before = engine.board[givenIndex];
  const result = engine.setValue(givenIndex, before === 9 ? 1 : 9);
  assert.equal(result.changed, false);
  assert.equal(engine.board[givenIndex], before);
});

test('correct values are accepted, wrong ones count as mistakes', () => {
  const engine = freshEngine();
  const empty = engine.puzzle.findIndex((value) => value === 0);
  const correctValue = engine.solution[empty];
  const wrongValue = correctValue === 9 ? 1 : correctValue + 1;
  const wrong = engine.setValue(empty, wrongValue);
  assert.equal(wrong.correct, false);
  assert.equal(engine.mistakes, 1);
  assert.equal(engine.isWrong(empty), true);

  const right = engine.setValue(empty, correctValue);
  assert.equal(right.correct, true);
  assert.equal(engine.isWrong(empty), false);
  assert.equal(engine.mistakes, 1, 'a corrected cell keeps the mistake count');
});

test('the mistake limit fails the game', () => {
  const engine = freshEngine({ mistakeLimit: 2 });
  const empties = engine.puzzle.map((value, index) => (value === 0 ? index : -1)).filter((i) => i >= 0);
  for (const index of empties.slice(0, 2)) {
    engine.setValue(index, engine.solution[index] === 9 ? 1 : engine.solution[index] + 1);
  }
  assert.equal(engine.status, GAME_STATUS.FAILED);
  assert.equal(engine.timer.running, false);
  const further = engine.setValue(empties[2], engine.solution[empties[2]]);
  assert.equal(further.changed, false, 'no moves allowed after failure');
});

test('undo restores the previous state', () => {
  const engine = freshEngine();
  const empty = engine.puzzle.findIndex((value) => value === 0);
  engine.setValue(empty, engine.solution[empty] === 9 ? 1 : engine.solution[empty] + 1);
  assert.equal(engine.undoStack.length, 1);
  engine.undo();
  assert.equal(engine.board[empty], 0);
  assert.equal(engine.isWrong(empty), false);
  assert.equal(engine.undoStack.length, 0);
  assert.equal(engine.undo(), false, 'undo with an empty stack is a no-op');
});

test('erase clears a cell and can be undone', () => {
  const engine = freshEngine();
  const empty = engine.puzzle.findIndex((value) => value === 0);
  engine.setValue(empty, engine.solution[empty]);
  engine.select(empty);
  engine.erase();
  assert.equal(engine.board[empty], 0);
  engine.undo();
  assert.equal(engine.board[empty], engine.solution[empty]);
});

test('pause stops the clock and resume restarts it', async () => {
  const engine = freshEngine();
  await new Promise((resolve) => setTimeout(resolve, 60));
  engine.pause();
  assert.equal(engine.status, GAME_STATUS.PAUSED);
  const frozen = engine.elapsedMs;
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(engine.elapsedMs, frozen);
  assert.equal(engine.setValue(engine.puzzle.findIndex((v) => v === 0), 1).changed, false, 'no input while paused');
  engine.resume();
  assert.equal(engine.status, GAME_STATUS.PLAYING);
});

test('completing the board ends the game and freezes the time', async () => {
  const engine = freshEngine();
  const empties = engine.puzzle.map((value, index) => (value === 0 ? index : -1)).filter((i) => i >= 0);
  let completed = null;
  engine.on('complete', (payload) => {
    completed = payload;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  for (const index of empties) engine.setValue(index, engine.solution[index]);
  assert.equal(engine.status, GAME_STATUS.COMPLETED);
  assert.equal(engine.progress, 1);
  assert.ok(completed && completed.elapsedMs > 0, 'completion event carries the time');
  const frozen = engine.elapsedMs;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(engine.elapsedMs, frozen, 'finished timer is frozen');
});

test('restart clears progress but keeps the same puzzle', () => {
  const engine = freshEngine();
  const puzzleCopy = engine.puzzle.join('');
  const empty = engine.puzzle.findIndex((value) => value === 0);
  engine.setValue(empty, engine.solution[empty] === 9 ? 1 : engine.solution[empty] + 1);
  engine.restart();
  assert.equal(engine.board.slice().join(''), puzzleCopy);
  assert.equal(engine.mistakes, 0);
  assert.equal(engine.wrongCells.size, 0);
  assert.equal(engine.undoStack.length, 0);
  assert.equal(engine.status, GAME_STATUS.PLAYING);
});

test('state survives serialization (refresh safety)', () => {
  const engine = freshEngine();
  const empty = engine.puzzle.findIndex((value) => value === 0);
  engine.setValue(empty, engine.solution[empty]);
  engine.select(3);
  const state = JSON.parse(JSON.stringify(engine.toState()));
  const restored = GameEngine.fromState(state);
  assert.deepEqual(restored.board, engine.board);
  assert.deepEqual(restored.puzzle, engine.puzzle);
  assert.equal(restored.mistakes, engine.mistakes);
  assert.equal(restored.status, engine.status);
  assert.equal(restored.timer.running, true);
  assert.ok(restored.elapsedMs >= state.elapsedMs, 'a running timer keeps counting after reload');
  assert.ok(restored.board.every((value, index) => value === engine.board[index]));
});

test('corrupted snapshots are rejected instead of breaking the game', () => {
  assert.throws(() => GameEngine.fromState({ puzzle: [1, 2, 3], solution: [] }), CorruptGameError);
  const engine = freshEngine();
  const state = engine.toState();
  const brokenSolution = state.solution.slice();
  brokenSolution[0] = 1;
  brokenSolution[1] = 1; // invalid grid
  assert.throws(() => GameEngine.fromState({ ...state, solution: brokenSolution }), CorruptGameError);
  const badClue = state.puzzle.map((value, index) => (index === 0 && value ? (value % 9) + 1 : value));
  assert.throws(() => GameEngine.fromState({ ...state, puzzle: badClue }), CorruptGameError);
  const outOfRangeBoard = state.board.slice();
  outOfRangeBoard[0] = 99;
  const repaired = GameEngine.fromState({ ...state, board: outOfRangeBoard });
  assert.ok(repaired.board[0] >= 0 && repaired.board[0] <= 9);
});

test('progress entries only include user-entered cells', () => {
  const engine = freshEngine();
  const empty = engine.puzzle.findIndex((value) => value === 0);
  engine.setValue(empty, engine.solution[empty]);
  const entries = engine.progressEntries();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { cell: empty, value: engine.solution[empty] });
  assert.ok(engine.progress > 0 && engine.progress <= 1);
});

/* -------------------------------- storage ------------------------------- */

console.log('\nSTORAGE');

await testAsync('init reports the fallback backend when IndexedDB is absent', async () => {
  await StorageManager.init();
  assert.ok(['localstorage', 'indexeddb'].includes(StorageManager.backendName));
});

await testAsync('game state round-trips through storage', async () => {
  const engine = freshEngine();
  await StorageManager.saveGame(engine.toState());
  const loaded = await StorageManager.loadGame();
  assert.equal(loaded.id, 'current', 'there is a single active-game slot');
  assert.equal(loaded.gameId, engine.id);
  assert.deepEqual(loaded.board, engine.board);
  await StorageManager.clearGame();
  assert.equal(await StorageManager.loadGame(), null);
});

await testAsync('stats persist with best-time tracking', async () => {
  const stats = defaultStats();
  stats.gamesPlayed = 3;
  stats.gamesCompleted = 2;
  stats.bestTimes.easy = 111_000;
  await StorageManager.saveStats(stats);
  const loaded = await StorageManager.getStats();
  assert.equal(loaded.gamesPlayed, 3);
  assert.equal(loaded.bestTimes.easy, 111_000);
  assert.equal(loaded.bestTimes.hard, null, 'missing keys fall back to defaults');
});

await testAsync('history is stored newest first and can be limited', async () => {
  for (let i = 0; i < 3; i++) {
    await StorageManager.addHistory({ difficulty: 'easy', elapsedMs: 1000 + i, result: 'completed' });
  }
  const history = await StorageManager.getHistory(2);
  assert.equal(history.length, 2);
  assert.ok(history[0].createdAt >= history[1].createdAt);
});

await testAsync('pending sync queue survives until markSynced', async () => {
  const record = await StorageManager.queueSync({ type: 'stats', payload: { gamesPlayed: 1 } });
  let pending = await StorageManager.getPendingSync();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, record.id);
  await StorageManager.markSyncFailed(record.id, 'network down');
  pending = await StorageManager.getPendingSync();
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[0].lastError, 'network down');
  await StorageManager.markSynced(record.id);
  pending = await StorageManager.getPendingSync();
  assert.equal(pending.length, 0, 'synced records leave the queue');
  const all = await StorageManager.allSyncRecords();
  assert.equal(all.length, 1, 'the record is retained for auditing');
  assert.equal(all[0].synced, true);
});

await testAsync('settings merge with defaults', async () => {
  await StorageManager.saveSettings({ mistakeLimit: 5 });
  const settings = await StorageManager.getSettings();
  assert.equal(settings.mistakeLimit, 5);
  assert.equal(settings.highlightDuplicates, true);
});

await testAsync('wipe clears local data', async () => {
  await StorageManager.wipe();
  assert.equal(await StorageManager.loadGame(), null);
  assert.equal((await StorageManager.getPendingSync()).length, 0);
  const stats = await StorageManager.getStats();
  assert.equal(stats.gamesPlayed, 0);
});

test('mergeStats keeps the best of both snapshots', () => {
  const local = { ...defaultStats(), gamesPlayed: 4, gamesCompleted: 3, bestTimes: { ...defaultStats().bestTimes, easy: 200_000 } };
  const remote = {
    ...defaultStats(),
    gamesPlayed: 9,
    gamesCompleted: 7,
    bestTimes: { ...defaultStats().bestTimes, easy: 150_000, hard: 400_000 },
  };
  const merged = mergeStats(local, remote);
  assert.equal(merged.gamesPlayed, 9);
  assert.equal(merged.gamesCompleted, 7);
  assert.equal(merged.bestTimes.easy, 150_000, 'fastest time wins');
  assert.equal(merged.bestTimes.hard, 400_000);
  assert.equal(merged.bestTimes.medium, null);
});

/* -------------------------------- summary ------------------------------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure.name}: ${failure.error.message}`);
  process.exit(1);
}
