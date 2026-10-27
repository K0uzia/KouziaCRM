import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { parisIsoDate } from "@/lib/format-fr.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 : startDate « AAAA-MM-JJ » lue en UTC (1 h du matin à Paris) ; computeNextInvoiceAt calait
// l'échéance au jour de prélèvement à minuit, avant le départ, et la repoussait d'une période : un abonnement annuel
// au 1er décembre commençait sa facturation au 1er décembre de l'année suivante.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-abo-depart@kouzia.test";
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

describe("abonnement créé à la main : date de départ saisie", () => {
  it.each([
    ["YEAR", 1, "2030-12-01", "2030-12-01"],
    ["MONTH", 15, "2030-12-15", "2030-12-15"],
    ["MONTH", 1, "2030-12-10", "2031-01-01"],
  ] as const)("%s, prélevé le %i, départ %s : 1re échéance le %s", async (billingInterval, billingDay, startDate, expected) => {
    const client = await createClient({ displayName: `Client ${startDate}`, type: "B2B" });
    const svc = await createService({ name: `Maintenance ${startDate}`, unitPriceCents: 12000 });
    const res = await app.inject({
      method: "POST",
      url: "/api/subscriptions",
      headers: { cookie },
      payload: { clientId: client.id, serviceId: svc.id, label: "Maintenance", amountEuros: 120, billingDay, billingInterval, startDate },
    });
    expect(res.statusCode, res.body).toBe(201);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(parisIsoDate(sub.nextInvoiceAt)).toBe(expected);
  });
});
