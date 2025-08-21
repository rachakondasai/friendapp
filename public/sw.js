const CACHE_NAME = "friendapp-v1";        // bump on each deploy
const CORE = ["/", "/login", "/signup", "/dashboard", "/settings", "/app.css", "/ui.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(CORE)));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/socket.io/") || url.pathname === "/healthz") return;

  // network-first for HTML
  if (request.headers.get("accept")?.includes("text/html")) {
    e.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }
  // cache-first for assets
  e.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(res => {
      const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(request, copy)); return res;
    }))
  );
});
