import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { EmailOutboxStatus, InvoiceDocumentType, InvoiceStatus, MilestoneStatus, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { decrypt, encrypt } from "@/lib/crypto.js";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// « E-mails à valider » (E6a) : les e-mails automatiques au client attendent la validation ; codes et alertes partent aussitôt.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));

const { buildApp } = await import("@/app.js");
const { mailEnqueue } = await import("@/lib/email/mailer/index.js");
const { sendDueReminders } = await import("@/lib/reminders/send.js");
const { sendDueDepositReminders } = await import("@/lib/reminders/deposit-send.js");
const { sendLoginCodeEmail, sendSignCodeEmail } = await import("@/lib/clients/access-email.js");

const ADMIN = "admin-valider@kouzia.test";
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.emailOutbox.deleteMany();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((x) => x.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const rows = () => prisma.emailOutbox.findMany({ orderBy: { createdAt: "asc" } });
const payloadOf = (row: Awaited<ReturnType<typeof rows>>[number]) => JSON.parse(outboxPayloadRaw(row)) as { subject: string; text: string; html?: string };
const setAutoApprove = async (json: string) => {
  await prisma.companySettings.updateMany({ data: { emailAutoApproveKinds: json } });
  invalidateCompanySettingsCache();
};

async function clientWithEmail() {
  const c = await createClient({ displayName: "Lou Martin", type: "B2C" });
  return prisma.client.update({ where: { id: c.id }, data: { firstName: "Lou", emailEncrypted: encrypt("lou@example.com") } });
}

describe("mise en file", () => {
  it("automatique : en attente ; famille validée d'office : envoi ; mise en demeure toujours en attente ; codes et alertes : aussitôt", async () => {
    const c = await clientWithEmail();
    const auto = await mailEnqueue({ to: "lou@example.com", subject: "Relance", text: "x", clientId: c.id, kind: "reminder_soft" }, { review: { family: "reminder", origin: "WORKER" } });
    expect(auto.awaitingReview).toBe(true);

    await setAutoApprove(JSON.stringify(["reminder", "formal_notice"]));
    const approved = await mailEnqueue({ to: "lou@example.com", subject: "Relance", text: "x", kind: "reminder_soft" }, { review: { family: "reminder", origin: "WORKER" } });
    expect(approved.awaitingReview).toBe(false);
    // Réglage forcé en base : la mise en demeure reste validée à la main.
    const formal = await mailEnqueue({ to: "lou@example.com", subject: "Mise en demeure", text: "x", kind: "reminder_formal" }, { review: { family: "formal_notice", origin: "WORKER" } });
    expect(formal.awaitingReview).toBe(true);

    await setAutoApprove("[]");
    await sendLoginCodeEmail(c, "123456");
    await sendSignCodeEmail(c, "654321", "D-2026-0001");
    const codes = (await rows()).filter((r) => r.reviewKind === "portal_code");
    expect(codes.length).toBe(2);
    expect(codes.every((r) => r.status !== EmailOutboxStatus.REVIEW)).toBe(true);
    const row = (await rows()).find((r) => r.id === auto.outboxId)!;
    expect(row).toMatchObject({ status: EmailOutboxStatus.REVIEW, origin: "WORKER", reviewFamily: "reminder", reviewKind: "reminder_soft" });
  });
});

describe("documents envoyés d'office", () => {
  it("facture d'abonnement (automatique) : en attente ; renvoi relu sur clic : envoi direct", async () => {
    const { sendDocumentPdf } = await import("@/lib/email/send-document-pdf.js");
    const { issueInvoice } = await import("@/lib/invoices/transitions.js");
    const c = await clientWithEmail();
    const inv = await prisma.invoice.create({
      data: {
        clientId: c.id,
        documentType: InvoiceDocumentType.INVOICE,
        status: InvoiceStatus.DRAFT,
        subtotalCents: 12_000,
        totalCents: 12_000,
        lines: { create: [{ position: 1, description: "Abonnement", quantity: 1, unitPriceCents: 12_000, lineTotalCents: 12_000 }] },
      },
    });
    await issueInvoice(inv.id);
    await prisma.emailOutbox.deleteMany();
    const auto = await sendDocumentPdf(inv.id, { review: { family: "subscription_invoice", origin: "WORKER" } });
    expect(auto).toMatchObject({ sent: true, awaitingReview: true });
    const click = await sendDocumentPdf(inv.id, { subject: "Votre facture", text: "Bonjour Lou,\n\nVoici votre facture." });
    expect(click.awaitingReview).toBe(false);
    const byId = new Map((await rows()).map((r) => [r.id, r.status]));
    expect(byId.get(auto.outboxId!)).toBe(EmailOutboxStatus.REVIEW);
    expect(byId.get(click.outboxId!)).toBe(EmailOutboxStatus.PENDING);
  });
});

describe("file à valider", () => {
  async function queued(subject: string, clientWaiting = false) {
    const c = await clientWithEmail();
    const r = await mailEnqueue(
      { to: "lou@example.com", subject, text: "Bonjour Lou,\n\nTexte d'origine.", html: "<p>Texte d'origine.</p>", clientId: c.id, kind: "payment_failed" },
      { review: { family: "payment_issue", origin: "WEBHOOK", clientWaiting } },
    );
    return r.outboxId;
  }

  it("liste (client qui attend d'abord), détail, validation relue, refus motivé, validation groupée, compteur", async () => {
    const a = await queued("Paiement non abouti A");
    const b = await queued("Paiement non abouti B", true);
    const c = await queued("Paiement non abouti C");
    expect((await app.inject({ method: "GET", url: "/api/emails/review" })).statusCode).toBe(401);

    const list = (await call("GET", "/api/emails/review")).json() as { pending: Array<{ id: string; clientWaiting: boolean; familyLabel: string; originLabel: string }> };
    expect(list.pending.map((x) => x.id)).toEqual([b, a, c]);
    expect(list.pending[0]).toMatchObject({ clientWaiting: true, familyLabel: "Échec ou régularisation de paiement", originLabel: "Paiement Stripe" });
    expect((await call("GET", "/api/emails/review/count")).json()).toEqual({ count: 3 });
    expect((await call("GET", `/api/emails/review/${a}`)).json().text).toBe("Bonjour Lou,\n\nTexte d'origine.");

    expect((await call("POST", `/api/emails/review/${a}/approve`, { subject: "Paiement à reprendre", text: "Bonjour Lou,\n\nTexte relu." })).json()).toEqual({ approved: true });
    const sentA = (await rows()).find((r) => r.id === a)!;
    expect(sentA.status).toBe(EmailOutboxStatus.PENDING);
    expect(payloadOf(sentA)).toMatchObject({ subject: "Paiement à reprendre", text: "Bonjour Lou,\n\nTexte relu." });
    expect(payloadOf(sentA).html).toBeUndefined();
    expect((await call("POST", `/api/emails/review/${a}/approve`)).statusCode).toBe(409);

    expect((await call("POST", `/api/emails/review/${b}/reject`, { reason: " " })).statusCode).toBe(400);
    expect((await call("POST", `/api/emails/review/${b}/reject`, { reason: "Déjà réglé par téléphone" })).json()).toEqual({ rejected: true });
    const rejected = (await rows()).find((r) => r.id === b)!;
    expect(rejected.status).toBe(EmailOutboxStatus.REJECTED);
    expect(rejected.rejectReason).not.toContain("téléphone");
    expect(decrypt(rejected.rejectReason!)).toBe("Déjà réglé par téléphone");

    expect((await call("POST", "/api/emails/review/approve", { ids: [a, b, c] })).json()).toEqual({ approved: 1 });
    expect((await call("GET", "/api/emails/review/count")).json()).toEqual({ count: 0 });
    const after = (await call("GET", "/api/emails/review")).json() as { pending: unknown[]; rejected: Array<{ id: string; rejectReason: string }> };
    expect(after.pending).toEqual([]);
    expect(after.rejected).toEqual([expect.objectContaining({ id: b, rejectReason: "Déjà réglé par téléphone" })]);
  });
});

describe("réglage des familles validées d'office", () => {
  it("vide par défaut ; mise en demeure refusée par l'API ; familles enregistrées sans doublon", async () => {
    const initial = (await call("GET", "/api/settings/email-review")).json() as { autoApprove: string[]; families: Array<{ id: string; alwaysReviewed: boolean }> };
    expect(initial.autoApprove).toEqual([]);
    expect(initial.families.find((f) => f.id === "formal_notice")?.alwaysReviewed).toBe(true);

    expect((await call("PUT", "/api/settings/email-review", { autoApprove: ["reminder", "formal_notice"] })).statusCode).toBe(400);
    expect((await call("PUT", "/api/settings/email-review", { autoApprove: ["inconnue"] })).statusCode).toBe(400);
    const saved = await call("PUT", "/api/settings/email-review", { autoApprove: ["payment_receipt", "reminder", "reminder"] });
    expect(saved.json().autoApprove).toEqual(["payment_receipt", "reminder"]);
  });
});

describe("aucune copie au cycle suivant", () => {
  async function sentQuote(nextReminderAt: Date, number = "D-2026-0042") {
    const c = await clientWithEmail();
    return prisma.invoice.create({
      data: {
        clientId: c.id,
        documentType: InvoiceDocumentType.QUOTE,
        status: InvoiceStatus.ISSUED,
        quoteStatus: QuoteStatus.SENT,
        number,
        subtotalCents: 50_000,
        totalCents: 50_000,
        nextReminderAt,
      },
    });
  }

  it("relance en attente : pas de copie au passage suivant ; validée, elle reprend le rythme ; refusée, elle repart au cycle suivant", async () => {
    const now = new Date("2026-10-20T09:00:00Z");
    const q = await sentQuote(new Date("2026-10-19T09:00:00Z"));
    expect(await sendDueReminders(now)).toBe(1);
    expect(await sendDueReminders(new Date(now.getTime() + 3_600_000))).toBe(0);
    expect(await sendDueReminders(new Date(now.getTime() + 86_400_000))).toBe(0);
    const [row] = await rows();
    expect(row!.status).toBe(EmailOutboxStatus.REVIEW);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).nextReminderAt).toBeNull();

    await call("POST", `/api/emails/review/${row!.id}/approve`);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).nextReminderAt).not.toBeNull();

    const q2 = await sentQuote(new Date("2026-10-19T09:00:00Z"), "D-2026-0044");
    await sendDueReminders(now);
    const second = (await rows()).find((r) => r.documentId === q2.id)!;
    await call("POST", `/api/emails/review/${second.id}/reject`, { reason: "Trop tôt" });
    const next = (await prisma.invoice.findUniqueOrThrow({ where: { id: q2.id } })).nextReminderAt!;
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it("rappel d'acompte en attente : pas de copie au passage suivant, même jour", async () => {
    await prisma.companySettings.updateMany({
      data: { reminderDepositMinus7Enabled: true, reminderDepositMinus7Days: 7, reminderDepositMinus1Enabled: false, reminderDepositPlus3Enabled: false, reminderDepositPlus10Enabled: false },
    });
    invalidateCompanySettingsCache();
    const c = await clientWithEmail();
    const quote = await prisma.invoice.create({
      data: { clientId: c.id, documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.ISSUED, quoteStatus: QuoteStatus.ACCEPTED, number: "D-2026-0043", subtotalCents: 100_000, totalCents: 100_000 },
    });
    const now = new Date("2026-10-20T09:00:00Z");
    await prisma.paymentMilestone.create({
      data: { quoteId: quote.id, position: 1, label: "Acompte", percentBps: 3000, amountCents: 30_000, triggerText: "À la signature", status: MilestoneStatus.PENDING, dueDate: new Date("2026-10-27T09:00:00Z") },
    });
    expect(await sendDueDepositReminders(now)).toBe(1);
    expect(await sendDueDepositReminders(new Date(now.getTime() + 3_600_000))).toBe(0);
    const list = await rows();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: EmailOutboxStatus.REVIEW, reviewFamily: "deposit_reminder" });
  });
});
