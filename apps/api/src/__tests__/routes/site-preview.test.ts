import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { SiteMediaKind } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { saveSiteImage } from "@/lib/site/media.js";
import { PREVIEW_TTL_MS, signPreviewToken, verifyPreviewToken } from "@/lib/site/preview.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Aperçu du brouillon d'une réalisation (lot 5b), contrat validé avec le site le 23/10/2026.
process.env.PUBLIC_WEB_ORIGIN = "https://kouzia.example";
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-apercu@kouzia.test";
const SITE = "https://kouzia.example";
const lines: string[] = [];
let app: FastifyInstance;
let cookie = "";

// Rendu sharp et import de l'application : marge au-delà des 5 s par défaut.
const SLOW = 30_000;

beforeAll(async () => {
  app = await buildApp({ serveStatic: false, logStream: { write: (line) => void lines.push(line) } });
}, SLOW);
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

async function image(seed: number) {
  const png = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: { r: 30, g: 60 + seed, b: 200 } } }).png().toBuffer();
  return saveSiteImage(png, SiteMediaKind.CAPTURE, `capture-${seed}.png`);
}

async function project(slug: string, extra: Record<string, unknown> = {}) {
  const card = await image(slug.length);
  return prisma.siteProject.create({
    data: { slug, name: `Projet ${slug}`, kind: "WEBSITE", text: "Texte de la carte.", url: "https://exemple.fr", linkLabel: "Voir le site", imagePath: `/media/${card.sha12}.webp`, status: "DRAFT", position: 1, ...extra },
  });
}

const issue = (id: string) => app.inject({ method: "POST", url: `/api/site/projects/${id}/preview`, headers: { cookie } });
const read = (token?: string, origin = SITE) =>
  app.inject({ method: "GET", url: "/api/public/preview/realisation", headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

describe("jeton de l'aperçu", () => {
  it("signé, 15 minutes, refusé s'il est retouché ou expiré", () => {
    const now = Date.now();
    const { token, expiresAt } = signPreviewToken("p1", now);
    expect(expiresAt.getTime() - now).toBeLessThanOrEqual(PREVIEW_TTL_MS);
    expect(expiresAt.getTime() - now).toBeGreaterThan(PREVIEW_TTL_MS - 1000);
    expect(verifyPreviewToken(token, now)?.projectId).toBe("p1");
    expect(verifyPreviewToken(token, now + PREVIEW_TTL_MS + 1000)).toBeNull();
    const [payload, sig] = token.split(".");
    const other = Buffer.from(JSON.stringify({ p: "p2", exp: Math.floor(now / 1000) + 900, jti: "x" })).toString("base64url");
    expect(verifyPreviewToken(`${other}.${sig}`, now)).toBeNull();
    expect(verifyPreviewToken(`${payload}.${"A".repeat(43)}`, now)).toBeNull();
    expect(verifyPreviewToken(undefined, now)).toBeNull();
    expect(signPreviewToken("p1", now).token).not.toBe(token);
  });
});

describe("aperçu du brouillon", () => {
  it("lien signé dans le fragment ; lecture par Bearer ; page projet incomplète rendue ; accord du client respecté ; blockers codés", async () => {
    const shot = await image(7);
    const p = await project("brouillon", {
      contextText: "Le contexte.",
      clientName: "Client Secret",
      capturesJson: JSON.stringify([{ image: `/media/${shot.sha12}.webp`, alt: "Accueil", vue: "bureau" }]),
    });
    expect((await app.inject({ method: "POST", url: `/api/site/projects/${p.id}/preview` })).statusCode).toBe(401);
    expect((await issue("inconnue")).statusCode).toBe(404);

    const res = await issue(p.id);
    expect(res.statusCode).toBe(200);
    const { url, expiresAt } = res.json() as { url: string; expiresAt: string };
    expect(url.startsWith(`${SITE}/apercu/#jeton=`)).toBe(true);
    const token = url.split("#jeton=")[1]!;
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const ok = await read(token);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.headers["referrer-policy"]).toBe("no-referrer");
    expect(String(ok.headers["x-robots-tag"])).toContain("noindex");
    expect(ok.headers["access-control-allow-origin"]).toBe(SITE);
    expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();
    const body = ok.json();
    expect(body.realisation).toMatchObject({ id: "brouillon", nom: "Projet brouillon", detail: { contexte: "Le contexte." } });
    expect(body.realisation.detail.clientNom).toBeUndefined();
    expect(body.realisation.detail.description).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("Client Secret");
    expect(body.blockers.map((b: { code: string }) => b.code)).toEqual(["brouillon", "accord-client", "description-manquante"]);
    expect(body.blockers.every((b: { message: string }) => b.message.length > 0)).toBe(true);
    const capture = body.media[`/media/${shot.sha12}.webp`];
    expect(capture).toMatchObject({ width: shot.width, height: shot.height });
    expect(capture.src).toContain(`/api/public/preview/media/${shot.sha12}.webp?jeton=`);
    if (shot.width2x) expect(capture.src2x).toContain(`${shot.sha12}-2x.webp`);
    expect(Object.keys(body.media)).toHaveLength(2);
    expect(body.expiresAt).toBe(expiresAt);
    expect(typeof body.generatedAt).toBe("string");
  }, SLOW);

  it("refus identiques : sans jeton, jeton faux ou réalisation supprimée", async () => {
    const p = await project("efface");
    const token = (await issue(p.id)).json().url.split("#jeton=")[1] as string;
    const refusals = [await read(), await read("faux.jeton"), await read(`${token.slice(0, -2)}AA`)];
    await prisma.siteProject.delete({ where: { id: p.id } });
    refusals.push(await read(token));
    for (const r of refusals) {
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: "Introuvable" });
    }
  }, SLOW);

  it("images : seulement celles de cette réalisation, en-têtes de l'aperçu ; jeton masqué dans les journaux", async () => {
    const a = await project("a");
    const b = await project("bb");
    const token = (await issue(a.id)).json().url.split("#jeton=")[1] as string;
    const own = a.imagePath!.slice("/media/".length);
    const other = b.imagePath!.slice("/media/".length);
    const img = await app.inject({ method: "GET", url: `/api/public/preview/media/${own}?jeton=${token}`, headers: { origin: SITE } });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/webp");
    expect(img.headers["cache-control"]).toBe("private, no-store");
    expect(img.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect((await app.inject({ method: "GET", url: `/api/public/preview/media/${other}?jeton=${token}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/preview/media/${own}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/preview/media/${own}?jeton=faux` })).json()).toEqual({ error: "Introuvable" });

    await read(token);
    const log = lines.join("\n");
    expect(log).not.toContain(token);
    expect(log).toContain(a.id);
  }, SLOW);

  it("CORS : préflight du site avec Authorization, sans cookie ; autre origine refusée ; admin inchangée", async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: "OPTIONS",
        url: "/api/public/preview/realisation",
        headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
      });
    for (const origin of [SITE, "http://localhost:4321", "http://127.0.0.1:4321"]) {
      const res = await preflight(origin);
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
      expect(String(res.headers["access-control-allow-methods"])).toBe("GET");
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    }
    expect((await preflight("https://ailleurs.example")).headers["access-control-allow-origin"]).toBeUndefined();

    const admin = await app.inject({ method: "GET", url: "/api/health", headers: { origin: SITE } });
    expect(admin.headers["access-control-allow-origin"]).toBe(SITE);
    expect(admin.headers["access-control-allow-credentials"]).toBe("true");
  });
});
