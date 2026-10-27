import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createOnboardingToken } from "@/lib/clients/onboarding-token.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Base nationale d'adresses simulée : la réponse dépend du cas testé. Chaque test a sa propre adresse (cache par requête).
type Feature = { name: string; postcode: string; city: string; citycode: string; score: number; lon: number; lat: number };
let features: Feature[] = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async () =>
    new Response(
      JSON.stringify({
        features: features.map((f) => ({
          geometry: { coordinates: [f.lon, f.lat] },
          properties: { label: `${f.name} ${f.postcode} ${f.city}`, name: f.name, postcode: f.postcode, city: f.city, citycode: f.citycode, score: f.score, type: "housenumber" },
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  ),
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
  features = [];
  await resetDb();
  await seedCompanySettings();
});

async function send(address: Record<string, unknown>, existingClientId: string | null = null) {
  const email = "prospect-adresse@example.com";
  const { token, jti, expiresAt } = createOnboardingToken({ email, existingClientId });
  await prisma.onboardingInvitation.create({ data: { email, token: jti, jti, expiresAt, existingClientId } });
  return app.inject({
    method: "POST",
    url: "/api/public/clients",
    payload: { token, type: "B2B", firstName: "Camille", lastName: "Dupont", companyName: "Atelier Exemple", website: "", country: "FRANCE", ...address },
  });
}

const CAUCETEY: Feature = { name: "3 Chemin de Caucetey", postcode: "33880", city: "Saint-Caprais-de-Bordeaux", citycode: "33381", score: 0.92, lon: -0.43, lat: 44.76 };

describe("POST /api/public/clients : garde-fou d'adresse", () => {
  it("autre voie proposée : 400 au format du contrat, rien d'enregistré, invitation gardée", async () => {
    features = [CAUCETEY];
    const res = await send({ addressLine1: "3 chemin de Recette", postalCode: "33880", city: "Saint-Caprais-de-Bordeaux" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Adresse à vérifier : la base nationale propose « 3 Chemin de Caucetey, 33880 Saint-Caprais-de-Bordeaux ». Choisissez cette adresse ou confirmez votre saisie.",
      code: "address_suggestion",
      suggestion: { addressLine1: "3 Chemin de Caucetey", postalCode: "33880", city: "Saint-Caprais-de-Bordeaux", addressCityCode: "33381", addressLat: 44.76, addressLon: -0.43 },
    });
    expect(await prisma.client.count()).toBe(0);
    expect((await prisma.onboardingInvitation.findFirstOrThrow()).usedAt).toBeNull();
  });

  it("autre commune proposée : même refus ; fiche existante (invitation de mise à jour) inchangée", async () => {
    features = [{ ...CAUCETEY, name: "12 Rue des Lilas", city: "Bordeaux", postcode: "33000", citycode: "33063" }];
    const existing = await prisma.client.create({ data: { type: "B2C", displayName: "Camille Dupont", lastName: "Dupont", city: "Talence" } });
    const res = await send({ addressLine1: "12 rue des Lilas", postalCode: "33000", city: "Talence" }, existing.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("address_suggestion");
    expect(res.json().error).toMatch(/^Adresse à vérifier : la base nationale propose « 12 Rue des Lilas, 33000 Bordeaux »/);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: existing.id } })).city).toBe("Talence");
  });

  it("casse et accents seuls : corrigés d'office, 201", async () => {
    features = [{ ...CAUCETEY, name: "8 Allée des Érables", city: "Saint-Caprais-de-Bordeaux" }];
    const res = await send({ addressLine1: "8 allee des erables", postalCode: "33880", city: "saint caprais de bordeaux" });
    expect(res.statusCode).toBe(201);
    expect(await prisma.client.findFirstOrThrow()).toMatchObject({ addressLine1: "8 Allée des Érables", city: "Saint-Caprais-de-Bordeaux", addressCityCode: "33381" });
  });

  it("suggestion renvoyée telle quelle (bouton « Utiliser cette adresse ») : acceptée sans revérification", async () => {
    features = [];
    const s = { addressLine1: "3 Chemin de Caucetey", postalCode: "33880", city: "Saint-Caprais-de-Bordeaux", addressCityCode: "33381", addressLat: 44.76, addressLon: -0.43 };
    const res = await send(s);
    expect(res.statusCode).toBe(201);
    expect(await prisma.client.findFirstOrThrow()).toMatchObject({ addressLine1: "3 Chemin de Caucetey", addressCityCode: "33381" });
  });

  it("saisie confirmée (addressManualConfirmed) : gardée telle quelle", async () => {
    features = [CAUCETEY];
    const res = await send({ addressLine1: "5 chemin de Recette", postalCode: "33880", city: "Saint-Caprais-de-Bordeaux", addressManualConfirmed: true });
    expect(res.statusCode).toBe(201);
    expect((await prisma.client.findFirstOrThrow()).addressLine1).toBe("5 chemin de Recette");
  });

  it("ambiguë et introuvable : messages inchangés (commencent par « Adresse »), codes ajoutés, sans suggestion", async () => {
    features = [
      { ...CAUCETEY, name: "1 Rue Haute", score: 0.5 },
      { ...CAUCETEY, name: "1 Rue Basse", score: 0.45 },
    ];
    const ambiguous = await send({ addressLine1: "1 rue", postalCode: "33880", city: "Saint-Caprais-de-Bordeaux" });
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.json()).toEqual({
      error: "Adresse ambiguë : choisissez une suggestion ou confirmez que l'adresse est correcte.",
      code: "address_ambiguous",
    });
    await resetDb();
    await seedCompanySettings();
    features = [];
    const notFound = await send({ addressLine1: "99 impasse Inconnue", postalCode: "33880", city: "Saint-Caprais-de-Bordeaux" });
    expect(notFound.statusCode).toBe(400);
    expect(notFound.json()).toEqual({
      error: "Adresse introuvable. Corrigez-la ou confirmez que l'adresse est correcte.",
      code: "address_not_found",
    });
  });
});
