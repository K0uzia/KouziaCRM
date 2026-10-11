import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, MilestoneStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { acceptQuoteByClient, issueQuote } from "@/lib/invoices/transitions.js";
import { computeMilestoneAmounts } from "@/lib/quotes/milestones.js";
import { PaymentPlanError, planTemplate } from "@/lib/quotes/payment-plans.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  invalidateCompanySettingsCache();
});

afterEach(async () => {
  await resetDb();
});

async function draftQuote(totalCents: number, offer: string | null) {
  const client = await createClient({ displayName: "Association Les Amis" });
  const quote = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.DRAFT,
      clientId: client.id,
      subtotalCents: totalCents,
      totalCents,
      paymentPlanOffer: offer,
      lines: {
        create: [{ position: 1, description: "Site association", quantity: 1, unitPriceCents: totalCents, lineTotalCents: totalCents }],
      },
    },
  });
  return quote.id;
}

const milestonesOf = (quoteId: string) =>
  prisma.paymentMilestone.findMany({ where: { quoteId }, orderBy: { position: "asc" } });

describe("formules de paiement", () => {
  it("3 fois 30/40/30 sur un montant impair : somme exacte, reste sur le solde", async () => {
    const settings = await prisma.companySettings.findFirstOrThrow();
    const amounts = computeMilestoneAmounts(149_001, planTemplate("THREE", settings));
    expect(amounts.map((m) => m.amountCents)).toEqual([44_700, 59_600, 44_701]);
    expect(amounts.reduce((s, m) => s + m.amountCents, 0)).toBe(149_001);
  });

  it("seuil du 3 fois à l'émission : 499,99 € retombe sur 2 fois, 500 € garde le choix", async () => {
    const sous = await draftQuote(49_999, "CHOICE");
    const pile = await draftQuote(50_000, "CHOICE");
    await issueQuote(sous);
    await issueQuote(pile);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: sous } })).paymentPlanOffer).toBe("TWO");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: pile } })).paymentPlanOffer).toBe("CHOICE");
    expect(await milestonesOf(pile)).toHaveLength(2);
  });

  it("choix du 3 fois à la signature : jalons remplacés, formule tracée dans l'audit", async () => {
    const id = await draftQuote(149_000, "CHOICE");
    await issueQuote(id);
    await acceptQuoteByClient(id, "Camille Dupont", { paymentPlan: "THREE" });

    const ms = await milestonesOf(id);
    expect(ms.map((m) => m.percentBps)).toEqual([3000, 4000, 3000]);
    expect(ms[1]!.triggerText).toBe("À la validation de l'étape définie dans le suivi de projet");
    expect(ms[1]!.dueDate).toBeNull();
    expect(ms[0]!.status).toBe(MilestoneStatus.DUE);

    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(quote.paymentPlan).toBe("THREE");
    const audit = await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId: id } });
    expect(audit.paymentPlan).toBe("THREE");
  });

  it("offre au choix depuis l'espace client : sans formule, signature refusée et devis inchangé", async () => {
    const id = await draftQuote(149_000, "CHOICE");
    await issueQuote(id);
    await expect(acceptQuoteByClient(id, "Camille Dupont")).rejects.toBeInstanceOf(PaymentPlanError);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).quoteStatus).toBe("SENT");
  });

  it("acceptation par l'admin sans formule : 2 fois par défaut", async () => {
    const id = await draftQuote(149_000, "CHOICE");
    await issueQuote(id);
    await acceptQuoteByClient(id, "Camille Dupont", { source: "ADMIN" });
    expect((await milestonesOf(id)).map((m) => m.percentBps)).toEqual([3000, 7000]);
  });

  it("formule non proposée refusée", async () => {
    const id = await draftQuote(149_000, "TWO");
    await issueQuote(id);
    await expect(acceptQuoteByClient(id, "Camille Dupont", { paymentPlan: "THREE" })).rejects.toBeInstanceOf(
      PaymentPlanError,
    );
  });

  it("devis historique (sans offre) : échéancier inchangé, rien d'enregistré", async () => {
    const id = await draftQuote(149_000, null);
    await issueQuote(id);
    await acceptQuoteByClient(id, "Camille Dupont");
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(quote.paymentPlanOffer).toBeNull();
    expect(quote.paymentPlan).toBeNull();
    expect((await milestonesOf(id)).map((m) => m.percentBps)).toEqual([3000, 7000]);
  });
});
