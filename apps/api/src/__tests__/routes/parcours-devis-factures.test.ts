import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, MilestoneStatus, PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { generateMilestoneInvoice } from "@/lib/invoices/documentFlowService.js";
import { acceptQuoteByClient, convertQuoteToInvoice, issueInvoice, issueQuote } from "@/lib/invoices/transitions.js";
import { markPaidFromOnlinePayment } from "@/lib/stripe/mark-paid.js";
import { parisParts } from "@/lib/format-fr.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// Parcours devis et factures : régressions des anomalies prouvées par l'audit du 28/10/2026 (facture libre rattachée,
// refacturation après avoir, validité, annulation d'acompte, mentions du client, clauses figées, retrait du devis et
// annulation de la commande). Les cas de concurrence (double clic) fixent des invariants déjà tenus.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-parcours@kouzia.test";
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
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  // Session créée directement : la connexion est limitée à 10 essais par 15 minutes.
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

async function draftQuote(clientId: string, extra: Record<string, unknown> = {}) {
  const res = await call("POST", "/api/invoices", {
    clientId,
    documentType: "QUOTE",
    billingMode: "ONE_OFF",
    lines: [{ description: "Site vitrine", quantity: 1, unitPriceEuros: 1000 }],
    ...extra,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function signedQuote() {
  const client = await createClient({ displayName: "Asso Parcours", type: "ASSOCIATION" });
  const id = await draftQuote(client.id);
  expect((await call("POST", `/api/invoices/${id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  expect((await call("POST", `/api/quotes/${id}/sign-offline`, { signerName: "Léa Martin" })).statusCode).toBe(200);
  return { quoteId: id, clientId: client.id };
}

/** Facture libre de tout le devis, rattachée par sourceQuoteId, puis émise. */
async function freeTotalInvoice(quoteId: string, clientId: string) {
  const inv = await call("POST", "/api/invoices", {
    clientId,
    documentType: "INVOICE",
    sourceQuoteId: quoteId,
    lines: [{ description: "Site vitrine", quantity: 1, unitPriceEuros: 1000 }],
  });
  expect(inv.statusCode).toBe(201);
  expect((await call("POST", `/api/invoices/${inv.json().id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  return inv.json().id as string;
}

const OPEN = [MilestoneStatus.PENDING, MilestoneStatus.DUE, MilestoneStatus.OVERDUE, MilestoneStatus.FAILED];

describe("facture libre rattachée à un devis signé", () => {
  it("émise pour tout le devis, elle ferme les échéances d'acompte comme la conversion", async () => {
    const { quoteId, clientId } = await signedQuote();
    const open = await prisma.paymentMilestone.count({ where: { quoteId, status: { in: OPEN } } });
    expect(open).toBeGreaterThan(0); // échéancier 2 fois créé à la signature

    await freeTotalInvoice(quoteId, clientId);

    // Plus aucune échéance à payer sur le devis (sinon acompte réclamé en plus de la facture totale).
    const stillOpen = await prisma.paymentMilestone.findMany({ where: { quoteId, status: { in: OPEN } } });
    expect(stillOpen.map((m) => `${m.label}:${m.status}`)).toEqual([]);
  });

  it("un paiement en ligne d'un acompte annulé entre-temps se rattache à la facture totale", async () => {
    const { quoteId, clientId } = await signedQuote();
    const invoiceId = await freeTotalInvoice(quoteId, clientId);
    const deposit = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId }, orderBy: { position: "asc" } });

    const res = await markPaidFromOnlinePayment({
      amountCents: deposit.amountCents,
      method: PaymentMethod.CARD,
      paymentIntentId: "pi_acompte_annule",
      milestoneId: deposit.id,
    });
    // Le paiement ne peut plus être proposé ; s'il arrive quand même, il se rattache à la facture émise.
    expect(res.invoiceId).toBe(invoiceId);
  });

  it("devis facturé en totalité : plus de lien ni de page de paiement sur ses échéances", async () => {
    const { quoteId, clientId } = await signedQuote();
    await freeTotalInvoice(quoteId, clientId);
    const deposit = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId }, orderBy: { position: "asc" } });
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId } });
    const { assertMilestonePayable } = await import("@/lib/stripe/checkout.js");
    await expect(assertMilestonePayable({ ...deposit, status: MilestoneStatus.DUE, quote })).rejects.toThrow(/facturé en totalité/);
    const { activateMilestoneCheckout } = await import("@/lib/payments/milestonePaymentService.js");
    await prisma.paymentMilestone.update({ where: { id: deposit.id }, data: { status: MilestoneStatus.DUE } });
    await expect(activateMilestoneCheckout(deposit.id, { sendEmail: false })).rejects.toThrow(/facturé en totalité/);
    const { payPageInfo } = await import("@/lib/stripe/pay-page.js");
    expect(await payPageInfo("milestone", deposit.id)).toBeNull();
  });
});

describe("annulation de la facture d'un devis par avoir", () => {
  it("après l'avoir total, le devis peut être refacturé (facture corrigée)", async () => {
    const { quoteId } = await signedQuote();
    const conv = await call("POST", `/api/invoices/${quoteId}/convert`);
    expect(conv.statusCode).toBe(201);
    expect((await call("POST", `/api/invoices/${conv.json().id}/issue`, { email: { send: false } })).statusCode).toBe(200);
    expect((await call("POST", `/api/invoices/${conv.json().id}/cancel`)).statusCode).toBe(201);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: conv.json().id } })).status).toBe("CANCELLED");

    // Le devis ne reste pas « PAID » (marque de la conversion) alors que rien n'est payé ni dû.
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId } });
    expect(quote.status).not.toBe("PAID");
    const again = await call("POST", `/api/invoices/${quoteId}/convert`);
    expect(again.statusCode).toBe(201);
  });
});

describe("validité du devis", () => {
  it("l'émission garde la date de validité saisie sur le brouillon", async () => {
    const client = await createClient({ type: "B2B" });
    const in60 = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const id = await draftQuote(client.id, { validUntil: in60 });
    const draft = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(draft.validUntil!.toISOString().slice(0, 10) >= in60).toBe(true);
    // Émission sans date (ancien formulaire) : la date du brouillon, encore à venir, est gardée.
    expect((await call("POST", `/api/invoices/${id}/issue`, { email: { send: false } })).statusCode).toBe(200);
    const issued = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(issued.validUntil!.toISOString().slice(0, 10)).toBe(draft.validUntil!.toISOString().slice(0, 10));
  });

  it("sans date saisie, le devis émis est valable jusqu'au soir du 30e jour (heure de Paris)", async () => {
    const client = await createClient({ type: "B2B" });
    const id = await draftQuote(client.id);
    // Brouillon sans date : la règle de l'émission seule.
    await prisma.invoice.update({ where: { id }, data: { validUntil: null } });
    // Émis à 10 h (Paris) : fin du 30e jour, 23:59 heure de Paris (le PDF imprime « valable jusqu'au <jour> »).
    await issueQuote(id, new Date("2026-10-20T10:00:00+02:00"));
    const q = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(parisParts(q.validUntil!)).toMatchObject({ year: 2026, month: 11, day: 19, hour: 23, minute: 59 });
  });

  it("brouillon créé sans date : validité par défaut à la fin du 30e jour, heure de Paris", async () => {
    const client = await createClient({ type: "B2B" });
    const id = await draftQuote(client.id);
    const draft = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(parisParts(draft.validUntil!)).toMatchObject({ hour: 23, minute: 59 });
  });
});

describe("annulation d'une facture d'acompte", () => {
  it("« Annuler » ne rembourse pas un acompte sans la confirmation exigée par l'assistant d'avoir (CGV : acompte acquis)", async () => {
    const { quoteId } = await signedQuote();
    const first = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId }, orderBy: { position: "asc" } });
    const deposit = await generateMilestoneInvoice(first.id);
    expect((await call("POST", `/api/invoices/${deposit.id}/pay`, { amountEuros: deposit.totalCents / 100, notifyClient: false })).statusCode).toBe(201);

    const res = await call("POST", `/api/invoices/${deposit.id}/cancel`);
    // Refus code CGV, comme POST /credit-note sans cgvDepositRefundable.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("CGV");
    // CGV : acompte acquis, pas d'avoir.
    const kept = await call("POST", `/api/invoices/${deposit.id}/cancel`, { cgvDepositRefundable: false });
    expect(kept.json().code).toBe("CGV");
    // Remboursable confirmé : l'avoir est émis.
    expect((await call("POST", `/api/invoices/${deposit.id}/cancel`, { cgvDepositRefundable: true })).statusCode).toBe(201);
  });
});

describe("mentions obligatoires du client", () => {
  it("une facture n'est pas émise pour un client professionnel sans adresse", async () => {
    const client = await createClient({ displayName: "SARL Sans Adresse", type: "B2B", withoutAddress: true });
    const res = await call("POST", "/api/invoices", { clientId: client.id, documentType: "INVOICE", lines: [{ description: "Prestation", quantity: 1, unitPriceEuros: 100 }] });
    const issued = await call("POST", `/api/invoices/${res.json().id}/issue`, { email: { send: false } });
    // Art. 242 nonies A, annexe II du CGI : nom et adresse du client sur la facture. Refus avant numérotation.
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error).toMatch(/l'adresse et le code postal/);
    expect(await prisma.counter.count({ where: { documentType: "FACTURE" } })).toBe(0);
  });

  it("un devis n'est pas émis sans code postal, aucun numéro consommé", async () => {
    const client = await createClient({ type: "ASSOCIATION" });
    await prisma.client.update({ where: { id: client.id }, data: { postalCode: null } });
    const id = await draftQuote(client.id);
    const res = await call("POST", `/api/invoices/${id}/issue`, { email: { send: false } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/le code postal/);
    expect(await prisma.counter.count({ where: { documentType: "DEVIS" } })).toBe(0);
  });

  it("acompte refusé si l'adresse a été retirée après la signature, aucun numéro consommé", async () => {
    const { quoteId, clientId } = await signedQuote();
    await prisma.client.update({ where: { id: clientId }, data: { addressLine1: null } });
    const first = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId }, orderBy: { position: "asc" } });
    await expect(generateMilestoneInvoice(first.id)).rejects.toThrow(/l'adresse/);
    expect(await prisma.counter.count({ where: { documentType: "FACTURE" } })).toBe(0);
  });
});

describe("clauses figées sur les factures", () => {
  it("la facture d'acompte reprend les clauses figées du devis à son émission", async () => {
    const { quoteId } = await signedQuote();
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId } });
    expect(quote.legalClausesSnapshot).not.toBeNull();
    const first = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId }, orderBy: { position: "asc" } });
    const deposit = await generateMilestoneInvoice(first.id);
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: deposit.id } });
    expect(stored.legalClausesSnapshot).toEqual(quote.legalClausesSnapshot);
  });

  it("une facture libre fige les clauses actives à son émission", async () => {
    const client = await createClient({ type: "B2B" });
    const res = await call("POST", "/api/invoices", { clientId: client.id, documentType: "INVOICE", lines: [{ description: "Prestation", quantity: 1, unitPriceEuros: 100 }] });
    expect((await call("POST", `/api/invoices/${res.json().id}/issue`, { email: { send: false } })).statusCode).toBe(200);
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(Array.isArray(stored.legalClausesSnapshot) ? stored.legalClausesSnapshot.length : 0).toBeGreaterThan(0);
  });
});

describe("retrait du devis et annulation de la commande", () => {
  it("« Retirer le devis » : statut Retiré, motif interne, échéances annulées, plus signable ni facturable", async () => {
    const client = await createClient({ type: "B2B" });
    const id = await draftQuote(client.id);
    expect((await call("POST", `/api/invoices/${id}/issue`, { email: { send: false } })).statusCode).toBe(200);
    // Motif obligatoire.
    expect((await call("POST", `/api/quotes/${id}/withdraw`, {})).statusCode).toBe(400);
    const res = await call("POST", `/api/quotes/${id}/withdraw`, { reason: "Erreur de prix" });
    expect(res.statusCode).toBe(200);
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(quote).toMatchObject({ quoteStatus: "WITHDRAWN", status: "CANCELLED", quoteRejectReason: "Erreur de prix", nextReminderAt: null });
    expect(await prisma.paymentMilestone.count({ where: { quoteId: id, status: { not: "CANCELLED" } } })).toBe(0);
    await expect(acceptQuoteByClient(id, "Léa Martin", { source: "ADMIN" })).rejects.toThrow();
    expect((await call("POST", `/api/invoices/${id}/convert`)).statusCode).not.toBe(201);
  });

  it("« Annuler la commande » : échéances libres annulées, refus tant qu'une facture n'est pas réglée", async () => {
    const { quoteId } = await signedQuote();
    const [first] = await prisma.paymentMilestone.findMany({ where: { quoteId }, orderBy: { position: "asc" } });
    const deposit = await generateMilestoneInvoice(first!.id);
    // Facture d'acompte émise et pas réglée : annulation refusée (avoir d'abord).
    const refused = await call("POST", `/api/quotes/${quoteId}/cancel-order`, { reason: "Projet abandonné" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/avoir/);
    await call("POST", `/api/invoices/${deposit.id}/pay`, { amountEuros: deposit.totalCents / 100, notifyClient: false });
    const res = await call("POST", `/api/quotes/${quoteId}/cancel-order`, { reason: "Projet abandonné" });
    expect(res.statusCode).toBe(200);
    const milestones = await prisma.paymentMilestone.findMany({ where: { quoteId }, orderBy: { position: "asc" } });
    expect(milestones.map((m) => m.status)).toEqual(["PAID", "CANCELLED"]);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId } })).toMatchObject({ quoteStatus: "CANCELLED", status: "CANCELLED" });
    // Plus de solde à facturer.
    await expect(generateMilestoneInvoice(milestones[1]!.id)).rejects.toThrow();
  });
});

describe("double clic et courses", () => {
  it("deux signatures hors ligne simultanées : une seule acceptée, une seule preuve", async () => {
    const client = await createClient({ type: "B2B" });
    const id = await draftQuote(client.id);
    await issueQuote(id);
    const results = await Promise.allSettled([
      acceptQuoteByClient(id, "Léa Martin", { source: "ADMIN" }),
      acceptQuoteByClient(id, "Léa Martin", { source: "ADMIN" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.quoteAcceptanceAudit.count({ where: { quoteId: id } })).toBe(1);
  });

  it("deux « Facturer l'acompte » simultanés : une seule facture, aucun numéro perdu", async () => {
    const { quoteId } = await signedQuote();
    const first = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId }, orderBy: { position: "asc" } });
    const results = await Promise.allSettled([generateMilestoneInvoice(first.id), generateMilestoneInvoice(first.id)]);
    const invoices = await prisma.invoice.findMany({ where: { quoteId, documentType: InvoiceDocumentType.INVOICE } });
    expect(invoices).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const counter = await prisma.counter.findFirst({ where: { documentType: "FACTURE" } });
    expect(counter?.lastValue).toBe(1);
  });

  it("deux conversions simultanées : une seule facture", async () => {
    const { quoteId } = await signedQuote();
    await Promise.allSettled([convertQuoteToInvoice(quoteId), convertQuoteToInvoice(quoteId)]);
    expect(await prisma.invoice.count({ where: { sourceQuoteId: quoteId, documentType: InvoiceDocumentType.INVOICE } })).toBe(1);
  });

  it("deux émissions simultanées d'une facture : un seul numéro consommé", async () => {
    const client = await createClient({ type: "B2B" });
    const res = await call("POST", "/api/invoices", { clientId: client.id, documentType: "INVOICE", lines: [{ description: "Prestation", quantity: 1, unitPriceEuros: 100 }] });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const results = await Promise.allSettled([issueInvoice(id), issueInvoice(id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const counter = await prisma.counter.findFirst({ where: { documentType: "FACTURE" } });
    expect(counter?.lastValue).toBe(1);
  });
});
