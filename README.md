# Sudoku — Beat the Clock

A complete, **offline-first competitive Sudoku** application built with **HTML5, CSS3 and vanilla
JavaScript only** — no React/Vue/Angular, no TypeScript, no jQuery/Bootstrap/Tailwind, no build step
and no runtime dependencies in the frontend. ES modules, a service worker and IndexedDB are the only
"frameworks".

TIME is the score: every mode is a race against the clock, and multiplayer is a head-to-head race on
the *same* puzzle.

---

## 1. Quick start

### Play the single player game (no backend needed)

The app is a static site, but it must be served over `http://` (ES modules + service workers do not
work from `file://`).

```bash
# any static server works, e.g.
npx serve .            # or: python -m http.server 8000
```

Then open the printed URL. Everything — puzzle generation, timer, statistics, history, offline
caching — works with the network switched off.

### Run the whole thing, including multiplayer and sync

```bash
npm start                      # from the project root: node server/server.js

# or, backend only (its own package.json owns the single dependency)
cd server && npm install && npm start
```

* App: <http://localhost:8787>
* WebSocket endpoint: `ws://localhost:8787/ws`
* Sync API: `POST http://localhost:8787/api/sync`
* Health check: `GET http://localhost:8787/api/health`

Open the URL in two tabs (or two devices on the same machine/network), then:

1. **Multiplayer → Create room** in tab 1 → note the 5-character code (e.g. `X7K92`).
2. **Multiplayer → Join room** with that code in tab 2.
3. Both press **I'm ready** → the race starts automatically on an identical puzzle.

The only npm dependency in the whole project is [`ws`](https://github.com/websockets/ws), used by the
backend. The frontend has zero dependencies.

---

## 2. Project structure

```
sudoku/
├── index.html            # app shell: every screen, board, numpad, status bar
├── style.css             # theme tokens, responsive layout, dark/light, a11y focus styles
├── app.js                # bootstrap: routing, wiring, persistence, stats, multiplayer session
├── manifest.json         # PWA manifest (name, icons, display, colors)
├── sw.js                 # service worker: app shell cache + offline navigation fallback
│
├── js/
│   ├── sudoku.js         # pure logic: seeded PRNG, generator, solver, uniqueness, conflicts
│   ├── game.js           # GameEngine: rules, undo, mistakes, pause, completion, serialization
│   ├── timer.js          # pausable, refresh-safe timer + time formatting
│   ├── storage.js        # StorageManager: IndexedDB abstraction with localStorage fallback
│   ├── sync.js           # SyncManager: offline queue, retries/backoff, cross-tab bus
│   ├── multiplayer.js    # MultiplayerClient: WebSocket protocol, reconnect, session restore
│   ├── chat.js           # ChatClient: server-authoritative room chat (no own socket)
│   ├── chat-ui.js        # ChatUI: desktop side panel + mobile bottom sheet
│   ├── chat-toast.js     # ChatToast: single-slot incoming-message notification
│   ├── voice.js          # VoiceCall: WebRTC audio calls (signaling over the room socket)
│   ├── voice-ui.js       # VoiceUI: tool button, in-call panel, incoming-call modal
│   └── ui.js             # UI layer: renders state and reports user intent (no game rules)
│
├── assets/               # SVG + generated PNG icons (192/512/maskable)
├── server/               # OPTIONAL backend (authoritative multiplayer + sync API + static host)
│   ├── server.js
│   └── package.json
│
├── tools/                # verification suite (not shipped to the browser)
│   ├── test-sudoku.mjs        # 35 logic/engine/timer/storage checks
│   ├── test-multiplayer.mjs   # 25 end-to-end WebSocket/server checks
│   ├── test-standalone.mjs    # 6 checks on a static-only host (no backend at all)
│   ├── browser-smoke.mjs      # 27 real-browser checks over the Chrome DevTools Protocol
│   ├── make-icons.mjs         # dependency-free PNG icon generator
│   └── screenshots/           # screenshots captured by the browser suite
└── package.json          # ESM type + npm scripts (no dependencies)
```

### Architecture

```
                    ┌─────────────────┐
                    │   Sudoku UI     │   js/ui.js + index.html + style.css
                    └────────┬────────┘
                             │ intent / render
                    ┌────────▼────────┐
                    │   Game Engine   │   js/game.js + js/sudoku.js + js/timer.js
                    └──────┬─────┬────┘
             ┌─────────────┘     └──────────────┐
             ▼                                  ▼
     ┌────────────────┐                 ┌────────────────┐
     │ Local Storage  │                 │ Multiplayer    │
     │ / IndexedDB    │                 │ WebSocket      │
     └────────────────┘                 └───────┬────────┘
                                                │
                                         ┌──────▼──────┐
                                         │ Multiplayer │  server/server.js (authoritative)
                                         │   Server    │
                                         └─────────────┘
```

Rules live in the engine, rendering lives in the UI, persistence lives in `StorageManager`, the
network lives in `MultiplayerClient`/`SyncManager`. `app.js` is the only file that knows about all of
them, and it is ~500 lines of wiring, not game logic.

---

## 3. Offline-first behaviour

**The single player game never depends on the internet.** There is no server check before play, no
"loading account" step and no network call in the startup path.

```
Start game → playable locally? → YES → start immediately
                                   → if online: queue a sync → if offline: keep playing
```

* **Service worker (`sw.js`)** caches the whole app shell on install. Navigations are network-first
  with a cached fallback; static assets are cache-first with a background refresh; `/api/*` is never
  cached. After the first successful load the app opens and runs with the network off.
* **`StorageManager` (js/storage.js)** is the single persistence API. It uses **IndexedDB** and falls
  back to **localStorage** if IndexedDB is unavailable:

  ```js
  StorageManager.saveGame(game);      StorageManager.loadGame();
  StorageManager.saveStats(stats);    StorageManager.getStats();
  StorageManager.addHistory(record);  StorageManager.getHistory();
  StorageManager.queueSync(record);   StorageManager.getPendingSync();
  StorageManager.markSynced(id);      StorageManager.markSyncFailed(id, error);
  StorageManager.getSettings();       StorageManager.saveSettings(settings);
  ```

  State is stored in five object stores: `games` (active game), `stats`, `history`, `settings`,
  `pendingSync`. The active game record contains exactly the pieces the spec asks for: puzzle,
  solution, user progress (`board`), timer, difficulty, game status, mistakes, wrong cells and the
  undo stack.

* **`SyncManager` (js/sync.js)** writes every change locally *first* and appends syncable records to
  `pendingSync`. It flushes them when the browser fires `online`, on a timer, and on demand. Failures
  use exponential backoff (`2s → 5s → 15s → 60s → 300s`), never block gameplay, and surface the
  message *"Sync failed. Your local progress is safe. We'll try again automatically."* Records for
  the same id are deduplicated by the server, and incompatible stat snapshots are merged safely
  (`mergeStats` keeps the best time and the higher counters).
* **Cross-tab bus (`BroadcastChannel`)** notifies other tabs when stats or the active game change.
* The status bar always shows the truth: `● Online` / `● Offline`, then `Syncing…` → `✓ Synced`.

Offline transition, as implemented:

```
ONLINE → OFFLINE        ● Offline          (game keeps running, records queue up)
OFFLINE → ONLINE        ● Back online
                        Syncing…           (queue drained automatically)
                        ✓ Synced           (no page refresh required)
```

---

## 4. Multiplayer

### 4.1 The shared puzzle

The server owns puzzle generation per race:

1. On race start the server calls the *same* `generatePuzzle(difficulty)` from `js/sudoku.js` that the
   client uses, producing `{ puzzle, solution, seed, clues }` from a random 32-bit seed.
2. It broadcasts `GAME_STARTED` with `{ puzzleId, seed, difficulty, startedAt }`.
3. Both clients generate the board from that seed — identical clues, identical solution — so no board
   is ever transmitted and neither client can invent its own puzzle.
4. The server keeps the solution, so it can validate any submitted board. `puzzleId` is
   `pz-<room>-<seed in base36>`; a mismatch is rejected.

### 4.2 Protocol (JSON over WebSocket at `/ws`)

Client → server:

| Message | Purpose |
| --- | --- |
| `CREATE_ROOM` | create a room (`{name, difficulty}`) |
| `JOIN_ROOM` | join or reconnect (`{roomId, name}`) |
| `PLAYER_READY` | ready toggle for the lobby / rematch |
| `START_GAME` | explicit start (also automatic when both are ready) |
| `PLAYER_PROGRESS` | one cell changed (`{cell, value, timestamp}`) |
| `PLAYER_MOVE` | one cell submitted for validation (`{cell, value}`) — the server decides correctness |
| `PLAYER_COMPLETED` | finished board (`{board, clientTimestamp}`) — the timestamp is advisory only |
| `REQUEST_STATE` | ask for the authoritative snapshot (sent on reconnect) |
| `PLAYER_SETTINGS` | pre-game lobby: propose a mistake limit `{roomId, maxMistakes}` |
| `CALL_CONFIG` | request this player's ICE servers (STUN + ephemeral TURN) |
| `CALL_INVITE` / `CALL_ACCEPT` / `CALL_DECLINE` / `CALL_END` | voice-call lifecycle for the room |
| `CALL_SIGNAL` | opaque SDP/ICE relayed only to the opponent `{roomId, signal}` |
| `LEAVE_ROOM` / `PING` | leave the table / keepalive |

Server → client: `ROOM_CREATED`, `ROOM_STATE`, `PLAYER_JOINED`, `PLAYER_LEFT`, `PLAYER_READY`,
`GAME_STARTED`, `PROGRESS_STATE`, `PLAYER_PROGRESS`, `MOVE_RESULT`, `PLAYER_COMPLETED`,
`PLAYER_DISCONNECTED`, `PLAYER_RECONNECTED`, `GAME_FINISHED`, `GAME_ENDED`, `PONG`, `ERROR`
(`ROOM_NOT_FOUND`, `ROOM_FULL`, `ROOM_IN_PROGRESS`, `INVALID_SOLUTION`, `NOT_IN_ROOM`,
`RATE_LIMITED`, `INVALID_PLAYER`, `UNKNOWN_TYPE`).

Every cell entry is validated by the server, which replies with its verdict and the
authoritative mistake count — the correct value is never sent back:

```json
{ "type": "PLAYER_MOVE", "cell": 42, "value": 7 }
{ "type": "MOVE_RESULT", "correct": false, "cell": 42, "value": 7, "mistakes": 1, "remainingMistakes": 2, "maxMistakes": 3 }
```

Progress is event-based and throttled by design — one small message per changed cell, never a whole
board stream:

```json
{ "type": "PLAYER_PROGRESS", "roomId": "X7K92", "playerId": "abc123", "cell": 42, "value": 7, "timestamp": 1730000000000 }
```

### 4.3 Rooms, reconnects and disconnections

* A room holds **2 players**, has a 5-character code from an unambiguous alphabet
  (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) and lives until it is empty and idle for 15 minutes.
* Refresh, tab close and network loss are survivable: the player identity is remembered in
  `sessionStorage`, the client reconnects with exponential backoff (`1s → 2s → 4s → … → 30s`), asks
  for `ROOM_STATE` and reapplies the authoritative progress snapshot. Opening the app again rejoins
  the stored room automatically, even mid-race.
* Disconnected players are kept for a 3-minute grace period and shown as `● Reconnecting…` to the
  opponent. Leaving a race on purpose awards the win to the player who stayed.
* A finished race can be replayed: both players press ready again and the server deals a brand new
  puzzle (never the same board twice).

### 4.4 Who wins (server side, not client side)

The client cannot declare a winner. It only reports `PLAYER_COMPLETED { board }`; the server:

1. checks the room is running and the player has not already finished;
2. checks `puzzleId` matches the current race;
3. checks the board has 81 integer cells, still contains every original clue, and **equals the
   server's own solution**;
4. stamps `completedAt = Date.now()` on the *server* clock and computes `elapsedMs = completedAt −
   startedAt` (the official start time);
5. the first valid completion becomes `winnerId` and `GAME_FINISHED` is broadcast to both players;
6. a second, late finish is still recorded with its real server time and the result message is
   re-broadcast, but the winner does not change.

Invalid submissions produce `ERROR INVALID_SOLUTION` and are logged — no result is issued. Client
`clientTimestamp` values are ignored entirely, so a hacked clock or a fake `{winner: true}` message
changes nothing (`WINNER` is not even a known message type; unknown types are rejected explicitly).

### 4.5 Voice calls (WebRTC)

Multiplayer rooms support **real, audio-only peer-to-peer voice calls**. There is no second backend:
signaling reuses the authenticated room WebSocket, and audio never touches the server.

* **Signaling.** `CALL_INVITE` rings the opponent; `CALL_ACCEPT` / `CALL_DECLINE` answer it; `CALL_END`
hangs up; `CALL_SIGNAL` carries the SDP offer/answer, trickled ICE candidates and a tiny mute flag.
The server never inspects or stores the payload — it only enforces *who may talk to whom*: sender and
recipient are resolved from the socket's own room membership (a client-supplied `roomId` is never
trusted), the call must be in a valid state, and signaling is relayed to the opponent alone. Chat
and voice messages can never change Sudoku state.
* **ICE configuration.** `CALL_CONFIG` returns the ICE servers *for that player* over the authenticated
socket. STUN is public; when TURN is configured the server mints **short-lived HMAC credentials**
(the coturn REST API scheme) so the shared secret is never sent to a client, logged, or committed.
* **Media.** The client uses `RTCPeerConnection` + `getUserMedia` (audio only), attaches the remote
track to a managed `<audio>` element and plays it (autoplay is handled gracefully). The microphone is
requested only when a player starts or accepts a call — never on entering a room. Tracks and peer
connections are released on end, decline, timeout, opponent disconnect/leave, match end, socket loss
and page teardown; audio is never recorded or persisted.
* **Timeouts.** Unanswered calls ring for 45 s (`CALL_RING_TIMEOUT_MS`) and are cleared on both ends;
the client adds ring/connect/reconnect guards and clears stale state.

Configuration (all optional; see the server's `process.env` reads):

| Variable | Purpose |
| --- | --- |
| `STUN_URLS` | Comma-separated STUN URLs (default `stun:stun.l.google.com:19302`) |
| `TURN_URLS` | Comma-separated TURN URLs, e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349` |
| `TURN_STATIC_SECRET` | Shared secret for coturn's `static-auth-secret` (drives ephemeral credentials) |
| `TURN_TTL_SECONDS` | Lifetime of a minted credential (default 3600) |
| `CALL_RING_TIMEOUT_MS` | How long an unanswered call rings (default 45000) |

HTTPS is required in production for `getUserMedia` (localhost is treated as secure). A production
deployment therefore needs TLS termination in front of the server plus a reachable TURN service; STUN
alone works only when a direct path exists.

### 4.6 Mistake limit

A race also ends when a player makes **3 mistakes**. Every entered value is validated against the
server's own solution; an incorrect one increments that player's server-owned `mistakes` counter
(never a client-supplied value) and the client is told only *that* it was wrong. The third mistake
marks the player `eliminated`, awards the win to the opponent and broadcasts `GAME_FINISHED`:

```json
{ "type": "GAME_FINISHED", "winnerId": "player-2", "loserId": "player-1", "reason": "OPPONENT_MISTAKE_LIMIT" }
```

* Selecting a cell, erasing, navigating and entering the correct number are never mistakes.
* Correct answers keep contributing to completion; deleting a value is never a mistake.
* After elimination the loser's input is disabled and further `PLAYER_MOVE`s are rejected; the clock
  stops and completion submissions are refused.
* The mistake count lives in the room state (and on disk), so it survives a disconnect, a refresh or
  a server restart along with the puzzle and the original timer.
* Chat stays on the same room WebSocket and remains usable after the race ends.
* Explicit result reasons are stored with every finish: `PLAYER_COMPLETED`, `OPPONENT_COMPLETED`,
  `OPPONENT_MISTAKE_LIMIT` and `OPPONENT_ABANDONED`.

### 4.7 Sync API (optional)

`POST /api/sync` accepts one record `{ id, type, payload, createdAt, updatedAt }` and returns
`{ ok, duplicate, stored, stats }`. Records are idempotent by id, so retries after a flaky connection
can never double-count. `GET /api/health` reports uptime, room count and stored sync records.

---

## 5. Single player features

* **Generation** — randomised backtracking fill, then symmetric clue removal validated by a bitmask
  MRV solver so **every puzzle has exactly one solution** (≈3–10 ms per puzzle, measured).
  Difficulties: Easy / Medium / Hard / Expert, each with its own clue target.
* **Play** — number pad, keyboard, cell highlighting (row/column/box peers, matching numbers,
  duplicates, mistakes), undo, erase, pause/resume, restart.
* **Mistakes** — wrong entries are flagged; the configurable mistake limit (default 3, `0` = off)
  ends the game and is counted in *Games Failed*.
* **Timer** — starts with the puzzle, stops on completion, freezes while paused, survives refreshes
  in both directions (never resets, never fast-forwards), and works offline.
* **Records** — completion time, per-difficulty best time, average time, history of recent games.
* **Statistics** — single player and multiplayer (games, wins, losses, win rate) with local storage
  and background synchronisation when a backend is available.
* **Settings** — player name, mistake limit, duplicate highlighting, haptics, multiplayer URL, sync
  endpoint, export data (JSON), clear local data.

### Accessibility

Real `<button>` elements everywhere (`role="grid"`/`gridcell` on the board), ARIA labels per cell
("Row 4 column 5, value 7, given"), a live region announcing mistakes/completions/race results,
visible `:focus-visible` outlines, arrow-key navigation, digits `1–9` to fill, `Backspace/Delete` to
erase, `U`/`P` shortcuts, ≥40 px touch targets, sufficient contrast and dark/light theming.

---

## 6. Verification

```bash
npm test          # logic suite + multiplayer integration suite + static-host-only suite
npm run smoke     # real browser: gameplay, refresh, offline, sync, two-tab race, mobile, console
```

| Suite | Checks | What it proves |
| --- | --- | --- |
| `tools/test-standalone.mjs` | 6 | the frontend on a plain static host (`/api` and `/ws` return 404): the game starts, plays, keeps its timer, survives a sync failure, restores after a reload and degrades gracefully on the multiplayer screen — i.e. **the Sudoku game works without the backend** |
| `tools/test-sudoku.mjs` | 35 | unique solutions, solver agreement, clue bands, deterministic seeds, duplicate detection, timer pause/refresh, engine rules (givens, mistakes, undo, pause, restart, completion, serialization, corruption), StorageManager round-trips and the sync queue |
| `tools/test-multiplayer.mjs` | 39 | server boot, static hosting, path-traversal blocking, room create/join/full/not-found, state relay to both players, identical seeded puzzle, progress relay without echo, clue tampering, **server-decided winner**, late finisher, rematch, cheat rejection, reconnect with replay, **3-mistake elimination + `OPPONENT_MISTAKE_LIMIT` + rejected post-game move + client-manipulation rejection + mistake persistence across reconnect**, **pre-game settings agreement/mismatch/readiness/unlimited**, **voice signaling (invite/accept/decline/signal/end), busy + invalid states, no-answer timeout, peer-disconnect, cross-room rejection, and ephemeral TURN credentials that never leak the secret**, sync idempotency, abandonment, rate limiting |
| `tools/browser-smoke.mjs` | 33 | headless Chrome through the real UI: board/a11y, timer, mouse+keyboard play, peers, givens, mistakes/undo, pause, **refresh continuity**, **offline play**, **offline reload via service worker**, queue drain → `✓ Synced`, completion + stats, **two-tab race with an identical puzzle and an authoritative winner**, **3-mistake elimination with the game-over/you-win overlays and chat still open**, **lobby settings gating**, **chat beside the board + board-safe toast**, **mobile chat sheet**, **a real two-tab WebRTC audio call over fake devices (connect, remote audio, mute, teardown)**, opponent drop/rejoin, lobby leave, 390×844 layout, zero console errors |

The suites were written before/while building and each failure was investigated rather than relaxed;
screenshots from the browser run land in `tools/screenshots/`.

All suites are green: **113 checks (35 + 39 + 6 + 33), 0 failures, 0 browser console errors.**

Known limits (honest list):

* The frontend must be served over `http(s)` — `file://` cannot use ES modules, IndexedDB-backed
  service workers or WebSockets.
* Sync state on the demo backend is in-memory (the sync API is a demonstration endpoint). Rooms and
  results are equally in-memory; a production deployment would persist them and add accounts.
* Multiplayer matches two players per room and does not implement matchmaking or spectating.
* Voice calls are verified end-to-end between two tabs on one machine (two real `RTCPeerConnection`s
  over fake media devices). Cross-network connectivity, real microphones and TURN relay fallbacks
  are **not** covered by the automated suite — they need a TURN service and TLS in production, and
  should be tested on the target networks.
* Chrome/Edge is required for the browser suite (`CHROME_PATH` overrides detection), and
  `tools/browser-smoke.mjs` exits with code 2 when no browser is found.
