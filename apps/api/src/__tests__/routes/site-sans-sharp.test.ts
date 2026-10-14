import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Binaire de sharp absent (installation incomplète sur le serveur) : l'import du module échoue.
vi.mock("sharp", () => {
  throw new Error("Could not load the \"sharp\" module using the linuxmusl-x64 runtime");
});

const { buildApp } = await import("@/app.js");

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: "admin-sharp@kouzia.test" } });
  await prisma.user.create({ data: { email: "admin-sharp@kouzia.test", passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin-sharp@kouzia.test", password: "mot-de-passe-de-test" },
  });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

describe("sans sharp", () => {
  it("l'API démarre et répond ; l'envoi d'image est refusé avec un message clair", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    const status = await app.inject({ method: "GET", url: "/api/site/status", headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ imagesAvailable: false });
    const upload = await app.inject({ method: "POST", url: "/api/site/media?kind=CAPTURE", headers: { cookie }, payload: {} });
    expect(upload.statusCode).toBe(503);
    expect(upload.json().error).toMatch(/sharp n'est pas installé/);
  });
});
