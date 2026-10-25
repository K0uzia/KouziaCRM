import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubscriptionStatus } from "@prisma/client";
import {
  createSubscription,
  computeMrrCents,
  computeNextInvoiceAt,
  generateDueSubscriptionInvoices,
  listSubscriptions,
  SubscriptionError,
  updateSubscription,
} from "@/lib/subscriptions/subscription-service.js";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import {
  seedCompanySettings,
  createClient,
  createService,
} from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

afterEach(async () => {
  await resetDb();
});

describe("computeNextInvoiceAt", () => {
  it("retourne le billingDay du mois courant s'il est >= today", () => {
    const from = new Date(2026, 0, 10, 12, 0, 0); // 10 jan 2026
    const next = computeNextInvoiceAt(15, from);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(15);
  });

  it("passe au mois suivant si le billingDay est passé", () => {
    const from = new Date(2026, 0, 20, 12, 0, 0); // 20 jan 2026
    const next = computeNextInvoiceAt(15, from);
    expect(next.getMonth()).toBe(1); // février
    expect(next.getDate()).toBe(15);
  });

  it("gère le passage d'année", () => {
    const from = new Date(2026, 11, 31, 23, 0, 0); // 31 déc 2026
    const next = computeNextInvoiceAt(5, from);
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(5);
  });
});

describe("createSubscription", () => {
  it("crée un abonnement actif avec nextInvoiceAt au prochain billingDay", async () => {
    const client = await createClient();
    const service = await createService();
    const start = new Date(2026, 0, 1, 0, 0, 0); // 1 jan 2026
    const sub = await createSubscription({
      clientId: client.id,
      serviceId: service.id,
      label: "Maintenance",
      amountCents: 30000,
      billingDay: 1,
      startDate: start,
      catchUpPastPeriods: true,
    });
    expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
    expect(sub.amountCents).toBe(30000);
    expect(sub.billingDay).toBe(1);
    expect(sub.nextInvoiceAt.getTime()).toBe(start.getTime());
  });

  it("skipCurrentPeriod repousse nextInvoiceAt au mois suivant", async () => {
    const client = await createClient();
    const service = await createService();
    const start = new Date(2026, 0, 1, 0, 0, 0); // 1 jan 2026
    const sub = await createSubscription({
      clientId: client.id,
      serviceId: service.id,
      label: "Maintenance",
      amountCents: 30000,
      billingDay: 1,
      startDate: start,
      catchUpPastPeriods: true,
      skipCurrentPeriod: true,
    });
    expect(sub.nextInvoiceAt.getFullYear()).toBe(2026);
    expect(sub.nextInvoiceAt.getMonth()).toBe(1); // février
    expect(sub.nextInvoiceAt.getDate()).toBe(1);
  });

  it("rejette un billingDay invalide", async () => {
    const client = await createClient();
    const service = await createService();
    await expect(
      createSubscription({
        clientId: client.id,
        serviceId: service.id,
        label: "X",
        amountCents: 1000,
        billingDay: 31,
        startDate: new Date(),
      }),
    ).rejects.toThrow(SubscriptionError);
  });

  it("rejette un montant invalide", async () => {
    const client = await createClient();
    const service = await createService();
    await expect(
      createSubscription({
        clientId: client.id,
        serviceId: service.id,
        label: "X",
        amountCents: 0,
        billingDay: 1,
        startDate: new Date(),
      }),
    ).rejects.toThrow(SubscriptionError);
  });

  it("rejette un client inexistant", async () => {
    const service = await createService();
    await expect(
      createSubscription({
        clientId: "nope",
        serviceId: service.id,
        label: "X",
        amountCents: 1000,
        billingDay: 1,
        startDate: new Date(),
      }),
    ).rejects.toThrow(SubscriptionError);
  });

  it("rejette un service inexistant", async () => {
    const client = await createClient();
    await expect(
      createSubscription({
        clientId: client.id,
        serviceId: "nope",
        label: "X",
        amountCents: 1000,
        billingDay: 1,
        startDate: new Date(),
      }),
    ).rejects.toThrow(SubscriptionError);
  });
});

describe("computeMrrCents", () => {
  it("retourne 0 sans abonnement actif", async () => {
    const snap = await computeMrrCents(new Date(2026, 5, 1));
    expect(snap.mrrCents).toBe(0);
    expect(snap.arrCents).toBe(0);
    expect(snap.activeCount).toBe(0);
  });

  it("somme les abonnements actifs et calcule l'ARR", async () => {
    const c1 = await createClient();
    const c2 = await createClient();
    const s1 = await createService({ unitPriceCents: 30000 });
    const s2 = await createService({ unitPriceCents: 50000 });
    await createSubscription({
      clientId: c1.id,
      serviceId: s1.id,
      label: "A",
      amountCents: 30000,
      billingDay: 1,
      startDate: new Date(2026, 0, 1),
      catchUpPastPeriods: true,
    });
    await createSubscription({
      clientId: c2.id,
      serviceId: s2.id,
      label: "B",
      amountCents: 50000,
      billingDay: 15,
      startDate: new Date(2026, 0, 1),
      catchUpPastPeriods: true,
    });
    const snap = await computeMrrCents(new Date(2026, 2, 1));
    expect(snap.mrrCents).toBe(80000);
    expect(snap.arrCents).toBe(960000);
    expect(snap.activeCount).toBe(2);
    expect(snap.bySubscription).toHaveLength(2);
  });

  it("1re facture à venir (ex. une année offerte) : hors MRR et ARR, comptée à part ; incluse une fois facturée", async () => {
    const c = await createClient();
    const s = await createService();
    await createSubscription({ clientId: c.id, serviceId: s.id, label: "Maintenance", amountCents: 3000, billingDay: 1, startDate: new Date(2026, 0, 1), catchUpPastPeriods: true });
    const inAYear = new Date();
    inAYear.setFullYear(inAYear.getFullYear() + 1);
    const offert = await createSubscription({
      clientId: c.id,
      serviceId: s.id,
      label: "Hébergement offert un an",
      amountCents: 12000,
      billingDay: 1,
      billingInterval: "YEAR",
      startDate: new Date(),
      firstInvoiceAt: inAYear,
    });
    const snap = await computeMrrCents();
    expect([snap.mrrCents, snap.arrCents, snap.activeCount, snap.upcomingCount, snap.upcomingMrrCents]).toEqual([3000, 36000, 2, 1, 1000]);
    expect(snap.bySubscription.find((x) => x.id === offert.id)!.upcoming).toBe(true);
    const rows = await listSubscriptions();
    expect(rows.find((r) => r.id === offert.id)!.firstInvoicePending).toBe(true);

    await prisma.subscription.update({ where: { id: offert.id }, data: { lastInvoiceId: "facture-emise" } });
    const billed = await computeMrrCents();
    expect([billed.mrrCents, billed.upcomingCount]).toEqual([4000, 0]);
  });

  it("exclut les abonnements clôturés (endDate passée)", async () => {
    const c = await createClient();
    const s = await createService();
    await createSubscription({
      clientId: c.id,
      serviceId: s.id,
      label: "A",
      amountCents: 30000,
      billingDay: 1,
      startDate: new Date(2026, 0, 1),
      catchUpPastPeriods: true,
      endDate: new Date(2026, 1, 1), // clôturé en février
    });
    const snap = await computeMrrCents(new Date(2026, 5, 1)); // juin
    expect(snap.activeCount).toBe(0);
    expect(snap.mrrCents).toBe(0);
  });

  it("plusieurs abonnements actifs pour le même client, chacun avec son début, sa périodicité et son encaissement", async () => {
    const c = await createClient();
    const s1 = await createService();
    const s2 = await createService();
    const maintenance = await createSubscription({
      clientId: c.id,
      serviceId: s1.id,
      label: "Maintenance mensuelle",
      amountCents: 30000,
      billingDay: 1,
      startDate: new Date(2026, 0, 1),
      catchUpPastPeriods: true,
    });
    const inAYear = new Date();
    inAYear.setFullYear(inAYear.getFullYear() + 1);
    const mails = await createSubscription({
      clientId: c.id,
      serviceId: s2.id,
      label: "Adresses e-mail",
      amountCents: 6000,
      billingDay: 15,
      billingInterval: "YEAR",
      startDate: new Date(),
      firstInvoiceAt: inAYear,
      collectionMethod: "STRIPE",
    });
    expect(await prisma.subscription.count({ where: { clientId: c.id, status: "ACTIVE" } })).toBe(2);
    expect(maintenance.billingInterval).toBe("MONTH");
    expect([mails.billingInterval, mails.collectionMethod]).toEqual(["YEAR", "STRIPE"]);
    // 1re facture différée d'un an (ex. une année offerte), à minuit.
    expect(mails.nextInvoiceAt.getFullYear()).toBe(inAYear.getFullYear());
    expect([mails.nextInvoiceAt.getMonth(), mails.nextInvoiceAt.getDate(), mails.nextInvoiceAt.getHours()]).toEqual([inAYear.getMonth(), inAYear.getDate(), 0]);
  });

  it("1re facture différée : jamais avant le début ni dans le passé ; modifiable tant que rien n'est facturé ; garde son mois au changement de jour", async () => {
    const c = await createClient();
    const s = await createService();
    const base = { clientId: c.id, serviceId: s.id, label: "Hébergement", amountCents: 9000, billingDay: 10, billingInterval: "YEAR" as const };
    await expect(createSubscription({ ...base, startDate: new Date(2030, 5, 1), firstInvoiceAt: new Date(2030, 4, 1) })).rejects.toThrow(/précéder le début/);
    await expect(createSubscription({ ...base, startDate: new Date(2020, 0, 1), firstInvoiceAt: new Date(2020, 5, 1) })).rejects.toThrow(/passé/);
    const sub = await createSubscription({ ...base, startDate: new Date(2030, 0, 1), firstInvoiceAt: new Date(2031, 0, 10) });
    const moved = await updateSubscription(sub.id, { firstInvoiceAt: new Date(2031, 2, 10) });
    expect([moved.nextInvoiceAt.getFullYear(), moved.nextInvoiceAt.getMonth()]).toEqual([2031, 2]);
    // Nouveau jour de facturation : la 1re échéance différée reste en mars 2031.
    const day = await updateSubscription(sub.id, { billingDay: 20 });
    expect([day.nextInvoiceAt.getFullYear(), day.nextInvoiceAt.getMonth(), day.nextInvoiceAt.getDate()]).toEqual([2031, 2, 20]);
    await prisma.subscription.update({ where: { id: sub.id }, data: { lastInvoiceId: "facture-emise" } });
    await expect(updateSubscription(sub.id, { firstInvoiceAt: new Date(2031, 5, 10) })).rejects.toThrow(SubscriptionError);
  });
});

describe("generateDueSubscriptionInvoices", () => {
  it("génère une facture pour un abonnement échu et avance nextInvoiceAt", async () => {
    const c = await createClient();
    const s = await createService();
    const start = new Date(2026, 0, 1);
    const sub = await createSubscription({
      clientId: c.id,
      serviceId: s.id,
      label: "Maintenance",
      amountCents: 30000,
      billingDay: 1,
      startDate: start,
      catchUpPastPeriods: true,
    });

    const now = new Date(2026, 0, 1, 1, 0, 0); // 1 jan, après minuit
    const generated = await generateDueSubscriptionInvoices(now);
    expect(generated).toBe(1);

    const updated = await import("@/lib/prisma.js").then((m) =>
      m.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } }),
    );
    expect(updated.nextInvoiceAt.getMonth()).toBe(1); // février
    expect(updated.lastInvoiceId).toBeTruthy();

    const inv = await import("@/lib/prisma.js").then((m) =>
      m.prisma.invoice.findUniqueOrThrow({
        where: { id: updated.lastInvoiceId! },
        include: { lines: true },
      }),
    );
    expect(inv.subscriptionId).toBe(sub.id);
    expect(inv.totalCents).toBe(30000);
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]!.lineTotalCents).toBe(30000);
  });

  it("est idempotent : ne re-facture pas un cycle déjà émis", async () => {
    const c = await createClient();
    const s = await createService();
    await createSubscription({
      clientId: c.id,
      serviceId: s.id,
      label: "Maintenance",
      amountCents: 30000,
      billingDay: 1,
      startDate: new Date(2026, 0, 1),
      catchUpPastPeriods: true,
    });
    const now = new Date(2026, 0, 1, 1, 0, 0);
    const first = await generateDueSubscriptionInvoices(now);
    expect(first).toBe(1);
    // Re-run au même moment : aucune nouvelle facture (cycle déjà facturé)
    const second = await generateDueSubscriptionInvoices(now);
    expect(second).toBe(0);
  });

  it("ne facture pas un abonnement pas encore échu", async () => {
    const c = await createClient();
    const s = await createService();
    await createSubscription({
      clientId: c.id,
      serviceId: s.id,
      label: "Maintenance",
      amountCents: 30000,
      billingDay: 15,
      startDate: new Date(2026, 0, 1), // nextInvoiceAt = 15 jan
    });
    const now = new Date(2026, 0, 10); // 10 jan, avant le 15
    const generated = await generateDueSubscriptionInvoices(now);
    expect(generated).toBe(0);
  });
});
