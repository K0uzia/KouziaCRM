import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { siteOptionalSchemas } from "@/lib/site/contract.js";
import { clearTable, resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// P0 du 26/10/2026 : après « Resynchroniser depuis le site », le contrôle avant publication (état de l'espace Site)
// refusait des dizaines de clés (communs, nouvelles pages, menus.libelles, pied à plus de 10 liens). Il validait avec
// la copie ancienne du contrat embarquée dans l'ERP, la resynchronisation avec le contrat du site. Contrat réel :
// KouziaWebsite main addfd0c (contenu.schema.main.json, pages.main.json).
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/site/${name}`, import.meta.url)), "utf8");
const MAIN = fixture("contenu.schema.main.json");
const main = JSON.parse(MAIN) as { fichiersFacultatifs: Record<string, { properties: Record<string, { maxItems?: number }> }> };
// Commit suivant du site : le pied de page n'accepte plus qu'un lien (contrat qui change entre deux contrôles).
const next = structuredClone(main);
next.fichiersFacultatifs["menus.json"]!.properties.pied!.maxItems = 1;
const CONTRACTS: Record<string, string> = { aaa111: MAIN, bbb222: JSON.stringify(next) };

let head = "aaa111";
let githubDown = false;
const reads: string[] = [];
vi.mock("@/lib/site/github.js", async (orig) => {
  const real = await orig<typeof import("@/lib/site/github.js")>();
  return {
    ...real,
    readSiteHeadSha: vi.fn(async () => {
      if (githubDown) throw new real.GithubError("GitHub injoignable.", 502);
      return head;
    }),
    readRepoFileAt: vi.fn(async (_path: string, ref: string) => {
      reads.push(ref);
      return CONTRACTS[ref]!;
    }),
    readSiteRepoFiles: vi.fn(async () => ({
      files: Object.fromEntries(["infos", "textes", "faq", "realisations", "avis", "references"].map((n) => [n, fixture(`${n}.json`)])),
      optional: { pages: fixture("pages.main.json") },
      contract: JSON.parse(CONTRACTS[head]!),
    })),
  };
});

const { buildApp } = await import("@/app.js");
const { forgetSiteContract } = await import("@/lib/site/editor.js");

const ADMIN = "admin-contrat@kouzia.test";
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
  head = "aaa111";
  githubDown = false;
  reads.length = 0;
  forgetSiteContract();
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie } });
const CONTRACT_DOCS = ["pages", "seo", "menus", "espace-client"];
type Issue = { file: string; path: string; message: string };
const docIssues = async (url: string) => ((await call("GET", url)).json().issues as Issue[]).filter((i) => CONTRACT_DOCS.includes(i.file));

async function resync() {
  const plan = (await call("GET", "/api/site/editor/resync")).json() as { planId: string };
  const applied = await call("POST", "/api/site/editor/resync", { planId: plan.planId });
  expect(applied.statusCode, applied.body).toBe(200);
}
const stored = async (key: string) => JSON.parse((await prisma.siteText.findUniqueOrThrow({ where: { key } })).valueJson) as Record<string, unknown>;

describe("une seule source de contrat : celle du dépôt du site", () => {
  it("défaut reproduit : après la resynchronisation, l'état de l'espace Site ne refuse plus les clés du site", async () => {
    await call("PUT", "/api/site/editor/pages", { value: { pages: { accueil: { hero: { surTitre: "Sur-titre saisi dans l'ERP" } } } } });
    await resync();
    const pages = await stored("pages");
    const menus = await stored("menus");
    // Ce que la resynchronisation écrit (contrat du site), que la copie de l'ERP refusait : cause des erreurs signalées.
    expect(pages.communs).toBeDefined();
    expect(menus.libelles).toBeDefined();
    expect(siteOptionalSchemas.pages.safeParse({ schemaVersion: 1, ...pages }).success).toBe(false);
    expect(siteOptionalSchemas.menus.safeParse({ schemaVersion: 1, ...menus }).success).toBe(false);
    // Texte saisi gardé : aucune suppression.
    expect((pages.pages as { accueil: { hero: { surTitre: string } } }).accueil.hero.surTitre).toBe("Sur-titre saisi dans l'ERP");

    expect(await docIssues("/api/site/status")).toEqual([]);
    expect(await docIssues("/api/site/changes")).toEqual([]);
    // Vérifiés pour de bon, par le contrat du dépôt (pas « non vérifié »).
    const { warnings } = (await call("GET", "/api/site/changes")).json() as { warnings: Issue[] };
    expect(warnings.filter((w) => w.message.includes("non vérifié"))).toEqual([]);
    expect(reads).toContain("aaa111");
  });

  it("le contrat est relu dès que le commit du site change, et seulement alors", async () => {
    await resync();
    expect(await docIssues("/api/site/status")).toEqual([]);
    await docIssues("/api/site/status");
    expect(reads.filter((r) => r === "aaa111")).toHaveLength(1);

    head = "bbb222";
    const issues = await docIssues("/api/site/status");
    expect(reads).toContain("bbb222");
    expect(issues.some((i) => i.file === "menus" && i.message.startsWith("Contrat du site"))).toBe(true);
  });

  it("GitHub indisponible : aucun refus tiré d'une copie locale, documents signalés non vérifiés", async () => {
    await resync();
    githubDown = true;
    expect(await docIssues("/api/site/status")).toEqual([]);
    const changes = (await call("GET", "/api/site/changes")).json() as { warnings: Issue[] };
    expect(changes.warnings).toContainEqual(expect.objectContaining({ file: "pages", message: expect.stringContaining("non vérifié") }));
  });
});
