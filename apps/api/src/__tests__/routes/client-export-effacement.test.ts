import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { EmailDirection, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { readClientSnapshot } from "@/lib/invoices/client-snapshot.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Décision du 27/10/2026 : fiche client, « Exporter » (export complet) et « Effacer ». Client facturé : anonymisation
// partielle, documents émis gardés 10 ans ; abonnement en cours : refus avec un message clair.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-effacement@kouzia.test";
const EMAIL = "lea.martin@exemple.fr";
let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

async function personalClient() {
  const client = await createClient({ displayName: "Léa Martin", type: "B2C" });
  await prisma.client.update({
    where: { id: client.id },
    data: { firstName: "Léa", lastName: "Martin", emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL), phoneEncrypted: encrypt("0611223344"), addressLine1: "3 rue des Lilas", city: "Quimper", postalCode: "29000" },
  });
  await prisma.clientContact.create({ data: { clientId: client.id, firstName: "Paul", lastName: "Martin" } });
  await prisma.emailThread.create({
    data: {
      subject: "Projet",
      participants: JSON.stringify([EMAIL]),
      lastMessageAt: new Date(),
      clientId: client.id,
      messages: { create: [{ direction: EmailDirection.INBOUND, messageId: "<projet@test>", fromAddress: EMAIL, toAddresses: "[]", subject: "Projet", receivedAt: new Date(), bodyText: "Bonjour" }] },
    },
  });
  return client;
}

async function issueInvoice(clientId: string) {
  const inv = (await call("POST", "/api/invoices", { clientId, documentType: "INVOICE", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 500 }] })).json();
  expect((await call("POST", `/api/invoices/${inv.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  return inv.id as string;
}

describe("export complet", () => {
  it("coordonnées, contacts, documents, messagerie, projets et preuves dans un seul fichier", async () => {
    const client = await personalClient();
    await issueInvoice(client.id);
    await prisma.clientProject.create({ data: { clientId: client.id, name: "Site vitrine" } });
    const res = await call("GET", `/api/clients/${client.id}/export`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    const data = res.json();
    expect(data.client.email).toBe(EMAIL);
    expect(data.contacts).toHaveLength(1);
    expect(data.invoices).toHaveLength(1);
    expect(data.emailThreads[0].messages[0].bodyText).toBe("Bonjour");
    expect(data.projects.map((p: { name: string }) => p.name)).toEqual(["Site vitrine"]);
    for (const key of ["testimonials", "portalSessions", "emailEvents", "quoteAcceptances", "softwareRequests"]) expect(data).toHaveProperty(key);
  });
});

describe("effacement", () => {
  it("sans document ni abonnement : fiche supprimée, messagerie comprise", async () => {
    const client = await personalClient();
    const res = await call("DELETE", `/api/clients/${client.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ mode: "DELETED" });
    expect(await prisma.client.count({ where: { id: client.id } })).toBe(0);
    expect(await prisma.emailMessage.count({ where: { fromAddress: EMAIL } })).toBe(0);
  });

  it("client facturé : anonymisé, documents gardés avec leurs coordonnées figées, recherche par e-mail sans résultat", async () => {
    const client = await personalClient();
    const invoiceId = await issueInvoice(client.id);
    const res = await call("DELETE", `/api/clients/${client.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ mode: "ANONYMIZED", keptDocuments: 1 });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.displayName).toMatch(/^Client effacé/);
    expect([after.firstName, after.lastName, after.emailEncrypted, after.emailHash, after.phoneEncrypted, after.addressLine1]).toEqual([null, null, null, null, null, null]);
    expect(await prisma.clientContact.count({ where: { clientId: client.id } })).toBe(0);
    expect(await prisma.emailMessage.count({ where: { fromAddress: EMAIL } })).toBe(0);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(readClientSnapshot(invoice)?.email).toBe(EMAIL);
    expect(await prisma.client.findUnique({ where: { emailHash: computeEmailHash(EMAIL)! } })).toBeNull();
  });

  it("abonnement en cours : 409 avec un message clair, rien d'effacé", async () => {
    const client = await personalClient();
    const service = await createService();
    await prisma.subscription.create({
      data: { clientId: client.id, serviceId: service.id, label: "Maintenance", amountCents: 3000, billingDay: 1, startDate: new Date(), nextInvoiceAt: new Date(), status: SubscriptionStatus.ACTIVE },
    });
    const res = await call("DELETE", `/api/clients/${client.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Abonnement en cours \(« Maintenance »\)/);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).firstName).toBe("Léa");
  });
});
