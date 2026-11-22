/* MediStock SW v51 — Android/iOS PWA updates */
const CACHE_NAME = 'medistock-v51';
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
  try {
    if (response.redirected) {
      const body = await response.clone().text();
      await cache.put(request, new Response(body, { status: 200, statusText: 'OK', headers: response.headers }));
    } else {
      await cache.put(request, response.clone());
    }
  } catch (e) {}
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
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;padding:24px"><h1>MediStock</h1><p>Sin conexión o caché vacía. Abre con internet y recarga.</p><p><a href="./">Reintentar</a></p></body></html>',
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
    // Avisar a las ventanas abiertas para recargar (PWA Android)
    const clientsList = await self.clients.matchAll({ type: 'window' });
    for (const c of clientsList) {
      try { c.postMessage({ type: 'SW_UPDATED', cache: CACHE_NAME }); } catch (e) {}
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

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

  // Network-first for JS/CSS so Android PWA picks up updates
  const isAsset = /\.(js|css)$/i.test(url.pathname) || url.pathname.endsWith('/app.js') || url.pathname.endsWith('/db.js');
  if (isAsset && url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        await cachePutSafe(cache, req, net.clone());
        return (await cleanResponse(net)) || net;
      } catch (e) {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return (await cleanResponse(cached)) || cached;
        return new Response('// offline', { status: 503, headers: { 'Content-Type': 'application/javascript' } });
      }
    })());
    return;
  }

  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        await cachePutSafe(cache, './index.html', net.clone());
        return (await cleanResponse(net)) || net;
      } catch (e) {
        const cache = await caches.open(CACHE_NAME);
        return matchShell(cache);
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) {
        const cleaned = await cleanResponse(cached);
        if (cleaned) return cleaned;
      }
      try {
        const net = await fetch(req);
        await cachePutSafe(cache, req, net);
        return (await cleanResponse(net)) || net;
      } catch (e) {
        if (cached) return cleanResponse(cached);
        return new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).catch(() => new Response('', { status: 503 })))
  );
});
