import { describe, expect, it } from "vitest";
import { annualPriceOfService } from "@kouzia-erp/annual-price";
import { suggestedAmountCents } from "@/lib/billing-interval";
import { formatPercentBps } from "@/lib/format";
import { equalInstallments } from "@/lib/payment-summary";
import { editorTotalsCents, proposalsAmountText, quoteInvoicedCents, sameModeProposals } from "@/lib/quote-totals";

/** Montants affichés par l'ERP web, comparés à la vérité de l'API (régressions de l'audit du 28/10/2026). */
const line = (quantity: string, unitPriceEuros: string, extra: Partial<{ isSubscription: boolean; isOptional: boolean }> = {}) => ({
  isSubscription: false,
  quantity,
  unitPriceEuros,
  ...extra,
});
const noDiscount = { quote: true, discountType: "NONE", discountPercent: "", discountEuros: "" };

describe("récapitulatif de l'éditeur (DocumentForm) : mêmes centimes que l'API", () => {
  it("2,5 h à 33,33 € : 83,33 € (chaque ligne arrondie au centime, demi-centime vers le haut)", () => {
    expect(editorTotalsCents([line("2.5", "33.33")], noDiscount).totalCents).toBe(8333);
    expect(editorTotalsCents([line("2,5", "33,33")], noDiscount).totalCents).toBe(8333);
  });

  it("deux lignes de 2,5 h à 33,33 € : 166,66 €", () => {
    expect(editorTotalsCents([line("2.5", "33.33"), line("2.5", "33.33")], noDiscount).totalCents).toBe(16666);
  });

  it("remise sur une base négative : aucune remise, le total n'est pas gonflé", () => {
    const t = editorTotalsCents([line("1", "100"), line("1", "-150")], { ...noDiscount, discountType: "PERCENT", discountPercent: "10" });
    expect(t.discountCents).toBe(0);
    expect(t.totalCents).toBe(-5000);
  });

  it("remise en % et fixe, sur la partie ponctuelle seulement", () => {
    const lines = [line("1", "1000"), line("1", "29", { isSubscription: true })];
    expect(editorTotalsCents(lines, { ...noDiscount, discountType: "PERCENT", discountPercent: "10" })).toMatchObject({ subtotalCents: 102900, discountCents: 10000, totalCents: 92900 });
    expect(editorTotalsCents(lines, { ...noDiscount, discountType: "FIXED", discountEuros: "5000" }).discountCents).toBe(100000);
  });
});

describe("devis mixte signé et devis à propositions", () => {
  it("« Facture totale, sans acompte » et « Montant du devis » : le projet facturé (depositBaseCents)", () => {
    // Paiement unique 1 650 € + option annuelle 650 € retenue à la signature : total 2 300 €, facture 1 650 €.
    expect(quoteInvoicedCents({ totalCents: 230000, depositBaseCents: 165000 }, true)).toBe(165000);
    expect(quoteInvoicedCents({ totalCents: 165000, depositBaseCents: 165000 }, false)).toBe(165000);
  });

  it("« dès X » seulement entre propositions du même mode", () => {
    expect(sameModeProposals([{ billingMode: "ONE_OFF" }, { billingMode: "RECURRING" }])).toBe(false);
    expect(proposalsAmountText(2, [{ billingMode: "ONE_OFF" }, { billingMode: "RECURRING" }], 118800)).toBe("2 propositions");
    expect(proposalsAmountText(2, [{ billingMode: "ONE_OFF" }, { billingMode: "ONE_OFF" }], 165000)).toMatch(/^2 propositions, dès 1\s650,00\s€$/);
    expect(proposalsAmountText(2, [{ billingMode: "RECURRING" }, { billingMode: "RECURRING" }], 118800)).toMatch(/sur l'engagement$/);
  });
});

describe("prix annuel, pourcentages et parts égales", () => {
  it("prix annuel d'un abonnement mensuel : même règle partout (changement de périodicité, option de pack)", () => {
    expect(suggestedAmountCents(2900, "MONTH", "YEAR", 2)).toBe(annualPriceOfService({ unitPriceCents: 2900, billingInterval: "MONTH" }, 2));
    expect(suggestedAmountCents(2900, "MONTH", "YEAR", 2)).toBe(29000);
    // Prix annuel du catalogue renseigné : il prime.
    expect(suggestedAmountCents(2900, "MONTH", "YEAR", 2, 31000)).toBe(31000);
  });

  it("pourcentages des échéances à deux décimales (33,33 %)", () => {
    expect([3333, 3333, 3334].map(formatPercentBps)).toEqual(["33,33\u00a0%", "33,33\u00a0%", "33,34\u00a0%"]);
    expect(formatPercentBps(5000)).toBe("50\u00a0%");
  });

  it("parts égales : au centime inférieur, le reste sur la dernière (comme l'API)", () => {
    expect(equalInstallments("THREE", 200000, 30).map((i) => i.amountCents)).toEqual([66666, 66666, 66668]);
  });
});
