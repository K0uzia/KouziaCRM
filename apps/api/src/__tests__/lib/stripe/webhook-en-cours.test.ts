import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// Décision du 27/10/2026 : idempotence du webhook Stripe par une ligne « en cours » réservée au début, sous la
// contrainte unique de l'événement. Deux livraisons simultanées : un seul traitement, donc ni e-mail ni alerte en double.
// Échec : la ligne est retirée, le renvoi de Stripe retraite. Ligne « en cours » abandonnée (arrêt brutal) : reprise.
const alertAdmin = vi.fn(async () => undefined);
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));
vi.mock("@/lib/stripe/mode.js", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe/mode.js")>()), keyLivemode: async () => false }));

const { processStripeEvent } = await import("@/lib/stripe/webhook-handlers.js");

const refund = (id: string) =>
  ({ id, type: "charge.refunded", created: 1_790_000_000, data: { object: { id: "ch_1", payment_intent: "pi_absent", amount_refunded: 1000 } } }) as unknown as Stripe.Event;

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  alertAdmin.mockReset();
  alertAdmin.mockImplementation(async () => {
    // Traitement lent : la seconde livraison arrive pendant la première.
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("webhook Stripe : ligne « en cours »", () => {
  it("deux livraisons simultanées : une seule alerte, un seul traitement", async () => {
    const [a, b] = await Promise.all([processStripeEvent(refund("evt_double")), processStripeEvent(refund("evt_double"))]);
    expect(alertAdmin).toHaveBeenCalledTimes(1);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { eventId: "evt_double" } });
    expect(row.status).toBe("DONE");
  });

  it("échec du traitement : ligne retirée, le renvoi est retraité", async () => {
    alertAdmin.mockRejectedValueOnce(new Error("SMTP indisponible"));
    await expect(processStripeEvent(refund("evt_echec"))).rejects.toThrow("SMTP indisponible");
    expect(await prisma.stripeWebhookEvent.count({ where: { eventId: "evt_echec" } })).toBe(0);
    const retry = await processStripeEvent(refund("evt_echec"));
    expect(retry.duplicate).toBe(false);
    expect(alertAdmin).toHaveBeenCalledTimes(2);
  });

  it("ligne « en cours » abandonnée depuis plus de 15 min : reprise ; récente : laissée", async () => {
    await prisma.stripeWebhookEvent.create({ data: { eventId: "evt_recent", eventType: "charge.refunded", payload: {}, status: "PROCESSING", claimedAt: new Date() } });
    expect((await processStripeEvent(refund("evt_recent"))).duplicate).toBe(true);
    await prisma.stripeWebhookEvent.create({ data: { eventId: "evt_abandon", eventType: "charge.refunded", payload: {}, status: "PROCESSING", claimedAt: new Date(Date.now() - 20 * 60_000) } });
    expect((await processStripeEvent(refund("evt_abandon"))).duplicate).toBe(false);
    expect(alertAdmin).toHaveBeenCalledTimes(1);
    expect((await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { eventId: "evt_abandon" } })).status).toBe("DONE");
  });
});
