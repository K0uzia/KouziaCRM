import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { createSubscription, invoiceSubscriptionNow } from "@/lib/subscriptions/subscription-service.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

// Audit du 27/10/2026 : l'idempotence du cycle (findFirst de la facture) était lue hors transaction et l'échéance avancée
// sans condition. Deux passages simultanés (worker et « Générer maintenant », ou deux démarrages du worker) émettaient
// deux factures numérotées pour le même cycle, corrigeables seulement par un avoir.
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

describe("facture d'un cycle d'abonnement : une seule, même en parallèle", () => {
  it("deux générations simultanées : une facture, l'échéance avancée d'une période", async () => {
    const client = await createClient({ displayName: "Client Cycle", type: "B2B" });
    const service = await createService({ name: "Maintenance cycle", unitPriceCents: 3000 });
    const sub = await createSubscription({ clientId: client.id, serviceId: service.id, label: "Maintenance", amountCents: 3_000, billingDay: 1, billingInterval: "MONTH", startDate: new Date() });
    await prisma.subscription.update({ where: { id: sub.id }, data: { nextInvoiceAt: new Date(Date.now() - 60_000) } });
    const results = await Promise.all([invoiceSubscriptionNow(sub.id), invoiceSubscriptionNow(sub.id), invoiceSubscriptionNow(sub.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.invoice.count({ where: { subscriptionId: sub.id, number: { not: null } } })).toBe(1);
  });
});
