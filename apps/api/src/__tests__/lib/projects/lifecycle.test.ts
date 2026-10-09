import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MilestoneStatus, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";
import { generateMilestoneInvoice } from "@/lib/invoices/documentFlowService.js";
import { markMilestonePaidManually } from "@/lib/payments/milestonePaymentService.js";
import { issueQuote } from "@/lib/invoices/transitions.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

afterEach(async () => {
  await resetDb();
});

async function acceptedQuote() {
  const client = await createClient();
  const draft = await prisma.invoice.create({
    data: {
      documentType: "QUOTE",
      invoiceType: "SIMPLE",
      status: "DRAFT",
      clientId: client.id,
      subtotalCents: 129000,
      totalCents: 129000,
      quoteStatus: QuoteStatus.DRAFT,
      lines: {
        create: [
          {
            position: 0,
            description: "Site vitrine (jusqu'à 5 pages) : design sur mesure",
            quantity: 1,
            unitPriceCents: 129000,
            lineTotalCents: 129000,
          },
        ],
      },
    },
  });
  await issueQuote(draft.id);
  await prisma.invoice.update({
    where: { id: draft.id },
    data: { quoteStatus: QuoteStatus.ACCEPTED, quoteDecidedAt: new Date() },
  });
  return draft.id;
}

describe("projet né du devis", () => {
  it("devis validé → facture d'acompte crée le projet → acompte payé le démarre", async () => {
    const quoteId = await acceptedQuote();
    const deposit = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId, position: 1 } });

    await generateMilestoneInvoice(deposit.id);
    const planned = await prisma.clientProject.findUniqueOrThrow({ where: { quoteId } });
    expect(planned.name).toBe("Site vitrine (jusqu'à 5 pages)");
    expect(planned.status).toBe("PLANNED");
    const plannedSteps = JSON.parse(planned.steps) as Array<{ label: string; status: string }>;
    expect(plannedSteps.map((s) => s.status)).toEqual(["done", "done", "current", "todo", "todo"]);
    expect(planned.progress).toBe(40);

    await markMilestonePaidManually({ milestoneId: deposit.id, method: "BANK_TRANSFER" });
    const active = await prisma.clientProject.findUniqueOrThrow({ where: { quoteId } });
    expect(active.status).toBe("ACTIVE");
    expect(active.startedAt).not.toBeNull();
    const activeSteps = JSON.parse(active.steps) as Array<{ label: string; status: string }>;
    expect(activeSteps.find((s) => s.label === "Réalisation")?.status).toBe("current");
    expect(active.progress).toBe(60);

    const paid = await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: deposit.id } });
    expect(paid.status).toBe(MilestoneStatus.PAID);
    // Un seul projet par devis.
    expect(await prisma.clientProject.count({ where: { quoteId } })).toBe(1);
  });
});
