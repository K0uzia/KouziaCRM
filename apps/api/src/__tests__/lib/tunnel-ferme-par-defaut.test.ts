import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 (P1-2) : sans proxy de confiance (TRUST_PROXY=false alors que cloudflared tourne, Docker sans le
// sous-réseau), une requête venue d'Internet était vue comme venant du LAN : connexion par mot de passe seul, sans 2FA,
// et toute l'admin servie sur api.kouzia.com. En-tête posé par Cloudflare (CF-Connecting-IP, CF-Ray) : traitée comme
// venue du tunnel. Jamais par l'hôte seul : un hôte public qui sert aussi le LAN (HTTP) doit continuer à marcher.
delete process.env.TRUST_PROXY;
process.env.ADMIN_PUBLIC_ORIGIN = "http://localhost:3001";
process.env.PUBLIC_API_ORIGIN = "https://api.audit.test";
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-tunnel-ferme@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
const CF = { "cf-connecting-ip": "203.0.113.9", "cf-ray": "8a1b2c3d4e5f-CDG" };
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
  app.inject({ method: "POST", url: "/api/auth/login", headers: { host, origin: `http://${host}`, ...extra }, payload: { email: ADMIN, password: PASSWORD } });
const sessionOf = (res: Awaited<ReturnType<typeof login>>) => res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;

describe("tunnel fermé par défaut, sans proxy de confiance", () => {
  it("api.kouzia.com par Cloudflare : l'admin répond 404, la santé reste servie", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { host: "api.audit.test", ...CF } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { host: "api.audit.test", ...CF } })).statusCode).toBe(200);
  });

  it("hôte admin par Cloudflare : pas de session par mot de passe seul (2FA exigée)", async () => {
    expect(sessionOf(await login("localhost:3001", CF))).toBeUndefined();
  });

  it("CF-Ray seul, autre hôte : traité comme le tunnel", async () => {
    expect(sessionOf(await login("192.168.1.20:3001", { "cf-ray": CF["cf-ray"] }))).toBeUndefined();
  });

  it("LAN sans en-tête Cloudflare, même sur l'hôte public : connexion inchangée", async () => {
    const res = await login("localhost:3001");
    expect(res.statusCode, res.body).toBe(200);
    expect(sessionOf(res)).toBeDefined();
  });
});
