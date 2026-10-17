import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { saveSiteImage } from "@/lib/site/media.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-spa@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;
let cookie: string;
let dist: string;
const previousDist = process.env.WEB_DIST;

beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  // Build minimal de la SPA : page, chunk hashé et fichier de public/.
  dist = mkdtempSync(path.join(tmpdir(), "kouzia-dist-"));
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "index.html"), '<!doctype html><meta name="kouzia-offline-origin" content="https://build.invalid" /><title>ERP</title>');
  writeFileSync(path.join(dist, "assets", "SettingsPage-Ab12Cd34.js"), "export const x = 1;");
  writeFileSync(path.join(dist, "sw.js"), "self.addEventListener('push', () => {});");
  process.env.WEB_DIST = dist;
  app = await buildApp({ silent: true, serveStatic: true });
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});
afterAll(async () => {
  await app.close();
  if (previousDist === undefined) delete process.env.WEB_DIST;
  else process.env.WEB_DIST = previousDist;
  rmSync(dist, { recursive: true, force: true });
  await resetDb();
});

describe("SPA servie par l'API (production)", () => {
  it("chunk hashé : 200 en JavaScript, en cache un an (immuable)", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/SettingsPage-Ab12Cd34.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("ancien chunk absent après une mise à jour : 404, jamais index.html", async () => {
    for (const url of ["/assets/SettingsPage-Ancien99.js", "/assets/inconnu.css", "/favicon-ancien.svg"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(String(res.headers["content-type"]), url).not.toContain("text/html");
    }
  });

  it("route de la SPA et index.html : revalidés à chaque chargement (no-cache)", async () => {
    for (const url of ["/", "/settings", "/clients/abc?tab=projets", "/index.html"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toContain("text/html");
      expect(res.headers["cache-control"], url).toBe("no-cache");
    }
  });

  it("index.html : origine du hors ligne réécrite avec la configuration du serveur (jamais celle du build)", async () => {
    const previous = process.env.ADMIN_PUBLIC_ORIGIN;
    try {
      process.env.ADMIN_PUBLIC_ORIGIN = "https://erp.kouzia.test/";
      for (const url of ["/", "/clients/abc", "/index.html"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.body, url).toContain('<meta name="kouzia-offline-origin" content="https://erp.kouzia.test" />');
      }
      delete process.env.ADMIN_PUBLIC_ORIGIN;
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.body).toContain('<meta name="kouzia-offline-origin" content="" />');
      expect(res.body).not.toContain("build.invalid");
    } finally {
      if (previous === undefined) delete process.env.ADMIN_PUBLIC_ORIGIN;
      else process.env.ADMIN_PUBLIC_ORIGIN = previous;
    }
  });

  it("fichier non hashé (service worker) : no-cache", async () => {
    const res = await app.inject({ method: "GET", url: "/sw.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("API : jamais en cache (no-store), 404 JSON pour une route inconnue", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.headers["cache-control"]).toBe("no-store");
    const missing = await app.inject({ method: "GET", url: "/api/inconnue" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["cache-control"]).toBe("no-store");
  });

  it("médias du site : en-tête de la route conservé (privé, immuable), absent en 404 JSON", async () => {
    const png = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#203040" } }).png().toBuffer();
    const media = await saveSiteImage(png, "LOGO");
    const res = await app.inject({ method: "GET", url: `/api/site/media/${media.sha12}.webp`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    const missing = await app.inject({ method: "GET", url: "/api/site/media/000000000000.webp", headers: { cookie } });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/json");
  });

  it("webhook site-deploy : atteint sa route (jamais le repli SPA), réponse JSON non mise en cache", async () => {
    const res = await app.inject({ method: "POST", url: "/api/webhooks/site-deploy", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("en-têtes de sécurité sur toutes les réponses", () => {
  it("Permissions-Policy coupe caméra, micro, géolocalisation et paiement ; rien d'indexable ; polices locales seulement", async () => {
    for (const url of ["/", "/settings", "/api/health", "/api/inconnue"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["permissions-policy"], url).toBe("camera=(), microphone=(), geolocation=(), payment=()");
      expect(res.headers["x-robots-tag"], url).toBe("noindex, nofollow");
    }
    const csp = String((await app.inject({ method: "GET", url: "/" })).headers["content-security-policy"]);
    expect(csp).toMatch(/font-src 'self' data:(;|$)/);
  });
});
