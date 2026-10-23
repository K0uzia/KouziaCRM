import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { siteFileSchemas } from "@/lib/site/contract.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Mise en avant sur l'accueil (realisations.json : miseEnAvant, écrit seulement à true, 3 au plus, juste avant detail).
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-mise-en-avant@kouzia.test";
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
  await prisma.siteProject.deleteMany();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((x) => x.name === SESSION_COOKIE)?.value}`;
});

const body = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: `Projet ${slug}`,
  kind: "WEBSITE",
  text: "Texte de la carte.",
  url: "https://exemple.fr",
  linkLabel: "Voir le site",
  imagePath: `/projets/${slug}.webp`,
  ...extra,
});
const create = (slug: string, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/site/projects", headers: { cookie }, payload: body(slug, extra) });
const update = (id: string, slug: string, extra: Record<string, unknown>) => app.inject({ method: "PUT", url: `/api/site/projects/${id}`, headers: { cookie }, payload: body(slug, extra) });
const featured = async () => (await prisma.siteProject.findMany({ where: { featuredOnHome: true }, orderBy: { slug: "asc" } })).map((p) => p.slug);

describe("mise en avant sur l'accueil", () => {
  it("3 au plus, brouillons compris : la 4e est refusée (création et modification) avec les réalisations à décocher", async () => {
    expect((await create("a", { status: "PUBLISHED", featuredOnHome: true })).statusCode).toBe(201);
    expect((await create("b", { status: "PUBLISHED", featuredOnHome: true })).statusCode).toBe(201);
    expect((await create("c", { status: "DRAFT", featuredOnHome: true })).statusCode).toBe(201);

    const fourth = await create("d", { status: "PUBLISHED", featuredOnHome: true });
    expect(fourth.statusCode).toBe(400);
    expect(fourth.json().error).toBe("3 réalisations au plus sur l'accueil, brouillons compris : décochez d'abord « Projet a », « Projet b », « Projet c ».");
    expect(await prisma.siteProject.count({ where: { slug: "d" } })).toBe(0);

    const e = (await create("e", { status: "PUBLISHED" })).json() as { id: string };
    expect((await update(e.id, "e", { status: "PUBLISHED", featuredOnHome: true })).statusCode).toBe(400);
    expect(await featured()).toEqual(["a", "b", "c"]);
  });

  it("un brouillon coché publié ensuite ne fait pas passer le total à 4", async () => {
    await create("a", { status: "PUBLISHED", featuredOnHome: true });
    await create("b", { status: "PUBLISHED", featuredOnHome: true });
    const draft = (await create("c", { status: "DRAFT", featuredOnHome: true })).json() as { id: string };
    expect((await update(draft.id, "c", { status: "PUBLISHED", featuredOnHome: true })).statusCode).toBe(200);
    const file = JSON.parse((await buildSiteSnapshot()).files.realisations) as { realisations: Array<{ id: string; miseEnAvant?: true }> };
    expect(file.realisations.filter((r) => r.miseEnAvant).map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("retirée du site : décochée, sa place libérée ; de retour, elle ne reprend la case que s'il reste de la place", async () => {
    const a = (await create("a", { status: "PUBLISHED", featuredOnHome: true })).json() as { id: string };
    await create("b", { status: "PUBLISHED", featuredOnHome: true });
    await create("c", { status: "PUBLISHED", featuredOnHome: true });

    const withdrawn = await update(a.id, "a", { status: "WITHDRAWN", featuredOnHome: true });
    expect(withdrawn.json().featuredOnHome).toBe(false);
    expect((await create("d", { status: "PUBLISHED", featuredOnHome: true })).statusCode).toBe(201);

    const back = await update(a.id, "a", { status: "PUBLISHED", featuredOnHome: true });
    expect(back.statusCode).toBe(400);
    expect((await update(a.id, "a", { status: "PUBLISHED" })).json().featuredOnHome).toBe(false);
    expect(await featured()).toEqual(["b", "c", "d"]);
  });

  it("reprise initiale du site : la mise en avant publiée est reprise", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { SITE_FILES } = await import("@/lib/site/contract.js");
    const { importSiteFiles } = await import("@/lib/site/import.js");
    const raw = Object.fromEntries(
      SITE_FILES.map((n) => [n, readFileSync(fileURLToPath(new URL(`../fixtures/site/${n}.json`, import.meta.url)), "utf8").replace(/\r\n/g, "\n")]),
    ) as Record<(typeof SITE_FILES)[number], string>;
    const realisations = JSON.parse(raw.realisations) as { realisations: Array<{ id: string; miseEnAvant?: true }> };
    realisations.realisations[0]!.miseEnAvant = true;
    raw.realisations = JSON.stringify(realisations);
    await importSiteFiles(raw);
    expect(await featured()).toEqual([realisations.realisations[0]!.id]);
  });

  it("sans le champ, la case reste telle quelle (client antérieur)", async () => {
    const a = (await create("a", { status: "PUBLISHED", featuredOnHome: true })).json() as { id: string };
    expect((await update(a.id, "a", { status: "PUBLISHED", text: "Texte revu." })).json().featuredOnHome).toBe(true);
  });

  it("realisations.json : miseEnAvant seulement à true, juste avant detail, absente sinon ; le contrat refuse une 4e", async () => {
    await create("a", { status: "PUBLISHED", featuredOnHome: true, imageAlt: "Accueil", description: "Description pour Google.", context: "Contexte." });
    await create("b", { status: "PUBLISHED" });
    const file = JSON.parse((await buildSiteSnapshot()).files.realisations) as { realisations: Array<Record<string, unknown>> };
    const a = file.realisations.find((r) => r.id === "a")!;
    const keys = Object.keys(a);
    expect(a.miseEnAvant).toBe(true);
    expect(keys.indexOf("miseEnAvant")).toBe(keys.indexOf("imageAlt") + 1);
    expect(keys.indexOf("detail")).toBe(keys.indexOf("miseEnAvant") + 1);
    expect("miseEnAvant" in file.realisations.find((r) => r.id === "b")!).toBe(false);

    const four = ["w", "x", "y", "z"].map((id) => ({ id, nom: id, type: "Site web", texte: "t", url: "https://exemple.fr", lien: "Voir", image: `/projets/${id}.webp`, miseEnAvant: true }));
    expect(siteFileSchemas.realisations.safeParse({ schemaVersion: 1, realisations: four }).success).toBe(false);
    expect(siteFileSchemas.realisations.safeParse({ schemaVersion: 1, realisations: four.slice(0, 3) }).success).toBe(true);
  });
});
