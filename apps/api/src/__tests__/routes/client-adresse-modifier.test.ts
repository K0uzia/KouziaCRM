import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Base nationale d'adresses simulée : elle propose une AUTRE voie, au score élevé (cas réel : « 3 chemin de
// Recette » devenait « 3 Chemin de Caucetey » à l'enregistrement).
const banCalls: string[] = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    banCalls.push(String(url));
    return new Response(
      JSON.stringify({
        features: [
          {
            geometry: { coordinates: [-0.43, 44.76] },
            properties: { label: "3 Chemin de Caucetey 33880 Saint-Caprais-de-Bordeaux", name: "3 Chemin de Caucetey", postcode: "33880", city: "Saint-Caprais-de-Bordeaux", citycode: "33381", score: 0.92, type: "housenumber" },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }),
);

const { buildApp } = await import("@/app.js");
let app: FastifyInstance;
let cookie = "";
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  banCalls.length = 0;
  await resetDb();
  await seedCompanySettings();
  const user = await prisma.user.upsert({
    where: { email: "admin-adresse@kouzia.test" },
    update: {},
    create: { email: "admin-adresse@kouzia.test", passwordHash: await hashPassword("mot-de-passe-de-test") },
  });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

const ADRESSE = { addressLine1: "3 chemin de Recette", addressLine2: "Bât. R", postalCode: "33880", city: "Saint-Caprais-De-Bordeaux", country: "FRANCE" };

/** Fiche jamais géocodée (ni coordonnées ni code commune), comme les fiches anciennes en production. */
async function ficheAncienne() {
  return prisma.client.create({ data: { displayName: "Camille Recette", type: "B2C", firstName: "Camille", lastName: "Recette", ...ADRESSE } });
}

/** Ce que le formulaire « Modifier » envoie : tous les champs, la valeur affichée de chacun. */
function formulaire(overrides: Record<string, unknown> = {}) {
  return {
    type: "B2C",
    firstName: "Camille",
    lastName: "Recette",
    companyName: "",
    email: null,
    phone: "06 11 22 33 44",
    siret: null,
    siren: null,
    apeCode: null,
    companyVerifiedAt: null,
    ...ADRESSE,
    addressCityCode: null,
    addressLat: null,
    addressLon: null,
    addressManualConfirmed: false,
    notes: "",
    billingDay: null,
    ...overrides,
  };
}

const put = (id: string, payload: unknown) => app.inject({ method: "PUT", url: `/api/clients/${id}`, headers: { cookie }, payload: payload as object });

describe("« Modifier » une fiche client : l'adresse n'est jamais réécrite en silence", () => {
  it("aller-retour : un autre champ modifié, tous les champs d'adresse intacts, aucune revérification", async () => {
    const client = await ficheAncienne();
    const res = await put(client.id, formulaire());
    expect(res.statusCode).toBe(200);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after).toMatchObject(ADRESSE);
    expect(banCalls).toHaveLength(0);
  });

  it("adresse modifiée et autre voie proposée par la base nationale : refus avec la proposition, rien d'écrit", async () => {
    const client = await ficheAncienne();
    const res = await put(client.id, formulaire({ addressLine1: "5 chemin de Recette" }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("3 Chemin de Caucetey");
    expect(await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).toMatchObject(ADRESSE);
  });

  it("adresse confirmée à la main : enregistrée telle que saisie", async () => {
    const client = await ficheAncienne();
    const res = await put(client.id, formulaire({ addressLine1: "5 chemin de Recette", addressManualConfirmed: true }));
    expect(res.statusCode).toBe(200);
    expect(await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).toMatchObject({ ...ADRESSE, addressLine1: "5 chemin de Recette" });
  });
});
