/* Pulse service worker.
 *
 * What it does:  (1) shows a friendly offline page instead of the browser's error when a page cannot be fetched,
 *                (2) caches the app's static, fingerprinted assets so the chrome loads fast and survives a drop in
 *                    signal, (3) receives Web Push and opens the right page when a notification is tapped,
 *                (4) lets the page offer an "update available" prompt (new worker waits until the user agrees).
 * What it never does: cache pages, API responses, server actions or anything from Supabase. Those contain
 * patient data and must always come from the network (CLAUDE.md rule 10).
 *
 * Bump VERSION when this file changes: it names the caches, so old ones are cleaned up on activate.
 */
const VERSION = "pulse-sw-v1";
const STATIC_CACHE = `${VERSION}-static`;
const SHELL_CACHE = `${VERSION}-shell`;
const OFFLINE_URL = "/offline.html";
const SHELL_ASSETS = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png", "/icon.svg"];

self.addEventListener("install", (event) => {
  // No skipWaiting() here: a new version waits so the page can ask the user first (update prompt).
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("pulse-sw-") && !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

const isStaticAsset = (url) =>
  url.origin === self.location.origin &&
  (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname === "/icon.svg");

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // server actions and API writes go straight to the network
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase, Sentry, push services: not ours to touch

  // Fingerprinted build assets never change under the same URL: cache first.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // Page navigations: always the network (fresh, authenticated); the offline page only when there is no network.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(OFFLINE_URL)) || new Response("Offline", { status: 503 })),
    );
  }
});

// --- Web Push ---------------------------------------------------------------------------------------
// The payload carries ids and generic text only (lib/notify/push-payload.ts). The page the user lands on shows
// the real content, behind their login.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 80) : "Pulse";
  const body = typeof data.body === "string" ? data.body.slice(0, 160) : "You have a new notification.";
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/notifications";
  const tag = typeof data.tag === "string" ? data.tag.slice(0, 80) : undefined;

  event.waitUntil(
    (async () => {
      // If Pulse is open and in front, the in-app toast and badge already tell them: do not double up.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.some((c) => c.visibilityState === "visible" && c.focused);
      if (visible && data.event !== "test") return;
      await self.registration.showNotification(title, {
        body,
        tag,
        renotify: false,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { url },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  const target = typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/notifications";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
