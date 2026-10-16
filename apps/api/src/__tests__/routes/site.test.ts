import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { SITE_FILES } from "@/lib/site/contract.js";
import { readTokenExpiration } from "@/lib/site/github.js";
import { clearTable, resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-site@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
const TOKEN = "github_pat_11ABCDEFG0secretSecretSecret_xyz9";
const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/site/${name}`, import.meta.url));
const fixture = (name: string) => readFileSync(fixturePath(name), "utf8");

let app: FastifyInstance;
let cookie: string;

// Une seule connexion (limite de débit de la connexion admin) ; seules les tables du Site sont vidées entre les tests.
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
  for (const t of ["SiteProject", "SiteReview", "SiteReference", "SiteFaq", "SiteText", "SiteMedia"]) await clearTable(t);
  await prisma.companySettings.updateMany({
    data: { githubTokenEncrypted: null, githubTokenHint: null, githubTokenExpiresAt: null },
  });
  invalidateCompanySettingsCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { cookie } });

const project = {
  slug: "atelier",
  name: "Atelier",
  kind: "WEBSITE",
  text: "Site vitrine d'un atelier.",
  tech: ["Astro"],
  url: "https://atelier.example.fr/",
  linkLabel: "Voir le site",
  imagePath: "/projets/atelier.webp",
};

/** GitHub simulé : référence de main, contrat et fichiers publiés ; garde les en-têtes reçus. */
function stubGithub(expiration: string | null = "2027-10-14 12:00:00 UTC", contractStatus = 200) {
  const seen: { url: string; auth: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.includes("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: "a".repeat(40) } }), {
          headers: expiration === null ? {} : { "github-authentication-token-expiration": expiration },
        });
      }
      const m = /\/contents\/src\/content\/site\/([a-z.]+)\?ref=main$/.exec(url);
      // Fichier absent du dépôt (seo.json, menus.json tant que l'ERP ne les a pas publiés) : 404, comme GitHub.
      if (m && !existsSync(fixturePath(m[1]))) return new Response("{}", { status: 404 });
      if (m) return contractStatus === 200 ? new Response(fixture(m[1])) : new Response("{}", { status: contractStatus });
      return new Response("{}", { status: 404 });
    }),
  );
  return seen;
}

describe("espace Site : accès", () => {
  it("toutes les routes exigent la session admin", async () => {
    for (const [method, url] of [
      ["GET", "/api/site/status"],
      ["GET", "/api/site/projects"],
      ["POST", "/api/site/projects"],
      ["PUT", "/api/site/texts/infos"],
      ["POST", "/api/site/media?kind=LOGO"],
      ["PUT", "/api/site/github"],
      ["POST", "/api/site/import"],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === "GET" ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("espace Site : réalisations", () => {
  it("mention sous le projet : facultative, nettoyée, 60 caractères au plus, sans tiret long", async () => {
    const ok = await call("POST", "/api/site/projects", { ...project, slug: "atelier-mention", mention: "  Développé par Kouzia au sein de La Capsule  " });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().mention).toBe("Développé par Kouzia au sein de La Capsule");
    const url = `/api/site/projects/${ok.json().id}`;
    const base = { ...project, slug: "atelier-mention" };
    // Vide ou blancs : pas de mention (clé omise de realisations.json).
    expect((await call("PUT", url, { ...base, mention: "   " })).json().mention).toBeNull();
    expect((await call("PUT", url, { ...base, mention: "x".repeat(60) })).json().mention).toHaveLength(60);
    expect((await call("PUT", url, { ...base, mention: "x".repeat(61) })).statusCode).toBe(400);
    expect((await call("PUT", url, { ...base, mention: "Kouzia \u2013 La Capsule" })).statusCode).toBe(400);
  });

  it("création, identifiant unique, règles de la charte", async () => {
    const created = await call("POST", "/api/site/projects", project);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ slug: "atelier", status: "DRAFT", tech: ["Astro"] });
    expect((await call("POST", "/api/site/projects", project)).statusCode).toBe(409);
    const mobile = await call("PUT", `/api/site/projects/${created.json().id}`, { ...project, imageMobilePath: "/media/0123456789ab.webp" });
    expect(mobile.json()).toMatchObject({ imageMobilePath: "/media/0123456789ab.webp" });
    expect((await call("PUT", `/api/site/projects/${created.json().id}`, project)).json()).toMatchObject({ imageMobilePath: null });
    // Texte alternatif de la capture : "" = décorative (gardé tel quel), texte, ou absent = calculé par le site (null).
    const url = `/api/site/projects/${created.json().id}`;
    expect((await call("PUT", url, { ...project, imageAlt: "" })).json()).toMatchObject({ imageAlt: "" });
    expect((await call("PUT", url, { ...project, imageAlt: "Atelier : page d'accueil, meubles en chêne" })).json()).toMatchObject({
      imageAlt: "Atelier : page d'accueil, meubles en chêne",
    });
    expect((await call("PUT", url, project)).json()).toMatchObject({ imageAlt: null });
    for (const imageAlt of ["   ", "x".repeat(201), "Atelier \u2014 accueil"]) {
      expect((await call("PUT", url, { ...project, imageAlt })).statusCode, JSON.stringify(imageAlt)).toBe(400);
    }

    for (const bad of [
      { url: "http://atelier.example.fr/" },
      { url: "https://github.com/K0uzia/atelier" },
      { text: "Site \u2014 vitrine" },
      { slug: "Atelier Bois" },
      { imagePath: "https://cdn.example.fr/a.webp" },
      { imageMobilePath: "/media/capture.png" },
      { horaires: "9 h" },
    ]) {
      const res = await call("POST", "/api/site/projects", { ...project, slug: "autre", ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("publié : l'identifiant ne change plus et la suppression est refusée (retrait seulement)", async () => {
    const { id } = (await call("POST", "/api/site/projects", { ...project, status: "PUBLISHED" })).json() as { id: string };
    await prisma.siteProject.update({ where: { id }, data: { publishedAt: new Date() } });
    expect((await call("PUT", `/api/site/projects/${id}`, { ...project, slug: "atelier-2" })).statusCode).toBe(409);
    expect((await call("DELETE", `/api/site/projects/${id}`)).statusCode).toBe(409);
    expect((await call("PUT", `/api/site/projects/${id}`, { ...project, status: "WITHDRAWN" })).statusCode).toBe(200);
  });

  it("ordre manuel", async () => {
    const a = (await call("POST", "/api/site/projects", project)).json() as { id: string };
    const b = (await call("POST", "/api/site/projects", { ...project, slug: "b" })).json() as { id: string };
    expect((await call("POST", "/api/site/projects/reorder", { ids: [b.id, a.id] })).statusCode).toBe(204);
    expect(((await call("GET", "/api/site/projects")).json() as { id: string }[]).map((p) => p.id)).toEqual([b.id, a.id]);
    expect((await call("POST", "/api/site/projects/reorder", { ids: ["inconnu"] })).statusCode).toBe(400);
  });
});

describe("espace Site : avis et références", () => {
  const review = { author: "Lou Martin", reviewedOn: "2026-10-01", text: "Travail soigné." };

  it("avis : publication impossible sans accord, client lié et date de l'expérience ; texte figé une fois publié ; preuve chiffrée", async () => {
    const client = await createClient({ displayName: "Lou Martin" });
    const other = await createClient({ displayName: "Autre" });
    const invoice = await prisma.invoice.create({ data: { clientId: client.id, number: "F-2026-0001" } });
    const draft = await prisma.invoice.create({ data: { clientId: client.id } });
    const consent = { consentAt: "2026-10-02T10:00:00+02:00", consentChannel: "e-mail", consentProof: "E-mail du 2 octobre." };
    const proven = { clientId: client.id, experienceOn: "2026-09-20" };

    expect((await call("POST", "/api/site/reviews", { ...review, status: "PUBLISHED" })).statusCode).toBe(400);
    const noClient = await call("POST", "/api/site/reviews", { ...review, ...consent, experienceOn: "2026-09-20", status: "PUBLISHED" });
    expect(noClient.json().error).toMatch(/Client lié requis/);
    const noExperience = await call("POST", "/api/site/reviews", { ...review, ...consent, clientId: client.id, status: "PUBLISHED" });
    expect(noExperience.json().error).toMatch(/Date de l'expérience/);
    // Facture d'un autre client, brouillon non émis, facture sans client : refusés.
    for (const bad of [
      { clientId: other.id, invoiceId: invoice.id },
      { clientId: client.id, invoiceId: draft.id },
      { invoiceId: invoice.id },
      { clientId: "inconnu" },
    ]) {
      expect((await call("POST", "/api/site/reviews", { ...review, ...bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // Retouché (même avec accord) : jamais publiable, la charte du site impose le texte exact.
    const altered = await call("POST", "/api/site/reviews", { ...review, ...consent, ...proven, alteredWithConsent: true, status: "PUBLISHED" });
    expect(altered.json().error).toMatch(/Avis retouché/);
    const res = await call("POST", "/api/site/reviews", {
      ...review,
      ...proven,
      invoiceId: invoice.id,
      status: "PUBLISHED",
      consentAt: "2026-10-02T10:00:00+02:00",
      consentChannel: "e-mail",
      consentProof: "D'accord pour publier mon avis. Lou",
    });
    expect(res.statusCode).toBe(201);
    const { id, consentProof } = res.json() as { id: string; consentProof: string };
    expect(consentProof).toContain("D'accord");
    expect(res.json()).toMatchObject({ clientId: client.id, invoiceId: invoice.id, experienceOn: "2026-09-20", alteredWithConsent: false });
    const row = await prisma.siteReview.findUniqueOrThrow({ where: { id } });
    expect(row.consentProofEncrypted).not.toContain("accord");

    await prisma.siteReview.update({ where: { id }, data: { publishedAt: new Date() } });
    const edit = await call("PUT", `/api/site/reviews/${id}`, { ...review, ...proven, text: "Travail très soigné.", consentAt: "2026-10-02T10:00:00+02:00" });
    expect(edit.statusCode).toBe(409);
  });

  it("référence : autorisation requise, et elle doit couvrir logo et témoignage ; produit obligatoire pour USER", async () => {
    const base = { slug: "asso", type: "USER", name: "Asso du bourg", productSlug: "tracebay", status: "PUBLISHED" };
    expect((await call("POST", "/api/site/references", base)).statusCode).toBe(400);
    const authorized = { ...base, authorizationAt: "2026-10-02T10:00:00Z", authorizationScope: "NAME" };
    expect((await call("POST", "/api/site/references", { ...authorized, logoPath: "/media/0123456789ab.webp" })).statusCode).toBe(400);
    expect(
      (await call("POST", "/api/site/references", { ...authorized, testimonial: { text: "Merci.", author: "Anne" } })).statusCode,
    ).toBe(400);
    expect((await call("POST", "/api/site/references", { ...authorized, productSlug: null })).statusCode).toBe(400);
    const ok = await call("POST", "/api/site/references", { ...authorized, contact: "Anne, anne@asso.example" });
    expect(ok.statusCode).toBe(201);
    expect((await prisma.siteReference.findFirstOrThrow()).contactEncrypted).not.toContain("anne@");
  });

  it("référence du mur de logos (client, partenaire) : logo, lien https et au moins un emplacement avant publication", async () => {
    const logo = {
      slug: "mairie",
      type: "CLIENT",
      name: "Mairie de Huelgoat",
      logoPath: "/media/0123456789ab.webp",
      url: "https://huelgoat.example.fr/",
      authorizationAt: "2026-10-02T10:00:00Z",
      authorizationScope: "NAME_LOGO",
      status: "PUBLISHED",
    };
    expect((await call("POST", "/api/site/references", { ...logo, url: null })).json().error).toMatch(/Lien vers le site/);
    expect((await call("POST", "/api/site/references", { ...logo, logoPath: null })).json().error).toMatch(/Logo requis/);
    expect((await call("POST", "/api/site/references", { ...logo, onHome: false, onProjects: false })).json().error).toMatch(/emplacement/);
    // Texte alternatif du logo : jamais vide (nom du lien), 120 caractères au plus.
    expect((await call("POST", "/api/site/references", { ...logo, logoAlt: "" })).statusCode).toBe(400);
    expect((await call("POST", "/api/site/references", { ...logo, logoAlt: "x".repeat(121) })).statusCode).toBe(400);
    const ok = await call("POST", "/api/site/references", { ...logo, onProjects: true, logoAlt: "Mairie de Huelgoat, Finistère" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ onHome: true, onProjects: true, logoAlt: "Mairie de Huelgoat, Finistère" });
    // Brouillon : rien n'est exigé.
    expect((await call("POST", "/api/site/references", { slug: "brouillon", type: "PARTNER", name: "Partenaire" })).statusCode).toBe(201);
  });
});

describe("espace Site : textes", () => {
  it("valide chaque document ; refuse un champ hors contrat", async () => {
    const infos = JSON.parse(fixture("infos.json")).infos;
    expect((await call("PUT", "/api/site/texts/infos", infos)).statusCode).toBe(200);
    expect((await call("PUT", "/api/site/texts/infos", { ...infos, telephone: "0778551825" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/site/texts/infos", { ...infos, horaires: "9 h" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/site/texts/inconnu", {})).statusCode).toBe(404);
    expect(((await call("GET", "/api/site/texts")).json() as { infos: unknown }).infos).toEqual(infos);
  });

  it("méthode des avis : brouillon absent tant qu'elle n'est pas enregistrée, puis titre et texte de la charte", async () => {
    expect(((await call("GET", "/api/site/texts")).json() as { avisMethode: unknown }).avisMethode).toBeNull();
    const methode = { titre: "Comment les avis sont recueillis et vérifiés", texte: "Seuls des clients ayant eu une prestation." };
    expect((await call("PUT", "/api/site/texts/avisMethode", methode)).statusCode).toBe(200);
    expect((await call("PUT", "/api/site/texts/avisMethode", { ...methode, texte: "" })).statusCode).toBe(400);
    expect(((await call("GET", "/api/site/texts")).json() as { avisMethode: unknown }).avisMethode).toEqual(methode);
  });
});

describe("espace Site : jeton GitHub et import", () => {
  it("le jeton n'est jamais renvoyé : indice seulement, y compris dans les réglages", async () => {
    expect((await call("PUT", "/api/site/github", { token: "pas-un-jeton" })).statusCode).toBe(400);
    const res = await call("PUT", "/api/site/github", { token: TOKEN });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(TOKEN);
    expect(res.json()).toEqual({ token: { set: true, hint: "••••••••xyz9" } });
    for (const url of ["/api/settings", "/api/site/status"]) {
      const body = (await call("GET", url)).body;
      expect(body, url).not.toContain(TOKEN);
      expect(body, url).not.toContain((await prisma.companySettings.findFirstOrThrow()).githubTokenEncrypted!);
    }
  });

  it("test de connexion : lecture seule, expiration du jeton enregistrée", async () => {
    await call("PUT", "/api/site/github", { token: TOKEN });
    const seen = stubGithub();
    const res = await call("POST", "/api/site/github/test");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ repo: "K0uzia/KouziaWebsite", branch: "main", headSha: "a".repeat(40) });
    expect((await prisma.companySettings.findFirstOrThrow()).githubTokenExpiresAt?.toISOString()).toBe("2027-10-14T12:00:00.000Z");
    expect(res.json()).toMatchObject({ expiration: "date" });
    const status = (await call("GET", "/api/site/status")).json() as { github: { expiresAt: string; checkedAt: string } };
    expect(status.github.expiresAt).toBe("2027-10-14T12:00:00.000Z");
    expect(status.github.checkedAt).toBeTruthy();
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(seen.every((s) => s.url.startsWith("https://api.github.com/repos/K0uzia/KouziaWebsite/"))).toBe(true);
  });

  it("import depuis le dépôt : contenu repris, état sans anomalie ; refusé ensuite", async () => {
    expect((await call("POST", "/api/site/import")).statusCode).toBe(412);
    await call("PUT", "/api/site/github", { token: TOKEN });
    stubGithub();
    const res = await call("POST", "/api/site/import");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ issues: [] });
    expect(await prisma.siteProject.count()).toBe(JSON.parse(fixture("realisations.json")).realisations.length);
    expect(SITE_FILES.length).toBe(6);
    expect((await call("POST", "/api/site/import")).statusCode).toBe(409);
  });

  it("jeton refusé par GitHub : message clair, sans le jeton", async () => {
    await call("PUT", "/api/site/github", { token: TOKEN });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const res = await call("POST", "/api/site/github/test");
    expect(res.statusCode, res.body).toBe(502);
    expect(res.json()).toEqual({ error: "Jeton GitHub refusé (expiré ou révoqué)." });
  });

  it("lecture de l'en-tête d'expiration : date (UTC, décalage, ISO), sans expiration, illisible", () => {
    const at = (h: string) => {
      const r = readTokenExpiration(h);
      return r.kind === "date" ? r.at.toISOString() : r.kind;
    };
    expect(at("2027-10-14 12:00:00 UTC")).toBe("2027-10-14T12:00:00.000Z");
    expect(at("2027-10-14 12:00:00 +0200")).toBe("2027-10-14T10:00:00.000Z");
    expect(at("2027-10-14T12:00:00Z")).toBe("2027-10-14T12:00:00.000Z");
    expect(readTokenExpiration(null)).toEqual({ kind: "none" });
    expect(readTokenExpiration("")).toEqual({ kind: "none" });
    expect(readTokenExpiration("demain")).toEqual({ kind: "invalid" });
    expect(readTokenExpiration("2027-13-45 99:00:00 UTC")).toEqual({ kind: "invalid" });
  });

  it("jeton sans expiration : testé et marqué comme tel ; un nouveau jeton efface l'ancienne date", async () => {
    await call("PUT", "/api/site/github", { token: TOKEN });
    stubGithub();
    await call("POST", "/api/site/github/test");
    expect((await prisma.companySettings.findFirstOrThrow()).githubTokenExpiresAt).not.toBeNull();
    await call("PUT", "/api/site/github", { token: TOKEN });
    let row = await prisma.companySettings.findFirstOrThrow();
    expect([row.githubTokenExpiresAt, row.githubTokenCheckedAt]).toEqual([null, null]);
    stubGithub(null);
    const res = await call("POST", "/api/site/github/test");
    expect(res.json()).toMatchObject({ expiration: "none", expiresAt: null });
    row = await prisma.companySettings.findFirstOrThrow();
    expect(row.githubTokenExpiresAt).toBeNull();
    expect(row.githubTokenCheckedAt).not.toBeNull();
  });

  it("expiration enregistrée même si la lecture du contrat échoue ensuite", async () => {
    await call("PUT", "/api/site/github", { token: TOKEN });
    stubGithub("2027-10-14 12:00:00 UTC", 404);
    expect((await call("POST", "/api/site/github/test")).statusCode).toBe(502);
    expect((await prisma.companySettings.findFirstOrThrow()).githubTokenExpiresAt?.toISOString()).toBe("2027-10-14T12:00:00.000Z");
  });
});
