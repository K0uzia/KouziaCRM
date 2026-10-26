import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { clearTable, resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Contrat réel du site (branche feat/tracebay-realisations, avec la clé « editeur »).
const CONTRACT = readFileSync(fileURLToPath(new URL("../fixtures/site/contenu.schema.editeur.json", import.meta.url)), "utf8");
const contract = JSON.parse(CONTRACT) as { defauts: Record<string, Record<string, unknown>> };
let unreachable = false;
vi.mock("@/lib/site/github.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/site/github.js")>()),
  readSiteHeadSha: vi.fn(async () => {
    if (unreachable) throw new (await import("@/lib/site/github.js")).GithubError("GitHub injoignable", 502);
    return "0123abcd";
  }),
  readRepoFileAt: vi.fn(async () => {
    if (unreachable) throw new (await import("@/lib/site/github.js")).GithubError("GitHub injoignable", 502);
    return CONTRACT;
  }),
}));

const { buildApp } = await import("@/app.js");
const { forgetSiteContract } = await import("@/lib/site/editor.js");
const { textIssues } = await import("@/lib/site/editeur-rules.js");
const { buildSiteSnapshot } = await import("@/lib/site/snapshot.js");

const ADMIN = "admin-editeur@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await clearTable("SiteText");
  unreachable = false;
  forgetSiteContract();
});

const call = (method: "GET" | "PUT", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie } });
const d = contract.defauts;
const pagesDoc = () => ({ pages: structuredClone(d.pages), communs: structuredClone(d.communs) });

describe("règles « editeur » d'un texte", () => {
  const ed = { libelle: "Titre", page: "accueil", section: "Haut", type: "court" };
  it("variables : seulement celles du champ ; liens : seulement si permis, vers une cible connue ; accent : un passage au plus", () => {
    expect(textIssues("Réponse {delaiReponse}", { ...ed, variables: ["delaiReponse"] }, [])).toEqual([]);
    expect(textIssues("À {ville}", ed, [])).toEqual(["Variable {ville} non permise ici"]);
    expect(textIssues("Voir [la FAQ](faq)", ed, ["faq"])).toEqual(["Lien [libellé](cible) non permis dans ce texte"]);
    expect(textIssues("Voir [la FAQ](inconnue)", { ...ed, liens: true }, ["faq"])[0]).toMatch(/^Cible de lien inconnue : inconnue/);
    expect(textIssues("Un *site* et un *logiciel*", { ...ed, type: "titreAccent" }, [])).toEqual(["Un seul passage *entre astérisques* au plus"]);
  });
});

describe("/api/site/editor (« Tous les textes », lot L1)", () => {
  it("sans session : 401 ; avec : documents déclarés par le contrat, schéma, textes actuels du site et pages", async () => {
    expect((await app.inject({ method: "GET", url: "/api/site/editor" })).statusCode).toBe(401);
    const res = await call("GET", "/api/site/editor");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.docs.map((doc: { id: string }) => doc.id)).toEqual(["infos", "textes", "pages", "seo", "menus", "espace-client"]);
    expect(body.editeur.types).toContain("booleen");
    expect(body.editeur.pages).toContain("tracebay");
    expect(body.cibles.tracebay).toMatchObject({ chemin: expect.stringMatching(/^\//) });
    const pages = body.docs.find((doc: { id: string }) => doc.id === "pages");
    expect(pages.value).toBeNull();
    expect(pages.defaults.pages.tracebay).toBeDefined();
    expect(pages.schema.properties.pages.properties.tracebay).toBeDefined();
  });

  it("contrat illisible : available false avec le motif ; PUT : 503", async () => {
    unreachable = true;
    expect((await call("GET", "/api/site/editor")).json()).toEqual({ available: false, error: "GitHub injoignable" });
    expect((await call("PUT", "/api/site/editor/pages", { value: pagesDoc() })).statusCode).toBe(503);
  });

  it("PUT d'un document conforme (page tracebay et communs compris) : enregistré, relu, publié en entier", async () => {
    const doc = pagesDoc();
    (doc.pages.tracebay as Record<string, unknown>).surTitre = "Logiciel libre de traçabilité";
    const res = await call("PUT", "/api/site/editor/pages", { value: doc });
    expect(res.statusCode).toBe(200);
    const read = (await call("GET", "/api/site/editor")).json().docs.find((x: { id: string }) => x.id === "pages");
    expect(read.value.pages.tracebay.surTitre).toBe("Logiciel libre de traçabilité");
    expect(read.value.communs).toBeDefined();
    const published = JSON.parse((await buildSiteSnapshot()).files.pages!);
    expect(published).toMatchObject({ schemaVersion: 1, pages: { tracebay: { surTitre: "Logiciel libre de traçabilité" } } });
    expect(published.communs).toBeDefined();
  });

  it("PUT non conforme : 400 avec chaque chemin et motif, rien n'est enregistré", async () => {
    const doc = pagesDoc();
    (doc.pages.tracebay as Record<string, unknown>).surTitre = "Délai {inconnue}";
    (doc.pages.tracebay as Record<string, unknown>).cleInventee = "x";
    const res = await call("PUT", "/api/site/editor/pages", { value: doc });
    expect(res.statusCode).toBe(400);
    const paths = res.json().issues.map((i: { path: string }) => i.path);
    expect(paths).toContain("pages.tracebay.surTitre");
    expect(res.json().issues.some((i: { message: string }) => /cleInventee/.test(i.message))).toBe(true);
    expect(await prisma.siteText.count()).toBe(0);
    expect((await call("PUT", "/api/site/editor/inconnu", { value: {} })).statusCode).toBe(404);
  });

  it("menus : une page deux fois dans la même liste refusée (règle du build du site)", async () => {
    const res = await call("PUT", "/api/site/editor/menus", { value: { pied: [{ cible: "faq" }, { cible: "faq" }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toContainEqual({ path: "pied", message: "Cible en double" });
  });

  it("textes.json : enregistré en deux lignes historiques (accroche et offres), relu en un document", async () => {
    const textes = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/site/textes.json", import.meta.url)), "utf8")) as Record<string, unknown>;
    const { schemaVersion: _v, ...value } = textes;
    expect((await call("PUT", "/api/site/editor/textes", { value })).statusCode).toBe(200);
    expect((await prisma.siteText.findMany({ orderBy: { key: "asc" } })).map((r) => r.key)).toEqual(["accroche", "offres"]);
    const read = (await call("GET", "/api/site/editor")).json().docs.find((x: { id: string }) => x.id === "textes");
    expect(read.value).toEqual(value);
  });

  it("espace-client.json : nouveau document, publié quand le contrat le déclare", async () => {
    expect((await call("PUT", "/api/site/editor/espace-client", { value: structuredClone(d.espaceClient) })).statusCode).toBe(200);
    const snapshot = await buildSiteSnapshot(JSON.parse(CONTRACT));
    expect(JSON.parse(snapshot.files["espace-client"]!)).toMatchObject({ schemaVersion: 1, connexion: expect.any(Object) });
    expect(snapshot.issues.filter((i) => i.file === "espace-client")).toEqual([]);
  });
});
