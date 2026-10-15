// Mesure du chargement des pages principales de l'admin (Playwright, Chromium) : `npm run qa:mesure`.
// Pour chaque page : temps jusqu'à « page prête » en navigation dans la SPA (depuis le tableau de bord)
// et en chargement complet de l'URL, nombre de GET /api et appels en double. Médiane de plusieurs passes.
// Lecture seule : rien n'est enregistré.
//
// Prérequis : l'admin tourne sur une base de recette (build de prod servi par l'API de préférence,
// sinon le StrictMode du dev double les appels), compte admin de test SANS double authentification :
//   CHECK_MOBILE_EMAIL, CHECK_MOBILE_PASSWORD (mêmes variables que check:mobile)
//   MESURE_URL (défaut http://localhost:5173)
// Options : --width=360 (défaut 360), --profil=4g-lent|bureau (défaut 4g-lent), --passes=3,
//   --pages=Tableau de bord,Réglages (sous-ensemble, noms de la liste PAGES), --detail (durée médiane de chaque GET /api,
//   de l'envoi à la fin de la réponse, et poids transféré, par page).
// Profil « 4g-lent » : RTT 150 ms, 1,6 Mbit/s descendant, 750 kbit/s montant, processeur ralenti x4.
import { chromium, type Page, type Request } from "playwright";

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const BASE = (process.env.MESURE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const WIDTH = Number(arg("width", "360"));
const PROFIL = arg("profil", "4g-lent");
const PASSES = Number(arg("passes", "3"));
const FILTRE = arg("pages", "").split(",").map((s) => s.trim()).filter(Boolean);
const DETAIL = process.argv.includes("--detail");

// Page prête : contenu rendu dans <main>, ni « Chargement… », ni squelette aria-busy, ni reste du tableau de bord.
const settled = (p: Page) =>
  p.waitForFunction(
    () => {
      const m = document.querySelector("main");
      return (
        !!m &&
        m.innerText.length > 40 &&
        !/Encaissé ce mois-ci/.test(m.innerText) &&
        !/Chargement…/.test(m.innerText) &&
        !m.querySelector("[aria-busy=true]")
      );
    },
    null,
    { timeout: 30_000, polling: 50 },
  );
// Tableau de bord prêt : chiffres affichés, plus aucune barre de chargement ni zone aria-busy dans <main>.
const dashboardReady = (p: Page) =>
  p.waitForFunction(
    () => {
      const m = document.querySelector("main");
      return !!m && /Encaissé/.test(m.innerText) && !m.querySelector(".animate-pulse, [aria-busy=true]");
    },
    null,
    { timeout: 30_000, polling: 50 },
  );
const TOUTES: Array<[string, string, (p: Page) => Promise<unknown>]> = [
  ["Tableau de bord", "/", dashboardReady],
  ["Réglages", "/settings", (p) => p.getByRole("button", { name: "Enregistrer cet onglet" }).first().waitFor({ timeout: 30_000 })],
  ["Clients", "/clients", settled],
  ["Factures", "/invoices", settled],
  ["Messagerie", "/inbox", settled],
];
const PAGES = FILTRE.length ? TOUTES.filter(([n]) => FILTRE.includes(n)) : TOUTES;

async function main() {
  const email = process.env.CHECK_MOBILE_EMAIL;
  const password = process.env.CHECK_MOBILE_PASSWORD;
  if (!email || !password) throw new Error("CHECK_MOBILE_EMAIL et CHECK_MOBILE_PASSWORD requis (compte de recette).");
  const browser = await chromium.launch();
  const results = new Map<string, { ms: number[]; calls: number; dup: Set<string> }>();
  const details = new Map<string, Map<string, { ms: number[]; ko: number[] }>>();
  for (let pass = 0; pass < PASSES; pass++) {
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height: WIDTH < 600 ? 800 : 900 }, isMobile: WIDTH < 600, hasTouch: WIDTH < 600 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Mot de passe").fill(password);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.waitForURL(`${BASE}/`, { timeout: 15_000 }).catch(() => {
      throw new Error("Connexion refusée ou double authentification active : utiliser un compte de recette sans 2FA.");
    });
    await page.waitForTimeout(1500);
    if (PROFIL === "4g-lent") {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    }
    for (const [name, path, ready] of PAGES) {
      for (const mode of ["navigation", "chargement complet"] as const) {
        const calls: string[] = [];
        const onReq = (r: { url(): string; method(): string }) => {
          if (r.url().includes("/api/") && r.method() === "GET") calls.push(new URL(r.url()).pathname);
        };
        const key = `${name} (${mode})`;
        // Durée de chaque GET /api (envoi de la requête à la fin de la réponse) et poids transféré.
        const onFin = async (r: Request) => {
          if (!DETAIL || !r.url().includes("/api/") || r.method() !== "GET") return;
          const t = r.timing();
          const taille = await r.sizes().catch(() => null);
          const parPage = details.get(key) ?? new Map<string, { ms: number[]; ko: number[] }>();
          const d = parPage.get(new URL(r.url()).pathname) ?? { ms: [], ko: [] };
          d.ms.push(Math.round(t.responseEnd - t.requestStart));
          d.ko.push(taille ? Math.round((taille.responseBodySize + taille.responseHeadersSize) / 102.4) / 10 : 0);
          parPage.set(new URL(r.url()).pathname, d);
          details.set(key, parPage);
        };
        let ms: number;
        if (mode === "navigation") {
          // Navigation dans la SPA depuis le tableau de bord (ou depuis Clients pour le tableau de bord lui-même).
          await page.goto(`${BASE}${path === "/" ? "/clients" : "/"}`);
          await page.waitForTimeout(1500);
          page.on("request", onReq);
          page.on("requestfinished", onFin);
          const t = Date.now();
          await page.evaluate((to) => {
            history.pushState({}, "", to);
            dispatchEvent(new PopStateEvent("popstate"));
          }, path);
          await ready(page).catch(() => undefined);
          ms = Date.now() - t;
        } else {
          page.on("request", onReq);
          page.on("requestfinished", onFin);
          const t = Date.now();
          await page.goto(`${BASE}${path}`);
          await ready(page).catch(() => undefined);
          ms = Date.now() - t;
        }
        await page.waitForTimeout(1500);
        page.off("request", onReq);
        page.off("requestfinished", onFin);
        const r = results.get(key) ?? { ms: [], calls: 0, dup: new Set<string>() };
        r.ms.push(ms);
        r.calls = calls.length;
        const counts = calls.reduce<Record<string, number>>((a, c) => ((a[c] = (a[c] ?? 0) + 1), a), {});
        for (const [p, n] of Object.entries(counts)) if (n > 1) r.dup.add(`${p} x${n}`);
        results.set(key, r);
      }
    }
    await ctx.close();
  }
  await browser.close();
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  console.log(`${BASE} : ${WIDTH} px, profil ${PROFIL}, médiane de ${PASSES} passe(s)`);
  for (const [k, v] of results) {
    console.log(`${k.padEnd(32)} ${String(median(v.ms)).padStart(6)} ms  GET ${v.calls}${v.dup.size ? `  DOUBLONS ${[...v.dup].join(", ")}` : ""}`);
    for (const [route, d] of [...(details.get(k) ?? new Map())].sort((a, b) => median(b[1].ms) - median(a[1].ms))) {
      console.log(`    ${route.padEnd(40)} ${String(median(d.ms)).padStart(6)} ms  ${median(d.ko)} Ko`);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
