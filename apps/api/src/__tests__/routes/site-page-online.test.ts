import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SitePublicationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { SITE_FILES, type SiteFileName } from "@/lib/site/contract.js";
import { importSiteFiles } from "@/lib/site/import.js";
import { publishedProjectPage } from "@/lib/site/changes.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// « Voir la page sur le site » (5a) : lien vers la page projet seulement si la dernière publication arrivée dans le dépôt l'a mise en ligne.
const { buildApp } = await import("@/app.js");

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/site/${name}`, import.meta.url)), "utf8");
const raw = Object.fromEntries(SITE_FILES.map((n) => [n, fixture(`${n}.json`).replace(/\r\n/g, "\n")])) as Record<SiteFileName, string>;
const ADMIN = "admin-page-online@kouzia.test";
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.sitePublication.deleteMany();
  await importSiteFiles(raw);
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((x) => x.name === SESSION_COOKIE)?.value}`;
});

const online = (id: string) => app.inject({ method: "GET", url: `/api/site/projects/${id}/page-online`, headers: { cookie } });
const files = (items: Array<{ id: string; detail?: object }>) => JSON.stringify({ realisations: JSON.stringify({ schemaVersion: 1, realisations: items }) });

describe("page projet en ligne", () => {
  it("lien seulement pour une page partie avec la dernière publication arrivée dans le dépôt", async () => {
    const [a, b] = await prisma.siteProject.findMany({ orderBy: { position: "asc" }, take: 2 });
    expect((await online(a!.id)).json()).toEqual({ url: null });

    await prisma.sitePublication.create({
      data: { status: SitePublicationStatus.NOOP, digest: "d1", summaryJson: "[]", filesJson: files([{ id: a!.slug, detail: { description: "x" } }, { id: b!.slug }]) },
    });
    expect((await online(a!.id)).json()).toEqual({ url: `https://kouzia.com/realisations/${a!.slug}/` });
    expect((await online(b!.id)).json()).toEqual({ url: null });

    // Publication en échec (ni commit ni « rien à changer ») : ignorée.
    await prisma.sitePublication.create({
      data: { status: SitePublicationStatus.FAILED, digest: "d2", summaryJson: "[]", filesJson: files([]), startedAt: new Date(Date.now() + 1000) },
    });
    expect((await online(a!.id)).json()).toEqual({ url: `https://kouzia.com/realisations/${a!.slug}/` });

    expect((await online("inconnue")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/site/projects/${a!.id}/page-online` })).statusCode).toBe(401);
  });

  it("fichiers illisibles ou absents : pas de lien", () => {
    expect(publishedProjectPage(null, "x")).toBeNull();
    expect(publishedProjectPage({ realisations: "{" }, "x")).toBeNull();
    expect(publishedProjectPage({ faq: "{}" }, "x")).toBeNull();
  });
});
