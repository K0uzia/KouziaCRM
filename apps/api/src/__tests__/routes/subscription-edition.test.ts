import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { buildApp } from "@/app.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

const ADMIN = "admin-abonnements@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function contrat(data: Record<string, unknown> = {}) {
  const client = await createClient();
  const service = await createService();
  return prisma.subscription.create({
    data: {
      clientId: client.id,
      serviceId: service.id,
      label: "Maintenance",
      amountCents: 30_000,
      billingDay: 1,
      startDate: new Date(),
      nextInvoiceAt: new Date(Date.now() + 30 * 86_400_000),
      ...data,
    },
  });
}

const draftLike = async (id: string) =>
  ((await call("GET", "/api/subscriptions")).json() as Array<{ id: string; draftLike: boolean }>).find((s) => s.id === id)!.draftLike;

describe("contrat créé à la main, jamais facturé, sans Stripe", () => {
  it("montant corrigé directement, puis suppression", async () => {
    const sub = await contrat();
    expect(await draftLike(sub.id)).toBe(true);
    const patch = await call("PATCH", `/api/subscriptions/${sub.id}`, { amountEuros: 350 });
    expect(patch.statusCode).toBe(200);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).amountCents).toBe(35_000);
    expect((await call("DELETE", `/api/subscriptions/${sub.id}`)).statusCode).toBe(200);
    expect(await prisma.subscription.findUnique({ where: { id: sub.id } })).toBeNull();
    expect((await call("DELETE", `/api/subscriptions/${sub.id}`)).statusCode).toBe(404);
  });
});

describe("contrat verrouillé : suppression et montant refusés (409), le reste inchangé", () => {
  const cas: Array<[string, () => Promise<{ id: string }>]> = [
    ["déjà facturé", () => contrat({ lastInvoiceId: "facture-emise" })],
    ["prélevé par Stripe", () => contrat({ stripeSubscriptionId: "sub_123", collectionMethod: "STRIPE" })],
    [
      "issu d'un devis",
      async () => {
        const sub = await contrat();
        const s = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
        await prisma.invoice.create({
          data: {
            documentType: "QUOTE",
            invoiceType: "SIMPLE",
            status: "DRAFT",
            clientId: s.clientId,
            subtotalCents: 30_000,
            totalCents: 30_000,
            lines: {
              create: [{ position: 0, description: "Maintenance", quantity: 1, unitPriceCents: 30_000, lineTotalCents: 30_000, subscriptionId: sub.id }],
            },
          },
        });
        return sub;
      },
    ],
  ];
  for (const [nom, fabrique] of cas) {
    it(nom, async () => {
      const sub = await fabrique();
      expect(await draftLike(sub.id)).toBe(false);
      const patch = await call("PATCH", `/api/subscriptions/${sub.id}`, { amountEuros: 350 });
      expect(patch.statusCode).toBe(409);
      expect(patch.json().error).toMatch(/avenant/);
      const del = await call("DELETE", `/api/subscriptions/${sub.id}`);
      expect(del.statusCode).toBe(409);
      expect(del.json().error).toMatch(/Clôturez-le/);
      expect(await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ amountCents: 30_000 });
      // Le libellé reste modifiable ; renvoyer le même montant n'est pas un changement.
      expect((await call("PATCH", `/api/subscriptions/${sub.id}`, { label: "Maintenance annuelle", amountEuros: 300 })).statusCode).toBe(200);
    });
  }
});
