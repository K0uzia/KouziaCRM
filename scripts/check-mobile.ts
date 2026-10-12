// Contrôle mobile de l'admin (Playwright, Chromium) : `npm run check:mobile`.
// Échoue sur : scroll horizontal, élément sorti de son conteneur coupé (ou de l'écran),
// cible d'action de moins de 44 px, texte tronqué illisible (case de moins de 80 px, 120 px en
// liste) ; à partir de 768 px, tableau qui défile horizontalement. Écrans : navigation.ts, onglets des réglages, fiches, modales de création. Lecture seule : rien n'est enregistré (modales ouvertes puis fermées).
//
// Prérequis : l'admin tourne (npm run dev) sur une base de recette, et un compte admin de test :
//   CHECK_MOBILE_EMAIL, CHECK_MOBILE_PASSWORD, CHECK_MOBILE_TOTP (secret base32, si 2FA activée)
//   CHECK_MOBILE_URL (défaut http://localhost:5173), CHECK_MOBILE_WIDTHS (défaut « 320,375 »,
//   ou --widths=… ; npm run check:wide = 768, 1024 et 1280)
//   CHECK_MOBILE_REPORT (chemin d'un rapport JSON, facultatif)
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { NAV_SECTIONS, SETTINGS_ITEM } from "../apps/web/src/lib/navigation";
import { SETTINGS_TABS } from "../apps/web/src/pages/settings/types";

const BASE = (process.env.CHECK_MOBILE_URL ?? "http://localhost:5173").replace(/\/$/, "");
// --widths=768,1024,1280 (npm run check:wide) : l'option prime sur la variable d'environnement.
const WIDTHS_ARG = process.argv.find((a) => a.startsWith("--widths="))?.slice("--widths=".length);
const WIDTHS = (WIDTHS_ARG ?? process.env.CHECK_MOBILE_WIDTHS ?? "320,375").split(",").map(Number).filter(Boolean);
const TAP = 44;
const TOLERANCE = 2;

type Issue = { kind: "scroll" | "clip" | "target" | "state" | "lisible" | "tableau"; detail: string; selector: string };
type Result = { screen: string; width: number; issues: Issue[] };

function totp(secretBase32: string): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.replace(/\s/g, "").toUpperCase()) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const o = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

async function login(page: Page) {
  const email = process.env.CHECK_MOBILE_EMAIL;
  const password = process.env.CHECK_MOBILE_PASSWORD;
  if (!email || !password) {
    throw new Error("CHECK_MOBILE_EMAIL et CHECK_MOBILE_PASSWORD requis (compte admin de la base de recette).");
  }
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  const code = page.getByLabel("Code", { exact: true });
  await Promise.race([page.waitForURL(`${BASE}/`), code.waitFor()]);
  if (await code.isVisible().catch(() => false)) {
    const secret = process.env.CHECK_MOBILE_TOTP;
    if (!secret) throw new Error("Double authentification active : CHECK_MOBILE_TOTP (secret base32) requis.");
    await code.fill(totp(secret));
    await page.getByRole("button", { name: "Valider" }).click();
    await page.waitForURL(`${BASE}/`);
  }
}

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
  for (const section of NAV_SECTIONS) for (const item of section.items) screens.push({ name: item.label, path: item.to });
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
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 740 }, deviceScaleFactor: 2, hasTouch: true });
      const page = await context.newPage();
      await login(page);

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
  } finally {
    await browser.close();
  }

  if (process.env.CHECK_MOBILE_REPORT) writeFileSync(process.env.CHECK_MOBILE_REPORT, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.issues.length > 0);
  console.log(`\n${results.length - failed.length}/${results.length} écrans sans défaut (${WIDTHS.join(", ")} px).`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
