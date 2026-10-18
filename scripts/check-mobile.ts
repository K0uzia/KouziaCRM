// Contrôle mobile de l'admin (Playwright, Chromium) : `npm run check:mobile`.
// Échoue sur : scroll horizontal, élément sorti de son conteneur coupé (ou de l'écran),
// cible d'action de moins de 44 px, texte tronqué illisible (case de moins de 80 px, 120 px en
// liste) ; à partir de 768 px, tableau qui défile horizontalement ; à 800 px (tablette), contrôle de filtre de moins de
// 44 px. Écrans : navigation.ts, onglets des réglages, fiches, modales de création. Lecture seule : rien n'est enregistré (modales ouvertes puis fermées).
//
// Prérequis : l'admin tourne (npm run dev) sur une base de recette, et un compte admin de test :
//   CHECK_MOBILE_EMAIL, CHECK_MOBILE_PASSWORD, CHECK_MOBILE_TOTP (secret base32, si 2FA activée)
//   CHECK_MOBILE_URL (défaut http://localhost:5173), CHECK_MOBILE_WIDTHS (défaut « 320,375,414 »,
//   ou --widths=… ; npm run check:wide = 768, 1024 et 1280)
//   CHECK_MOBILE_REPORT (chemin d'un rapport JSON, facultatif)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { login } from "./check-login";
import { NAV_SPACES, SETTINGS_ITEM } from "../apps/web/src/lib/navigation";
import { SETTINGS_TABS } from "../apps/web/src/pages/settings/types";

const BASE = (process.env.CHECK_MOBILE_URL ?? "http://localhost:5173").replace(/\/$/, "");
// --widths=768,1024,1280 (npm run check:wide) : l'option prime sur la variable d'environnement.
const WIDTHS_ARG = process.argv.find((a) => a.startsWith("--widths="))?.slice("--widths=".length);
const WIDTHS = (WIDTHS_ARG ?? process.env.CHECK_MOBILE_WIDTHS ?? "320,375,414").split(",").map(Number).filter(Boolean);
const TAP = 44;
const TOLERANCE = 2;

type Issue = { kind: "scroll" | "clip" | "target" | "state" | "lisible" | "tableau"; detail: string; selector: string };
type Result = { screen: string; width: number; issues: Issue[] };

/** Mesure dans la page : code navigateur pur (check-mobile.measure.js), sans transpilation tsx. */
const MEASURE = readFileSync(path.resolve("scripts/check-mobile.measure.js"), "utf8").trim();

async function measure(page: Page): Promise<Issue[]> {
  return page.evaluate(`(${MEASURE})(${JSON.stringify({ tap: TAP, tolerance: TOLERANCE, minText: 80, listCell: 120 })})`);
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(300);
}

async function main() {
  const screens: Array<{ name: string; path: string; open?: (page: Page) => Promise<void> }> = [];
  for (const space of NAV_SPACES) {
    for (const section of space.sections) for (const item of section.items) screens.push({ name: item.label, path: item.to });
  }
  for (const tab of SETTINGS_TABS) screens.push({ name: `${SETTINGS_ITEM.label} > ${tab.label}`, path: `${SETTINGS_ITEM.to}?tab=${tab.id}` });
  for (const [name, path] of [
    ["Nouveau devis", "/quotes?new=1"],
    ["Nouvelle facture", "/invoices?new=1"],
    ["Nouveau client", "/clients?new=1"],
    ["Enregistrer un paiement", "/payments?new=1"],
    ["Nouvel abonnement", "/abonnements?new=1"],
  ] as const) {
    screens.push({ name: `Modale : ${name}`, path, open: async (page) => void (await page.getByRole("dialog").waitFor()) });
  }
  // États ouverts de la barre supérieure (panneaux qui débordaient sur téléphone).
  screens.push({
    name: "Panneau des notifications",
    path: "/",
    open: async (page) => {
      await page.getByRole("button", { name: /^Notifications/ }).click();
      await page.waitForTimeout(200);
    },
  });
  screens.push({
    // Les messages s'ouvrent par un bouton (pas de lien) : fil pris dans l'API, puis vue détail.
    name: "Messagerie : lecture d'un message",
    path: "/inbox",
    open: async (page) => {
      const threadId = await page.evaluate(async () => {
        const res = await fetch("/api/emails/messages?take=1", { credentials: "include" });
        const body = (await res.json()) as { messages?: Array<{ threadId?: string }> };
        return body.messages?.[0]?.threadId ?? null;
      });
      if (!threadId) throw new Error("aucun message dans la base de recette");
      await page.goto(`${BASE}/inbox/${threadId}`);
      await settle(page);
    },
  });
  screens.push({
    name: "Menu Créer",
    path: "/",
    open: async (page) => {
      await page.getByRole("button", { name: "Créer" }).click();
      await page.getByRole("button", { name: "Nouveau devis" }).waitFor();
    },
  });

  const browser = await chromium.launch();
  const results: Result[] = [];
  try {
    // Une seule connexion pour toutes les largeurs : la connexion admin est limitée en débit
    // (10 essais par 15 min et par IP), et chaque largeur se reconnectait.
    let session: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width, height: 740 },
        deviceScaleFactor: 2,
        hasTouch: true,
        ...(session ? { storageState: session } : {}),
      });
      const page = await context.newPage();
      if (!session) {
        await login(page, BASE);
        session = await context.storageState();
      }

      // Fiches : première ligne de chaque liste (lien de la 1re colonne ou carte mobile).
      const details: typeof screens = [];
      for (const [name, list, pattern] of [
        ["Fiche client", "/clients", /\/clients\/[^/?]+$/],
        ["Fiche devis", "/quotes", /\/quotes\/[^/?]+$/],
        ["Fiche facture", "/invoices", /\/invoices\/[^/?]+$/],
      ] as const) {
        await page.goto(`${BASE}${list}`);
        await settle(page);
        const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") ?? ""));
        const href = hrefs.find((h) => pattern.test(h));
        if (href) details.push({ name, path: href });
      }

      for (const screen of [...screens, ...details]) {
        await page.goto(`${BASE}${screen.path}`);
        await settle(page);
        const opened = screen.open ? await screen.open(page).then(() => true, () => false) : true;
        const issues = await measure(page);
        if (!opened) issues.unshift({ kind: "state", detail: "état non ouvert (bouton introuvable)", selector: screen.name });
        results.push({ screen: `${screen.name} (${screen.path})`, width, issues });
        const status = issues.length === 0 ? "OK  " : "KO  ";
        console.log(`${status}${width}px  ${screen.name}${issues.length ? `  (${issues.length})` : ""}`);
        for (const i of issues.slice(0, 8)) console.log(`        ${i.kind.padEnd(6)} ${i.detail}  ${i.selector}`);
        if (issues.length > 8) console.log(`        … ${issues.length - 8} de plus`);
      }
      await context.close();
    }

    // Tablette tactile (800 px) : contrôles de filtre des listes (boutons segmentés, listes, recherche) de 44 px au
    // moins, là où les champs s'alignent sur une même ligne.
    const tablet = await browser.newContext({ viewport: { width: 800, height: 1000 }, deviceScaleFactor: 2, hasTouch: true, storageState: session });
    const tab = await tablet.newPage();
    for (const list of ["/clients", "/quotes", "/invoices", "/services", "/inbox", "/site/faq", "/site/images", "/site/references", "/site/avis"]) {
      await tab.goto(`${BASE}${list}`);
      await settle(tab);
      const small = await tab.$$eval(
        "main [role=group] > button, main select, main input[type=search]",
        (els, min) =>
          els
            .filter((el) => (el as HTMLElement).offsetParent !== null)
            .map((el) => ({ h: Math.round(el.getBoundingClientRect().height * 10) / 10, name: el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 30) || el.tagName }))
            .filter((t) => t.h < min),
        // Seuil strict (44 px, demi-pixel d'arrondi) : la tolérance générale laisserait passer des boutons de 42 px.
        TAP - 0.5,
      );
      const issues: Issue[] = small.map((t) => ({ kind: "target", detail: `contrôle de filtre de ${t.h} px`, selector: t.name }));
      results.push({ screen: `Filtres (${list})`, width: 800, issues });
      console.log(`${issues.length ? "KO  " : "OK  "}800px  Filtres ${list}${issues.length ? `  (${issues.length})` : ""}`);
      for (const i of issues.slice(0, 8)) console.log(`        ${i.kind.padEnd(6)} ${i.detail}  ${i.selector}`);
    }
    await tablet.close();
  } finally {
    await browser.close();
  }

  if (process.env.CHECK_MOBILE_REPORT) writeFileSync(process.env.CHECK_MOBILE_REPORT, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.issues.length > 0);
  console.log(`\n${results.length - failed.length}/${results.length} écrans sans défaut (${WIDTHS.join(", ")} px, filtres à 800 px).`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
