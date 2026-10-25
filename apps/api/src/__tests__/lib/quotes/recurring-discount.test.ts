import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { ensureDefaultLegalClauses } from "@/lib/company/legal-clauses.js";
import { discountSentence, resolveRecurringDiscount, recurringDiscountSummary } from "@/lib/quotes/recurring-discount.js";
import { formatEUR } from "@/lib/money.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

// Remise d'un devis récurrent (R1, 26/10/2026) : règles, calculs, émission, PDF et facturation des échéances.
vi.mock("@/lib/email/send-document-pdf.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/send-document-pdf.js")>()),
  sendDocumentPdf: vi.fn(async () => ({ sent: false })),
}));

const { issueQuote } = await import("@/lib/invoices/transitions.js");
const { renderDocumentPdf } = await import("@/lib/pdf/document-pdf.js");
const { invoiceSubscriptionNow } = await import("@/lib/subscriptions/subscription-service.js");
const { activateSubscriptionsFromDocument } = await import("@/lib/subscriptions/activate-from-document.js");

const sub = (over: Record<string, unknown> = {}) => ({ isSubscription: true, billingInterval: "YEAR", billingDay: 1, commitmentMonths: 36, unitPriceCents: 150000, ...over });

describe("règles de la remise", () => {
  it("devis récurrent seulement ; remise d'ouverture : 36 mois, sans cumul", () => {
    expect(() => resolveRecurringDiscount("ONE_OFF", [], { openingDiscount: true })).toThrow(/paiement récurrent/);
    expect(() => resolveRecurringDiscount("RECURRING", [sub({ commitmentMonths: 24 })], { openingDiscount: true })).toThrow(
      "Remise d'ouverture : seulement avec l'engagement de 36 mois. Choisissez 36 mois, ou retirez la remise d'ouverture.",
    );
    expect(() => resolveRecurringDiscount("RECURRING", [sub()], { openingDiscount: true, recurringDiscount: { kind: "PERCENT", percent: 10 } })).toThrow(/ne se cumulent pas/);
    expect(resolveRecurringDiscount("RECURRING", [sub()], { openingDiscount: true })).toEqual({
      recurringDiscountKind: "PERCENT",
      recurringDiscountValue: 3000,
      recurringDiscountMonths: 12,
      openingDiscount: true,
    });
    expect(resolveRecurringDiscount("ONE_OFF", [], {})).toMatchObject({ recurringDiscountKind: null, openingDiscount: false });
  });

  it("pourcentage, montant et durée bornés", () => {
    const lines = [sub({ billingInterval: "QUARTER", unitPriceCents: 37500 })];
    expect(() => resolveRecurringDiscount("RECURRING", lines, { recurringDiscount: { kind: "PERCENT", percent: 100 } })).toThrow(/pourcentage/);
    expect(() => resolveRecurringDiscount("RECURRING", lines, { recurringDiscount: { kind: "FIXED", euros: 375 } })).toThrow(/inférieur au prix/);
    expect(() => resolveRecurringDiscount("RECURRING", lines, { recurringDiscount: { kind: "PERCENT", percent: 10, months: 4 } })).toThrow(/multiple de 3/);
    expect(() => resolveRecurringDiscount("RECURRING", [sub({ commitmentMonths: 12 })], { recurringDiscount: { kind: "PERCENT", percent: 10, months: 24 } })).toThrow(/engagement/);
    expect(resolveRecurringDiscount("RECURRING", lines, { recurringDiscount: { kind: "FIXED", euros: 50, months: 6 } })).toMatchObject({
      recurringDiscountKind: "FIXED",
      recurringDiscountValue: 5000,
      recurringDiscountMonths: 6,
    });
  });

  it("calculs : 1re échéance, plusieurs échéances, tout l'engagement", () => {
    const opening = { recurringDiscountKind: "PERCENT", recurringDiscountValue: 3000, recurringDiscountMonths: 12, openingDiscount: true };
    expect(recurringDiscountSummary(opening, 150000, "YEAR", 36)).toMatchObject({ periods: 1, discountCentsPerPeriod: 45000, discountedAmountCents: 105000, totalCommitmentCents: 405000 });
    expect(recurringDiscountSummary(opening, 37500, "QUARTER", 36)).toMatchObject({ periods: 4, discountCentsPerPeriod: 11250, totalCommitmentCents: 405000 });
    const whole = { recurringDiscountKind: "FIXED", recurringDiscountValue: 1000, recurringDiscountMonths: null, openingDiscount: false };
    expect(recurringDiscountSummary(whole, 12500, "MONTH", 24)).toMatchObject({ periods: 24, totalCommitmentCents: 24 * 11500 });
    expect(recurringDiscountSummary({ ...whole, recurringDiscountKind: null, recurringDiscountValue: null }, 12500, "MONTH", 24)).toBeNull();
  });

  it("phrase : annuel une échéance, N échéances, toute la durée (même texte partout)", () => {
    const n = (s: string) => s.replace(/[  ]/g, " ");
    const opening = { recurringDiscountKind: "PERCENT", recurringDiscountValue: 3000, recurringDiscountMonths: 12, openingDiscount: true };
    expect(n(discountSentence(recurringDiscountSummary(opening, 150000, "YEAR", 36)!, 150000, "YEAR", formatEUR))).toBe("Remise d’ouverture : 30 % sur la 1re échéance, soit 1 050,00 € la 1re année, puis 1 500,00 € par an.");
    expect(n(discountSentence(recurringDiscountSummary(opening, 37500, "QUARTER", 36)!, 37500, "QUARTER", formatEUR))).toBe("Remise d’ouverture : 30 % sur les 4 premières échéances, soit 262,50 € par trimestre pendant 12 mois, puis 375,00 € par trimestre.");
    const whole = { recurringDiscountKind: "FIXED", recurringDiscountValue: 1000, recurringDiscountMonths: null, openingDiscount: false };
    expect(n(discountSentence(recurringDiscountSummary(whole, 12500, "MONTH", 24)!, 12500, "MONTH", formatEUR))).toBe("Remise : 10,00 € par échéance sur toute la durée de l’engagement, soit 115,00 € par mois.");
  });
});

describe("devis récurrent remisé : émission, PDF, abonnement et factures", () => {
  beforeEach(async () => {
    await resetDb();
    await seedCompanySettings();
    await ensureDefaultLegalClauses();
    invalidateCompanySettingsCache();
  });

  async function quote(commitmentMonths: number, discount: Record<string, unknown>) {
    const client = await createClient({ displayName: "Atelier Remise" });
    const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
    return prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE,
        status: InvoiceStatus.DRAFT,
        clientId: client.id,
        subtotalCents: 150000,
        totalCents: 150000,
        billingMode: "RECURRING",
        paymentPlanOffer: "NONE",
        ...discount,
        lines: {
          create: [{ position: 1, description: "Site tout compris", quantity: 1, unitPriceCents: 150000, lineTotalCents: 150000, isSubscription: true, billingInterval: "YEAR", billingDay: 1, commitmentMonths, serviceId: svc.id }],
        },
      },
    });
  }
  const opening = { recurringDiscountKind: "PERCENT", recurringDiscountValue: 3000, recurringDiscountMonths: 12, openingDiscount: true };

  it("émission refusée : remise d'ouverture enregistrée sans engagement de 36 mois", async () => {
    const q = await quote(24, opening);
    await expect(issueQuote(q.id)).rejects.toThrow(/seulement avec l'engagement de 36 mois/);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).number).toBeNull();
  });

  it("PDF : ligne de remise, prix remisé puis tarif plein, mention de la remise d'ouverture, total sur la durée", async () => {
    const q = await quote(36, opening);
    await issueQuote(q.id);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array((await renderDocumentPdf(q.id))!), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
    const parts: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) for (const it of (await (await doc.getPage(p)).getTextContent()).items as Array<{ str?: string }>) if (it.str) parts.push(it.str);
    const text = parts.join(" ").replace(/[  ]/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Remise d’ouverture : 30 % sur les 12 premiers mois - 450,00 €");
    expect(text).toContain("Remise d’ouverture : 30 % sur la 1re échéance, soit 1 050,00 € la 1re année, puis 1 500,00 € par an.");
    expect(text).toContain("Remise d’ouverture : structure créée il y a moins de 12 mois.");
    expect(text).toContain("Total sur la durée de l'engagement : 4 050,00 € (3 échéances).");
  });

  it("signé : l'abonnement reçoit la remise ; 1re facture remisée, la suivante au tarif plein", async () => {
    const q = await quote(36, opening);
    await issueQuote(q.id);
    const { createdIds } = await activateSubscriptionsFromDocument(q.id, prisma, { startDate: new Date(2026, 9, 1), firstPeriodNow: true });
    const id = createdIds[0]!;
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id } })).toMatchObject({ discountKind: "PERCENT", discountValue: 3000, discountPeriods: 1, discountPeriodsBilled: 0 });

    const due = async () => {
      const s = await prisma.subscription.findUniqueOrThrow({ where: { id } });
      expect(await invoiceSubscriptionNow(id, new Date(s.nextInvoiceAt.getTime() + 1000))).toBe(true);
      return prisma.invoice.findFirstOrThrow({ where: { subscriptionId: id }, orderBy: { createdAt: "desc" }, include: { lines: { orderBy: { position: "asc" } } } });
    };
    const first = await due();
    expect(first.totalCents).toBe(105000);
    expect(first.lines.map((l) => [l.description.includes("Remise") ? l.description : "abonnement", l.lineTotalCents])).toEqual([
      ["abonnement", 150000],
      ["Remise de 30 % (échéance 1 sur 1)", -45000],
    ]);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id } })).discountPeriodsBilled).toBe(1);
    const second = await due();
    expect(second.totalCents).toBe(150000);
    expect(second.lines).toHaveLength(1);
  });
});
