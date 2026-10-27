import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 : par le tunnel, l'hôte API (api.kouzia.com) ne sert que l'API publique, les webhooks, le retour
// Google et la santé. La garde (tunnel-hosts) juge la route reconnue par le routeur : un chemin encodé ou à segments
// « .. » ne doit jamais y ouvrir l'admin.
delete process.env.TRUST_PROXY;
process.env.ADMIN_PUBLIC_ORIGIN = "https://erp.audit.test";
process.env.PUBLIC_API_ORIGIN = "https://api.audit.test";
const { buildApp } = await import("@/app.js");

let app: FastifyInstance;
beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

// Venue du tunnel : en-têtes posés par Cloudflare.
const CF = { host: "api.audit.test", "cf-connecting-ip": "203.0.113.9", "cf-ray": "8a1b2c3d4e5f-CDG" };

describe("hôte API par le tunnel : jamais l'admin, même par un chemin encodé", () => {
  it.each([
    "/api/%70romo-codes",
    "/api/clients",
    "/%61pi/clients",
    "/api/%70ublic/../clients",
    "/api/public/%2e%2e/clients",
    "/api/public/..%2Fclients",
    "/api/public/../clients",
    "/api/%2e%2e/api/clients",
    "/api/auth/%6de",
    "/api/settings",
  ])("GET %s : 404, aucune donnée", async (url) => {
    const res = await app.inject({ method: "GET", url, headers: CF });
    expect(res.statusCode, `${url} : ${res.body.slice(0, 80)}`).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Not found" }));
  });

  it("préflight CORS par chemin encodé : jamais ouvert vers l'admin", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/api/%70romo-codes", headers: { ...CF, origin: "https://site.audit.test", "access-control-request-method": "GET" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("routes publiques : toujours servies", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health", headers: CF })).statusCode).toBe(200);
  });
});
