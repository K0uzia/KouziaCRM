import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

let app: FastifyInstance;
let dist: string;
const previousDist = process.env.WEB_DIST;

beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  // Build minimal de la SPA : page, chunk hashé et fichier de public/.
  dist = mkdtempSync(path.join(tmpdir(), "kouzia-dist-"));
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>ERP</title>");
  writeFileSync(path.join(dist, "assets", "SettingsPage-Ab12Cd34.js"), "export const x = 1;");
  writeFileSync(path.join(dist, "sw.js"), "self.addEventListener('push', () => {});");
  process.env.WEB_DIST = dist;
  app = await buildApp({ silent: true, serveStatic: true });
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
});
