import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { clearTable, resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// « Resynchroniser depuis le site » (25/10/2026) : contrat réel du site (fixture) et contenu publié simulé.
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/site/${name}`, import.meta.url)), "utf8");
const CONTRACT = fixture("contenu.schema.editeur.json");
const contract = JSON.parse(CONTRACT) as { defauts: Record<string, Record<string, Record<string, unknown>>> };
let publishedPages: Record<string, unknown> | null = null;
vi.mock("@/lib/site/github.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/site/github.js")>()),
  readRepoFileAt: vi.fn(async () => CONTRACT),
  readSiteRepoFiles: vi.fn(async () => ({
    files: Object.fromEntries(["infos", "textes", "faq", "realisations", "avis", "references"].map((n) => [n, fixture(`${n}.json`)])),
    optional: publishedPages ? { pages: JSON.stringify(publishedPages) } : {},
    contract: JSON.parse(CONTRACT),
  })),
}));

const { buildApp } = await import("@/app.js");
const { forgetSiteContract } = await import("@/lib/site/editor.js");

const ADMIN = "admin-resync@kouzia.test";
let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await clearTable("SiteText");
  publishedPages = null;
  forgetSiteContract();
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie } });
const docValue = async (id: string) => (await call("GET", "/api/site/editor")).json().docs.find((d: { id: string }) => d.id === id).value;
type Plan = { planId: string; docs: Array<{ id: string; filled: Array<{ path: string; value: unknown }>; removed: string[]; skipped: unknown[]; blocked: unknown[] }> };
const planOf = async () => (await call("GET", "/api/site/editor/resync")).json() as Plan;
const docPlan = (plan: Plan, id: string) => plan.docs.find((d) => d.id === id)!;
const hero = contract.defauts.pages!.accueil as { hero: { titre: string; surTitre: string } };

describe("resynchronisation depuis le site", () => {
  it("réservée à l'administrateur", async () => {
    expect((await app.inject({ method: "GET", url: "/api/site/editor/resync" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/site/editor/resync", payload: { planId: "0".repeat(16) } })).statusCode).toBe(401);
  });

  it("défaut reproduit : texte affiché par le site, champ vide dans l'ERP ; rempli, publié prioritaire, texte saisi gardé", async () => {
    // Site : le titre publié, le reste par défaut. ERP : seul le sur-titre a été saisi.
    publishedPages = { schemaVersion: 1, pages: { accueil: { hero: { titre: "Titre *publié* sur le site" } } } };
    await call("PUT", "/api/site/editor/pages", { value: { pages: { accueil: { hero: { surTitre: "Sur-titre saisi dans l'ERP" } } } } });
    expect((await docValue("pages")).pages.accueil.hero.titre).toBeUndefined();

    const plan = await planOf();
    const pages = docPlan(plan, "pages");
    expect(pages.filled).toContainEqual({ path: "pages.accueil.hero.titre", value: "Titre *publié* sur le site" });
    expect(pages.filled.some((c) => c.path === "pages.accueil.hero.surTitre")).toBe(false);
    expect(pages.filled.length).toBeGreaterThan(50);
    expect(pages.blocked).toEqual([]);
    // Rien n'est écrit tant que le plan n'est pas appliqué.
    expect((await docValue("pages")).pages.accueil.hero.titre).toBeUndefined();

    const applied = await call("POST", "/api/site/editor/resync", { planId: plan.planId });
    expect(applied.statusCode, applied.body).toBe(200);
    const after = await docValue("pages");
    expect(after.pages.accueil.hero).toMatchObject({ titre: "Titre *publié* sur le site", surTitre: "Sur-titre saisi dans l'ERP" });
    expect(after.communs).toBeDefined();
    // Plus rien à reprendre ensuite.
    expect(docPlan(await planOf(), "pages").filled).toEqual([]);
  });

  it("champ que le site ne connaît plus : retiré (il bloquerait la publication)", async () => {
    const espace = structuredClone(contract.defauts.espaceClient) as Record<string, Record<string, unknown>>;
    await prisma.siteText.create({ data: { key: "espace-client", valueJson: JSON.stringify({ ...espace, textes: { ...espace.textes, engagementRythme: "Payé chaque mois" } }) } });
    const plan = await planOf();
    expect(docPlan(plan, "espace-client").removed).toEqual(["textes.engagementRythme"]);
    expect((await call("POST", "/api/site/editor/resync", { planId: plan.planId })).statusCode).toBe(200);
    const after = await docValue("espace-client");
    expect("engagementRythme" in after.textes).toBe(false);
    expect(after.textes.noteCarte).toBe(espace.textes!.noteCarte);
  });

  it("plan changé depuis l'affichage (texte saisi, site publié) : 409, rien d'écrit", async () => {
    const plan = await planOf();
    await call("PUT", "/api/site/editor/pages", { value: { pages: { accueil: { hero: { titre: hero.hero.titre } } } } });
    const res = await call("POST", "/api/site/editor/resync", { planId: plan.planId });
    expect(res.statusCode).toBe(409);
    expect((await docValue("pages")).pages.accueil.hero.surTitre).toBeUndefined();
    expect((await call("POST", "/api/site/editor/resync", { planId: "pas-un-plan" })).statusCode).toBe(400);
  });
});
