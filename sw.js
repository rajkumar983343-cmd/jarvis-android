/* =========================================================
   JARVIS – Personal AI Assistant · sw.js
   Offline-first service worker for the app shell.

   - Caches the app files on install.
   - Page loads: network first, then cache, then a built-in offline screen.
   - Other same-origin files: cache first, refreshed in the background.
   - Never touches cross-origin requests (your AI backend, websites).

   To publish an update: change VERSION below and commit.
   ========================================================= */

const VERSION = 'v1.0.0';
const CACHE_NAME = 'jarvis-shell-' + VERSION;

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#050a14">
<title>JARVIS · Offline</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;padding:24px;box-sizing:border-box;text-align:center;
    background:radial-gradient(900px 500px at 50% 0,#0d2447,transparent 60%),#02050b;
    color:#dbeafe;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .mark{width:84px;height:84px;margin:0 auto 18px;border-radius:50%;border:2px dashed rgba(251,191,36,.6);
    background:radial-gradient(circle,rgba(251,191,36,.6) 0 5px,transparent 6px);animation:s 14s linear infinite}
  h1{margin:0 0 8px;font-size:14px;letter-spacing:.32em;text-transform:uppercase;color:#fbbf24;font-weight:600}
  p{margin:0 auto 20px;max-width:340px;color:#8fa8c8;font-size:14px;line-height:1.5}
  button{min-height:44px;padding:0 22px;border-radius:12px;border:1px solid #22d3ee;background:#0b3b5e;
    color:#eaffff;font:600 12px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}
  @keyframes s{to{transform:rotate(360deg)}}
</style>
</head>
<body>
  <main>
    <div class="mark"></div>
    <h1>Signal lost</h1>
    <p>JARVIS could not load and no saved copy is available yet. Connect to the internet once so the app can store itself for offline use.</p>
    <button onclick="location.reload()">Retry</button>
  </main>
</body>
</html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        // Cache files one by one so a single missing file cannot block installation.
        Promise.allSettled(SHELL_FILES.map((url) => cache.add(url)))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('jarvis-shell-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave backends and websites alone

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached =
      (await caches.match(request, { ignoreSearch: true })) ||
      (await caches.match('./index.html')) ||
      (await caches.match('./'));
    if (cached) return cached;
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });

  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) return cached;

  const fresh = await network;
  return fresh || new Response('', { status: 504, statusText: 'Offline' });
}
