import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { getCompanySettings } from "@/lib/company.js";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { templateDefinition } from "@/lib/email/template-registry.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

// Modèles M3b (abonnements) : le modèle d'origine enregistré tel quel rend exactement l'e-mail du code (objet, texte
// et HTML), pour chaque variante ; un modèle modifié garde ses blocs obligatoires remplis par le système.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin: vi.fn(async () => undefined) }));

const dunning = await import("@/lib/subscriptions/dunning.js");
const reminders = await import("@/lib/subscriptions/renewal-reminder.js");
const { renderCardExpiryEmail } = await import("@/lib/subscriptions/card-expiry.js");
const { buildEmailBrand } = await import("@/lib/email/deposit-templates.js");
const { sendSubscriptionSetupEmail } = await import("@/lib/stripe/billing.js");
const { requestSubscriptionCancellation } = await import("@/lib/subscriptions/self-service.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

async function original(key: string) {
  const def = templateDefinition(key)!;
  await prisma.emailTemplate.deleteMany({ where: { key } });
  await prisma.emailTemplate.create({ data: { key, subject: def.subject, body: def.body } });
}

/** Rendu sans modèle, puis avec le modèle d'origine enregistré : identiques. */
async function same<T>(key: string, render: () => Promise<T>) {
  await prisma.emailTemplate.deleteMany({ where: { key } });
  const fromCode = await render();
  await original(key);
  expect(await render()).toEqual(fromCode);
}

async function ctx(firstName: string | null = "Lou") {
  const settings = await getCompanySettings();
  return { brand: buildEmailBrand(settings), settings, clientName: "Lou Martin", clientFirstName: firstName };
}

describe("M3b : incidents de paiement et résiliation (Stripe)", () => {
  const D = new Date(2026, 10, 3);
  it.each([
    ["échec, nouvelle tentative, facture", { nextAttempt: D, invoiceNumber: "F-2026-0042" }],
    ["échec, sans tentative ni facture, sans prénom", { nextAttempt: null, invoiceNumber: null, first: null }],
  ])("prélèvement non abouti (%s)", async (_l, v) => {
    const c = await ctx((v as { first?: null }).first === null ? null : "Lou");
    await same("subscription.payment_failed", () =>
      dunning.renderPaymentFailedEmail({ ...c, label: "Site vitrine", amountCents: 3_000, invoiceNumber: v.invoiceNumber, nextAttempt: v.nextAttempt, url: "https://pay.test/m" }),
    );
  });

  it("régularisé, suspendu, confirmation (et rappel), résiliation programmée et annulée", async () => {
    const c = await ctx();
    await same("subscription.payment_recovered", () => dunning.renderPaymentRecoveredEmail({ ...c, label: "Site", amountCents: 3_000, invoiceNumber: "F-2026-0042" }));
    await same("subscription.payment_recovered", () => dunning.renderPaymentRecoveredEmail({ ...c, label: "Site", amountCents: 3_000, invoiceNumber: null }));
    await same("subscription.suspended", () => dunning.renderSuspendedEmail({ ...c, label: "Site", url: "https://pay.test/s" }));
    for (const reminder of [false, true]) {
      await same("subscription.action_required", () =>
        dunning.renderActionRequiredEmail({ ...c, label: "Site", amountCents: 3_000, invoiceNumber: "F-2026-0042", url: "https://pay.test/3ds", reminder }),
      );
    }
    await same("subscription.cancel_scheduled", () => dunning.renderCancelScheduledEmail({ ...c, label: "Site", endsAt: D }));
    await same("subscription.cancel_revoked", () => dunning.renderCancelRevokedEmail({ ...c, label: "Site" }));
  });
});

describe("M3b : avis d'échéance", () => {
  const base = async () => ({ ...(await ctx()), label: "Site vitrine", amountCents: 36_000 });

  it.each([
    ["prélevé par Stripe (lien de gestion)", "https://manage.test/x"],
    ["facturé par l'ERP", null],
  ])("information de reconduction (%s)", async (_l, manageUrl) => {
    const b = await base();
    await same("subscription.renewal", () => reminders.renderRenewalReminderEmail({ ...b, renewalDate: new Date(2026, 11, 1), deadline: new Date(2026, 10, 30), manageUrl }));
  });

  it.each([
    ["fin d'engagement", true],
    ["fin d'une année reconduite", false],
  ])("fin de période (%s)", async (_l, commitmentEnd) => {
    const b = await base();
    await same("subscription.term_end", () =>
      reminders.renderTermEndReminderEmail({ ...b, billingInterval: "MONTH", termEndsAt: new Date(2027, 5, 1), deadline: new Date(2027, 4, 1), commitmentEnd, portalUrl: "https://kouzia.test/suivi/" }),
    );
  });

  it("fin d'engagement avec rachat proposé : les trois choix", async () => {
    const b = await base();
    await same("subscription.term_end_buyout", () =>
      reminders.renderTermEndReminderEmail({ ...b, billingInterval: "YEAR", termEndsAt: new Date(2027, 5, 1), deadline: new Date(2027, 4, 1), commitmentEnd: true, portalUrl: "https://kouzia.test/suivi/", buyoutPriceCents: 75_000 }),
    );
  });

  it.each([
    ["prélèvement Stripe", true, "https://manage.test/x"],
    ["facture ERP", false, null],
  ])("1re échéance (%s)", async (_l, stripe, manageUrl) => {
    const b = await base();
    await same("subscription.first_charge", () =>
      reminders.renderFirstChargeNoticeEmail({ ...b, billingInterval: "MONTH", firstChargeDate: new Date(2027, 0, 1), manageUrl, stripe }),
    );
  });

  it("carte bientôt expirée", async () => {
    const c = await ctx();
    await same("subscription.card_expiring", () =>
      renderCardExpiryEmail({ ...c, label: "Site", cardBrand: "visa", last4: "4242", expMonth: 11, expYear: 2026, url: "https://manage.test/card" }),
    );
  });

  it("modèle modifié : le bloc des trois choix et la date limite restent ceux du système", async () => {
    const b = await base();
    await prisma.emailTemplate.create({
      data: { key: "subscription.term_end_buyout", subject: "Votre site : {{date_fin}}", body: "{{salutation}}\n\nUn mot personnel.\n{{bloc_choix}}\n\n{{date_limite}}" },
    });
    const r = await reminders.renderTermEndReminderEmail({ ...b, billingInterval: "YEAR", termEndsAt: new Date(2027, 5, 1), deadline: new Date(2027, 4, 1), commitmentEnd: true, portalUrl: "https://kouzia.test/suivi/", buyoutPriceCents: 75_000 });
    expect(r.text).toContain("Un mot personnel.\nTrois possibilités :\n- Continuer");
    expect(r.text).toContain("- Racheter votre site");
    expect(r.text).toContain("Date limite pour demander la non-reconduction");
  });
});

describe("M3b : e-mails mis en file (mise en place, demande de résiliation)", () => {
  async function subscription(extra: Record<string, unknown> = {}) {
    const c = await createClient({ displayName: "Lou Martin" });
    await prisma.client.update({ where: { id: c.id }, data: { firstName: "Lou", emailEncrypted: encrypt("lou@example.com") } });
    const service = await createService({ name: "Maintenance", isSubscription: true });
    return prisma.subscription.create({
      data: { clientId: c.id, serviceId: service.id, label: "Maintenance", amountCents: 3_000, billingDay: 1, billingInterval: "MONTH", startDate: new Date(), nextInvoiceAt: new Date(Date.now() + 20 * 86_400_000), ...extra },
    });
  }
  const lastTwo = async () => {
    const rows = await prisma.emailOutbox.findMany({ orderBy: { createdAt: "asc" } });
    return rows.slice(-2).map((r) => {
      const p = parsePayload(outboxPayloadRaw(r));
      return { subject: p.subject, text: p.text, html: p.html };
    });
  };

  it("lien de mise en place du prélèvement", async () => {
    const sub = await subscription();
    await sendSubscriptionSetupEmail(sub.id);
    await original("subscription.setup");
    await sendSubscriptionSetupEmail(sub.id);
    const [a, b] = await lastTwo();
    expect(b).toEqual(a);
  });

  it.each([
    ["abonnement engagé (date de fin du contrat)", { commitmentMonths: 12, commitmentEndsAt: new Date(Date.now() + 200 * 86_400_000) }],
    ["sans engagement (date confirmée ensuite)", {}],
  ])("demande de résiliation reçue : %s", async (_l, extra) => {
    const sub = await subscription(extra);
    const now = new Date(2026, 9, 26, 10);
    await requestSubscriptionCancellation(sub.id, now);
    await prisma.subscription.update({ where: { id: sub.id }, data: { cancellationRequestedAt: null } });
    await original("subscription.cancel_request");
    await requestSubscriptionCancellation(sub.id, now);
    const [a, b] = await lastTwo();
    expect(b).toEqual(a);
  });
});
