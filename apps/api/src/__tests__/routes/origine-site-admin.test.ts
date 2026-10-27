import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 : le site public (PUBLIC_WEB_ORIGIN) était admis en CORS avec cookies et par la garde
// d'origine sur TOUTES les routes. Même site que l'admin, cookie SameSite=Lax : un script du site aurait lu et
// modifié l'admin avec la session d'Alexandre. Attendu : site admis sur /api/public/* seulement.
const SITE = "https://site-public.test";
process.env.PUBLIC_WEB_ORIGIN = SITE;
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-origine@kouzia.test";
let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  app = await buildApp({ silent: true, serveStatic: false });
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

describe("origine du site public : API publique seulement", () => {
  it("lecture de l'admin depuis le site : pas d'autorisation CORS (le navigateur bloque la réponse)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/clients", headers: { cookie, origin: SITE } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/clients",
      headers: { origin: SITE, "access-control-request-method": "POST" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("écriture dans l'admin depuis le site : refusée par la garde d'origine", async () => {
    const res = await app.inject({ method: "POST", url: "/api/clients", headers: { cookie, origin: SITE }, payload: { type: "B2B", companyName: "Piège" } });
    expect(res.statusCode).toBe(403);
    expect(await prisma.client.count({ where: { companyName: "Piège" } })).toBe(0);
  });

  it("API publique depuis le site : autorisée comme avant", async () => {
    const res = await app.inject({ method: "GET", url: "/api/public/tracking", headers: { origin: SITE } });
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/public/auth/logout",
      headers: { origin: SITE, "access-control-request-method": "POST" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBe(SITE);
  });
});
