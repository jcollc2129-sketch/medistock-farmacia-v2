/* MediStock SW v54 — Android PWA blank-screen fix */
const CACHE_NAME = 'medistock-v54';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './dotacion.js',
  './material_catalog.js',
  './sync.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './bg-medical.jpg',
  './header-doodles.png',
  './vendor-html5-qrcode.min.js'
];

function cleanResponse(response) {
  if (!response) return Promise.resolve(null);
  if (response.type === 'opaqueredirect' || response.redirected) {
    return response.clone().text().then((body) =>
      new Response(body, {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': response.headers.get('Content-Type') || 'text/html; charset=utf-8' }
      })
    );
  }
  return Promise.resolve(response);
}

async function cachePutSafe(cache, request, response) {
  if (!response || response.status !== 200 || response.type === 'opaqueredirect') return;
  try {
    const req = typeof request === 'string' ? request : request;
    if (response.redirected) {
      const body = await response.clone().text();
      const ct = response.headers.get('Content-Type') || 'text/html; charset=utf-8';
      await cache.put(req, new Response(body, { status: 200, statusText: 'OK', headers: { 'Content-Type': ct } }));
    } else {
      await cache.put(req, response.clone());
    }
  } catch (e) {}
}

async function matchShell(cache) {
  const keys = ['./index.html', 'index.html', './', new URL('./index.html', self.location.href).pathname];
  for (const k of keys) {
    try {
      const hit = await cache.match(k, { ignoreSearch: true });
      if (hit) {
        const cleaned = await cleanResponse(hit);
        if (cleaned) return cleaned;
      }
    } catch (e) {}
  }
  // Último recurso: HTML mínimo con login visible (nunca blanco)
  return new Response(
    `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MediStock</title><style>body{margin:0;font-family:sans-serif;background:#0f766e;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:24px;max-width:360px;width:100%}a{color:#0f766e}</style></head>
<body><div class="card"><h1>MediStock</h1><p>No se pudo cargar la app en caché.</p>
<p><a href="./index.html">Recargar</a> · Abre primero con internet en Chrome y vuelve a instalar.</p></div></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const path of SHELL) {
      try {
        const res = await fetch(path, { cache: 'reload' });
        await cachePutSafe(cache, path, res);
      } catch (e) {}
    }
    // Duplicar index bajo varias claves que Android puede pedir
    try {
      const idx = await cache.match('./index.html');
      if (idx) {
        const body = await idx.clone().text();
        const headers = { 'Content-Type': 'text/html; charset=utf-8' };
        await cache.put('./', new Response(body, { status: 200, headers }));
        await cache.put('index.html', new Response(body, { status: 200, headers }));
      }
    } catch (e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }

  if (url.pathname.includes('/api/')) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(JSON.stringify({ offline: true }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  const isNav = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isNav) {
    event.respondWith((async () => {
      try {
        const net = await fetch(req, { cache: 'no-store' });
        if (net && net.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cachePutSafe(cache, './index.html', net.clone());
          const body = await net.clone().text();
          const headers = { 'Content-Type': 'text/html; charset=utf-8' };
          await cache.put('./', new Response(body, { status: 200, headers }));
          return new Response(body, { status: 200, headers });
        }
      } catch (e) {}
      const cache = await caches.open(CACHE_NAME);
      return matchShell(cache);
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return (await cleanResponse(cached)) || cached;
    try {
      const net = await fetch(req);
      await cachePutSafe(cache, req, net);
      return net;
    } catch (e) {
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});
