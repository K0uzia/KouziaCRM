// Contrôle hors ligne de l'admin (Playwright, Chromium) : `npm run check:offline`.
// Réseau coupé (context.setOffline) : changer d'écran ne recharge pas la page et ne renvoie pas vers /login,
// le bandeau « Hors ligne » apparaît sans décaler la mise en page, un seul toast hors ligne, aucun message
// technique en anglais. Au retour : « De nouveau en ligne » disparaît après 3 s, et un écran resté
// indisponible s'ouvre tout seul. Lecture seule.
//
// Copie hors ligne (lot 2), sur l'origine configurée seulement (balise kouzia-offline-origin = origine testée ;
// build de prod servi par vite preview ou par l'API avec ADMIN_PUBLIC_ORIGIN = cette origine) : 1) en ligne,
// ouvrir clients, devis et factures (listes et fiches) ; 2) hors ligne, recharger : l'ERP démarre, chaque écran
// s'affiche avec « Données du JJ/MM à HH h MM » ; 3) IndexedDB : magasins « cle » et « copies » seulement,
// valeurs chiffrées (aucun titre affiché lisible en clair), clés de la liste fermée, rien de /api en Cache Storage.
// Données de recette requises : au moins un client, un devis et une facture.
//
// Créations hors ligne (lot 3), même origine : hors ligne, créer un client, puis un devis pour lui, puis une note de
// rendez-vous ; bandeau « Hors ligne · N à envoyer », écran « À envoyer » (mesure check:mobile), file chiffrée dans
// IndexedDB ; au retour du réseau, chaque élément est créé une seule fois (vérifié par l'API) et « À envoyer » est vide.
// Écrit dans la base de recette : un client « Hors Ligne … » par largeur, avec son devis brouillon et sa note.
//
// Prérequis : ceux de check:mobile (admin lancé sur une base de recette, CHECK_MOBILE_EMAIL,
// CHECK_MOBILE_PASSWORD, CHECK_MOBILE_TOTP). CHECK_OFFLINE_URL (défaut CHECK_MOBILE_URL, puis
// http://localhost:5173), build de prod servi par l'API ou serveur de dev.
// CHECK_OFFLINE_WIDTHS (défaut « 320,375,1280 »).
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { login } from "./check-login";

const BASE = (process.env.CHECK_OFFLINE_URL ?? process.env.CHECK_MOBILE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const WIDTHS = (process.env.CHECK_OFFLINE_WIDTHS ?? "320,375,1280").split(",").map(Number).filter(Boolean);
const OFFLINE_MESSAGE = "Pas de connexion. Réessayez dès le retour du réseau.";
const UNAVAILABLE = "Cet écran n'est pas encore disponible hors ligne. Il s'ouvrira dès le retour du réseau.";
const ENGLISH = /Failed to fetch|dynamically imported module|NetworkError|Load failed|Unauthorized|Bad Gateway/i;
const COPY_DATE = /Données du \d{2}\/\d{2} à \d{2} h \d{2}/;
/** Liste fermée des lectures copiées (apps/web/src/lib/offline/rules.ts), plus l'utilisateur courant. */
const COPY_KEYS =
  /^(session:utilisateur|\/api\/clients(\/[A-Za-z0-9_-]+(\/(notes|projects))?)?(\?hasCorrespondence=(true|false))?|\/api\/services(\?active=1)?|\/api\/invoices(\/[A-Za-z0-9_-]+|\?[A-Za-z0-9=&_-]+)|\/api\/settings)$/;
const OFFLINE_DB = "kouzia-hors-ligne";
const STORES = "cle,copies,file,relire";

/** Mêmes critères que check:mobile (scroll, coupe, cibles de 44 px), mesurés avec le bandeau affiché. */
const MEASURE = readFileSync(path.resolve("scripts/check-mobile.measure.js"), "utf8").trim();

/** Une seule connexion pour tous les scénarios (limite de débit de la connexion) : la session est réutilisée. */
let sessionCookies: Awaited<ReturnType<BrowserContext["cookies"]>> | null = null;
async function signIn(context: BrowserContext, page: Page) {
  if (sessionCookies) {
    await context.addCookies(sessionCookies);
    await page.goto(`${BASE}/`);
    await page.waitForURL(`${BASE}/`);
    return;
  }
  await login(page, BASE);
  sessionCookies = await context.cookies();
}

const failures: string[] = [];
function check(ok: boolean, label: string) {
  console.log(`${ok ? "OK  " : "KO  "}${label}`);
  if (!ok) failures.push(label);
}

/** Navigation dans la SPA par un vrai lien (onglets du bas, barre latérale ou menu mobile), jamais page.goto. */
async function follow(page: Page, to: string) {
  const visible = page.locator(`a[href="${to}"]:visible`).first();
  if ((await visible.count()) === 0) {
    await page.getByRole("button", { name: "Ouvrir le menu" }).click();
  }
  await page.locator(`a[href="${to}"]:visible`).first().click();
}

const status = (page: Page) => page.locator("[data-network-status]");

async function scenario(width: number) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height: 740 }, deviceScaleFactor: 2, hasTouch: width < 1024 });
  const page = await context.newPage();
  try {
    await signIn(context, page);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    // Marqueur en mémoire : il disparaît si la page se recharge.
    await page.evaluate(() => {
      (window as unknown as { __kouziaNoReload: boolean }).__kouziaNoReload = true;
      const w = window as unknown as { __kouziaCls: number };
      w.__kouziaCls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
          if (!entry.hadRecentInput) w.__kouziaCls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: false });
    });
    const notReloaded = () => page.evaluate(() => (window as unknown as { __kouziaNoReload?: boolean }).__kouziaNoReload === true);
    const header = page.locator("header").first();
    const headerBox = await header.boundingBox();
    const mainBox = await page.locator("main#contenu").boundingBox();

    await context.setOffline(true);
    await status(page).filter({ hasText: "Hors ligne" }).waitFor({ timeout: 5000 });
    check(true, `${width}px  bandeau « Hors ligne » affiché`);
    check((await page.getByRole("status").filter({ hasText: "Hors ligne" }).count()) >= 1, `${width}px  bandeau dans une région role=status`);
    const live = await status(page).evaluate((el) => el.parentElement?.getAttribute("aria-live"));
    check(live === "polite", `${width}px  aria-live="polite"`);
    check(JSON.stringify(await header.boundingBox()) === JSON.stringify(headerBox), `${width}px  barre du haut inchangée`);
    check(JSON.stringify(await page.locator("main#contenu").boundingBox()) === JSON.stringify(mainBox), `${width}px  contenu non décalé`);
    const issues = (await page.evaluate(`(${MEASURE})(${JSON.stringify({ tap: 44, tolerance: 2, minText: 80, listCell: 120 })})`)) as Array<{ kind: string; detail: string; selector: string }>;
    check(issues.length === 0, `${width}px  mesure check:mobile avec le bandeau : ${issues.length} défaut(s)`);
    for (const i of issues.slice(0, 8)) console.log(`        ${i.kind.padEnd(6)} ${i.detail}  ${i.selector}`);

    // Écrans pas encore chargés : aucun rechargement, aucune redirection vers /login.
    for (const to of ["/clients", "/invoices"]) {
      await follow(page, to);
      await page.waitForTimeout(1500);
      const path = new URL(page.url()).pathname;
      check(path === to, `${width}px  ${to} hors ligne : adresse conservée (${path})`);
      check(await notReloaded(), `${width}px  ${to} hors ligne : pas de rechargement`);
      const text = await page.locator("body").innerText();
      check(!/Une nouvelle version de l'ERP/.test(text), `${width}px  ${to} hors ligne : pas de faux « nouvelle version »`);
      check(!ENGLISH.test(text), `${width}px  ${to} hors ligne : aucun message technique en anglais`);
      const unavailable = text.includes(UNAVAILABLE);
      const toasts = await page.locator("[data-sonner-toast]").filter({ hasText: OFFLINE_MESSAGE }).count();
      // Écran déjà en cache (service worker du hors ligne) : message hors ligne dans l'écran, ou copie datée.
      const inline = (await page.locator("main").innerText()).includes(OFFLINE_MESSAGE) || COPY_DATE.test(text);
      check(unavailable || toasts > 0 || inline, `${width}px  ${to} hors ligne : écran indisponible, message hors ligne ou copie datée`);
      check(toasts <= 1, `${width}px  ${to} hors ligne : un seul toast hors ligne (${toasts})`);
    }

    // Retour sur un écran déjà chargé, puis retour du réseau : pas de rechargement, bandeau éphémère.
    await follow(page, "/");
    await page.waitForTimeout(500);
    await context.setOffline(false);
    await status(page).filter({ hasText: "De nouveau en ligne" }).waitFor({ timeout: 5000 });
    check(true, `${width}px  « De nouveau en ligne » affiché`);
    await page.waitForTimeout(3500);
    check((await status(page).count()) === 0, `${width}px  bandeau masqué après 3 s`);
    check(await notReloaded(), `${width}px  retour du réseau : pas de rechargement`);
    check(new URL(page.url()).pathname === "/", `${width}px  retour du réseau : toujours connecté`);
    const cls = await page.evaluate(() => (window as unknown as { __kouziaCls: number }).__kouziaCls);
    check(cls < 0.01, `${width}px  aucun décalage de mise en page (CLS ${cls.toFixed(4)})`);

    // Écran resté indisponible au retour du réseau : il s'ouvre tout seul.
    await context.setOffline(true);
    await status(page).filter({ hasText: "Hors ligne" }).waitFor({ timeout: 5000 });
    await follow(page, "/payments");
    const shown = await page.getByText(UNAVAILABLE).waitFor({ timeout: 4000 }).then(() => true, () => false);
    if (shown) {
      await context.setOffline(false);
      const reopened = await page
        .waitForFunction(() => {
          const title = document.querySelector("main h1")?.textContent ?? "";
          return title !== "" && title !== "Écran indisponible hors ligne";
        }, null, { timeout: 15_000 })
        .then(() => true, () => false);
      check(reopened, `${width}px  /payments : l'écran s'ouvre tout seul au retour du réseau`);
      check(new URL(page.url()).pathname === "/payments", `${width}px  /payments : adresse conservée après le retour`);
    } else {
      await context.setOffline(false);
      console.log(`--  ${width}px  /payments déjà chargé : reprise automatique non observable ici`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

/** Copie locale chiffrée : consultation hors ligne après rechargement, puis inspection d'IndexedDB. */
async function copyScenario(width: number) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height: 740 }, deviceScaleFactor: 2, hasTouch: width < 1024 });
  const page = await context.newPage();
  try {
    await signIn(context, page);
    const active = await page.evaluate(() => {
      const raw = document.querySelector<HTMLMetaElement>('meta[name="kouzia-offline-origin"]')?.content;
      try {
        return Boolean(raw) && new URL(raw!).origin === location.origin;
      } catch {
        return false;
      }
    });
    if (!active) {
      console.log(`--  ${width}px  copie hors ligne inactive sur ${BASE} (ADMIN_PUBLIC_ORIGIN différent) : partie copie non contrôlée`);
      return;
    }
    const controlled = await page
      .waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 })
      .then(() => true, () => false);
    check(controlled, `${width}px  service worker du hors ligne actif (écrans en cache)`);

    // 1) En ligne : listes puis une fiche de chaque.
    const visited: string[] = [];
    const shown: string[] = [];
    for (const [list, prefix] of [["/clients", "/clients/"], ["/quotes", "/quotes/"], ["/invoices", "/invoices/"]] as const) {
      await page.goto(`${BASE}${list}`);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      visited.push(list);
      const link = page.locator(`main a[href^="${prefix}"]:visible`).first();
      const href = await link.waitFor({ timeout: 8000 }).then(() => link.getAttribute("href"), () => null);
      check(Boolean(href), `${width}px  ${list} en ligne : au moins une fiche à ouvrir`);
      if (!href) continue;
      await page.goto(`${BASE}${href}`);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.locator("main h1").first().waitFor();
      const title = (await page.locator("main h1").first().innerText()).trim();
      if (title.length >= 4) shown.push(title);
      visited.push(href);
    }
    await page.waitForTimeout(800);

    // 2) Hors ligne, rechargement : l'ERP démarre et chaque écran s'affiche depuis la copie, daté.
    await context.setOffline(true);
    await page.reload();
    for (const to of visited) {
      if (new URL(page.url()).pathname !== to) await page.goto(`${BASE}${to}`);
      const path = new URL(page.url()).pathname;
      check(path === to, `${width}px  ${to} hors ligne après rechargement : l'ERP s'ouvre (${path})`);
      const notice = page.locator("[data-offline-notice]").first();
      const dated = await notice.waitFor({ timeout: 8000 }).then(() => true, () => false);
      const text = dated ? await notice.innerText() : "";
      check(COPY_DATE.test(text), `${width}px  ${to} hors ligne : « ${text.split(".")[0] || "mention absente"} »`);
      const body = await page.locator("body").innerText();
      check(!ENGLISH.test(body), `${width}px  ${to} hors ligne : aucun message technique en anglais`);
      check(await createMenuOffline(page), `${width}px  ${to} hors ligne : « Créer » limité à Nouveau devis et Nouveau client`);
    }
    const issues = (await page.evaluate(`(${MEASURE})(${JSON.stringify({ tap: 44, tolerance: 2, minText: 80, listCell: 120 })})`)) as Array<{ kind: string; detail: string; selector: string }>;
    check(issues.length === 0, `${width}px  mesure check:mobile avec la mention de date : ${issues.length} défaut(s)`);
    for (const i of issues.slice(0, 8)) console.log(`        ${i.kind.padEnd(6)} ${i.detail}  ${i.selector}`);

    // 3) IndexedDB et Cache Storage.
    const store = await page.evaluate(async (dbName) => {
      const names = (await indexedDB.databases()).map((d) => d.name ?? "");
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      // Pas de fonction nommée ici : tsx ajouterait un appel __name absent de la page.
      const stores = Array.from(db.objectStoreNames);
      const tx = db.transaction(["copies", "cle"]);
      const [rawKeys, rawValues, rawCryptoKeys] = await Promise.all(
        [tx.objectStore("copies").getAllKeys(), tx.objectStore("copies").getAll(), tx.objectStore("cle").getAll()].map(
          (req) =>
            new Promise<unknown[]>((resolve, reject) => {
              req.onsuccess = () => resolve(req.result as unknown[]);
              req.onerror = () => reject(req.error);
            }),
        ),
      );
      const keys = rawKeys!.map(String);
      const values = rawValues as Array<{ iv?: Uint8Array; data?: ArrayBuffer }>;
      const cryptoKeys = rawCryptoKeys as CryptoKey[];
      db.close();
      const decoder = new TextDecoder("latin1");
      const records = values.map((v) => ({
        fields: Object.keys(v).sort().join(","),
        ivLength: v.iv?.byteLength ?? 0,
        text: v.data ? decoder.decode(v.data) : "",
      }));
      const cached: string[] = [];
      for (const name of await caches.keys()) {
        for (const req of await (await caches.open(name)).keys()) cached.push(new URL(req.url).pathname);
      }
      return {
        names,
        stores,
        keys,
        records,
        keyInfo: cryptoKeys.map((k) => ({ type: k.constructor.name, extractable: k.extractable, algorithm: JSON.stringify(k.algorithm) })),
        cachedApi: cached.filter((p) => p.startsWith("/api")),
        cachedCount: cached.length,
      };
    }, OFFLINE_DB);
    check(store.names.every((n) => n === OFFLINE_DB), `${width}px  IndexedDB : une seule base (${store.names.join(", ")})`);
    check(store.stores.slice().sort().join(",") === STORES, `${width}px  magasins : ${store.stores.join(", ")}`);
    const outside = store.keys.filter((k) => !COPY_KEYS.test(k));
    check(outside.length === 0, `${width}px  ${store.keys.length} enregistrement(s), tous dans la liste fermée${outside.length ? ` (hors liste : ${outside.join(", ")})` : ""}`);
    check(store.keys.includes("session:utilisateur"), `${width}px  utilisateur courant gardé pour le démarrage hors ligne`);
    check(store.records.every((r) => r.fields === "data,iv" && r.ivLength === 12), `${width}px  chaque valeur : { iv (12 octets), data } seulement`);
    const leaks = shown.filter((s) => store.records.some((r) => r.text.includes(s)));
    const jsonLeak = store.records.some((r) => /"(id|email|displayName|totalCents|number)"\s*:/.test(r.text));
    check(shown.length > 0 && leaks.length === 0 && !jsonLeak, `${width}px  valeurs chiffrées : aucun des ${shown.length} titres affichés lisible en clair${leaks.length ? ` (${leaks.join(", ")})` : ""}`);
    const k = store.keyInfo[0];
    check(
      store.keyInfo.length === 1 && k?.type === "CryptoKey" && !k.extractable && /AES-GCM/.test(k.algorithm) && /256/.test(k.algorithm),
      `${width}px  clé AES-GCM 256 non extractible (${JSON.stringify(store.keyInfo)})`,
    );
    check(store.cachedApi.length === 0, `${width}px  Cache Storage : ${store.cachedCount} fichier(s), aucune réponse /api${store.cachedApi.length ? ` (${store.cachedApi.join(", ")})` : ""}`);
    await context.setOffline(false);
  } finally {
    await context.close();
    await browser.close();
  }
}

/** Menu « Créer » hors ligne : seulement les créations mises en file. */
async function createMenuOffline(page: Page): Promise<boolean> {
  const trigger = page.getByRole("button", { name: "Créer" });
  if (await trigger.isDisabled()) return false;
  await trigger.click();
  const labels = (await page.locator("header ul button").allInnerTexts()).map((t) => t.trim()).sort();
  await page.keyboard.press("Escape");
  return labels.join("|") === "Nouveau client|Nouveau devis";
}

/** Valeurs brutes de la file (magasin « file ») et noms des magasins. */
async function rawQueue(page: Page) {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const stores = Array.from(db.objectStoreNames);
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction("file").objectStore("file").getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    const decoder = new TextDecoder("latin1");
    return {
      stores,
      records: (values as Array<{ iv?: Uint8Array; data?: ArrayBuffer }>).map((v) => ({
        fields: Object.keys(v).sort().join(","),
        ivLength: v.iv?.byteLength ?? 0,
        text: v.data ? decoder.decode(v.data) : "",
      })),
    };
  }, OFFLINE_DB);
}

async function waitCheck(promise: Promise<unknown>, label: string) {
  check(await promise.then(() => true, () => false), label);
}

/** Lot 3 : hors ligne, un client, un devis pour lui, une note ; au retour du réseau, tout est créé une seule fois. */
async function creationScenario(width: number) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height: 740 }, deviceScaleFactor: 2, hasTouch: width < 1024 });
  const page = await context.newPage();
  try {
    await signIn(context, page);
    const active = await page.evaluate(() => {
      const raw = document.querySelector<HTMLMetaElement>('meta[name="kouzia-offline-origin"]')?.content;
      try {
        return Boolean(raw) && new URL(raw!).origin === location.origin;
      } catch {
        return false;
      }
    });
    if (!active) {
      console.log(`--  ${width}px  hors ligne inactif sur ${BASE} : créations hors ligne non contrôlées`);
      return;
    }
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 }).catch(() => undefined);
    // En ligne : listes et catalogue lus une fois (copie utile au formulaire de devis).
    for (const to of ["/clients", "/services", "/quotes"]) {
      await page.goto(`${BASE}${to}`);
      await page.waitForLoadState("networkidle").catch(() => undefined);
    }
    const name = `Hors Ligne ${width} ${Date.now().toString(36)}`;
    const noteText = `Rendez-vous ${name} : refonte du site.`;
    await context.setOffline(true);
    await status(page).filter({ hasText: "Hors ligne" }).waitFor({ timeout: 5000 });

    // 1) Client : même formulaire, champs minimaux.
    await follow(page, "/clients");
    await page.getByRole("button", { name: "Nouveau client" }).click();
    await waitCheck(page.locator("[data-offline-form]").waitFor({ timeout: 5000 }), `${width}px  formulaire client hors ligne : fiche minimale annoncée`);
    check((await page.locator("[role=dialog] summary").filter({ hasText: "Adresse" }).count()) === 0, `${width}px  formulaire client hors ligne : sans adresse ni recherche`);
    await page.getByRole("textbox", { name: "Nom", exact: true }).fill(name);
    await page.getByRole("button", { name: "Préparer le client" }).click();
    await page.waitForURL(/\/clients\/local-/, { timeout: 8000 });
    await waitCheck(page.locator("main h1").filter({ hasText: name }).waitFor({ timeout: 5000 }), `${width}px  fiche préparée hors ligne ouverte`);
    await waitCheck(status(page).filter({ hasText: "Hors ligne · 1 à envoyer" }).waitFor({ timeout: 5000 }), `${width}px  bandeau « Hors ligne · 1 à envoyer »`);
    const localPath = new URL(page.url()).pathname;

    // 2) Devis brouillon pour ce client.
    await page.getByRole("link", { name: "Nouveau devis" }).click();
    await page.getByLabel("Ligne 1 : désignation").fill(`Site vitrine ${name}`);
    await page.getByLabel("Ligne 1 : prix unitaire en euros").fill("1200");
    check((await page.getByRole("combobox", { name: "Client", exact: true }).inputValue()).startsWith("local-"), `${width}px  devis : client préparé hors ligne présélectionné`);
    await page.getByRole("button", { name: "Créer le devis" }).click();
    await page.waitForURL(`${BASE}${localPath}`, { timeout: 8000 });
    await waitCheck(status(page).filter({ hasText: "2 à envoyer" }).waitFor({ timeout: 5000 }), `${width}px  devis mis en file (bandeau : 2 à envoyer)`);

    // 3) Note de rendez-vous sur la fiche.
    await page.getByRole("textbox", { name: "Nouvelle note" }).fill(noteText);
    await page.getByRole("button", { name: "Ajouter la note" }).click();
    await waitCheck(page.locator("[data-note-pending]").filter({ hasText: noteText }).waitFor({ timeout: 5000 }), `${width}px  note affichée dans le journal, « À envoyer »`);

    // 4) Écran « À envoyer » par un lien (barre du haut dès 400 px, barre latérale ou menu).
    await follow(page, "/a-envoyer");
    await page.waitForURL(`${BASE}/a-envoyer`);
    await waitCheck(page.locator('[data-queue-count="3"]').waitFor({ timeout: 5000 }), `${width}px  « À envoyer » hors ligne : 3 éléments`);
    const issues = (await page.evaluate(`(${MEASURE})(${JSON.stringify({ tap: 44, tolerance: 2, minText: 80, listCell: 120 })})`)) as Array<{ kind: string; detail: string; selector: string }>;
    check(issues.length === 0, `${width}px  mesure check:mobile de « À envoyer » : ${issues.length} défaut(s)`);
    for (const i of issues.slice(0, 8)) console.log(`        ${i.kind.padEnd(6)} ${i.detail}  ${i.selector}`);
    const queue = await rawQueue(page);
    check(queue.stores.slice().sort().join(",") === STORES, `${width}px  magasins : ${queue.stores.join(", ")}`);
    check(
      queue.records.length === 3 &&
        queue.records.every((r) => r.fields === "data,iv" && r.ivLength === 12 && !r.text.includes(name) && !/cookie|kouzia_session|clientRequestId/.test(r.text)),
      `${width}px  file chiffrée : 3 valeurs { iv, data }, ni nom, ni cookie, ni champ lisible en clair`,
    );

    // 5) Retour du réseau : envoi depuis la page, puis « À envoyer » vide.
    await context.setOffline(false);
    await waitCheck(page.locator('[data-queue-count="0"]').waitFor({ timeout: 45_000 }), `${width}px  retour du réseau : « À envoyer » vide`);
    check(await page.getByText("Rien à envoyer").isVisible(), `${width}px  « À envoyer » : état vide affiché`);
    const clients = (await (await page.request.get(`${BASE}/api/clients`)).json()) as Array<{ id: string; displayName: string }>;
    const created = clients.filter((c) => c.displayName === name);
    check(created.length === 1, `${width}px  client créé une seule fois (${created.length})`);
    if (created[0]) {
      const quotes = (await (await page.request.get(`${BASE}/api/invoices?type=QUOTE&clientId=${created[0].id}&pageSize=100`)).json()) as Array<{ number: string | null; status: string }>;
      check(quotes.length === 1 && quotes[0]!.number === null && quotes[0]!.status === "DRAFT", `${width}px  devis créé une seule fois, brouillon sans numéro (${quotes.length})`);
      const notes = (await (await page.request.get(`${BASE}/api/clients/${created[0].id}/notes`)).json()) as Array<{ body: string }>;
      check(notes.length === 1 && notes[0]!.body === noteText, `${width}px  note créée une seule fois (${notes.length})`);
    }
    await page.reload();
    await waitCheck(page.getByText("Rien à envoyer").waitFor({ timeout: 8000 }), `${width}px  après rechargement : « À envoyer » toujours vide`);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  for (const width of WIDTHS) await scenario(width);
  for (const width of WIDTHS) await copyScenario(width);
  for (const width of WIDTHS) await creationScenario(width);
  console.log(failures.length ? `\n${failures.length} contrôle(s) en échec.` : "\nContrôle hors ligne vert.");
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
