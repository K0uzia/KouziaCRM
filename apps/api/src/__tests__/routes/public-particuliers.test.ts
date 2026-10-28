import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createOnboardingToken } from "@/lib/clients/onboarding-token.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Kouzia ne travaille qu'avec des professionnels et des associations (décision d'Alexandre, 27/10/2026) : le site a
// retiré « Un particulier » de /nouveau-client. Application propre à ce fichier : POST /api/public/clients est limité
// à 10 envois par 15 minutes.
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

async function invite(email = "prospect@example.com", existingClientId: string | null = null) {
  const { token, jti, expiresAt } = createOnboardingToken({ email, existingClientId });
  await prisma.onboardingInvitation.create({ data: { email, token: jti, jti, expiresAt, existingClientId } });
  return { token, jti };
}

const send = (token: string, extra: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/public/clients", payload: { token, firstName: "Camille", lastName: "Dupont", website: "", ...extra } });

const REFUSED = {
  error: "Kouzia travaille uniquement avec les professionnels et les associations : ce formulaire n'accepte pas les particuliers.",
  code: "particulier_refuse",
};

describe("POST /api/public/clients : particuliers refusés", () => {
  it("particulier : 422 avec un message clair, rien d'enregistré, invitation gardée", async () => {
    const { token, jti } = await invite();
    const res = await send(token, { type: "B2C" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual(REFUSED);
    expect(await prisma.client.count()).toBe(0);
    expect((await prisma.onboardingInvitation.findUniqueOrThrow({ where: { jti } })).usedAt).toBeNull();
  });

  it("particulier déjà en base, invité à mettre sa fiche à jour : envoi en particulier refusé, fiche inchangée", async () => {
    const existing = await prisma.client.create({ data: { type: "B2C", displayName: "Camille Dupont", lastName: "Dupont", city: "Talence" } });
    const { token, jti } = await invite("camille@example.com", existing.id);
    const res = await send(token, { type: "B2C", city: "Bordeaux" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual(REFUSED);
    expect(await prisma.client.findUniqueOrThrow({ where: { id: existing.id } })).toEqual(existing);
    expect((await prisma.onboardingInvitation.findUniqueOrThrow({ where: { jti } })).usedAt).toBeNull();
  });

  it("professionnel : toujours accepté", async () => {
    const { token } = await invite();
    const res = await send(token, { type: "B2B", companyName: "Atelier Exemple" });
    expect(res.statusCode).toBe(201);
    expect(await prisma.client.findFirstOrThrow()).toMatchObject({ type: "B2B", displayName: "Atelier Exemple" });
  });

  it("aperçu : type existant null pour un particulier (le site fait choisir pro ou association), pro et association inchangés", async () => {
    const types = ["B2C", "B2B", "ASSOCIATION"] as const;
    const seen: Record<string, unknown> = {};
    for (const type of types) {
      const existing = await prisma.client.create({ data: { type, displayName: `Fiche ${type}`, lastName: "Dupont", companyName: type === "B2C" ? null : `Fiche ${type}` } });
      const { token } = await invite(`${type.toLowerCase()}@example.com`, existing.id);
      const res = await app.inject({ method: "GET", url: `/api/public/clients/preview?token=${encodeURIComponent(token)}` });
      expect(res.statusCode).toBe(200);
      seen[type] = res.json().existingType;
      expect(await prisma.client.findUniqueOrThrow({ where: { id: existing.id } })).toEqual(existing);
    }
    expect(seen).toEqual({ B2C: null, B2B: "B2B", ASSOCIATION: "ASSOCIATION" });
  });

  it("association : toujours acceptée", async () => {
    const { token } = await invite("tresorier@asso.example");
    const res = await send(token, { type: "ASSOCIATION", companyName: "Les Amis du Moulin" });
    expect(res.statusCode).toBe(201);
    expect(await prisma.client.findFirstOrThrow()).toMatchObject({ type: "ASSOCIATION", displayName: "Les Amis du Moulin" });
  });
});
