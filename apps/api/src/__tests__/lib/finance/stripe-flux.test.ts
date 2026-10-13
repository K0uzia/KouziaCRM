import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getStripeFlux } from "@/lib/finance/stripe-flux.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await prisma.stripePayout.deleteMany();
  await seedCompanySettings();
});
afterEach(async () => {
  await prisma.stripePayout.deleteMany();
  await resetDb();
});

const NOW = new Date(2026, 9, 28, 12);

async function payment(opts: { at: Date; cents: number; stripe?: string; fee?: number | null; payoutId?: string; refunded?: number }) {
  const client = await createClient();
  const invoice = await prisma.invoice.create({
    data: { documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.PAID, clientId: client.id, issueDate: opts.at, subtotalCents: opts.cents, totalCents: opts.cents },
  });
  return prisma.payment.create({
    data: {
      invoiceId: invoice.id,
      amountCents: opts.cents,
      paidAt: opts.at,
      method: opts.stripe ? PaymentMethod.CARD : PaymentMethod.BANK_TRANSFER,
      stripePaymentIntentId: opts.stripe ?? null,
      feeCents: opts.fee === undefined ? null : opts.fee,
      stripePayoutId: opts.payoutId ?? null,
      refundedCents: opts.refunded ?? 0,
    },
  });
}

describe("flux Stripe", () => {
  it("rapprochement du mois : encaissé = frais + versé + en attente + retenues ; virements à part ; CA du tableau de bord", async () => {
    const po = await prisma.stripePayout.create({
      data: { stripePayoutId: "po_1", amountCents: 144426, status: "paid", arrivalDate: new Date(2026, 9, 12), deductionsCents: 0 },
    });
    await payment({ at: new Date(2026, 9, 2), cents: 99000, stripe: "pi_1", fee: 1510, payoutId: po.id });
    await payment({ at: new Date(2026, 9, 5), cents: 47700, stripe: "pi_2", fee: 764, payoutId: po.id });
    await payment({ at: new Date(2026, 9, 20), cents: 38200, stripe: "pi_3", fee: 598 });
    await payment({ at: new Date(2026, 9, 9), cents: 69000 });

    const flux = await getStripeFlux("2026-10", NOW);
    const m = flux.month;
    expect(m).toMatchObject({ encaisseStripeCents: 184900, directCents: 69000, caCents: 253900, feeCents: 2872, unknownFeeCount: 0, gapCents: 0 });
    expect(m.encaisseStripeCents - m.feeCents - m.verseCents - m.pendingCents - m.refundsDisputesCents).toBe(0);
    expect(m.verseCents).toBe(144426);
    expect(flux.payouts).toHaveLength(1);
    expect(flux.payouts[0]).toMatchObject({ grossCents: 146700, feeCents: 2274, expectedCents: 144426, gapCents: 0 });
  });

  it("versement qui ne correspond pas : écart signalé, jamais masqué ; retenue expliquée par un remboursement", async () => {
    const ok = await prisma.stripePayout.create({
      data: { stripePayoutId: "po_ok", amountCents: 40000, status: "paid", arrivalDate: new Date(2026, 9, 20), deductionsCents: 8000 },
    });
    await payment({ at: new Date(2026, 9, 10), cents: 49000, stripe: "pi_a", fee: 1000, payoutId: ok.id, refunded: 8000 });
    const ko = await prisma.stripePayout.create({
      data: { stripePayoutId: "po_ko", amountCents: 10000, status: "paid", arrivalDate: new Date(2026, 9, 22), deductionsCents: 0 },
    });
    // Frais inconnus : l'attendu (brut) dépasse le viré, l'écart apparaît.
    await payment({ at: new Date(2026, 9, 15), cents: 10300, stripe: "pi_b", fee: null, payoutId: ko.id });
    const flux = await getStripeFlux("2026-10", NOW);
    const byId = Object.fromEntries(flux.payouts.map((p) => [p.stripePayoutId, p]));
    expect(byId.po_ok).toMatchObject({ expectedCents: 40000, gapCents: 0, deductionsCents: 8000 });
    expect(byId.po_ko).toMatchObject({ expectedCents: 10300, gapCents: -300 });
    expect(flux.month).toMatchObject({ gapCents: -300, unknownFeeCount: 1, refundsDisputesCents: 8000 });
  });

  it("versement en route : pas d'écart calculé avant son arrivée ; liste des mois jusqu'au mois courant", async () => {
    await prisma.stripePayout.create({ data: { stripePayoutId: "po_t", amountCents: 5000, status: "in_transit", arrivalDate: new Date(2026, 9, 30) } });
    await payment({ at: new Date(2026, 7, 3), cents: 5000, stripe: "pi_c", fee: 100 });
    const flux = await getStripeFlux(undefined, NOW);
    expect(flux.months).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(flux.month.key).toBe("2026-10");
    expect(flux.payouts[0]!.gapCents).toBeNull();
    expect(flux.series.map((s) => s.key)).toEqual(["2026-08", "2026-09", "2026-10"]);
  });
});
