import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");
const { currentPeriodEndOf, remainingCommitmentPeriods } = await import("@/lib/subscriptions/buyout.js");

const ADMIN = "admin-rachat@kouzia.test";
let app: FastifyInstance;
let cookie = "";
let clientId = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
  ({ id: clientId } = await createClient({ displayName: "Client du rachat" }));
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, payload: payload as never });

const d = (iso: string) => new Date(`${iso}T00:00:00`);

/** Offre « Vitrine » (pack vendable en récurrent), sa prestation de rachat et un abonnement engagé 36 mois, annuel. */
async function setup(opts: { buyout?: boolean; commitmentMonths?: number | null; interval?: "YEAR" | "MONTH"; nextInvoiceAt?: string } = {}) {
  const site = await prisma.service.create({ data: { name: "Création du site", unitPriceCents: 120_000 } });
  const offer = await prisma.service.create({
    data: { name: "Vitrine", unitPriceCents: 150_000, annualPriceCents: 36_000, isPack: true, packItems: { create: [{ serviceId: site.id, quantity: 1, position: 0 }] } },
  });
  const buyout = await prisma.service.create({ data: { name: "Rachat du site Vitrine", unitPriceCents: 75_000 } });
  if (opts.buyout !== false) await prisma.service.update({ where: { id: offer.id }, data: { buyoutServiceId: buyout.id } });
  const months = opts.commitmentMonths === undefined ? 36 : opts.commitmentMonths;
  const sub = await prisma.subscription.create({
    data: {
      clientId,
      serviceId: offer.id,
      label: "Vitrine : abonnement annuel",
      amountCents: 40_000,
      billingDay: 1,
      billingInterval: opts.interval ?? "YEAR",
      startDate: d("2026-01-01"),
      nextInvoiceAt: d(opts.nextInvoiceAt ?? "2027-01-01"),
      commitmentMonths: months,
      commitmentEndsAt: months ? d(`${2026 + months / 12}-01-01`) : null,
    },
  });
  return { site, offer, buyout, sub };
}

describe("rachat R1 : périodes restantes de l'engagement", () => {
  const sub = { nextInvoiceAt: d("2027-01-01"), billingInterval: "YEAR", commitmentEndsAt: d("2029-01-01") };

  it("annuel, 36 mois commencés le 01/01/2026 : la période en cours finit le 01/01/2027, restent 2027 et 2028", () => {
    expect(currentPeriodEndOf(sub, d("2026-06-15"))).toEqual(d("2027-01-01"));
    expect(remainingCommitmentPeriods(sub, d("2026-06-15"))).toMatchObject({ count: 2, from: d("2027-01-01") });
  });

  it("dernière année de l'engagement ou année reconduite : plus rien de dû", () => {
    expect(remainingCommitmentPeriods({ ...sub, nextInvoiceAt: d("2029-01-01") }, d("2028-06-15")).count).toBe(0);
    expect(remainingCommitmentPeriods({ ...sub, nextInvoiceAt: d("2030-01-01") }, d("2029-03-01")).count).toBe(0);
  });

  it("échéance déjà passée (facture pas encore émise) : la période en cours est celle qui a commencé", () => {
    expect(currentPeriodEndOf(sub, d("2027-01-02"))).toEqual(d("2028-01-01"));
    expect(remainingCommitmentPeriods(sub, d("2027-01-02")).count).toBe(1);
  });

  it("mensuel, 12 mois : les mois après le mois en cours", () => {
    const monthly = { nextInvoiceAt: d("2026-07-01"), billingInterval: "MONTH", commitmentEndsAt: d("2027-01-01") };
    expect(remainingCommitmentPeriods(monthly, d("2026-06-15")).count).toBe(6);
  });
});

describe("rachat R1 : prestation de rachat au catalogue", () => {
  it("offre d'abonnement : rachat enregistré, retiré par null, refusé pour un abonnement, un pack, elle-même ou une prestation archivée", async () => {
    const { offer, buyout, site } = await setup({ buyout: false });
    const body = (extra: Record<string, unknown>) => ({
      name: "Vitrine",
      unitPriceEuros: 1500,
      isPack: true,
      annualPriceEuros: 360,
      packItems: [{ serviceId: site.id, quantity: 1 }],
      ...extra,
    });
    const ok = await call("PUT", `/api/services/${offer.id}`, body({ buyoutServiceId: buyout.id }));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().buyoutServiceId).toBe(buyout.id);
    // Absent : gardé.
    expect((await call("PUT", `/api/services/${offer.id}`, body({}))).json().buyoutServiceId).toBe(buyout.id);

    const monthly = await prisma.service.create({ data: { name: "Maintenance", unitPriceCents: 3_000, isSubscription: true, billingInterval: "MONTH" } });
    const archived = await prisma.service.create({ data: { name: "Ancien rachat", unitPriceCents: 1_000, active: false } });
    for (const [target, message] of [
      [monthly.id, /ponctuelle/],
      [offer.id, /propre prestation/],
      [archived.id, /archivée/],
    ] as const) {
      const res = await call("PUT", `/api/services/${offer.id}`, body({ buyoutServiceId: target }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(message);
    }
    expect((await prisma.service.findUniqueOrThrow({ where: { id: offer.id } })).buyoutServiceId).toBe(buyout.id);

    const notOffer = await call("POST", "/api/services", { name: "Logo", unitPriceEuros: 200, buyoutServiceId: buyout.id });
    expect(notOffer.statusCode).toBe(400);
    expect(notOffer.json().error).toMatch(/offre d'abonnement/);

    expect((await call("PUT", `/api/services/${offer.id}`, body({ buyoutServiceId: null }))).json().buyoutServiceId).toBeNull();
  });

  it("pack qui n'est plus vendable en récurrent : il perd sa prestation de rachat", async () => {
    const { offer, site } = await setup();
    const res = await call("PUT", `/api/services/${offer.id}`, {
      name: "Vitrine",
      unitPriceEuros: 1500,
      isPack: true,
      annualPriceEuros: null,
      packItems: [{ serviceId: site.id, quantity: 1 }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().buyoutServiceId).toBeNull();
  });
});

describe("rachat R1 : « Proposer le rachat »", () => {
  it("devis brouillon en paiement unique : prix de rachat et annuités restantes au prix du devis d'origine ; lien des deux côtés", async () => {
    const { sub, buyout } = await setup();
    // Devis d'origine signé à 360 € par an ; l'abonnement a été révisé depuis à 400 €.
    const origin = await prisma.invoice.create({
      data: { documentType: "QUOTE", quoteStatus: "ACCEPTED", number: "D-2025-0042", status: "ISSUED", issueDate: d("2025-12-15"), clientId, subtotalCents: 36_000, totalCents: 36_000 },
    });
    await prisma.invoiceLine.create({
      data: { invoiceId: origin.id, position: 1, description: "Vitrine", quantity: 1, unitPriceCents: 36_000, lineTotalCents: 36_000, isSubscription: true, billingInterval: "YEAR", subscriptionId: sub.id },
    });

    const before = (await call("GET", `/api/subscriptions/${sub.id}`)).json();
    expect(before.buyout).toMatchObject({ canPropose: true, service: { id: buyout.id, unitPriceCents: 75_000 }, quotes: [] });

    const res = await call("POST", `/api/subscriptions/${sub.id}/buyout-quote`);
    expect(res.statusCode, res.body).toBe(201);
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id: res.json().id }, include: { lines: { orderBy: { position: "asc" } } } });
    expect(quote).toMatchObject({ documentType: "QUOTE", quoteStatus: "DRAFT", status: "DRAFT", number: null, billingMode: "ONE_OFF", paymentPlanOffer: "ONE", buysOutSubscriptionId: sub.id, clientId });
    expect(quote.lines[0]).toMatchObject({ serviceId: buyout.id, unitPriceCents: 75_000, isSubscription: false });
    expect(Number(quote.lines[0]!.quantity)).toBe(1);
    expect(quote.lines[0]!.description).toMatch(/^Rachat du site Vitrine \(abonnement « Vitrine : abonnement annuel », fin le \d{2}\/\d{2}\/\d{4}\)$/);
    const now = new Date();
    const expected = remainingCommitmentPeriods(sub, now);
    if (expected.count > 0) {
      expect(Number(quote.lines[1]!.quantity)).toBe(expected.count);
      expect(quote.lines[1]).toMatchObject({ unitPriceCents: 36_000, lineTotalCents: expected.count * 36_000, isSubscription: false });
      expect(quote.lines[1]!.description).toMatch(/^Annuités restantes de l'engagement \(du .+ au .+\)$/);
    }
    expect(quote.totalCents).toBe(quote.lines.reduce((s, l) => s + l.lineTotalCents, 0));

    // Lien : fiche de l'abonnement et fiche du devis.
    const after = (await call("GET", `/api/subscriptions/${sub.id}`)).json();
    expect(after.buyout).toMatchObject({ canPropose: false, quotes: [{ id: quote.id, quoteStatus: "DRAFT" }] });
    expect((await call("GET", `/api/invoices/${quote.id}`)).json().buysOutSubscription).toEqual({ id: sub.id, label: "Vitrine : abonnement annuel" });

    // Un seul devis en cours : 409 avec son identifiant ; refusé, on peut en proposer un autre.
    const again = await call("POST", `/api/subscriptions/${sub.id}/buyout-quote`);
    expect(again.statusCode).toBe(409);
    expect(again.json().quoteId).toBe(quote.id);
    await prisma.invoice.update({ where: { id: quote.id }, data: { quoteStatus: "REJECTED" } });
    expect((await call("POST", `/api/subscriptions/${sub.id}/buyout-quote`)).statusCode).toBe(201);
  });

  it("calendrier fixe : 36 mois annuels commencés le 01/01/2026, proposé le 15/06/2026 : 2 annuités", async () => {
    const { sub } = await setup();
    const { createBuyoutQuote } = await import("@/lib/subscriptions/buyout.js");
    const { id } = await createBuyoutQuote(sub.id, d("2026-06-15"));
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { position: "asc" } });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.description).toContain("fin le 01/01/2027");
    // Sans devis d'origine : le montant de l'abonnement.
    expect(Number(lines[1]!.quantity)).toBe(2);
    expect(lines[1]).toMatchObject({ description: "Annuités restantes de l'engagement (du 01/01/2027 au 01/01/2029)", unitPriceCents: 40_000, lineTotalCents: 80_000 });
  });

  it("fin de l'engagement atteinte : une seule ligne, le prix de rachat", async () => {
    const { sub } = await setup();
    const { createBuyoutQuote } = await import("@/lib/subscriptions/buyout.js");
    const { id } = await createBuyoutQuote(sub.id, d("2028-06-15"));
    expect(await prisma.invoiceLine.count({ where: { invoiceId: id } })).toBe(1);
  });

  it("refus : offre sans prestation de rachat, sans engagement, abonnement clôturé ; 404 inconnu", async () => {
    const none = await setup({ buyout: false });
    expect((await call("GET", `/api/subscriptions/${none.sub.id}`)).json().buyout).toBeNull();
    expect((await call("POST", `/api/subscriptions/${none.sub.id}/buyout-quote`)).statusCode).toBe(400);

    const free = await setup({ commitmentMonths: null });
    const freeRes = await call("POST", `/api/subscriptions/${free.sub.id}/buyout-quote`);
    expect(freeRes.statusCode).toBe(400);
    expect(freeRes.json().error).toMatch(/sans engagement/);

    const ended = await setup();
    await prisma.subscription.update({ where: { id: ended.sub.id }, data: { status: "ENDED" } });
    expect((await call("POST", `/api/subscriptions/${ended.sub.id}/buyout-quote`)).json().error).toMatch(/actif/);

    expect((await call("POST", "/api/subscriptions/inconnu/buyout-quote")).statusCode).toBe(404);
    expect(await prisma.invoice.count({ where: { buysOutSubscriptionId: { not: null } } })).toBe(0);
  });
});
