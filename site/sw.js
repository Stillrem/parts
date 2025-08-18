/* sw.js */
const VERSION = 'v1.0.0';
const STATIC_CACHE = `static-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;
const IMG_CACHE = `img-${VERSION}`;

// что считаем «статикой»
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest'
];

// install: прогреваем статику
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC_CACHE).then(c => c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

// activate: чистим старые кэши
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => ![STATIC_CACHE, RUNTIME_CACHE, IMG_CACHE].includes(k))
        .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// helper: детектируем тип запроса
function isApi(req) { return req.url.includes('/api/search'); }
function isImg(req) { return req.url.includes('/api/img'); }
function isSameOrigin(req) { return new URL(req.url).origin === self.origin; }

// stale-while-revalidate для изображений (включая opaque)
async function handleImage(req) {
  const cache = await caches.open(IMG_CACHE);
  const cached = await cache.match(req);
  const fetchAndPut = fetch(req, { mode: 'no-cors' }).then(res => {
    // даже opaque кладём — браузер позволит отрисовать
    cache.put(req, res.clone()).catch(()=>{});
    return res;
  }).catch(() => cached);
  return cached ? Promise.resolve(cached) : fetchAndPut;
}

// network-first для API
async function handleApi(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(req);
    cache.put(req, res.clone()).catch(()=>{});
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ items: [], meta: { error: 'offline' } }), {
      headers: { 'Content-Type': 'application/json' }, status: 200
    });
  }
}

// cache-first для статики / остального своего
async function handleStatic(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  cache.put(req, res.clone()).catch(()=>{});
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;

  if (isApi(req)) {
    e.respondWith(handleApi(req));
    return;
  }
  if (isImg(req)) {
    e.respondWith(handleImage(req));
    return;
  }
  if (isSameOrigin(req) && (req.method === 'GET')) {
    e.respondWith(handleStatic(req));
  }
});
