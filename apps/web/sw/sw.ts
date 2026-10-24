/// <reference lib="webworker" />
// Service worker de l'ERP, compilé par vite-plugin-pwa (injectManifest, Workbox).
// - Partout : notifications push. Contenu reçu : { title, body, url, tag }, chiffré de bout en bout par le service push.
// - Sur l'origine du hors ligne seulement (enregistré avec ?mode=hors-ligne, voir src/lib/sw-register.ts) :
//   l'index et tous les fichiers des écrans en cache, toute page servie par index.html sauf /api. Aucune réponse
//   /api n'entre dans Cache Storage : les données passent par la copie chiffrée d'IndexedDB.
// Mise à jour : la nouvelle version attend ; la page propose « Recharger » et envoie SKIP_WAITING.
import { addPlugins, cleanupOutdatedCaches, createHandlerBoundToURL, getCacheKeyForURL, precacheAndRoute } from "workbox-precaching";
import { cacheNames } from "workbox-core";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

const OFFLINE_MODE = "hors-ligne";
const isOfflineScript = (url: string | undefined) => Boolean(url) && new URL(url!).searchParams.get("mode") === OFFLINE_MODE;
const manifest = self.__WB_MANIFEST;

if (isOfflineScript(self.location.href)) {
  // Avancement de l'installation d'une nouvelle version (« Mise à jour en cours », lib/sw-register.ts) : fichiers à
  // télécharger (absents du cache) et fichiers reçus, envoyés aux onglets.
  let total: number | null = null;
  let done = 0;
  const notify = async () => {
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      client.postMessage({ type: "UPDATE_PROGRESS", done, total });
    }
  };
  addPlugins([
    {
      cacheDidUpdate: async () => {
        done += 1;
        await notify();
      },
    },
  ]);
  precacheAndRoute(manifest);
  cleanupOutdatedCaches();
  registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/api(\/|$)/] }));
  self.addEventListener("install", () => {
    void (async () => {
      const cache = await caches.open(cacheNames.precache);
      let missing = 0;
      for (const entry of manifest) {
        const key = getCacheKeyForURL(new URL(entry.url, self.location.href).href);
        if (!key || !(await cache.match(key))) missing += 1;
      }
      total = missing;
      await notify();
    })().catch(() => undefined);
    // Remplace un service worker sans cache (notifications seules) : rien de périmé à protéger, pas d'attente.
    if (!isOfflineScript(self.registration.active?.scriptURL)) void self.skipWaiting();
  });
  self.addEventListener("message", (event) => {
    if ((event.data as { type?: unknown } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
  });
} else {
  self.addEventListener("install", () => void self.skipWaiting());
}

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data: { title?: string; body?: string; url?: string; tag?: string } = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Kouzia ERP";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      lang: "fr",
      data: { url: data.url || "/" },
    }),
  );
});

// Clic : l'onglet de l'ERP déjà ouvert est réutilisé, sinon une fenêtre s'ouvre sur l'écran visé.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data as { url?: string } | null)?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
