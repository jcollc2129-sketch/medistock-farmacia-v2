/* MediStock SW — compatible Safari iOS (sin respuestas redirect) */
const CACHE_NAME = 'medistock-v47';
const SHELL = [
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

/** Safari rechaza respuestas del SW si response.redirected === true */
function cleanResponse(response) {
  if (!response) return null;
  if (response.type === 'opaqueredirect' || response.redirected) {
    return response.text().then((body) =>
      new Response(body, {
        status: 200,
        statusText: 'OK',
        headers: response.headers
      })
    );
  }
  return Promise.resolve(response);
}

async function cachePutSafe(cache, request, response) {
  if (!response || response.status !== 200 || response.type === 'opaqueredirect') return;
  if (response.redirected) {
    const body = await response.clone().text();
    const headers = new Headers(response.headers);
    await cache.put(request, new Response(body, { status: 200, statusText: 'OK', headers }));
    return;
  }
  try {
    await cache.put(request, response.clone());
  } catch (e) {
    console.log('cache put skip', e);
  }
}

async function matchShell(cache) {
  const keys = ['./index.html', 'index.html', './', new URL('./index.html', self.location).href];
  for (const k of keys) {
    const hit = await cache.match(k, { ignoreSearch: true });
    if (hit) {
      const cleaned = await cleanResponse(hit);
      if (cleaned) return cleaned;
    }
  }
  return new Response(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><h1>MediStock</h1><p>Sin conexión. Abre la app una vez con internet.</p></body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const path of SHELL) {
      try {
        const req = new Request(path, { cache: 'reload' });
        const res = await fetch(req);
        await cachePutSafe(cache, path, res);
      } catch (e) {
        console.log('SW skip', path, e);
      }
    }
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

  // API: solo red
  if (url.pathname.includes('/api/')) {
    event.respondWith(
      fetch(req).catch(
        () =>
          new Response(JSON.stringify({ offline: true }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    );
    return;
  }

  // Navegación (abrir la app): crítico en Safari offline
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      (async () => {
        try {
          const net = await fetch(req);
          const cache = await caches.open(CACHE_NAME);
          await cachePutSafe(cache, './index.html', net.clone());
          const cleaned = await cleanResponse(net);
          return cleaned || net;
        } catch (e) {
          const cache = await caches.open(CACHE_NAME);
          return matchShell(cache);
        }
      })()
    );
    return;
  }

  // Mismo origen: caché primero
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) {
          const cleaned = await cleanResponse(cached);
          if (cleaned) return cleaned;
        }
        try {
          const net = await fetch(req);
          await cachePutSafe(cache, req, net);
          const cleaned = await cleanResponse(net);
          return cleaned || net;
        } catch (e) {
          if (cached) return cleanResponse(cached);
          return new Response('Offline', { status: 503 });
        }
      })()
    );
    return;
  }

  // CDN / externos
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) {
        const cleaned = await cleanResponse(cached);
        if (cleaned) return cleaned;
      }
      try {
        return await fetch(req);
      } catch (e) {
        return cached || new Response('', { status: 503 });
      }
    })()
  );
});
