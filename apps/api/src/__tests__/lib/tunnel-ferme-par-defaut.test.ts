import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 (P1-2) : sans proxy de confiance (TRUST_PROXY=false alors que cloudflared tourne, Docker sans le
// sous-réseau), une requête venue d'Internet était vue comme venant du LAN : connexion par mot de passe seul, sans 2FA,
// et toute l'admin servie sur api.kouzia.com. Hôte public ou en-tête Cloudflare : traitée comme venue du tunnel.
delete process.env.TRUST_PROXY;
process.env.ADMIN_PUBLIC_ORIGIN = "https://erp.audit.test";
process.env.PUBLIC_API_ORIGIN = "https://api.audit.test";
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-tunnel-ferme@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;
beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  app = await buildApp({ silent: true, serveStatic: false });
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  // Compte sans 2FA : par le tunnel, la connexion doit être refusée.
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

const login = (host: string, extra: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/auth/login", headers: { host, origin: `https://${host}`, ...extra }, payload: { email: ADMIN, password: PASSWORD } });
const sessionOf = (res: Awaited<ReturnType<typeof login>>) => res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;

describe("tunnel fermé par défaut, sans proxy de confiance", () => {
  it("api.kouzia.com : l'admin répond 404, la santé reste servie", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { host: "api.audit.test" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { host: "api.audit.test" } })).statusCode).toBe(200);
  });

  it("erp.kouzia.com : pas de session par mot de passe seul (2FA exigée)", async () => {
    expect(sessionOf(await login("erp.audit.test"))).toBeUndefined();
  });

  it("en-tête Cloudflare sur un autre hôte : traité comme le tunnel", async () => {
    expect(sessionOf(await login("192.168.1.20:3001", { "cf-ray": "8a1b2c3d4e5f-CDG" }))).toBeUndefined();
  });

  it("LAN (hôte local, sans en-tête Cloudflare) : connexion inchangée", async () => {
    const res = await login("localhost:3001");
    expect(res.statusCode, res.body).toBe(200);
    expect(sessionOf(res)).toBeDefined();
  });
});
