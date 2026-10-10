import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';

// Emits sw.js with the exact list of built files, versioned by their content
// hash, so a new deploy replaces the old cache and nothing stale is served.
function serviceWorker() {
  return {
    name: 'razgovor-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      // .woff2 is supported by every target browser; skip the legacy .woff duplicates.
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && !f.endsWith('.woff'));
      const publicFiles = ['manifest.webmanifest', 'favicon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];
      const assets = ['./', ...files.map((f) => './' + f), ...publicFiles.map((f) => './' + f)];
      const hash = createHash('sha256');
      for (const f of files) {
        const o = bundle[f];
        hash.update(f).update(o.type === 'chunk' ? o.code : typeof o.source === 'string' ? o.source : Buffer.from(o.source));
      }
      const version = hash.digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: swSource(version, assets) });
    },
  };
}

function swSource(version, assets) {
  return `// Generated at build time. Offline-first for the app shell; network-only for the API.
const CACHE = 'razgovor-${version}';
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('razgovor-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // API calls go straight to the network
  if (req.mode === 'navigate') {
    // Network first so updates arrive; fall back to the cached shell offline.
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put('./', copy));
      return res;
    }).catch(() => caches.match('./', { ignoreVary: true })));
    return;
  }
  // ignoreVary: hosts send Vary (Origin / Accept-Encoding) and module scripts carry an Origin
  // header the precache request lacked; for immutable hashed assets that difference is irrelevant.
  e.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req)));
});
`;
}

export default defineConfig({
  base: './', // works from a sub-path (GitHub Pages) and inside the native shells
  plugins: [serviceWorker()],
  build: { outDir: 'dist', target: 'es2020', sourcemap: false },
  test: { environment: 'node', include: ['tests/**/*.test.js'] },
});
