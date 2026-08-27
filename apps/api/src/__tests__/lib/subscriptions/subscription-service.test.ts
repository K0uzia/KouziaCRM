import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubscriptionStatus } from "@prisma/client";
import {
  createSubscription,
  computeMrrCents,
  computeNextInvoiceAt,
  generateDueSubscriptionInvoices,
  SubscriptionError,
} from "@/lib/subscriptions/subscription-service.js";
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
    });
    await createSubscription({
      clientId: c2.id,
      serviceId: s2.id,
      label: "B",
      amountCents: 50000,
      billingDay: 15,
      startDate: new Date(2026, 0, 1),
    });
    const snap = await computeMrrCents(new Date(2026, 2, 1));
    expect(snap.mrrCents).toBe(80000);
    expect(snap.arrCents).toBe(960000);
    expect(snap.activeCount).toBe(2);
    expect(snap.bySubscription).toHaveLength(2);
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
      endDate: new Date(2026, 1, 1), // clôturé en février
    });
    const snap = await computeMrrCents(new Date(2026, 5, 1)); // juin
    expect(snap.activeCount).toBe(0);
    expect(snap.mrrCents).toBe(0);
  });

  it("rejette un second abonnement actif pour le même client", async () => {
    const c = await createClient();
    const s1 = await createService();
    const s2 = await createService();
    await createSubscription({
      clientId: c.id,
      serviceId: s1.id,
      label: "A",
      amountCents: 30000,
      billingDay: 1,
      startDate: new Date(2026, 0, 1),
    });
    await expect(
      createSubscription({
        clientId: c.id,
        serviceId: s2.id,
        label: "B",
        amountCents: 50000,
        billingDay: 15,
        startDate: new Date(2026, 0, 1),
      }),
    ).rejects.toThrow(SubscriptionError);
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
