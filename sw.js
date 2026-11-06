/* Gestione Conti — Service Worker
 *
 * Strategia scelta: network-first con cache di fallback, limitata al guscio
 * dell'app servito da questo origin.
 *
 * - Online: la rete vince sempre → nessun rischio di dati o asset stantii.
 * - Offline: si riapre il guscio (HTML/CSS/JS/icone) dall'ultima versione vista.
 * - Le richieste cross-origin (Supabase REST/Auth, CDN Tailwind/Chart.js) NON
 *   vengono mai intercettate né messe in cache: i dati restano sempre freschi.
 * - Cambiare VERSION invalida la cache al deploy successivo.
 */

const VERSION = "v1";
const SHELL_CACHE = `gestione-conti-shell-${VERSION}`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./assets/app.js",
  "./assets/style.css",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-maskable-192.png",
  "./assets/icons/icon-maskable-512.png",
  "./assets/icons/apple-touch-icon-180.png",
  "./assets/icons/favicon-32.png",
  "./config/supabase-config.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // addAll fallirebbe per un singolo 404: meglio cacheare il disponibile.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("gestione-conti-shell-") && key !== SHELL_CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // CDN e Supabase: pass-through
  if (url.pathname.endsWith("/sw.js")) return;

  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const isNavigation = request.mode === "navigate";

  let response = null;
  try {
    response = await fetch(request);
  } catch (error) {
    response = null; // offline / connessione rifiutata
  }

  if (response && response.ok) {
    const copy = response.clone();
    caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    return response;
  }

  // 4xx = risposta reale del server (es. 404): non mascherare con la cache.
  if (response && response.status < 500 && !isNavigation) return response;

  // Rete assente o 5xx (proxy/gateway): meglio il guscio in cache.
  const cached = await caches.match(request, { ignoreSearch: isNavigation });
  if (cached) return cached;
  if (isNavigation) {
    const shell = (await caches.match("./index.html")) || (await caches.match("./"));
    if (shell) return shell;
  }
  if (response) return response;
  throw new Error("offline e nessuna copia in cache");
}
