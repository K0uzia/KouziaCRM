import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { clearTable, resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-fiches@kouzia.test";
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
  for (const t of ["SiteProject", "SiteMedia"]) await clearTable(t);
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { cookie } });

const card = {
  slug: "atelier",
  name: "Atelier",
  kind: "WEBSITE",
  text: "Site vitrine d'un atelier.",
  tech: ["Astro"],
  url: "https://atelier.example.fr/",
  linkLabel: "Voir le site",
  imagePath: "/projets/atelier.webp",
  status: "PUBLISHED",
};
const detail = {
  description: "Site vitrine d'un atelier de céramique : catalogue, ateliers et prise de rendez-vous, rapide et lisible sur téléphone.",
  context: "Un atelier sans site, des demandes par messages privés.\n\nBesoin d'une vitrine simple.",
  approach: "Ateliers de cadrage, maquette, puis mise en ligne.",
  captures: [{ image: "/media/0123456789ab.webp", alt: "Accueil du site de l'atelier", caption: "Accueil" }],
  links: [{ label: "Article de presse", url: "https://presse.example.fr/atelier" }],
};
const publishedRealisations = async () => JSON.parse((await buildSiteSnapshot()).files.realisations).realisations as Array<Record<string, unknown>>;

describe("fiches Réalisation : saisie et règles de publication", () => {
  it("projet sans client : page projet publiée avec ses textes, captures et liens, dans l'ordre du schéma du site", async () => {
    const res = await call("POST", "/api/site/projects", { ...card, ...detail });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ captures: detail.captures, links: detail.links, consentFile: false, detailBlocker: null });
    const [out] = await publishedRealisations();
    expect(out!.detail).toEqual({
      description: detail.description,
      contexte: detail.context,
      demarche: detail.approach,
      captures: [{ image: "/media/0123456789ab.webp", alt: "Accueil du site de l'atelier", legende: "Accueil" }],
      liens: [{ libelle: "Article de presse", url: "https://presse.example.fr/atelier" }],
    });
    expect(Object.keys(out!.detail as object)).toEqual(["description", "contexte", "demarche", "captures", "liens"]);
    // Capture citée : comptée dans les images à publier (absente de l'ERP ici, donc signalée).
    expect((await buildSiteSnapshot()).issues.some((i) => i.message.includes("0123456789ab"))).toBe(true);
  });

  it("sans description ou sans texte détaillé : carte publiée, page projet retenue avec son motif", async () => {
    const res = await call("POST", "/api/site/projects", { ...card, captures: detail.captures, description: detail.description });
    expect(res.json().detailBlocker).toMatch(/aucun texte détaillé/);
    const [out] = await publishedRealisations();
    expect(out).not.toHaveProperty("detail");
    expect((await buildSiteSnapshot()).warnings).toContainEqual(expect.objectContaining({ path: "Atelier", message: expect.stringMatching(/page projet non publiée/) }));
  });

  it("projet d'un client sans accord écrit : nouvelle carte retenue ; avec accord : nom du client et accordClient publiés", async () => {
    const client = await createClient({ displayName: "Atelier Martin" });
    const res = await call("POST", "/api/site/projects", { ...card, ...detail, clientId: client.id, clientName: "Atelier Martin", clientIntro: "Céramiste à Lyon." });
    const id = res.json().id;
    expect(res.json()).toMatchObject({ client: { id: client.id, displayName: "Atelier Martin" }, detailBlocker: "accord écrit du client non renseigné" });
    expect(await publishedRealisations()).toEqual([]);
    expect((await buildSiteSnapshot()).warnings).toContainEqual(expect.objectContaining({ message: "non publiée : accord écrit du client à renseigner" }));

    const put = await call("PUT", `/api/site/projects/${id}`, {
      ...card, ...detail, clientId: client.id, clientName: "Atelier Martin", clientIntro: "Céramiste à Lyon.",
      consentAt: "2026-10-20T10:00:00.000Z", consentNote: "E-mail du 20/10/2026",
    });
    expect(put.statusCode).toBe(200);
    const [out] = await publishedRealisations();
    expect(out!.detail).toMatchObject({ clientNom: "Atelier Martin", accordClient: true, client: "Céramiste à Lyon." });
    expect(Object.keys(out!.detail as object).slice(0, 5)).toEqual(["description", "contexte", "clientNom", "accordClient", "client"]);
  });

  it("carte déjà en ligne liée ensuite à un client sans accord : la carte reste, la page projet attend l'accord", async () => {
    const client = await createClient({ displayName: "Atelier Martin" });
    const created = await call("POST", "/api/site/projects", { ...card, ...detail });
    await prisma.siteProject.update({ where: { id: created.json().id }, data: { publishedAt: new Date() } });
    await call("PUT", `/api/site/projects/${created.json().id}`, { ...card, ...detail, clientId: client.id });
    const [out] = await publishedRealisations();
    expect(out!.id).toBe("atelier");
    expect(out).not.toHaveProperty("detail");
  });

  it("refus : capture hors médiathèque, plus de 6 captures, lien vers du code source, client inconnu", async () => {
    expect((await call("POST", "/api/site/projects", { ...card, captures: [{ image: "/projets/a.webp", alt: "x" }] })).statusCode).toBe(400);
    const seven = Array.from({ length: 7 }, () => detail.captures[0]);
    expect((await call("POST", "/api/site/projects", { ...card, captures: seven })).statusCode).toBe(400);
    expect((await call("POST", "/api/site/projects", { ...card, links: [{ label: "Code", url: "https://github.com/kouzia/x" }] })).statusCode).toBe(400);
    const unknown = await call("POST", "/api/site/projects", { ...card, clientId: "inconnu" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("Client introuvable");
  });

  it("justificatif de l'accord : PDF déposé, relu, remplacé puis retiré ; autre format refusé", async () => {
    const id = (await call("POST", "/api/site/projects", card)).json().id;
    const upload = (type: string, body: string) => {
      const boundary = "----kouzia";
      const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="accord"\r\nContent-Type: ${type}\r\n\r\n${body}\r\n--${boundary}--\r\n`;
      return app.inject({ method: "POST", url: `/api/site/projects/${id}/consent-file`, payload, headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` } });
    };
    expect((await upload("text/plain", "non")).statusCode).toBe(400);
    const ok = await upload("application/pdf", "%PDF-1.4 accord");
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ consentFile: true });
    expect(ok.json()).not.toHaveProperty("publicationConsentFile");
    const read = await call("GET", `/api/site/projects/${id}/consent-file`);
    expect(read.headers["content-type"]).toBe("application/pdf");
    expect(read.body).toContain("accord");
    expect((await call("DELETE", `/api/site/projects/${id}/consent-file`)).json().consentFile).toBe(false);
    expect((await call("GET", `/api/site/projects/${id}/consent-file`)).statusCode).toBe(404);
  });
});
