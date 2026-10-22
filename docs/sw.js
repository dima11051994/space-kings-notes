// Офлайн-режим: сначала сеть (чтобы приходили обновления), без сети — последняя сохранённая копия.
const CACHE = "space-kings-recon";
const FILES = ["./", "index.html", "core.js", "battle.js", "ds-worker.js", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // no-cache: сверяться с сервером, иначе HTTP-кэш (10 мин у GitHub Pages) отдаёт старый app.js к новому index.html.
    fetch(e.request, { cache: "no-cache" })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
