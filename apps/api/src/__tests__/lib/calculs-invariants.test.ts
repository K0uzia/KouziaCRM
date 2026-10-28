import { describe, expect, it } from "vitest";
import { computeDepositBaseCents, computeDiscountCents, computeLineTotals, type LineInput } from "@/lib/invoices/totals.js";
import { describePlans, milestoneAmounts, planTemplate, type PlanSettings } from "@/lib/quotes/payment-plans.js";
import { discountCentsPerPeriod, recurringDiscountSummary } from "@/lib/quotes/recurring-discount-calc.js";
import { periodAmountCents } from "@/lib/quotes/billing-mode.js";
import { creditNoteCaps, invoiceBalance } from "@/lib/invoices/balance.js";
import { creditNoteSplit } from "@/lib/invoices/credit-note-service.js";
import { lineTotalCents } from "@/lib/money.js";

/**
 * Invariants des calculs d'argent (audit du 28/10/2026) : échéanciers, totaux, remises, avoirs, montants partagés avec
 * l'ERP web. Générateur pseudo-aléatoire déterministe : mêmes cas à chaque passage.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const int = (r: () => number, min: number, max: number) => min + Math.floor(r() * (max - min + 1));

const SETTINGS: PlanSettings = {
  depositPercent1Bps: 3000,
  depositPercent2Bps: 7000,
  split3Percent1Bps: 3000,
  split3Percent2Bps: 4000,
  split3Percent3Bps: 3000,
  split3MinTotalCents: 150000,
  split3Step2TriggerText: "À la validation de la maquette",
  installmentIntervalDays: 30,
};

describe("invariants des échéanciers", () => {
  it("somme des échéances = base, chaque échéance >= 0 (pourcentages et parts égales, 2 000 cas)", () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      const total = int(r, 0, 5_000_000);
      for (const plan of ["ONE", "TWO", "THREE"] as const) {
        for (const mode of [null, "ONE_OFF"] as const) {
          const amounts = milestoneAmounts(total, planTemplate(plan, SETTINGS, mode), mode);
          expect(amounts.reduce((s, m) => s + m.amountCents, 0)).toBe(total);
          for (const m of amounts) expect(m.amountCents).toBeGreaterThanOrEqual(0);
          expect(amounts.reduce((s, m) => s + m.percentBps, 0)).toBe(10000);
        }
      }
    }
  });

  it("acompte <= base : la 1re échéance ne dépasse jamais la base", () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const total = int(r, 1, 5_000_000);
      for (const plan of ["TWO", "THREE"] as const) {
        const [first] = milestoneAmounts(total, planTemplate(plan, SETTINGS, null), null);
        expect(first!.amountCents).toBeLessThanOrEqual(total);
      }
    }
  });

  it("parts égales : parts au centime inférieur, la dernière porte le reste et n'est jamais la plus petite", () => {
    // 2 000 € en 3 fois : 666,66 + 666,66 + 666,68 ; le PDF imprime 33,33 %, 33,33 %, 33,34 %.
    const amounts = milestoneAmounts(200000, planTemplate("THREE", SETTINGS, "ONE_OFF"), "ONE_OFF");
    expect(amounts.map((m) => m.percentBps)).toEqual([3333, 3333, 3334]);
    expect(amounts[2]!.amountCents).toBeGreaterThanOrEqual(amounts[0]!.amountCents);
  });

  it("describePlans (PDF, espace client) et applyPlanMilestones (jalons enregistrés) : mêmes montants", () => {
    const r = rng(3);
    for (let i = 0; i < 500; i++) {
      const total = int(r, 1, 3_000_000);
      for (const mode of [null, "ONE_OFF"] as const) {
        const shown = describePlans("CHOICE", total, SETTINGS, mode);
        for (const p of shown) {
          const stored = milestoneAmounts(total, planTemplate(p.plan, SETTINGS, mode), mode);
          expect(p.milestones.map((m) => m.amountCents)).toEqual(stored.map((m) => m.amountCents));
        }
      }
    }
  });
});

const line = (over: Partial<LineInput>): LineInput => ({ description: "Ligne", quantity: 1, unitPriceCents: 10000, ...over });

describe("invariants des totaux de document", () => {
  it("total >= 0, remise <= partie ponctuelle, base d'acompte <= total, total = sous-total - remise (3 000 cas)", () => {
    const r = rng(11);
    for (let i = 0; i < 3000; i++) {
      const n = int(r, 1, 6);
      const lines: LineInput[] = [];
      for (let k = 0; k < n; k++) {
        const kind = int(r, 0, 3);
        if (kind === 0) lines.push(line({ quantity: int(r, 1, 40) / (r() < 0.3 ? 4 : 1), unitPriceCents: int(r, 1, 500000) }));
        if (kind === 1) lines.push(line({ isSubscription: true, billingDay: 1, serviceId: "s", billingInterval: ["MONTH", "QUARTER", "YEAR"][int(r, 0, 2)], unitPriceCents: int(r, 100, 300000), subscriptionStart: ["SIGNATURE", "DELIVERY", "DATE", "FREE_MONTHS"][int(r, 0, 3)], subscriptionStartDate: "2027-01-01", subscriptionFreeMonths: 2 }));
        if (kind === 2) lines.push(line({ isSubscription: true, billingDay: 1, serviceId: "s", billingInterval: "YEAR", unitPriceCents: int(r, 100, 300000), isOptional: true, optionalAccepted: [null, true, false][int(r, 0, 2)] as boolean | null, commitmentMonths: 12 }));
        if (kind === 3) lines.push(line({ unitPriceCents: int(r, 1000, 900000) }));
      }
      // Remise pack : jamais plus que les lignes ponctuelles du pack (packs.ts:390).
      const oneOff = lines.filter((l) => !l.isSubscription).reduce((s, l) => s + lineTotalCents(l.quantity, l.unitPriceCents), 0);
      if (oneOff > 0 && r() < 0.4) lines.push(line({ isPackDiscount: true, unitPriceCents: -int(r, 0, oneOff) }));
      const discount = r() < 0.5 ? { discountType: "PERCENT", discountValue: int(r, 0, 10000) } : { discountType: "FIXED", discountValue: int(r, 0, 2_000_000) };
      const t = computeLineTotals(lines, discount);
      expect(t.totalCents).toBeGreaterThanOrEqual(0);
      expect(t.totalCents).toBe(t.subtotalCents - t.discountCents);
      const oneOffNet = t.lines.filter((l) => !l.isSubscription).reduce((s, l) => s + l.lineTotalCents, 0);
      expect(t.discountCents).toBeLessThanOrEqual(Math.max(0, oneOffNet));
      const base = computeDepositBaseCents(t.lines, t.subtotalCents, t.totalCents);
      expect(base).toBeGreaterThanOrEqual(0);
      expect(base).toBeLessThanOrEqual(t.totalCents);
    }
  });

  it("remise en % : arrondi au centime le plus proche, demi-centime vers le haut", () => {
    expect(computeDiscountCents(12345, { discountType: "PERCENT", discountValue: 1000 })).toBe(1235); // 1 234,5 -> 1 235
    expect(computeDiscountCents(12344, { discountType: "PERCENT", discountValue: 1000 })).toBe(1234);
    expect(lineTotalCents("0.5", 1001)).toBe(501); // 500,5 -> 501
    expect(lineTotalCents("2.5", 333)).toBe(833); // 832,5 -> 833
  });
});

describe("abonnements : montant par période et remise récurrente", () => {
  it("prix annuel ramené à la période : arrondi au centime, écart sur l'année borné à 6 centimes", () => {
    const r = rng(5);
    for (let i = 0; i < 2000; i++) {
      const annual = int(r, 100, 2_000_000);
      expect(periodAmountCents(annual, "YEAR")).toBe(annual);
      expect(Math.abs(periodAmountCents(annual, "MONTH") * 12 - annual)).toBeLessThanOrEqual(6);
      expect(Math.abs(periodAmountCents(annual, "QUARTER") * 4 - annual)).toBeLessThanOrEqual(2);
    }
  });

  it("remise par échéance : jamais plus que l'échéance, jamais négative", () => {
    const r = rng(9);
    for (let i = 0; i < 2000; i++) {
      const amount = int(r, 1, 500000);
      const v = int(r, -100, 20000);
      for (const kind of ["PERCENT", "FIXED"]) {
        const d = discountCentsPerPeriod(kind, v, amount);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(amount);
      }
    }
  });

  it("total sur l'engagement = somme des échéances facturées (remise comprise)", () => {
    for (const [interval, commitment, months] of [["MONTH", 12, 3], ["QUARTER", 24, 6], ["YEAR", 36, 12], ["MONTH", 36, null]] as const) {
      const s = recurringDiscountSummary({ recurringDiscountKind: "PERCENT", recurringDiscountValue: 3000, recurringDiscountMonths: months, openingDiscount: false }, 24167, interval, commitment)!;
      const step = interval === "YEAR" ? 12 : interval === "QUARTER" ? 3 : 1;
      const periods = commitment / step;
      let sum = 0;
      for (let k = 0; k < periods; k++) sum += 24167 - (k < s.periods ? s.discountCentsPerPeriod : 0);
      expect(s.totalCommitmentCents).toBe(sum);
    }
  });
});

describe("avoirs et reste dû", () => {
  it("invariants : reste dû >= 0, net >= 0, plafond d'avoir <= net, partage déduit + remboursé = montant (2 000 cas)", () => {
    const r = rng(13);
    for (let i = 0; i < 2000; i++) {
      const total = int(r, 1, 500000);
      const paid = int(r, 0, total);
      const credited = int(r, 0, total);
      const refund = int(r, 0, Math.min(paid, credited));
      const b = invoiceBalance({ totalCents: total, payments: [{ amountCents: paid }], creditNotes: [{ totalCents: -credited, payments: [{ amountCents: -refund }] }] });
      expect(b.netCents).toBeGreaterThanOrEqual(0);
      expect(b.dueCents).toBeGreaterThanOrEqual(0);
      const caps = creditNoteCaps(b);
      expect(caps.maxCents).toBeLessThanOrEqual(b.netCents);
      const amount = int(r, 1, Math.max(1, caps.maxCents));
      const split = creditNoteSplit(amount, b.dueCents);
      expect(split.deductedCents + split.refundCents).toBe(amount);
      expect(split.deductedCents).toBeLessThanOrEqual(b.dueCents);
    }
  });
});


describe("montants partagés avec l'ERP web (@kouzia-erp/line-amounts)", () => {
  it("total de ligne en arithmétique entière : identique à decimal.js (ROUND_HALF_UP), 20 000 cas", async () => {
    const { Prisma } = await import("@prisma/client");
    const Decimal = Prisma.Decimal;
    const r = rng(17);
    for (let i = 0; i < 20000; i++) {
      const q = [String(int(r, 0, 99)), (r() * 50).toFixed(int(r, 0, 3)), `${-int(r, 0, 9)}.5`, String(r() * 3)][i % 4]!;
      const p = int(r, -500_000, 2_000_000);
      const ref = new Decimal(q).mul(p).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber() + 0;
      expect(lineTotalCents(q, p) + 0, `${q} x ${p}`).toBe(ref);
    }
    // Saisie française de l'éditeur : virgule décimale.
    expect(lineTotalCents("2,5", 3333)).toBe(8333);
  });

  it("remise : nulle sur une base négative, jamais plus que la base", () => {
    expect(computeDiscountCents(-5000, { discountType: "PERCENT", discountValue: 1000 })).toBe(0);
    expect(computeDiscountCents(5000, { discountType: "FIXED", discountValue: 9000 })).toBe(5000);
  });
});

describe("propositions : montant comparable (« dès X »)", () => {
  const option = (billingMode: string | null, totals: ReturnType<typeof computeLineTotals>) => ({
    billingMode,
    subtotalCents: totals.subtotalCents,
    totalCents: totals.totalCents,
    recurringDiscountKind: null,
    recurringDiscountValue: null,
    recurringDiscountMonths: null,
    openingDiscount: false,
  });

  it("projet ponctuel : sa partie ponctuelle ; abonnement : le total sur l'engagement, jamais une mensualité", async () => {
    const { proposalComparableCents, sameModeProposals } = await import("@/lib/quotes/quote-options.js");
    const a = computeLineTotals([line({ description: "Site vitrine", unitPriceCents: 165000 })]);
    const b = computeLineTotals([
      line({ isSubscription: true, billingDay: 1, serviceId: "s", billingInterval: "MONTH", unitPriceCents: 9900, commitmentMonths: 12, subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 2 }),
    ]);
    expect(b.totalCents).toBe(0); // 1re mensualité repoussée : ce qu'on ne doit pas comparer
    expect(proposalComparableCents(option("ONE_OFF", a), a.lines)).toBe(165000);
    expect(proposalComparableCents(option("RECURRING", b), b.lines)).toBe(12 * 9900);
    expect(sameModeProposals([{ billingMode: "ONE_OFF" }, { billingMode: "RECURRING" }])).toBe(false);
    expect(sameModeProposals([{ billingMode: "ONE_OFF" }, { billingMode: "ONE_OFF" }])).toBe(true);
  });

  it("abonnement remisé : total sur l'engagement remise comprise", async () => {
    const { proposalComparableCents } = await import("@/lib/quotes/quote-options.js");
    const t = computeLineTotals([line({ isSubscription: true, billingDay: 1, serviceId: "s", billingInterval: "MONTH", unitPriceCents: 10000, commitmentMonths: 12 })]);
    const discounted = { ...option("RECURRING", t), recurringDiscountKind: "PERCENT", recurringDiscountValue: 2000, recurringDiscountMonths: 3 };
    expect(proposalComparableCents(discounted, t.lines)).toBe(12 * 10000 - 3 * 2000);
  });
});

describe("pourcentages, prix annuel et offre à l'émission", () => {
  it("pourcentage à deux décimales au plus", async () => {
    const { formatPercentBps } = await import("@/lib/format-fr.js");
    expect(formatPercentBps(3333)).toBe("33,33\u00a0%");
    expect(formatPercentBps(5000)).toBe("50\u00a0%");
    expect(formatPercentBps(3050)).toBe("30,5\u00a0%");
  });

  it("prix annuel d'un abonnement mensuel : celui du catalogue, sinon 12 mois moins les mois offerts", async () => {
    const { annualPriceOfService } = await import("@/lib/services/annual-price.js");
    expect(annualPriceOfService({ unitPriceCents: 2900, billingInterval: "MONTH" }, 2)).toBe(29000);
    expect(annualPriceOfService({ unitPriceCents: 2900, billingInterval: "MONTH", annualPriceCents: 31000 }, 2)).toBe(31000);
    expect(annualPriceOfService({ unitPriceCents: 39000, billingInterval: "YEAR" }, 2)).toBe(39000);
    expect(annualPriceOfService({ unitPriceCents: 9000, billingInterval: "QUARTER" }, 2)).toBe(30000);
  });

  it("offre figée à l'émission : récurrent, abonnement seul ou sans partie ponctuelle = aucun échéancier ; 3 fois sous le seuil = 2 fois", async () => {
    const { offerAtIssue } = await import("@/lib/quotes/payment-plans.js");
    const s = { split3MinTotalCents: 150000 };
    const oneOff = [{ isSubscription: false }];
    const mixed = [{ isSubscription: false }, { isSubscription: true }];
    expect(offerAtIssue("RECURRING", oneOff, 100000, "TWO", s)).toBe("NONE");
    expect(offerAtIssue("ONE_OFF", [{ isSubscription: true }], 0, "TWO", s)).toBe("NONE");
    expect(offerAtIssue("ONE_OFF", mixed, 0, "TWO", s)).toBe("NONE");
    expect(offerAtIssue("ONE_OFF", oneOff, 100000, "THREE", s)).toBe("TWO");
    expect(offerAtIssue("ONE_OFF", oneOff, 200000, "CHOICE", s)).toBe("CHOICE");
  });
});

describe("trésorerie : taux URSSAF de la période de chaque fenêtre", () => {
  it("une fenêtre passée garde le taux de sa période, pas celui du jour du calcul", async () => {
    const { buildCashflowFromEncaisse } = await import("@/lib/finance/cashflow-service.js");
    const { computeSocialChargesForEncaisse } = await import("@/lib/publicodes.js");
    const meta = { scope: "month" as const, periodLabel: "x", periodKey: "x", now: new Date(2026, 9, 28), treasuryRateBps: 0, placementRateBps: 0 };
    for (const start of [new Date(2024, 5, 1), new Date(2025, 11, 1)]) {
      const cf = buildCashflowFromEncaisse(500000, { ...meta, ratePeriodStart: start });
      expect(cf.urssafCents).toBe(computeSocialChargesForEncaisse(500000, start).totalCents);
    }
  });
});
