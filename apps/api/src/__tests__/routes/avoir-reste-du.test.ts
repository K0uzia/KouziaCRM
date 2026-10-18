import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { ensureDefaultLegalClauses } from "@/lib/company/legal-clauses.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";
import { pdfText } from "../helpers/pdf-text.js";

vi.mock("@/lib/email/mailer/index.js", () => ({
  mailEnqueue: vi.fn(async () => ({ outboxId: "outbox-1", messageId: "<x@y>" })),
}));

const { buildApp } = await import("@/app.js");
const { reconcileCreditedInvoiceStatuses } = await import("@/lib/invoices/reconcile-status.js");
const { assessCreditNoteEligibility } = await import("@/lib/invoices/credit-note-service.js");

const ADMIN = "admin-avoir@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;
let cookie = "";
let clientId = "";
let seq = 0;

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
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  // Session ouverte directement (une connexion par test dépasserait la limite de débit de la connexion).
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
  ({ id: clientId } = await createClient({ displayName: "Client des avoirs" }));
});

/** Facture émise de 1 000 € (numérotée, une ligne). */
async function issuedInvoice(extra: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.invoice.create({
    data: {
      clientId,
      documentType: "INVOICE",
      status: "ISSUED",
      number: `F-2026-${String(seq).padStart(4, "0")}`,
      sequenceYear: 2026,
      sequenceNumber: seq,
      issueDate: new Date(2026, 9, 1),
      issuedAt: new Date(2026, 9, 1),
      dueDate: new Date(2026, 9, 31),
      subtotalCents: 100_000,
      totalCents: 100_000,
      lines: { create: [{ position: 0, description: "Site vitrine", quantity: 1, unitPriceCents: 100_000, lineTotalCents: 100_000 }] },
      ...extra,
    },
  });
}

const call = (method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, headers: { cookie }, payload: payload as never });
const credit = (id: string, amountEuros: number, refundMethod: string) =>
  call("POST", `/api/invoices/${id}/credit-note`, { amountEuros, reason: "AMOUNT_CORRECTION", refundMethod });
const pay = (id: string, amountEuros: number) => call("POST", `/api/invoices/${id}/pay`, { amountEuros, method: "BANK_TRANSFER", notifyClient: false });
const detail = async (id: string) => (await call("GET", `/api/invoices/${id}`)).json() as { status: string; balance: Record<string, number> };
const summary = async () => (await call("GET", "/api/invoices/summary?type=INVOICE")).json() as { amounts: Record<string, number> };
const receipts = async () => (await call("GET", "/api/receipts?year=2026")).json() as { totalCents: number; rows: unknown[] };

describe("exemple chiffré : facture 1 000, avoir 300, puis paiement 700", () => {
  it("avoir permis sur la facture impayée, reste dû 700, puis Payée ; livre des recettes : 700 seulement", async () => {
    const inv = await issuedInvoice();
    const elig = await assessCreditNoteEligibility(inv.id);
    expect(elig).toMatchObject({ allowed: true, maxCreditCents: 100_000, dueCents: 100_000, cashInCents: 0 });

    const cn = await credit(inv.id, 300, "DEDUCT_FROM_BALANCE");
    expect(cn.statusCode).toBe(201);
    let d = await detail(inv.id);
    expect(d.status).toBe("ISSUED");
    expect(d.balance).toEqual({ creditedCents: 30_000, netCents: 70_000, refundedCents: 0, cashInCents: 0, dueCents: 70_000, overpaidCents: 0 });
    expect((await summary()).amounts).toMatchObject({ toCollectCents: 70_000, cashInCents: 0, invoicedNetCents: 70_000, openCount: 1 });

    // PDF de la facture rendu sans archive (rendu de secours) : avoirs et reste dû, plus « total moins payé ».
    const invoicePdf = pdfText((await call("GET", `/api/invoices/${inv.id}/pdf`)).rawPayload);
    expect(invoicePdf).toContain("Avoirs");
    expect(invoicePdf).toMatch(/Reste d[^\n]{0,40}700,00/);

    // Avoir sans remboursement : aucune ligne au livre des recettes (aucun argent n'a bougé).
    expect((await receipts()).totalCents).toBe(0);

    expect((await pay(inv.id, 800)).statusCode).toBe(400);
    expect((await pay(inv.id, 700)).statusCode).toBe(201);
    d = await detail(inv.id);
    expect(d.status).toBe("PAID");
    expect(d.balance).toMatchObject({ netCents: 70_000, cashInCents: 70_000, dueCents: 0 });
    expect((await summary()).amounts).toMatchObject({ toCollectCents: 0, cashInCents: 70_000, invoicedNetCents: 70_000, openCount: 0, paidCount: 1 });
    expect((await receipts()).totalCents).toBe(70_000);

    // PDF de l'avoir : facture rectifiée référencée, montant négatif, déduction du solde, mention de TVA des réglages.
    const cnId = (cn.json() as { id: string }).id;
    const text = pdfText((await call("GET", `/api/invoices/${cnId}/pdf`)).rawPayload);
    expect(text).toContain(inv.number!);
    expect(text).toMatch(/-\s?300,00/);
    expect(text).toContain("déduire du solde restant dû");
    const settings = await prisma.companySettings.findFirstOrThrow();
    if (settings.vatMention) expect(text).toContain(settings.vatMention.slice(0, 20));
  });
});

describe("remboursement : facture payée puis avoir remboursé", () => {
  it("facture 1 000 payée, avoir 300 par virement : encaissé net 700, recette négative au livre", async () => {
    const inv = await issuedInvoice();
    expect((await pay(inv.id, 1_000)).statusCode).toBe(201);
    expect((await detail(inv.id)).status).toBe("PAID");

    expect((await credit(inv.id, 300, "DEDUCT_FROM_BALANCE")).statusCode).toBe(400);
    expect((await credit(inv.id, 300, "BANK_TRANSFER")).statusCode).toBe(201);
    const d = await detail(inv.id);
    expect(d.status).toBe("PAID");
    expect(d.balance).toEqual({ creditedCents: 30_000, netCents: 70_000, refundedCents: 30_000, cashInCents: 70_000, dueCents: 0, overpaidCents: 0 });
    const book = await receipts();
    expect(book.totalCents).toBe(70_000);
    expect(book.rows).toHaveLength(2);
    expect((await summary()).amounts).toMatchObject({ toCollectCents: 0, cashInCents: 70_000, invoicedNetCents: 70_000 });
  });
});

describe("plafonds et mode de l'avoir", () => {
  it("impayée : déduction au plus du reste dû, rien à rembourser ; avoir total : Annulée", async () => {
    const inv = await issuedInvoice();
    const over = await credit(inv.id, 1_200, "DEDUCT_FROM_BALANCE");
    expect(over.statusCode).toBe(400);
    const refund = await credit(inv.id, 300, "BANK_TRANSFER");
    expect(refund.statusCode).toBe(400);
    expect((refund.json() as { error: string }).error).toContain("rien à rembourser");
    expect((await credit(inv.id, 1_000, "DEDUCT_FROM_BALANCE")).statusCode).toBe(201);
    expect((await detail(inv.id)).status).toBe("CANCELLED");
    expect((await receipts()).totalCents).toBe(0);
  });

  it("partiellement payée : avoir 800 sur 1 000 payés 400 : 600 déduits, 200 remboursés", async () => {
    const inv = await issuedInvoice();
    await pay(inv.id, 400);
    const cn = await credit(inv.id, 800, "BANK_TRANSFER");
    expect(cn.statusCode).toBe(201);
    expect((cn.json() as { notes: string }).notes).toContain("Déduit du solde restant dû : 600,00");
    const d = await detail(inv.id);
    expect(d.status).toBe("PAID");
    expect(d.balance).toMatchObject({ netCents: 20_000, refundedCents: 20_000, cashInCents: 20_000, dueCents: 0 });
    expect((await receipts()).totalCents).toBe(20_000);
  });

  it("échéance prélevée par Stripe et impayée : avoir refusé (Stripe prélèverait le montant initial)", async () => {
    const inv = await issuedInvoice({ stripeInvoiceId: "in_test_avoir" });
    const elig = await assessCreditNoteEligibility(inv.id);
    expect(elig.allowed).toBe(false);
    expect(elig.message).toContain("Stripe");
  });

  it("relances : une facture soldée par avoir et paiement n'est plus « Émise »", async () => {
    const inv = await issuedInvoice({ nextReminderAt: new Date(2026, 0, 1) });
    await credit(inv.id, 300, "DEDUCT_FROM_BALANCE");
    await pay(inv.id, 700);
    const { listPendingReminders } = await import("@/lib/reminders.js");
    expect((await listPendingReminders(new Date(2026, 11, 1))).map((i) => i.id)).not.toContain(inv.id);
  });
});

describe("revue : trop-perçu, remboursement, concurrence, jalon, liens", () => {
  it("paiement en ligne reçu après un avoir : enregistré en entier, trop-perçu remboursable une fois", async () => {
    const inv = await issuedInvoice();
    await credit(inv.id, 300, "DEDUCT_FROM_BALANCE");
    const { markPaidFromOnlinePayment } = await import("@/lib/stripe/mark-paid.js");
    await markPaidFromOnlinePayment({ amountCents: 100_000, method: "BANK_TRANSFER", paymentIntentId: "pi_trop_percu", invoiceId: inv.id });
    let d = (await call("GET", `/api/invoices/${inv.id}`)).json() as { status: string; balance: Record<string, number> };
    expect(d.status).toBe("PAID");
    expect(d.balance).toMatchObject({ cashInCents: 100_000, netCents: 70_000, dueCents: 0, overpaidCents: 30_000 });
    expect((await receipts()).totalCents).toBe(100_000);

    expect((await call("POST", `/api/invoices/${inv.id}/refund`, { amountEuros: 400 })).statusCode).toBe(400);
    expect((await call("POST", `/api/invoices/${inv.id}/refund`, { amountEuros: 300, paidAt: "2026-10-20" })).statusCode).toBe(201);
    d = (await call("GET", `/api/invoices/${inv.id}`)).json() as typeof d;
    expect(d.balance).toMatchObject({ cashInCents: 70_000, overpaidCents: 0 });
    expect((await receipts()).totalCents).toBe(70_000);
    expect((await call("POST", `/api/invoices/${inv.id}/refund`, { amountEuros: 1 })).statusCode).toBe(400);
  });

  it("avoir en mode « Autre » sur facture payée : le remboursement s'enregistre ensuite depuis la facture", async () => {
    const inv = await issuedInvoice();
    await pay(inv.id, 1_000);
    expect((await credit(inv.id, 300, "OTHER")).statusCode).toBe(201);
    expect((await detail(inv.id)).balance).toMatchObject({ cashInCents: 100_000, overpaidCents: 30_000 });
    expect((await call("POST", `/api/invoices/${inv.id}/refund`, { amountEuros: 300 })).statusCode).toBe(201);
    expect((await receipts()).totalCents).toBe(70_000);
  });

  it("deux avoirs simultanés de 600 sur 1 000 impayés : un seul passe, le net ne devient jamais négatif", async () => {
    const inv = await issuedInvoice();
    const [a, b] = await Promise.all([credit(inv.id, 600, "DEDUCT_FROM_BALANCE"), credit(inv.id, 600, "DEDUCT_FROM_BALANCE")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 400]);
    expect((await detail(inv.id)).balance).toMatchObject({ creditedCents: 60_000, netCents: 40_000 });
  });

  it("avoir et paiement simultanés : jamais de trop-perçu caché ni de statut faux", async () => {
    const inv = await issuedInvoice();
    const [c, p] = await Promise.all([credit(inv.id, 300, "DEDUCT_FROM_BALANCE"), pay(inv.id, 1_000)]);
    // Avoir d'abord : le paiement de 1 000 dépasse le reste dû (700), refusé. Paiement d'abord : plus rien à déduire,
    // l'avoir en déduction est refusé. Jamais les deux.
    expect([c.statusCode, p.statusCode].sort()).toEqual([201, 400]);
    const d = await detail(inv.id);
    expect(d.status).toBe(d.balance.dueCents > 0 ? "ISSUED" : "PAID");
    expect(d.balance.overpaidCents).toBe(0);
  });

  it("facture d'acompte annulée par un avoir : le jalon est annulé et son lien retiré", async () => {
    const quote = await prisma.invoice.create({ data: { clientId, documentType: "QUOTE", status: "ISSUED", quoteStatus: "ACCEPTED", number: "D-2026-0100", subtotalCents: 100_000, totalCents: 100_000 } });
    const m = await prisma.paymentMilestone.create({ data: { quoteId: quote.id, label: "Acompte", percentBps: 3000, amountCents: 30_000, triggerText: "À la signature", status: "DUE", position: 1, checkoutUrl: "https://exemple.test/lien" } as never });
    const inv = await issuedInvoice({ totalCents: 30_000, subtotalCents: 30_000, invoiceType: "ACOMPTE", milestoneId: m.id, quoteId: quote.id });
    expect((await credit(inv.id, 300, "DEDUCT_FROM_BALANCE")).statusCode).toBe(201);
    expect((await detail(inv.id)).status).toBe("CANCELLED");
    const after = await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: m.id } });
    expect(after).toMatchObject({ status: "CANCELLED", checkoutUrl: null });
  });

  it("page de paiement et lien collé à la main : le reste dû, plus l'ancien montant", async () => {
    const inv = await issuedInvoice({ checkoutUrl: "https://revolut.me/lien-fixe-1000" });
    await credit(inv.id, 300, "DEDUCT_FROM_BALANCE");
    const { payPageInfo } = await import("@/lib/stripe/pay-page.js");
    expect((await payPageInfo("invoice", inv.id))?.detail).toContain("700,00");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).checkoutUrl).toBeNull();
  });
});

describe("espace client /suivi : champs ajoutés, aucun changé", () => {
  it("facture 1 000, avoir 300, paiement 700 : dueCents 0 et encaissé net ; remainingCents et totalPaidCents inchangés", async () => {
    await prisma.companySettings.updateMany({ data: { publicTrackingShowAmounts: true } });
    (await import("@/lib/company.js")).invalidateCompanySettingsCache();
    const inv = await issuedInvoice();
    await credit(inv.id, 300, "DEDUCT_FROM_BALANCE");
    await pay(inv.id, 700);
    const { openPortalSession, PORTAL_COOKIE } = await import("@/lib/portal/auth.js");
    const { token } = await openPortalSession({ clientId, deviceId: "appareil-avoir", ipAddress: "203.0.113.9", userAgent: "Test" });
    const res = await app.inject({ method: "GET", url: "/api/public/tracking", headers: { cookie: `${PORTAL_COOKIE}=${token}` }, remoteAddress: "10.8.0.1" });
    expect(res.statusCode, res.body).toBe(200);
    const t = res.json() as { documents: Array<Record<string, unknown>>; paymentHistory: Record<string, unknown> };
    const doc = t.documents.find((d) => d.number === inv.number)!;
    // Champs existants : valeurs d'avant (total - règlements, sans les avoirs).
    expect(doc).toMatchObject({ totalCents: 100_000, paidCents: 70_000, remainingCents: 30_000 });
    // Ajouts : solde avoirs compris.
    expect(doc).toMatchObject({ creditedCents: 30_000, netCents: 70_000, refundedCents: 0, cashInCents: 70_000, dueCents: 0 });
    const avoir = t.documents.find((d) => d.documentType === "CREDIT_NOTE")!;
    expect(avoir.dueCents).toBeUndefined();
    expect(t.paymentHistory).toMatchObject({ totalCreditedCents: 30_000, totalRefundedCents: 0, totalCashInCents: 70_000 });
    expect(t.paymentHistory.totalPaidCents).toBe(100_000);
    // Reste à régler avoirs compris : facture soldée par l'avoir et le paiement, donc 0.
    expect(t.paymentHistory.totalNetDueCents).toBe(0);

    // Montants masqués par le réglage : aucun des nouveaux champs.
    await prisma.companySettings.updateMany({ data: { publicTrackingShowAmounts: false } });
    (await import("@/lib/company.js")).invalidateCompanySettingsCache();
    const hidden = (await app.inject({ method: "GET", url: "/api/public/tracking", headers: { cookie: `${PORTAL_COOKIE}=${token}` }, remoteAddress: "10.8.0.2" })).json() as typeof t;
    expect(hidden.documents.find((d) => d.number === inv.number)!.dueCents).toBeUndefined();
    expect(hidden.paymentHistory.totalCashInCents).toBeUndefined();
    expect(hidden.paymentHistory.totalNetDueCents).toBeUndefined();

    // Seconde facture de 1 000, avoir de 300 sans paiement : reste à régler 700 (totalDueCents l'ignore).
    await prisma.companySettings.updateMany({ data: { publicTrackingShowAmounts: true } });
    (await import("@/lib/company.js")).invalidateCompanySettingsCache();
    const second = await issuedInvoice();
    await credit(second.id, 300, "DEDUCT_FROM_BALANCE");
    const again = (await app.inject({ method: "GET", url: "/api/public/tracking", headers: { cookie: `${PORTAL_COOKIE}=${token}` }, remoteAddress: "10.8.0.3" })).json() as typeof t;
    expect(again.paymentHistory.totalNetDueCents).toBe(70_000);
  });
});

describe("remise en cohérence des statuts au démarrage", () => {
  it("facture réglée après un avoir mais restée « Émise » (ancienne règle) : passe Payée, une seule fois", async () => {
    const inv = await issuedInvoice();
    await prisma.invoice.create({
      data: { clientId, documentType: "CREDIT_NOTE", status: "ISSUED", number: "A-2026-0001", creditedInvoiceId: inv.id, subtotalCents: -30_000, totalCents: -30_000 },
    });
    await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 70_000, paidAt: new Date(2026, 9, 5) } });
    expect(await reconcileCreditedInvoiceStatuses()).toEqual([inv.number]);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
    expect(await reconcileCreditedInvoiceStatuses()).toEqual([]);
  });

  it("jamais de retour à « Émise » : une facture Payée non couverte (donnée ancienne) reste Payée", async () => {
    const inv = await issuedInvoice({ status: "PAID" });
    await prisma.invoice.create({
      data: { clientId, documentType: "CREDIT_NOTE", status: "ISSUED", number: "A-2026-0009", creditedInvoiceId: inv.id, subtotalCents: -10_000, totalCents: -10_000 },
    });
    expect(await reconcileCreditedInvoiceStatuses()).toEqual([]);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
  });
});
