// Abonnements multiples : devis antérieurs aux avenants ciblés (repli), rattachement par l'admin, renouvellements
// chez un tiers (gestion autonome).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/send-document-pdf.js", () => ({ sendDocumentPdf: vi.fn(async () => ({ sent: false })) }));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  mailEnqueue: vi.fn(async () => ({ outboxId: "outbox-1", messageId: "<x@y>" })),
}));

const { issueQuote, acceptQuoteByClient } = await import("@/lib/invoices/transitions.js");
const { listRevisionsToAttach, attachRevisionLine, resetTargetedRevisionsCutoff } = await import("@/lib/subscriptions/activate-from-document.js");
const { mailEnqueue } = await import("@/lib/email/mailer/index.js");
const renewals = await import("@/lib/clients/renewals.js");

const MIGRATION = "20261112090000_avenant_abonnement";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  vi.mocked(mailEnqueue).mockClear();
  resetTargetedRevisionsCutoff();
});
afterEach(async () => {
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "_prisma_migrations"');
  resetTargetedRevisionsCutoff();
  await resetDb();
});

/** Historique de migrations comme en production (migrate deploy) : finished_at en millisecondes. */
async function migrationAppliedAt(at: Date) {
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "_prisma_migrations" ("id" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT current_timestamp, "applied_steps_count" INTEGER NOT NULL DEFAULT 0)',
  );
  await prisma.$executeRawUnsafe('INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name") VALUES (?, ?, ?, ?)', "m1", "x", at.getTime(), MIGRATION);
  resetTargetedRevisionsCutoff();
}

async function client() {
  const c = await createClient({ displayName: "Lou Abonnée", type: "B2B" });
  await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt("lou@example.test") } });
  return c;
}

async function activeSubscription(clientId: string, label: string, amountCents: number) {
  const service = await createService({ name: label });
  return prisma.subscription.create({
    data: { clientId, serviceId: service.id, label, amountCents, billingDay: 1, startDate: new Date(2026, 0, 1), nextInvoiceAt: new Date(2026, 11, 1) },
  });
}

/** Devis d'une ligne d'abonnement sans revisesSubscriptionId (avenant envoyé avant la migration, ou nouveau devis). */
async function quoteFor(clientId: string, description: string, amountCents: number, createdAt: Date) {
  const service = await createService({ name: description });
  const quote = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      clientId,
      subtotalCents: amountCents,
      totalCents: amountCents,
      createdAt,
      lines: {
        create: [{ position: 1, description, quantity: 1, unitPriceCents: amountCents, lineTotalCents: amountCents, isSubscription: true, billingDay: 1, serviceId: service.id }],
      },
    },
  });
  await issueQuote(quote.id);
  return quote;
}

describe("devis antérieurs aux avenants ciblés", () => {
  it("un seul abonnement actif : révisé comme avant (avenant envoyé avant le déploiement)", async () => {
    await migrationAppliedAt(new Date(2026, 9, 16, 12));
    const c = await client();
    const sub = await activeSubscription(c.id, "Maintenance", 2900);
    const quote = await quoteFor(c.id, "Maintenance revue", 3900, new Date(2026, 9, 10));
    await acceptQuoteByClient(quote.id, "Lou Abonnée", { source: "PORTAL" });
    const subs = await prisma.subscription.findMany({ where: { clientId: c.id } });
    expect(subs).toHaveLength(1);
    expect([subs[0]!.id, subs[0]!.amountCents]).toEqual([sub.id, 3900]);
  });

  it("plusieurs abonnements actifs : rien d'écrasé, tâche « à rattacher », puis rattachement par l'admin", async () => {
    await migrationAppliedAt(new Date(2026, 9, 16, 12));
    const c = await client();
    const maintenance = await activeSubscription(c.id, "Maintenance", 2900);
    const mails = await activeSubscription(c.id, "Adresses e-mail", 6000);
    const quote = await quoteFor(c.id, "Adresses e-mail revues", 7200, new Date(2026, 9, 10));
    await acceptQuoteByClient(quote.id, "Lou Abonnée", { source: "PORTAL" });
    const untouched = await prisma.subscription.findMany({ where: { clientId: c.id }, orderBy: { amountCents: "asc" } });
    expect(untouched.map((s) => s.amountCents)).toEqual([2900, 6000]);

    const todo = await listRevisionsToAttach();
    expect(todo).toHaveLength(1);
    expect(todo[0]).toMatchObject({ quoteId: quote.id, displayName: "Lou Abonnée", description: "Adresses e-mail revues" });
    expect(todo[0]!.subscriptions.map((s) => s.id).sort()).toEqual([maintenance.id, mails.id].sort());

    await attachRevisionLine(mails.id, todo[0]!.lineId);
    const after = await prisma.subscription.findMany({ where: { clientId: c.id } });
    expect(after.find((s) => s.id === mails.id)!.amountCents).toBe(7200);
    expect(after.find((s) => s.id === maintenance.id)!.amountCents).toBe(2900);
    expect(await listRevisionsToAttach()).toEqual([]);
    await expect(attachRevisionLine(maintenance.id, todo[0]!.lineId)).rejects.toThrow(/déjà rattachée/);
  });

  it("nouveau devis (après la migration) pour un client déjà abonné : 2e abonnement, le 1er intact", async () => {
    await migrationAppliedAt(new Date(2026, 9, 16, 12));
    const c = await client();
    const maintenance = await activeSubscription(c.id, "Maintenance", 2900);
    const quote = await quoteFor(c.id, "Adresses e-mail", 6000, new Date(2026, 9, 20));
    await acceptQuoteByClient(quote.id, "Lou Abonnée", { source: "PORTAL" });
    const subs = await prisma.subscription.findMany({ where: { clientId: c.id } });
    expect(subs).toHaveLength(2);
    expect(subs.find((s) => s.id === maintenance.id)!.amountCents).toBe(2900);
    expect(await listRevisionsToAttach()).toEqual([]);
  });

  it("historique des migrations illisible : traité comme un nouveau devis, jamais de révision au hasard", async () => {
    const c = await client();
    const maintenance = await activeSubscription(c.id, "Maintenance", 2900);
    const quote = await quoteFor(c.id, "Adresses e-mail", 6000, new Date(2020, 0, 1));
    await acceptQuoteByClient(quote.id, "Lou Abonnée", { source: "PORTAL" });
    const subs = await prisma.subscription.findMany({ where: { clientId: c.id } });
    expect(subs).toHaveLength(2);
    expect(subs.find((s) => s.id === maintenance.id)!.amountCents).toBe(2900);
  });
});

describe("renouvellements chez un tiers (gestion autonome)", () => {
  const day = (y: number, m: number, d: number) => new Date(y, m, d);

  it("tâche à J-30 dans « À traiter », e-mail au client seulement si demandé, une seule fois", async () => {
    const c = await client();
    const interne = await renewals.createClientRenewal(c.id, { label: "Hébergement et domaine", provider: "Hostinger", renewsAt: day(2026, 11, 1), interval: "YEAR", notifyClient: false });
    await renewals.createClientRenewal(c.id, { label: "Adresses e-mail", provider: null, renewsAt: day(2026, 11, 5), interval: "YEAR", notifyClient: true });
    expect(await renewals.listDueClientRenewals(day(2026, 9, 30))).toEqual([]);
    const due = await renewals.listDueClientRenewals(day(2026, 10, 3));
    expect(due.map((r) => r.label)).toEqual(["Hébergement et domaine"]);
    expect(due[0]).toMatchObject({ id: interne.id, displayName: "Lou Abonnée", provider: "Hostinger" });

    expect(await renewals.sendDueClientRenewalNotices(day(2026, 10, 3))).toBe(0);
    expect(await renewals.sendDueClientRenewalNotices(day(2026, 10, 6))).toBe(1);
    expect(await renewals.sendDueClientRenewalNotices(day(2026, 10, 20))).toBe(0);
    const mail = vi.mocked(mailEnqueue).mock.calls[0]![0];
    expect(mail.to).toBe("lou@example.test");
    expect(mail.subject).toBe("Pensez au renouvellement de « Adresses e-mail » le 5 décembre 2026");
    expect(mail.text).toContain("chez votre hébergeur");
  });

  it("échéance passée : date suivante (annuelle ou mensuelle), l'e-mail repart pour la nouvelle échéance", async () => {
    const c = await client();
    const an = await renewals.createClientRenewal(c.id, { label: "Domaine", renewsAt: day(2026, 0, 15), interval: "YEAR", notifyClient: true });
    const mois = await renewals.createClientRenewal(c.id, { label: "Hébergement", renewsAt: day(2026, 8, 10), interval: "MONTH", notifyClient: false });
    expect(await renewals.advancePastClientRenewals(day(2026, 9, 1))).toBe(2);
    const [a, m] = await Promise.all([prisma.clientRenewal.findUniqueOrThrow({ where: { id: an.id } }), prisma.clientRenewal.findUniqueOrThrow({ where: { id: mois.id } })]);
    expect(a.renewsAt).toEqual(day(2027, 0, 15));
    expect(m.renewsAt).toEqual(day(2026, 9, 10));
  });

  it("refuse un libellé vide, un client inconnu, et un renouvellement d'un autre client", async () => {
    const c = await client();
    const autre = await createClient({ displayName: "Autre" });
    await expect(renewals.createClientRenewal(c.id, { label: "  ", renewsAt: day(2026, 11, 1), interval: "YEAR", notifyClient: false })).rejects.toThrow(/Libellé/);
    await expect(renewals.createClientRenewal("inconnu", { label: "Domaine", renewsAt: day(2026, 11, 1), interval: "YEAR", notifyClient: false })).rejects.toThrow(/introuvable/);
    const r = await renewals.createClientRenewal(c.id, { label: "Domaine", renewsAt: day(2026, 11, 1), interval: "YEAR", notifyClient: false });
    await expect(renewals.deleteClientRenewal(autre.id, r.id)).rejects.toThrow(/introuvable/);
  });
});
