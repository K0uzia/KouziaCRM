import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { parisIsoDate, parisParts } from "@/lib/format-fr.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 : une validité de devis saisie « AAAA-MM-JJ » était lue à minuit UTC, soit 1 h ou 2 h du matin à
// Paris ; le worker (validUntil < maintenant) expirait le devis dès le début du dernier jour imprimé « valable jusqu'au ».
const { buildApp } = await import("@/app.js");
const { expireQuotes } = await import("@/lib/reminders.js");

const ADMIN = "admin-validite@kouzia.test";
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

describe("validité d'un devis saisie en jour", () => {
  it("valable jusqu'au soir de ce jour à Paris, pas expiré le matin même", async () => {
    const client = await createClient({ displayName: "Client Validité", type: "B2B" });
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie },
      payload: { clientId: client.id, documentType: "QUOTE", billingMode: "ONE_OFF", validUntil: "2030-03-15", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 900 }] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const q = await prisma.invoice.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(parisIsoDate(q.validUntil!)).toBe("2030-03-15");
    expect(parisParts(q.validUntil!).hour).toBe(23);

    await prisma.invoice.update({ where: { id: q.id }, data: { status: "ISSUED", quoteStatus: "SENT", number: "D-2030-0001" } });
    await expireQuotes(new Date("2030-03-15T08:00:00+01:00"));
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).quoteStatus).toBe("SENT");
    await expireQuotes(new Date("2030-03-16T00:30:00+01:00"));
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).quoteStatus).toBe("EXPIRED");
  });
});
