// Contrôle hors ligne de l'admin (Playwright, Chromium) : `npm run check:offline`.
// Réseau coupé (context.setOffline) : changer d'écran ne recharge pas la page et ne renvoie pas vers /login,
// le bandeau « Hors ligne » apparaît sans décaler la mise en page, un seul toast hors ligne, aucun message
// technique en anglais. Au retour : « De nouveau en ligne » disparaît après 3 s, et un écran resté
// indisponible s'ouvre tout seul. Lecture seule.
//
// Prérequis : ceux de check:mobile (admin lancé sur une base de recette, CHECK_MOBILE_EMAIL,
// CHECK_MOBILE_PASSWORD, CHECK_MOBILE_TOTP). CHECK_OFFLINE_URL (défaut CHECK_MOBILE_URL, puis
// http://localhost:5173), build de prod servi par l'API ou serveur de dev.
// CHECK_OFFLINE_WIDTHS (défaut « 320,375,1280 »).
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { login } from "./check-login";

const BASE = (process.env.CHECK_OFFLINE_URL ?? process.env.CHECK_MOBILE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const WIDTHS = (process.env.CHECK_OFFLINE_WIDTHS ?? "320,375,1280").split(",").map(Number).filter(Boolean);
const OFFLINE_MESSAGE = "Pas de connexion. Réessayez dès le retour du réseau.";
const UNAVAILABLE = "Cet écran n'est pas encore disponible hors ligne. Il s'ouvrira dès le retour du réseau.";
const ENGLISH = /Failed to fetch|dynamically imported module|NetworkError|Load failed|Unauthorized|Bad Gateway/i;

/** Mêmes critères que check:mobile (scroll, coupe, cibles de 44 px), mesurés avec le bandeau affiché. */
const MEASURE = readFileSync(path.resolve("scripts/check-mobile.measure.js"), "utf8").trim();

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
    await login(page, BASE);
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
      check(unavailable || toasts > 0, `${width}px  ${to} hors ligne : écran indisponible ou toast hors ligne affiché`);
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

async function main() {
  for (const width of WIDTHS) await scenario(width);
  console.log(failures.length ? `\n${failures.length} contrôle(s) en échec.` : "\nContrôle hors ligne vert.");
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
