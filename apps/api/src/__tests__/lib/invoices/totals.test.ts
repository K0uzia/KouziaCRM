import { describe, it, expect } from "vitest";
import {
  computeLineTotals,
  computeDiscountCents,
  assertSubscriptionLinesValid,
  type LineInput,
} from "@/lib/invoices/totals.js";

describe("computeLineTotals", () => {
  it("calcule le sous-total HT d'un document simple", () => {
    const lines: LineInput[] = [
      { description: "Audit SEO", quantity: 2, unitPriceCents: 50000 },
      { description: "Hébergement", quantity: 1, unitPriceCents: 20000 },
    ];
    const r = computeLineTotals(lines);
    expect(r.subtotalCents).toBe(120000); // 2*500 + 1*200
    expect(r.discountCents).toBe(0);
    expect(r.totalCents).toBe(120000);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].lineTotalCents).toBe(100000);
    expect(r.lines[1].lineTotalCents).toBe(20000);
  });

  it("applique une remise en pourcentage (basis points)", () => {
    const lines: LineInput[] = [
      { description: "Mission", quantity: 1, unitPriceCents: 100000 },
    ];
    const r = computeLineTotals(lines, { discountType: "PERCENT", discountValue: 1000 }); // 10 %
    expect(r.subtotalCents).toBe(100000);
    expect(r.discountCents).toBe(10000);
    expect(r.discountType).toBe("PERCENT");
    expect(r.discountValue).toBe(1000);
    expect(r.totalCents).toBe(90000);
  });

  it("applique une remise fixe en centimes", () => {
    const lines: LineInput[] = [
      { description: "Mission", quantity: 1, unitPriceCents: 100000 },
    ];
    const r = computeLineTotals(lines, { discountType: "FIXED", discountValue: 15000 });
    expect(r.discountCents).toBe(15000);
    expect(r.totalCents).toBe(85000);
  });

  it("plafonne la remise fixe au sous-total", () => {
    const lines: LineInput[] = [
      { description: "Mission", quantity: 1, unitPriceCents: 50000 },
    ];
    const r = computeLineTotals(lines, { discountType: "FIXED", discountValue: 999999 });
    expect(r.discountCents).toBe(50000);
    expect(r.totalCents).toBe(0);
  });

  it("retourne NONE quand la remise vaut 0", () => {
    const lines: LineInput[] = [
      { description: "Mission", quantity: 1, unitPriceCents: 100000 },
    ];
    const r = computeLineTotals(lines, { discountType: "PERCENT", discountValue: 0 });
    expect(r.discountCents).toBe(0);
    expect(r.discountType).toBe("NONE");
    expect(r.discountValue).toBe(0);
    expect(r.totalCents).toBe(100000);
  });

  it("force quantity=1 pour une ligne abonnement", () => {
    const lines: LineInput[] = [
      {
        description: "Maintenance mensuelle",
        quantity: 5,
        unitPriceCents: 30000,
        isSubscription: true,
        billingDay: 1,
        serviceId: "svc_1",
      },
    ];
    const r = computeLineTotals(lines);
    expect(r.lines[0].quantity).toBe(1);
    expect(r.lines[0].lineTotalCents).toBe(30000);
    expect(r.lines[0].isSubscription).toBe(true);
    expect(r.lines[0].billingDay).toBe(1);
    expect(r.lines[0].serviceId).toBe("svc_1");
  });

  it("rejette un billingDay hors 1-28 pour une ligne abonnement", () => {
    const lines: LineInput[] = [
      {
        description: "Maintenance",
        quantity: 1,
        unitPriceCents: 30000,
        isSubscription: true,
        billingDay: 31,
        serviceId: "svc_1",
      },
    ];
    const r = computeLineTotals(lines);
    expect(r.lines[0].billingDay).toBeNull();
  });

  it("ignore les champs abonnement pour une ligne classique", () => {
    const lines: LineInput[] = [
      {
        description: "Audit",
        quantity: 2,
        unitPriceCents: 40000,
        isSubscription: false,
        billingDay: 15,
        serviceId: "svc_x",
      },
    ];
    const r = computeLineTotals(lines);
    expect(r.lines[0].quantity).toBe(2);
    expect(r.lines[0].isSubscription).toBe(false);
    expect(r.lines[0].billingDay).toBeNull();
    // Ligne ponctuelle du catalogue : le lien à la prestation est gardé (E3, 23/10/2026).
    expect(r.lines[0].serviceId).toBe("svc_x");
  });

  it("préserve l'ordre des positions", () => {
    const lines: LineInput[] = [
      { description: "B", quantity: 1, unitPriceCents: 1000, position: 5 },
      { description: "A", quantity: 1, unitPriceCents: 2000, position: 1 },
    ];
    const r = computeLineTotals(lines);
    expect(r.lines[0].position).toBe(5);
    expect(r.lines[1].position).toBe(1);
  });

  it("auto-numérote les positions manquantes", () => {
    const lines: LineInput[] = [
      { description: "A", quantity: 1, unitPriceCents: 1000 },
      { description: "B", quantity: 1, unitPriceCents: 2000 },
    ];
    const r = computeLineTotals(lines);
    expect(r.lines[0].position).toBe(1);
    expect(r.lines[1].position).toBe(2);
  });
});

describe("computeDiscountCents", () => {
  it("retourne 0 pour NONE", () => {
    expect(computeDiscountCents(100000, { discountType: "NONE" })).toBe(0);
  });

  it("calcule un pourcentage arrondi", () => {
    expect(computeDiscountCents(100000, { discountType: "PERCENT", discountValue: 1000 })).toBe(10000);
    expect(computeDiscountCents(9999, { discountType: "PERCENT", discountValue: 1500 })).toBe(1500); // 15 % de 99.99
  });

  it("plafonne au sous-total", () => {
    expect(computeDiscountCents(50000, { discountType: "FIXED", discountValue: 999999 })).toBe(50000);
    expect(computeDiscountCents(50000, { discountType: "PERCENT", discountValue: 999999 })).toBe(50000);
  });
});

describe("assertSubscriptionLinesValid", () => {
  it("passe pour des lignes classiques", () => {
    expect(() =>
      assertSubscriptionLinesValid([{ isSubscription: false }]),
    ).not.toThrow();
  });

  it("passe pour un abonnement valide", () => {
    expect(() =>
      assertSubscriptionLinesValid([
        { isSubscription: true, billingDay: 15, serviceId: "svc_1", commitmentMonths: 12 },
      ]),
    ).not.toThrow();
  });

  it("tout abonnement a un engagement de 12, 24 ou 36 mois (décision du 28/10/2026), sauf l'avenant d'un abonnement existant", () => {
    expect(() => assertSubscriptionLinesValid([{ isSubscription: true, billingDay: 1, serviceId: "svc_1", commitmentMonths: null }])).toThrow(/engagement de 12, 24 ou 36 mois/);
    expect(() => assertSubscriptionLinesValid([{ isSubscription: true, billingDay: 1, serviceId: "svc_1", commitmentMonths: 18 }])).toThrow(/engagement/);
    expect(() => assertSubscriptionLinesValid([{ isSubscription: true, billingDay: 1, serviceId: "svc_1", revisesSubscriptionId: "sub_1" }])).not.toThrow();
  });

  it("lève une erreur si billingDay invalide", () => {
    expect(() =>
      assertSubscriptionLinesValid([
        { isSubscription: true, billingDay: 0, serviceId: "svc_1" },
      ]),
    ).toThrow(/Jour de facturation/);
    expect(() =>
      assertSubscriptionLinesValid([
        { isSubscription: true, billingDay: 31, serviceId: "svc_1" },
      ]),
    ).toThrow(/Jour de facturation/);
  });

  it("lève une erreur si serviceId manquant", () => {
    expect(() =>
      assertSubscriptionLinesValid([
        { isSubscription: true, billingDay: 1, serviceId: null },
      ]),
    ).toThrow(/prestation du catalogue/);
  });
});

describe("remise globale : partie ponctuelle seulement", () => {
  const lignes = [
    { description: "Site", quantity: 1, unitPriceCents: 69000 },
    { description: "Maintenance", quantity: 1, unitPriceCents: 2900, isSubscription: true, billingDay: 1, serviceId: "svc" },
  ];
  it("10 % : sur la partie ponctuelle, la 1re période de l'abonnement reste au prix prélevé ensuite", () => {
    const r = computeLineTotals(lignes, { discountType: "PERCENT", discountValue: 1000 });
    expect(r).toMatchObject({ subtotalCents: 71900, discountCents: 6900, totalCents: 65000 });
    expect(r.lines[1]!.lineTotalCents).toBe(2900);
  });
  it("remise fixe plafonnée à la partie ponctuelle ; abonnement seul : aucune remise", () => {
    expect(computeLineTotals(lignes, { discountType: "FIXED", discountValue: 100000 })).toMatchObject({ discountCents: 69000, totalCents: 2900 });
    expect(computeLineTotals([lignes[1]!], { discountType: "PERCENT", discountValue: 1000 })).toMatchObject({ discountCents: 0, discountType: "NONE", totalCents: 2900 });
  });
});

describe("ligne en option (paiement unique, 28/10/2026)", () => {
  const site: LineInput = { description: "Site vitrine", quantity: 1, unitPriceCents: 120000 };
  const maintenance: LineInput = {
    description: "Maintenance",
    quantity: 1,
    unitPriceCents: 30000,
    isSubscription: true,
    isOptional: true,
    billingDay: 1,
    billingInterval: "YEAR",
    serviceId: "svc",
    commitmentMonths: 24,
    subscriptionStart: "SIGNATURE",
  };

  it("en attente ou non retenue : hors du total ; départ forcé à la livraison", () => {
    const r = computeLineTotals([site, maintenance], { discountType: "PERCENT", discountValue: 1000 });
    expect(r).toMatchObject({ subtotalCents: 120000, discountCents: 12000, totalCents: 108000 });
    expect(r.lines[1]).toMatchObject({ isOptional: true, optionalAccepted: null, subscriptionStart: "DELIVERY", commitmentMonths: 24 });
    expect(computeLineTotals([site, { ...maintenance, optionalAccepted: false }]).totalCents).toBe(120000);
  });

  it("retenue : 1re année dans le total, remise toujours sur la seule partie ponctuelle", () => {
    const r = computeLineTotals([site, { ...maintenance, optionalAccepted: true }], { discountType: "PERCENT", discountValue: 1000 });
    expect(r).toMatchObject({ subtotalCents: 150000, discountCents: 12000, totalCents: 138000 });
  });

  it("hors abonnement : jamais en option", () => {
    expect(computeLineTotals([{ ...site, isOptional: true }]).lines[0]).toMatchObject({ isOptional: false, optionalAccepted: null });
  });
});
