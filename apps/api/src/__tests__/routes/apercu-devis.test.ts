import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { ensureDefaultLegalClauses } from "@/lib/company/legal-clauses.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";
import { pdfText } from "../helpers/pdf-text.js";

vi.mock("@/lib/email/mailer/index.js", () => ({
  mailEnqueue: vi.fn(async () => ({ outboxId: "outbox-1", messageId: "<x@y>" })),
}));

const { buildApp } = await import("@/app.js");
const { issueInvoice } = await import("@/lib/invoices/transitions.js");

const ADMIN = "admin-apercu@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
const NOTICE = "Si la date de prélèvement de l'abonnement ne vous convient pas";
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
  await ensureDefaultLegalClauses();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

/** Nombre de lignes de chaque table et réglages : toute écriture en base change cet instantané. */
async function dbSnapshot(): Promise<string> {
  const counts: Record<string, number> = {};
  for (const m of Prisma.dmmf.datamodel.models) {
    const delegate = (prisma as unknown as Record<string, { count: () => Promise<number> }>)[
      m.name.charAt(0).toLowerCase() + m.name.slice(1)
    ];
    counts[m.name] = await delegate.count();
  }
  const settings = await prisma.companySettings.findMany();
  return JSON.stringify({ counts, settings });
}

const oneOff = { description: "Site vitrine", quantity: 1, unitPriceEuros: 1500 };
const subscription = (serviceId: string) => ({
  description: "Hébergement et maintenance",
  quantity: 1,
  unitPriceEuros: 240,
  isSubscription: true,
  billingDay: 5,
  billingInterval: "YEAR",
  serviceId,
  commitmentMonths: 12,
});

const preview = (payload: Record<string, unknown>, withCookie = true) =>
  app.inject({ method: "POST", url: "/api/invoices/preview.pdf", headers: withCookie ? { cookie } : {}, payload });

describe("aperçu avant création", () => {
  it("rend le PDF réel du brouillon sans écrire en base ni consommer de numéro", async () => {
    const client = await createClient({ displayName: "Client Aperçu" });
    const service = await createService({ name: "Hébergement" });
    const numbersBefore = (await app.inject({ method: "GET", url: "/api/numbering/preview", headers: { cookie } })).json();
    const before = await dbSnapshot();

    const res = await preview({ clientId: client.id, documentType: "QUOTE", lines: [oneOff, subscription(service.id)] });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const text = pdfText(res.rawPayload);
    expect(text).toContain("APERÇU");
    expect(text).toContain("Numéro attribué à l'émission");
    expect(text).toContain("Client Aperçu");
    expect(text).toContain("Total du projet");

    const invoice = await preview({ clientId: client.id, documentType: "INVOICE", lines: [oneOff] });
    expect(invoice.statusCode).toBe(200);
    expect(pdfText(invoice.rawPayload)).toContain("APERÇU");

    expect(await dbSnapshot()).toBe(before);
    const numbersAfter = (await app.inject({ method: "GET", url: "/api/numbering/preview", headers: { cookie } })).json();
    expect(numbersAfter.previews).toEqual(numbersBefore.previews);
  });

  it("refuse sans session, valide le brouillon et ne révèle pas un client inconnu", async () => {
    const client = await createClient();
    expect((await preview({ clientId: client.id, lines: [oneOff] }, false)).statusCode).toBe(401);
    expect((await preview({ clientId: client.id, lines: [] })).statusCode).toBe(400);
    // Abonnement sans prestation liée : refusé comme à la création.
    const unlinked = await preview({ clientId: client.id, documentType: "QUOTE", lines: [{ ...subscription(""), serviceId: null }] });
    expect(unlinked.statusCode).toBe(400);
    expect((await preview({ clientId: "inconnu", lines: [oneOff] })).statusCode).toBe(404);
  });
});

describe("mention de la date de prélèvement", () => {
  it("figure avec un abonnement qui ne démarre pas à la livraison (PDF et fiche), jamais sans abonnement ni sur une facture", async () => {
    const client = await createClient();
    const service = await createService({ name: "Hébergement" });
    // Règle du 29/10/2026 : un abonnement qui démarre à la livraison (devis mixte) n'a pas encore de date à discuter.
    const withSub = await preview({ clientId: client.id, documentType: "QUOTE", lines: [oneOff, subscription(service.id)] });
    expect(pdfText(withSub.rawPayload)).not.toContain(NOTICE);
    const atSignature = await preview({ clientId: client.id, documentType: "QUOTE", lines: [oneOff, { ...subscription(service.id), subscriptionStart: "SIGNATURE" }] });
    expect(pdfText(atSignature.rawPayload)).toContain(NOTICE);
    const subOnly = await preview({ clientId: client.id, documentType: "QUOTE", lines: [subscription(service.id)] });
    expect(pdfText(subOnly.rawPayload)).toContain(NOTICE);
    const noSub = await preview({ clientId: client.id, documentType: "QUOTE", lines: [oneOff] });
    expect(pdfText(noSub.rawPayload)).not.toContain(NOTICE);
    const invoice = await preview({ clientId: client.id, documentType: "INVOICE", lines: [oneOff, subscription(service.id)] });
    expect(pdfText(invoice.rawPayload)).not.toContain(NOTICE);

    const create = (documentType: string, lines: unknown[]) =>
      app.inject({ method: "POST", url: "/api/invoices", headers: { cookie }, payload: { clientId: client.id, documentType, lines } });
    const detail = async (id: string) => (await app.inject({ method: "GET", url: `/api/invoices/${id}`, headers: { cookie } })).json();
    const quoteSub = (await create("QUOTE", [subscription(service.id)])).json();
    expect((await detail(quoteSub.id)).subscriptionDateNotice).toContain(NOTICE);
    const quoteMixed = (await create("QUOTE", [oneOff, subscription(service.id)])).json();
    expect((await detail(quoteMixed.id)).subscriptionDateNotice).toBeNull();
    const quotePlain = (await create("QUOTE", [oneOff])).json();
    expect((await detail(quotePlain.id)).subscriptionDateNotice).toBeNull();
    const invoiceSub = (await create("INVOICE", [oneOff, subscription(service.id)])).json();
    expect((await detail(invoiceSub.id)).subscriptionDateNotice).toBeNull();
  });

  it("suit la clause modifiée dans les mentions légales", async () => {
    const client = await createClient();
    const service = await createService({ name: "Hébergement" });
    await prisma.legalClause.updateMany({
      where: { kind: "SUBSCRIPTION_BILLING_DATE" },
      data: { body: "Date de prélèvement modifiable : écrivez à {{email}}." },
    });
    const res = await preview({ clientId: client.id, documentType: "QUOTE", lines: [subscription(service.id)] });
    const text = pdfText(res.rawPayload);
    expect(text).toContain("Date de prélèvement modifiable");
    expect(text).not.toContain(NOTICE);
    // La clause dédiée ne s'ajoute pas aux mentions légales génériques.
    expect(text.split("Date de prélèvement modifiable").length).toBe(2);
  });
});

describe("aperçu d'un avoir", () => {
  async function paidInvoice() {
    const client = await createClient({ displayName: "Client Avoir" });
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie },
      payload: { clientId: client.id, documentType: "INVOICE", lines: [oneOff] },
    });
    const invoice = await issueInvoice(created.json().id);
    await prisma.payment.create({ data: { invoiceId: invoice.id, amountCents: 150_000, paidAt: new Date(), method: "BANK_TRANSFER" } });
    return invoice;
  }
  const creditBody = (invoiceId: string) => ({
    documentType: "CREDIT_NOTE",
    invoiceId,
    amountEuros: 300,
    reason: "COMMERCIAL_GESTURE",
    reasonDetail: "Retard de livraison",
    refundMethod: "BANK_TRANSFER",
    // Jour de Paris, comme l'API : en UTC, entre minuit et 1 h le test prenait la veille.
    issueDate: new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date()),
  });

  it("montre l'avoir tel qu'émis (facture d'origine, montants négatifs) sans écriture ni numéro consommé", async () => {
    const invoice = await paidInvoice();
    const eligibility = async () =>
      (await app.inject({ method: "GET", url: `/api/invoices/${invoice.id}/credit-note/eligibility`, headers: { cookie } })).json();
    const nextBefore = (await eligibility()).nextNumberPreview;
    const before = await dbSnapshot();

    const res = await preview(creditBody(invoice.id));
    expect(res.statusCode).toBe(200);
    const text = pdfText(res.rawPayload);
    expect(text).toContain("AVOIR");
    expect(text).toContain("APERÇU");
    expect(text).toContain("Numéro attribué à l'émission");
    expect(text).toContain(invoice.number!);
    expect(text).toContain("-300,00");
    expect(text).toContain("Retard de livraison");

    expect(await dbSnapshot()).toBe(before);
    expect((await eligibility()).nextNumberPreview).toBe(nextBefore);

    // L'avoir émis ensuite porte le premier numéro et le même contenu que l'aperçu.
    const issued = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/credit-note`,
      headers: { cookie },
      payload: { ...creditBody(invoice.id), documentType: undefined, invoiceId: undefined, registerRefundPayment: false },
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().number).toBe(nextBefore);
    const pdf = await app.inject({ method: "GET", url: `/api/invoices/${issued.json().id}/pdf`, headers: { cookie } });
    const issuedText = pdfText(pdf.rawPayload).replace(`N° ${nextBefore}`, "").replace(`Avoir ${nextBefore}`, "Avoir APERÇU");
    // Filigrane puis numéro de l'en-tête ; le pied de page garde « Avoir APERÇU ».
    const previewText = text.replace("APERÇU", "").replace("APERÇU", "").replace("Numéro attribué à l'émission", "");
    expect(previewText).toBe(issuedText);
  });

  it("applique les contrôles de l'émission", async () => {
    const invoice = await paidInvoice();
    expect((await preview({ ...creditBody(invoice.id), amountEuros: 2000 })).statusCode).toBe(400);
    expect((await preview({ ...creditBody(invoice.id), reason: "INCONNU" })).statusCode).toBe(400);
    expect((await preview({ ...creditBody("inconnue") })).statusCode).toBe(404);
    expect((await preview(creditBody(invoice.id), false)).statusCode).toBe(401);
  });
});
