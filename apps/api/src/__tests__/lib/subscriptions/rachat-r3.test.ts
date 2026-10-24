import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", () => ({ isSmtpConfigured: vi.fn(async () => true) }));
vi.mock("@/lib/email/mailer/index.js", () => ({
  mailEnqueue: vi.fn(async () => ({ outboxId: "outbox-1", messageId: "<x@y>" })),
}));

const { mailEnqueue } = await import("@/lib/email/mailer/index.js");
const { sendDueTermEndReminders } = await import("@/lib/subscriptions/renewal-reminder.js");
const { listNotifications } = await import("@/lib/notifications/feed.js");
const { PUSHED_KINDS } = await import("@/lib/push/dispatch.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  vi.mocked(mailEnqueue).mockClear();
});

/** Abonnement annuel engagé jusqu'au 1er janvier 2027 (date limite 1er décembre 2026, rappel dès le 17 octobre). */
async function engaged(opts: { buyout?: "active" | "archived" | "none"; commitmentEndsAt?: Date } = {}) {
  const c = await createClient({ displayName: "Lou Martin" });
  await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt("lou@example.test") } });
  const buyout = await prisma.service.create({ data: { name: "Rachat du site Vitrine", unitPriceCents: 75_000, active: opts.buyout !== "archived" } });
  const offer = await prisma.service.create({
    data: { name: "Vitrine", unitPriceCents: 36_000, isSubscription: true, billingInterval: "YEAR", buyoutServiceId: (opts.buyout ?? "active") === "none" ? null : buyout.id },
  });
  const sub = await prisma.subscription.create({
    data: {
      clientId: c.id,
      serviceId: offer.id,
      label: "Vitrine : annuel",
      amountCents: 36_000,
      billingDay: 1,
      billingInterval: "YEAR",
      startDate: new Date(2024, 0, 1),
      nextInvoiceAt: new Date(2027, 0, 1),
      lastInvoiceId: "deja-facture",
      commitmentMonths: 36,
      commitmentEndsAt: opts.commitmentEndsAt ?? new Date(2027, 0, 1),
    },
  });
  return { sub, clientId: c.id };
}

const plain = (s: string | undefined) => (s ?? "").replace(/[  ]/g, " ");

describe("rachat R3 : rappel à trois choix", () => {
  it("fin du premier engagement, offre rachetable : trois choix en tiret simple, prix du catalogue, type à part", async () => {
    const { sub } = await engaged();
    expect(await sendDueTermEndReminders(new Date(2026, 9, 20))).toBe(1);
    const call = vi.mocked(mailEnqueue).mock.calls[0]!;
    const text = plain(call[0].text);
    expect(call[0].subject).toBe("Votre abonnement « Vitrine : annuel » : fin d'engagement le 1er janvier 2027");
    expect(text).toContain("Trois possibilités :");
    expect(text).toContain("- Continuer : vous n'avez rien à faire. L'abonnement est reconduit pour un an au prix en vigueur (actuellement 360,00 € par an).");
    expect(text).toContain("- Arrêter : demandez sa non-reconduction, sans frais ni justification, jusqu'au 1er décembre 2026 (préavis d'un mois)");
    expect(text).toContain("- Racheter votre site : il devient le vôtre pour 750,00 €, en une fois, sans abonnement ensuite. Répondez à cet e-mail pour le demander : je vous envoie le devis.");
    expect(text).not.toMatch(/[–—]/);
    expect(call[0]).toMatchObject({ kind: "subscription_term_end_buyout", documentId: sub.id });
    // Toujours relu dans « E-mails à valider » (famille des avis d'abonnement).
    expect(call[1]).toEqual({ review: { family: "subscription_notice", origin: "WORKER" } });
    // Une seule fois.
    expect(await sendDueTermEndReminders(new Date(2026, 9, 25))).toBe(0);
  });

  it("e-mail d'origine, sans rachat : offre sans prestation, prestation archivée, rachat déjà signé, année reconduite", async () => {
    for (const buyout of ["none", "archived"] as const) {
      await resetDb();
      await seedCompanySettings();
      vi.mocked(mailEnqueue).mockClear();
      await engaged({ buyout });
      expect(await sendDueTermEndReminders(new Date(2026, 9, 20))).toBe(1);
      const call = vi.mocked(mailEnqueue).mock.calls[0]![0];
      expect(call.kind).toBe("subscription_term_end");
      expect(plain(call.text)).not.toContain("Racheter");
    }

    await resetDb();
    await seedCompanySettings();
    vi.mocked(mailEnqueue).mockClear();
    const signed = await engaged();
    await prisma.invoice.create({
      data: { documentType: "QUOTE", quoteStatus: "ACCEPTED", status: "ISSUED", number: "D-2026-0900", clientId: signed.clientId, buysOutSubscriptionId: signed.sub.id, subtotalCents: 75_000, totalCents: 75_000 },
    });
    expect(await sendDueTermEndReminders(new Date(2026, 9, 20))).toBe(1);
    expect(vi.mocked(mailEnqueue).mock.calls[0]![0].kind).toBe("subscription_term_end");

    // Engagement fini le 1er janvier 2026 : l'année reconduite garde l'e-mail d'origine (Q5).
    await resetDb();
    await seedCompanySettings();
    vi.mocked(mailEnqueue).mockClear();
    await engaged({ commitmentEndsAt: new Date(2026, 0, 1) });
    expect(await sendDueTermEndReminders(new Date(2026, 9, 20))).toBe(1);
    const renewal = vi.mocked(mailEnqueue).mock.calls[0]![0];
    expect(renewal.subject).toContain("reconduction le 1er janvier 2027");
    expect(renewal.kind).toBe("subscription_term_end");
  });
});

describe("rachat R3 : notification « proposer le rachat ? »", () => {
  it("rappel à trois choix mis en file : élément de la cloche vers la fiche du contrat, envoyé sur le téléphone", async () => {
    const { sub } = await engaged();
    const since = new Date(Date.now() - 60_000);
    const row = await prisma.emailOutbox.create({
      data: { status: "REVIEW", payload: "", payloadEncrypted: encrypt("{}"), reviewKind: "subscription_term_end_buyout", reviewFamily: "subscription_notice", documentId: sub.id },
    });
    // Rappel ordinaire : pas d'élément de rachat.
    await prisma.emailOutbox.create({ data: { status: "REVIEW", payload: "", payloadEncrypted: encrypt("{}"), reviewKind: "subscription_term_end", reviewFamily: "subscription_notice" } });
    const items = (await listNotifications(since)).filter((i) => i.kind === "buyout_offer");
    expect(items).toEqual([
      {
        id: `buyout_offer:${row.id}`,
        kind: "buyout_offer",
        title: "Fin d'engagement de Lou Martin le 01/01/2027 : proposer le rachat ?",
        body: "Abonnement « Vitrine : annuel » : le rappel au client propose le rachat.",
        href: `/abonnements?tab=contrats&contrat=${sub.id}`,
        at: row.createdAt.toISOString(),
      },
    ]);
    expect(PUSHED_KINDS.has("buyout_offer")).toBe(true);
    // Déjà vu : rien de nouveau après sa création.
    expect((await listNotifications(new Date(row.createdAt.getTime() + 1))).some((i) => i.kind === "buyout_offer")).toBe(false);
  });
});
