import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

const created: Array<{ params: Stripe.PayoutCreateParams; key?: string }> = [];
let availableCents = 50_000;
let failCreate = false;

const mockStripe = {
  balance: {
    retrieve: vi.fn(async () => ({
      available: [{ amount: availableCents, currency: "eur" }],
      pending: [{ amount: 1_200, currency: "eur" }],
    })),
  },
  payouts: {
    list: vi.fn(async () => ({
      data: [{ destination: { object: "bank_account", bank_name: "REVOLUT", last4: "4321" } }],
    })),
    create: vi.fn(async (params: Stripe.PayoutCreateParams, opts?: { idempotencyKey?: string }) => {
      if (failCreate) throw new Error("Insufficient funds in Stripe account");
      // Stripe renvoie le même versement pour une même clé d'idempotence.
      const existing = created.find((c) => c.key === opts?.idempotencyKey);
      if (!existing) created.push({ params, key: opts?.idempotencyKey });
      const index = created.findIndex((c) => c.key === opts?.idempotencyKey);
      return { id: `po_test_${index}`, amount: params.amount, status: "pending", arrival_date: Math.floor(Date.now() / 1000) + 2 * 86400 };
    }),
  },
};

vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => mockStripe),
  getStripeConfig: vi.fn(async () => ({ secretKey: "sk_test_fake", webhookSecret: "whsec", mode: "test" as const, enabled: true })),
}));

const { createManualPayout, getPayoutPreview } = await import("@/lib/stripe/payouts.js");
const { processStripeEvent } = await import("@/lib/stripe/webhook-handlers.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({
    data: { moduleStripeEnabled: true, stripeSecretKeyEncrypted: encrypt("sk_test_fake"), email: "admin@kouzia.test" },
  });
  invalidateCompanySettingsCache();
  created.length = 0;
  availableCents = 50_000;
  failCreate = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("versement manuel Stripe (bouton Verser)", () => {
  it("aperçu : solde disponible, compte de destination et délai", async () => {
    const p = await getPayoutPreview();
    expect(p).toMatchObject({ availableCents: 50_000, pendingCents: 1_200, destination: { last4: "4321" }, mode: "test" });
  });

  it("plafonné au solde disponible, et refusé à 0", async () => {
    await expect(createManualPayout({ amountCents: 60_000, requestId: "11111111-1111-4111-8111-111111111111", actorEmail: null })).rejects.toMatchObject({ statusCode: 409 });
    await expect(createManualPayout({ amountCents: 0, requestId: "11111111-1111-4111-8111-111111111112", actorEmail: null })).rejects.toMatchObject({ statusCode: 400 });
    expect(created).toHaveLength(0);
  });

  it("idempotent : la même demande renvoyée ne crée qu'un versement, tracé avec son auteur", async () => {
    const req = { amountCents: 30_000, requestId: "22222222-2222-4222-8222-222222222222", actorEmail: "admin@kouzia.test" };
    const a = await createManualPayout(req);
    const b = await createManualPayout(req);
    expect(a.stripePayoutId).toBe(b.stripePayoutId);
    expect(created).toHaveLength(1);
    expect(created[0]!.params).toMatchObject({ amount: 30_000, currency: "eur", description: "Kouzia ERP" });
    const row = await prisma.stripePayout.findUniqueOrThrow({ where: { stripePayoutId: a.stripePayoutId } });
    expect(row.requestedByEmail).toBe("admin@kouzia.test");
    expect(await prisma.stripePayout.count()).toBe(1);
  });

  it("échec côté Stripe : erreur claire, rien d'enregistré", async () => {
    failCreate = true;
    await expect(createManualPayout({ amountCents: 1_000, requestId: "33333333-3333-4333-8333-333333333333", actorEmail: null })).rejects.toMatchObject({ statusCode: 502 });
    expect(await prisma.stripePayout.count()).toBe(0);
  });

  it("webhook payout.failed : état et motif mis à jour sur le versement demandé", async () => {
    const res = await createManualPayout({ amountCents: 5_000, requestId: "44444444-4444-4444-8444-444444444444", actorEmail: null });
    await processStripeEvent({
      id: "evt_po_failed",
      type: "payout.failed",
      data: { object: { id: res.stripePayoutId, amount: 5_000, status: "failed", failure_message: "Compte clôturé", arrival_date: null } },
    } as unknown as Stripe.Event);
    const row = await prisma.stripePayout.findUniqueOrThrow({ where: { stripePayoutId: res.stripePayoutId } });
    expect(row).toMatchObject({ status: "failed", failureMessage: "Compte clôturé" });
  });
});
