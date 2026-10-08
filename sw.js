/**
 * sw.js — service worker for the Sudoku app shell.
 *
 * Offline-first rules:
 *  - the app shell (HTML/CSS/JS/icons) is cached on install and served from
 *    cache first, so the game opens instantly and works with no connection;
 *  - navigations are network-first with a cached fallback, so updates land
 *    when online but the app still opens offline;
 *  - API/sync requests are never cached: the app keeps its own durable queue.
 */

const VERSION = 'sudoku-shell-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './js/sudoku.js',
  './js/game.js',
  './js/timer.js',
  './js/storage.js',
  './js/sync.js',
  './js/multiplayer.js',
  './js/ui.js',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll fails the whole install if one file is missing, so cache individually.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((error) => {
            console.warn('[sw] could not cache', url, error);
          }),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function isCacheable(request, url) {
  if (request.method !== 'GET') return false;
  if (url.pathname.includes('/api/')) return false;
  return url.origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (!isCacheable(request, url)) return; // let the network handle API/WebSocket/etc.

  // App navigations: fresh HTML when online, cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', response.clone()).catch(() => {});
          return response;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('./index.html')) ||
            (await cache.match('./')) ||
            new Response('Offline and the app shell is not cached yet.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            })
          );
        }
      })(),
    );
    return;
  }

  // Static assets: cache-first with a background refresh.
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      if (cached) {
        fetch(request)
          .then((response) => {
            if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
          })
          .catch(() => {});
        return cached;
      }
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const runtime = await caches.open(RUNTIME_CACHE);
          runtime.put(request, response.clone()).catch(() => {});
        }
        return response;
      } catch (error) {
        const runtime = await caches.open(RUNTIME_CACHE);
        const fallback = await runtime.match(request);
        if (fallback) return fallback;
        throw error;
      }
    })(),
  );
});
