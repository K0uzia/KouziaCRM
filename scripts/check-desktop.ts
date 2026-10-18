// Contrôle grand écran de l'admin (Playwright, Chromium) : `npm run check:desktop`.
// Règle web-design (interfaces adaptées jusqu'aux écrans de 27 pouces). À 1280, 1920 et 2560 px, sur chaque écran
// de navigation.ts, chaque onglet des réglages et les fiches client, devis et facture, échoue sur :
//   - scroll horizontal de la page ;
//   - contenu décentré : marges gauche et droite du conteneur principal différentes de plus de 1 px ;
//   - colonne étroite figée : conteneur plus étroit que la place utile (zone moins les gouttières, dans la
//     limite de --content-max), ou contenu visible qui couvre moins de 80 % du conteneur ;
//   - taille de base qui ne suit pas l'écran (16 px jusqu'à 1600 px, puis jusqu'à 18 px à 2560 px).
// Prérequis : ceux de check:mobile (CHECK_MOBILE_URL, CHECK_MOBILE_EMAIL, CHECK_MOBILE_PASSWORD, CHECK_MOBILE_TOTP).
// CHECK_DESKTOP_WIDTHS (défaut « 1280,1920,2560 »). Lecture seule.
import { chromium, type BrowserContext, type Page } from "playwright";
import { login } from "./check-login";
import { NAV_SPACES, SETTINGS_ITEM } from "../apps/web/src/lib/navigation";
import { SETTINGS_TABS } from "../apps/web/src/pages/settings/types";

const BASE = (process.env.CHECK_MOBILE_URL ?? "http://localhost:5173").replace(/\/$/, "");
/** Plafond du contenu attendu par la règle (index.css, --content-max) : 120rem. */
const CONTENT_MAX_REM = 120;
const WIDTHS = (process.env.CHECK_DESKTOP_WIDTHS ?? "1280,1920,2560").split(",").map(Number).filter(Boolean);

/** Taille de base attendue (index.css : clamp(100%, 0.7917rem + 0.2083vw, 112.5%) à partir de 1600 px). */
function expectedRoot(width: number): number {
  if (width < 1600) return 16;
  return Math.min(18, Math.max(16, 12.667 + 0.002083 * width));
}

type Measure = {
  scrollX: number;
  root: number;
  workspace: boolean;
  left: number;
  right: number;
  width: number;
  available: number;
  contentMax: number;
  expectedMax: number;
  pageWidth: number;
  pageSelector: string;
};

async function measure(page: Page): Promise<Measure> {
  return page.evaluate((CONTENT_MAX_REM) => {
    const main = document.getElementById("contenu")!;
    const box = main.firstElementChild as HTMLElement;
    const m = main.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const contentMax = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--content-max")) * root;
    // Bloc principal de la page : premier enfant du contenu de la route (sous la limite d'erreur).
    const pageRoot = (box.firstElementChild ?? box) as HTMLElement;
    // Étendue réellement occupée par le contenu visible : une colonne étroite figée laisse le reste vide.
    let minLeft = Infinity;
    let maxRight = -Infinity;
    for (const el of pageRoot.querySelectorAll<HTMLElement>("*")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === "hidden") continue;
      minLeft = Math.min(minLeft, r.left);
      maxRight = Math.max(maxRight, r.right);
    }
    const padding = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    return {
      scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      root,
      workspace: !cs.maxWidth || cs.maxWidth === "none",
      left: b.left - m.left,
      right: m.right - b.right,
      width: b.width - padding,
      // --content-max borne la boîte entière (border-box) : la place utile est sans les gouttières.
      // Plafond attendu fixé ici (pas lu dans la page) : un plafond étroit déclaré en token serait sinon accepté.
      available: Math.min(m.width, CONTENT_MAX_REM * root) - padding,
      contentMax,
      pageWidth: Number.isFinite(minLeft) ? maxRight - minLeft : 0,
      expectedMax: CONTENT_MAX_REM * root,
      pageSelector: `${pageRoot.tagName.toLowerCase()}${pageRoot.className ? `.${String(pageRoot.className).split(" ").slice(0, 3).join(".")}` : ""}`,
    };
  }, CONTENT_MAX_REM);
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(300);
}

async function main() {
  const screens: Array<{ name: string; path: string }> = [];
  for (const space of NAV_SPACES) {
    for (const section of space.sections) for (const item of section.items) screens.push({ name: item.label, path: item.to });
  }
  for (const tab of SETTINGS_TABS) screens.push({ name: `${SETTINGS_ITEM.label} > ${tab.label}`, path: `${SETTINGS_ITEM.to}?tab=${tab.id}` });

  const browser = await chromium.launch();
  let failures = 0;
  let total = 0;
  try {
    let session: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 1440 * (width / 2560) || 900 }, ...(session ? { storageState: session } : {}) });
      const page = await context.newPage();
      if (!session) {
        await login(page, BASE);
        session = await context.storageState();
      }
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
        const m = await measure(page);
        const issues: string[] = [];
        if (m.scrollX > 0) issues.push(`scroll horizontal de ${m.scrollX} px`);
        if (Math.abs(m.root - expectedRoot(width)) > 0.25) issues.push(`taille de base ${m.root.toFixed(2)} px, attendu ${expectedRoot(width).toFixed(2)} px`);
        if (!m.workspace) {
          if (Math.abs(m.left - m.right) > 1) issues.push(`décentré : marge gauche ${m.left.toFixed(1)} px, droite ${m.right.toFixed(1)} px`);
          if (Math.abs(m.contentMax - m.expectedMax) > 1) issues.push(`--content-max vaut ${Math.round(m.contentMax)} px, attendu ${Math.round(m.expectedMax)} px (120rem)`);
          if (m.width < m.available - 2) issues.push(`conteneur de ${Math.round(m.width)} px pour ${Math.round(m.available)} px utiles`);
          if (m.pageWidth < m.width * 0.8) issues.push(`colonne étroite : ${Math.round(m.pageWidth)} px sur ${Math.round(m.width)} px (${m.pageSelector})`);
        }
        total++;
        if (issues.length) failures++;
        const gap = m.workspace ? "espace de travail pleine largeur" : `contenu ${Math.round(m.width)} px, marges ${Math.round(m.left)}/${Math.round(m.right)}`;
        console.log(`${issues.length ? "KO  " : "OK  "}${width}px  ${screen.name}  (${gap}, base ${m.root.toFixed(1)} px)`);
        for (const i of issues) console.log(`        ${i}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${total - failures}/${total} écrans conformes (${WIDTHS.join(", ")} px).`);
  if (failures) process.exitCode = 1;
}

void main();
