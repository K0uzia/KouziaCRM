import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { MEDIATOR_REQUIRED_MESSAGE } from "@/lib/company/mediator.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");
const ADMIN = "admin-mediateur@kouzia.test";
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
  await resetDb();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
});
let ip = 0;
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  // resetDb vide les sessions : connexion à chaque test.
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" }, remoteAddress: `10.4.0.${++ip}` });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

async function withoutMediator() {
  await prisma.companySettings.updateMany({ data: { mediationClause: null } });
  invalidateCompanySettingsCache();
}

async function draftQuote(type: "B2C" | "B2B" | "ASSOCIATION") {
  const client = await createClient({ displayName: `Client ${type}`, type });
  return prisma.invoice.create({
    data: {
      clientId: client.id,
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      subtotalCents: 100_000,
      totalCents: 100_000,
      lines: { create: [{ position: 1, description: "Site vitrine", quantity: 1, unitPriceCents: 100_000, lineTotalCents: 100_000 }] },
    },
  });
}
const issue = (id: string) => app.inject({ method: "POST", url: `/api/invoices/${id}/issue`, headers: { cookie }, payload: {} });

describe("médiateur de la consommation obligatoire pour signer avec un particulier (L612-1)", () => {
  it("particulier sans médiateur : devis refusé à l'envoi en signature, message clair, brouillon intact", async () => {
    await withoutMediator();
    const quote = await draftQuote("B2C");
    const res = await issue(quote.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(MEDIATOR_REQUIRED_MESSAGE);
    expect(res.json().error).toContain("Réglages > Mentions légales");
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: quote.id } });
    expect(after).toMatchObject({ status: "DRAFT", number: null });
  });

  it("professionnel ou association sans médiateur : envoi possible", async () => {
    await withoutMediator();
    for (const type of ["B2B", "ASSOCIATION"] as const) {
      const res = await issue((await draftQuote(type)).id);
      expect(res.statusCode, `${type} ${res.body}`).toBe(200);
    }
  });

  it("particulier avec médiateur déclaré : envoi possible", async () => {
    const res = await issue((await draftQuote("B2C")).id);
    expect(res.statusCode, res.body).toBe(200);
  });
});
