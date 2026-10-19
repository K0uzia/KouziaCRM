import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createOnboardingToken } from "@/lib/clients/onboarding-token.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Base nationale des entreprises simulée : aucun résultat (l'entreprise passe en saisie manuelle).
vi.stubGlobal(
  "fetch",
  vi.fn(async () => new Response(JSON.stringify({ results: [], total_results: 0 }), { status: 200, headers: { "Content-Type": "application/json" } })),
);

const { buildApp } = await import("@/app.js");
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

async function send(extra: Record<string, unknown>) {
  const email = "pro-siret@example.com";
  const { token, jti, expiresAt } = createOnboardingToken({ email, existingClientId: null });
  await prisma.onboardingInvitation.create({ data: { email, token: jti, jti, expiresAt, existingClientId: null } });
  return app.inject({
    method: "POST",
    url: "/api/public/clients",
    payload: { token, type: "B2B", companyName: "Atelier Exemple", website: "", ...extra },
  });
}

describe("POST /api/public/clients : codes stables des erreurs SIRET et SIREN", () => {
  it("format refusé : erreurs par champ inchangées, code « validation »", async () => {
    const res = await send({ siret: "12345678901234" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("validation");
    expect(body.error.fieldErrors.siret).toEqual(["SIRET invalide (14 chiffres, Luhn)"]);
  });

  it("SIRET et SIREN incohérents : siret_siren_mismatch, rien d'enregistré", async () => {
    const res = await send({ siren: "552100554", siret: "73282932000074" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Le SIRET ne correspond pas au SIREN : ses 9 premiers chiffres doivent être le SIREN.",
      code: "siret_siren_mismatch",
    });
    expect(await prisma.client.count()).toBe(0);
  });

  it("SIRET et SIREN cohérents, ou SIRET seul : acceptés", async () => {
    expect((await send({ siren: "732829320", siret: "73282932000074" })).statusCode).toBe(201);
    await resetDb();
    await seedCompanySettings();
    expect((await send({ siret: "55210055400013" })).statusCode).toBe(201);
  });
});
