import { readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 : le routeur décode les %XX du chemin, les gardes lisaient l'URL brute. « /api/%70romo-codes »
// atteignait les codes promo sans session (P0) ; « /%61pi/… » sautait la validation des paramètres et des requêtes,
// d'où un justificatif d'obligation écrit hors du dossier par « ..%2F » (P1), et l'en-tête no-store.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-chemins@kouzia.test";
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

describe("chemins encodés : les gardes jugent la route, pas l'URL brute", () => {
  it.each([
    ["GET", "/api/%70romo-codes"],
    ["GET", "/api/%70romo-codes/available"],
    ["POST", "/api/%70romo-codes"],
    ["DELETE", "/api/%70romo-codes/abc"],
  ] as const)("codes promo sans session : %s %s refusé (401)", async (method, url) => {
    const res = await app.inject({
      method,
      url,
      headers: { origin: "http://localhost:3001", host: "localhost:3001" },
      ...(method === "POST" ? { payload: { code: "PIRATE100", kind: "PERCENT", percent: 100 } } : {}),
    });
    expect(res.statusCode).toBe(401);
    expect(await prisma.promoCode.count({ where: { code: "PIRATE100" } })).toBe(0);
  });

  it("validation des requêtes et en-tête no-store aussi sur « /%61pi/… »", async () => {
    const res = await app.inject({ method: "GET", url: "/%61pi/clients?search=%00", headers: { cookie } });
    expect(res.statusCode).toBe(400);
    const ok = await app.inject({ method: "GET", url: "/%61pi/clients", headers: { cookie } });
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("justificatif d'obligation : identifiant traversant refusé, aucun fichier écrit hors du dossier", async () => {
    const boundary = "----audit";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from("%PDF-1.4 piège"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const outside = path.resolve(process.cwd(), "data");
    const before = readdirSync(outside, { withFileTypes: true }).map((d) => d.name);
    for (const url of ["/%61pi/obligations/..%2F..%2Fevil/attachment", "/api/obligations/..%2F..%2Fevil/attachment"]) {
      const res = await app.inject({ method: "POST", url, payload: body, headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` } });
      expect(res.statusCode, url).toBe(404);
    }
    const after = readdirSync(outside, { withFileTypes: true }).map((d) => d.name);
    expect(after.filter((n) => n.startsWith("evil-"))).toEqual([]);
    expect(after.length).toBe(before.length);
  });

  it("justificatif d'une obligation inconnue : 404, rien d'écrit", async () => {
    const boundary = "----audit";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({ method: "POST", url: "/api/obligations/cinconnue000000000000000/attachment", payload: body, headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect(res.statusCode).toBe(404);
  });
});
