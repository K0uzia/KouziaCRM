import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createOnboardingToken } from "@/lib/clients/onboarding-token.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

async function invite(email = "prospect@example.com") {
  const { token, jti, expiresAt } = createOnboardingToken({ email, existingClientId: null });
  await prisma.onboardingInvitation.create({
    data: { email, token: jti, jti, expiresAt, existingClientId: null },
  });
  return { token, jti };
}

const body = (token: string, extra: Record<string, unknown> = {}) => ({
  token,
  type: "B2C",
  firstName: "Camille",
  lastName: "Dupont",
  website: "",
  ...extra,
});

describe("POST /api/public/clients", () => {
  it("honeypot rempli : 201 factice, aucun client créé, invitation intacte", async () => {
    const { token, jti } = await invite();
    const res = await app.inject({
      method: "POST",
      url: "/api/public/clients",
      payload: body(token, { website: "https://spam.example" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
    expect(await prisma.client.count()).toBe(0);
    const inv = await prisma.onboardingInvitation.findUniqueOrThrow({ where: { jti } });
    expect(inv.usedAt).toBeNull();
  });

  it("honeypot vide : client créé, puis 409 au second envoi", async () => {
    const { token } = await invite();
    const first = await app.inject({ method: "POST", url: "/api/public/clients", payload: body(token) });
    expect(first.statusCode).toBe(201);
    expect(await prisma.client.count()).toBe(1);

    const second = await app.inject({ method: "POST", url: "/api/public/clients", payload: body(token) });
    expect(second.statusCode).toBe(409);
  });
});

describe("routes d'onboarding historiques", () => {
  it("GET et POST /api/public/onboarding/:token n'existent plus", async () => {
    const { jti } = await invite();
    const get = await app.inject({ method: "GET", url: `/api/public/onboarding/${jti}` });
    const post = await app.inject({
      method: "POST",
      url: `/api/public/onboarding/${jti}`,
      payload: body(jti),
    });
    expect(get.statusCode).toBe(404);
    expect(post.statusCode).toBe(404);
  });
});
