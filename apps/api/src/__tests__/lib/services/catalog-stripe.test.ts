import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// Stripe simulé : identifiants uniques, nouveau prix refusé pour un produit choisi.
let n = 0;
const refuse = { priceProduct: "" };
const productsCreate = vi.fn(async (..._a: unknown[]) => ({ id: `prod_new_${++n}` }));
const productsUpdate = vi.fn(async (..._a: unknown[]) => ({}));
const productsRetrieve = vi.fn(async (..._a: unknown[]) => ({ default_price: null }));
const pricesCreate = vi.fn(async (p: { product: string }, ..._a: unknown[]) => {
  if (p.product === refuse.priceProduct) throw new Error("montant refusé");
  return { id: `price_new_${++n}` };
});
const pricesUpdate = vi.fn(async (..._a: unknown[]) => ({}));
const getStripe = vi.fn(async () => ({
  products: { create: productsCreate, update: productsUpdate, retrieve: productsRetrieve },
  prices: { create: pricesCreate, update: pricesUpdate },
}));
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe,
  getStripeConfig: vi.fn(async () => ({ secretKey: "sk_test_x", webhookSecret: null, mode: "test", enabled: true })),
}));

const { applyCatalog } = await import("@/lib/services/catalog.js");
const stripeCalls = () => [productsCreate, productsUpdate, productsRetrieve, pricesCreate, pricesUpdate].reduce((s, m) => s + m.mock.calls.length, 0);

/** Production simulée : deux prestations liées à Stripe, une ponctuelle à l'ancien nom, une maintenance mensuelle avec un contrat. */
async function prodSimulee() {
  const vitrine = await prisma.service.create({
    data: { name: "Site vitrine (jusqu'à 5 pages)", unitPriceCents: 129_000, unit: "FORFAIT", active: true, stripeProductId: "prod_v", stripePriceId: "price_v", stripeLivemode: false, category: null },
  });
  const mensuelle = await prisma.service.create({
    data: { name: "Maintenance site Essentiel", unitPriceCents: 2_900, unit: "FORFAIT", active: true, isSubscription: true, billingInterval: "MONTH", stripeProductId: "prod_m", stripePriceId: "price_m", stripeLivemode: false },
  });
  const client = await prisma.client.create({ data: { displayName: "Client en cours", type: "B2B" } });
  const contrat = await prisma.subscription.create({
    data: { clientId: client.id, serviceId: mensuelle.id, label: "Maintenance", amountCents: 2_900, billingDay: 1, startDate: new Date(), nextInvoiceAt: new Date(), stripeSubscriptionId: "sub_en_cours" },
  });
  return { vitrine, mensuelle, contrat };
}

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: true } });
  invalidateCompanySettingsCache();
  for (const m of [productsCreate, productsUpdate, productsRetrieve, pricesCreate, pricesUpdate, getStripe]) m.mockClear();
  refuse.priceProduct = "";
});

describe("kouziactl catalog --stripe", () => {
  it("simulation : toutes les actions Stripe listées, aucun appel à Stripe, rien d'écrit", async () => {
    const { vitrine } = await prodSimulee();
    const actions = await applyCatalog(prisma, { dryRun: true, update: true, stripe: true });
    expect(getStripe).not.toHaveBeenCalled();
    expect(actions.find((a) => a.name === "Site vitrine (jusqu'à 5 pages)")).toMatchObject({
      action: "stripe-update",
      changes: expect.arrayContaining([expect.stringMatching(/^renommée .* -> « Site vitrine \(5 pages\) »/), expect.stringMatching(/^nouveau prix Stripe 1290,00 € -> 1300,00 €, l'ancien archivé$/)]),
    });
    expect(actions.find((a) => a.name === "Maintenance site (annuel)")).toMatchObject({ action: "stripe-create", changes: ["produit et prix Stripe annuel créés : 350,00 € par an"] });
    expect(actions.find((a) => a.name === "Maintenance site Essentiel")).toMatchObject({ action: "stripe-archive" });
    // Packs annoncés : leurs prestations seront créées ou alignées.
    expect(actions.filter((a) => a.action === "blocked")).toEqual([]);
    expect(await prisma.service.findUniqueOrThrow({ where: { id: vitrine.id } })).toMatchObject({ name: "Site vitrine (jusqu'à 5 pages)", unitPriceCents: 129_000 });
    expect(await prisma.service.count()).toBe(2);
  });

  it("succès : renommage et nouveau prix repoussés, offre annuelle créée, mensuelle archivée, contrat en cours inchangé ; relancé, rien de plus", async () => {
    const { vitrine, mensuelle, contrat } = await prodSimulee();
    const actions = await applyCatalog(prisma, { update: true, stripe: true });
    expect(actions.filter((a) => a.action === "failed")).toEqual([]);
    expect(productsUpdate).toHaveBeenCalledWith("prod_v", { name: "Site vitrine (5 pages)", description: expect.any(String) });
    expect(pricesCreate).toHaveBeenCalledWith(expect.objectContaining({ product: "prod_v", unit_amount: 130_000 }), expect.anything());
    expect(pricesUpdate).toHaveBeenCalledWith("price_v", { active: false });
    const v = await prisma.service.findUniqueOrThrow({ where: { id: vitrine.id } });
    expect(v).toMatchObject({ name: "Site vitrine (5 pages)", unitPriceCents: 130_000, category: "SITE" });
    expect(v.stripePriceId).not.toBe("price_v");
    const annuelle = await prisma.service.findFirstOrThrow({ where: { name: "Maintenance site (annuel)" } });
    expect(annuelle).toMatchObject({ isSubscription: true, billingInterval: "YEAR", unitPriceCents: 35_000 });
    expect(annuelle.stripeProductId).toMatch(/^prod_new_/);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: mensuelle.id } })).active).toBe(false);
    expect(productsUpdate).toHaveBeenCalledWith("prod_m", { active: false });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: contrat.id } })).toMatchObject({ amountCents: 2_900, serviceId: mensuelle.id, stripeSubscriptionId: "sub_en_cours" });
    // Packs composés avec les offres Stripe (« (annuel) » comprise) : la maintenance pack depuis le 28/10/2026.
    const maintenancePack = await prisma.service.findFirstOrThrow({ where: { name: "Maintenance site (pack) (annuel)" } });
    const vitrinePack = await prisma.service.findFirstOrThrow({ where: { name: "Pack Vitrine" }, include: { packItems: true } });
    expect(vitrinePack.packItems.map((i) => i.serviceId)).toContain(maintenancePack.id);

    // Idempotence : relancée, la commande n'appelle plus Stripe et ne crée rien.
    const before = await prisma.service.count();
    for (const m of [productsCreate, productsUpdate, productsRetrieve, pricesCreate, pricesUpdate]) m.mockClear();
    const again = await applyCatalog(prisma, { update: true, stripe: true });
    expect(stripeCalls()).toBe(0);
    expect(again.filter((a) => a.action.startsWith("stripe-") || a.action === "failed" || a.action === "create")).toEqual([]);
    expect(await prisma.service.count()).toBe(before);
  });

  it("échec partiel : la prestation refusée reste inchangée, les autres avancent, le bilan liste l'échec", async () => {
    const { vitrine, mensuelle } = await prodSimulee();
    refuse.priceProduct = "prod_v";
    const actions = await applyCatalog(prisma, { update: true, stripe: true });
    const failed = actions.filter((a) => a.action === "failed");
    expect(failed.map((a) => a.name)).toEqual(["Site vitrine (jusqu'à 5 pages)"]);
    // Le pack qui en dépend attend la prestation : il se créera à la relance.
    expect(actions.find((a) => a.name === "Pack Vitrine")?.action).toBe("blocked");
    expect(failed.find((a) => a.name === "Site vitrine (jusqu'à 5 pages)")!.changes[0]).toMatch(/garde son prix actuel/);
    expect(await prisma.service.findUniqueOrThrow({ where: { id: vitrine.id } })).toMatchObject({ name: "Site vitrine (jusqu'à 5 pages)", unitPriceCents: 129_000, stripePriceId: "price_v" });
    // Le nom a été remis dans Stripe (rien d'appliqué à moitié).
    expect(productsUpdate).toHaveBeenCalledWith("prod_v", { name: "Site vitrine (jusqu'à 5 pages)", description: "" });
    // Les autres ont avancé.
    expect(await prisma.service.findFirst({ where: { name: "Maintenance site (annuel)" } })).not.toBeNull();
    expect((await prisma.service.findUniqueOrThrow({ where: { id: mensuelle.id } })).active).toBe(false);

    // Relance après correction : seule la prestation en échec est traitée.
    refuse.priceProduct = "";
    for (const m of [productsCreate, productsUpdate, productsRetrieve, pricesCreate, pricesUpdate]) m.mockClear();
    const again = await applyCatalog(prisma, { update: true, stripe: true });
    expect(again.filter((a) => a.action === "stripe-update").map((a) => a.name)).toEqual(["Site vitrine (5 pages)"]);
    expect(productsCreate).not.toHaveBeenCalled();
    expect(again.find((x) => x.name === "Pack Vitrine")?.action).toBe("create");
  });

  it("sans --stripe : garde-fou inchangé ; module Stripe inactif : --stripe refusé", async () => {
    const { vitrine } = await prodSimulee();
    const actions = await applyCatalog(prisma, { update: true });
    expect(actions.find((a) => a.name === "Site vitrine (jusqu'à 5 pages)")?.action).toBe("stripe");
    expect(getStripe).not.toHaveBeenCalled();
    expect((await prisma.service.findUniqueOrThrow({ where: { id: vitrine.id } })).unitPriceCents).toBe(129_000);
    await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: false } });
    invalidateCompanySettingsCache();
    await expect(applyCatalog(prisma, { update: true, stripe: true })).rejects.toThrow(/module Stripe est inactif/);
  });
});
