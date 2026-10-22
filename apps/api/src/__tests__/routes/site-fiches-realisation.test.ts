import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { contractFileIssues, type SiteContract } from "@/lib/site/editeur-rules.js";
import { clearTable, resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");
const CONTRACT = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/site/contenu.schema.editeur.json", import.meta.url)), "utf8")) as SiteContract;

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

describe("fiches Réalisation : avant / après (contrat du site main 61feb6f)", () => {
  const media = (sha12: string, kind: "CAPTURE" | "MOBILE", width: number, height: number) =>
    prisma.siteMedia.create({ data: { sha12, kind, width, height, bytes: 1000 } });
  const pair = (vue: "bureau" | "mobile", avant: string, apres: string, source?: string) => ({
    vue,
    avant: { image: `/media/${avant}.webp`, alt: "Ancien site", date: "2024-03", ...(source !== undefined ? { source } : {}) },
    apres: { image: `/media/${apres}.webp`, alt: "Nouveau site" },
  });

  it("deux paires : stockées, relues, publiées entre captures et liens, images comptées dans la publication", async () => {
    await media("aaaaaaaaaaa1", "CAPTURE", 960, 540);
    await media("aaaaaaaaaaa2", "CAPTURE", 1920, 1080);
    await media("bbbbbbbbbbb1", "MOBILE", 390, 844);
    await media("bbbbbbbbbbb2", "MOBILE", 390, 844);
    const avantApres = [pair("bureau", "aaaaaaaaaaa1", "aaaaaaaaaaa2", "https://web.archive.org/web/2024/https://atelier.example.fr/"), pair("mobile", "bbbbbbbbbbb1", "bbbbbbbbbbb2", "")];
    const res = await call("POST", "/api/site/projects", { ...card, ...detail, avantApres });
    expect(res.statusCode).toBe(201);
    // Source vide : clé absente, jamais "".
    expect(res.json().avantApres).toEqual([avantApres[0], { ...avantApres[1], avant: { image: "/media/bbbbbbbbbbb1.webp", alt: "Ancien site", date: "2024-03" } }]);
    const [out] = await publishedRealisations();
    expect(Object.keys(out!.detail as object)).toEqual(["description", "contexte", "demarche", "captures", "avantApres", "liens"]);
    expect((out!.detail as { avantApres: unknown[] }).avantApres[0]).toEqual({
      vue: "bureau",
      avant: { image: "/media/aaaaaaaaaaa1.webp", alt: "Ancien site", date: "2024-03", source: "https://web.archive.org/web/2024/https://atelier.example.fr/" },
      apres: { image: "/media/aaaaaaaaaaa2.webp", alt: "Nouveau site" },
    });
    const snap = await buildSiteSnapshot();
    expect(snap.media).toEqual(expect.arrayContaining(["aaaaaaaaaaa1", "aaaaaaaaaaa2", "bbbbbbbbbbb1", "bbbbbbbbbbb2"]));
    expect(snap.issues.filter((i) => i.message.includes("Ratios"))).toEqual([]);
    // Fichier écrit conforme au vrai contrat du site (main 61feb6f, fixture).
    expect(contractFileIssues(CONTRACT, "realisations.json", JSON.parse(snap.files.realisations))).toEqual([]);
  });

  it("ratios différents d'un pixel : publication bloquée avec l'explication", async () => {
    await media("ccccccccccc1", "CAPTURE", 1366, 768);
    await media("ccccccccccc2", "CAPTURE", 1920, 1080);
    await call("POST", "/api/site/projects", { ...card, ...detail, avantApres: [pair("bureau", "ccccccccccc1", "ccccccccccc2")] });
    expect((await buildSiteSnapshot()).issues).toContainEqual({
      file: "realisations",
      path: "Atelier, avant / après (ordinateur)",
      message: "Ratios différents : 1366×768 avant, 1920×1080 après ; recadrer l'une des deux captures",
    });
  });

  it("refus : même vue deux fois, trois paires, date hors AAAA-MM, source hors web.archive.org, image hors médiathèque", async () => {
    const p = pair("bureau", "aaaaaaaaaaa1", "aaaaaaaaaaa2");
    const post = (avantApres: unknown) => call("POST", "/api/site/projects", { ...card, avantApres });
    expect((await post([p, p])).statusCode).toBe(400);
    expect((await post([p, pair("mobile", "bbbbbbbbbbb1", "bbbbbbbbbbb2"), p])).statusCode).toBe(400);
    expect((await post([{ ...p, avant: { ...p.avant, date: "2024-13" } }])).statusCode).toBe(400);
    expect((await post([{ ...p, avant: { ...p.avant, source: "https://archive.ph/abc" } }])).statusCode).toBe(400);
    expect((await post([{ ...p, apres: { ...p.apres, image: "/projets/a.webp" } }])).statusCode).toBe(400);
  });
});
