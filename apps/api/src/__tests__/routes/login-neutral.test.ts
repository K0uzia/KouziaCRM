import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword } from "@/lib/auth.js";
import { LOGIN_FAILURE_FLOOR_MS } from "@/routes/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");
const ADMIN = "admin-neutre@kouzia.test";
let app: FastifyInstance;
beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

let ip = 0;
describe("connexion admin : refus neutre", () => {
  it("compte inconnu, mot de passe faux, requête mal formée : même message, jamais avant le délai plancher", async () => {
    const bodies = [{ email: "inconnu@kouzia.test", password: "x".repeat(12) }, { email: ADMIN, password: "mauvais-mot-de-passe" }, { email: "pas-un-email" }];
    const messages = new Set<string>();
    for (const payload of bodies) {
      const t = Date.now();
      const res = await app.inject({ method: "POST", url: "/api/auth/login", payload, remoteAddress: `10.8.0.${++ip}` });
      expect(Date.now() - t, JSON.stringify(payload)).toBeGreaterThanOrEqual(LOGIN_FAILURE_FLOOR_MS - 5);
      expect([400, 401]).toContain(res.statusCode);
      messages.add(res.json().error);
    }
    expect([...messages]).toEqual(["Email ou mot de passe incorrect"]);
  });
});
