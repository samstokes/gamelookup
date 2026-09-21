'use strict';

// Bump VERSION to push a new app shell to installed copies.
const VERSION = 'v4';

// Cache Storage and worker scopes are origin-wide, but branch previews deploy under the same
// origin (see .github/workflows/pages.yml), so every name is tagged with the deployment's own
// path. Without it a preview's activate handler would reap the installed app's shell.
const SCOPE = new URL(self.registration.scope).pathname;
const SHELL = `shell-${VERSION}@${SCOPE}`;

// The catalogue cache is written by app.js, which derives the same name; listing it here keeps
// activate from reaping it.
const KEEP = [SHELL, `gfn-catalogue-v1@${SCOPE}`];

// Caches from before the scope tag existed. They belong to whichever deployment wrote them,
// so only retire one whose entries all live under our own scope.
const LEGACY = ['shell-v3', 'gfn-catalogue-v1'];

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// Resolved against our scope: the exact set of URLs this worker speaks for. Anything deeper
// under the scope is a separate deployment with its own worker.
const SHELL_URLS = new Set(ASSETS.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Retire old shells and any superseded catalogue cache from an earlier version.
      .then((keys) => Promise.all(
        keys.map((k) => {
          if (LEGACY.includes(k)) return reapIfOurs(k);
          if (k.endsWith(`@${SCOPE}`) && !KEEP.includes(k)) return caches.delete(k);
          return undefined;
        })
      ))
      .then(() => self.clients.claim())
  );
});

// An untagged cache is ours only if everything in it came from our own scope.
async function reapIfOurs(name) {
  const cache = await caches.open(name);
  const entries = await cache.keys();
  if (entries.every((req) => new URL(req.url).pathname.startsWith(SCOPE))) {
    await caches.delete(name);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Leave cross-origin traffic alone: the GFN JSON and the ProtonDB iframe go straight out.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations (including ?q=… and share-target hits) always resolve to the cached shell —
  // but only for our own entry point. A deeper path under our scope is a branch preview, which
  // must reach the network to load its own copy of the app rather than being served ours.
  if (request.mode === 'navigate') {
    if (url.pathname !== SCOPE && url.pathname !== `${SCOPE}index.html`) return;
    event.respondWith(
      caches.match('./index.html').then((cached) => cached || fetch(request))
    );
    return;
  }

  // Same reasoning for subresources: we answer for the shell we precached, nothing else.
  if (!SHELL_URLS.has(url.href)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((cache) => cache.put(request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
