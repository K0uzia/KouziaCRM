import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { encrypt } from "@/lib/crypto.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// « Vérifier l'e-mail » (E6c) : brouillon sans envoi, puis envoi avec l'objet et le message relus.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));

const { buildApp } = await import("@/app.js");
const { issueInvoice } = await import("@/lib/invoices/transitions.js");

const ADMIN = "admin-verifier@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
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
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((x) => x.name === SESSION_COOKIE)?.value}`;
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });
const queued = async () => (await prisma.emailOutbox.findMany()).map((m) => JSON.parse(outboxPayloadRaw(m)) as { subject: string; text: string; kind?: string });

async function clientWithEmail(email = "lou@example.com") {
  const c = await createClient({ displayName: "Lou Martin", type: "B2C" });
  await prisma.client.update({ where: { id: c.id }, data: { firstName: "Lou", emailEncrypted: encrypt(email) } });
  return c;
}

describe("Vérifier l'e-mail : accès à l'espace client", () => {
  it("brouillon sans rien envoyer, puis envoi de l'objet et du message relus ; client sans adresse signalé", async () => {
    const c = await clientWithEmail();
    const draft = await get(`/api/clients/${c.id}/portal/welcome/draft`);
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ to: "lou@example.com", attachments: [] });
    expect(draft.json().text).toContain("Votre espace client est prêt");
    expect(await prisma.emailOutbox.count()).toBe(0);

    const sent = await post(`/api/clients/${c.id}/portal/welcome`, { subject: "Votre accès", text: "Bonjour Lou,\n\nVoici votre accès." });
    expect(sent.json()).toEqual({ sent: true });
    expect(await queued()).toEqual([expect.objectContaining({ subject: "Votre accès", text: "Bonjour Lou,\n\nVoici votre accès.", kind: "access" })]);

    const noEmail = await createClient({ displayName: "Sans Mail" });
    expect((await get(`/api/clients/${noEmail.id}/portal/welcome/draft`)).statusCode).toBe(409);
  });
});

describe("Vérifier l'e-mail : invitation à compléter la fiche", () => {
  it("brouillon avec {{lien}} ; à l'envoi, le lien personnel le remplace, ou s'ajoute s'il a été retiré", async () => {
    const draft = await get(`/api/onboarding/invite/draft?email=${encodeURIComponent("Prospect@Example.com")}`);
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ to: "prospect@example.com" });
    expect(draft.json().text).toContain("{{lien}}");
    expect(await prisma.onboardingInvitation.count()).toBe(0);

    await post("/api/onboarding/invite", { email: "prospect@example.com", subject: "Votre fiche", text: "Bonjour,\n\nVotre lien : {{lien}}\n\nMerci." });
    await post("/api/onboarding/invite", { email: "autre@example.com", text: "Bonjour, merci de compléter votre fiche." });
    const [a, b] = await queued();
    expect(a!.subject).toBe("Votre fiche");
    expect(a!.text).toMatch(/Votre lien : https?:\/\/\S+\/nouveau-client\/\?token=\S+\n\nMerci\./);
    expect(a!.text).not.toContain("{{lien}}");
    expect(b!.text).toMatch(/^Bonjour, merci de compléter votre fiche\.\n\nhttps?:\/\/\S+\/nouveau-client\/\?token=/);
    expect((await get("/api/onboarding/invite/draft?email=pas-une-adresse")).statusCode).toBe(400);
  });
});

describe("Vérifier l'e-mail : relance et renvoi du document", () => {
  async function issued() {
    const c = await clientWithEmail();
    const inv = await prisma.invoice.create({
      data: {
        clientId: c.id,
        documentType: InvoiceDocumentType.INVOICE,
        status: InvoiceStatus.DRAFT,
        subtotalCents: 12_000,
        totalCents: 12_000,
        lines: { create: [{ position: 1, description: "Site", quantity: 1, unitPriceCents: 12_000, lineTotalCents: 12_000 }] },
      },
    });
    await issueInvoice(inv.id);
    await prisma.emailOutbox.deleteMany();
    return prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  }

  it("relance : brouillon, puis envoi relu ; la relance est comptée", async () => {
    const inv = await issued();
    const draft = await get(`/api/invoices/${inv.id}/reminders/draft`);
    expect(draft.json()).toMatchObject({ to: "lou@example.com", subject: `Relance - facture ${inv.number}` });
    expect(await prisma.emailOutbox.count()).toBe(0);
    const res = await post(`/api/invoices/${inv.id}/reminders/send`, { subject: "Petit rappel", text: "Bonjour Lou,\n\nUn petit rappel." });
    expect(res.json().emailed).toBe(true);
    expect(await queued()).toEqual([expect.objectContaining({ subject: "Petit rappel", text: "Bonjour Lou,\n\nUn petit rappel." })]);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).reminderCount).toBe(1);
  });

  it("renvoi : brouillon avec la pièce jointe, sans effet de bord (aucun lien de paiement créé, rien en file)", async () => {
    const inv = await issued();
    await prisma.invoice.update({ where: { id: inv.id }, data: { checkoutUrl: null } });
    const draft = await get(`/api/invoices/${inv.id}/send-email/draft`);
    expect(draft.statusCode).toBe(200);
    expect(draft.json().subject).toContain(inv.number!);
    expect(draft.json().attachments).toHaveLength(1);
    expect(draft.json().attachments[0]).toMatch(/\.pdf$/);
    expect(await prisma.emailOutbox.count()).toBe(0);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).checkoutUrl).toBeNull();

    await post(`/api/invoices/${inv.id}/send-email`, { subject: "Votre facture", text: "Bonjour,\n\nVoici votre facture." });
    const [mail] = await queued();
    expect(mail!.subject).toBe("Votre facture");
    expect(mail!.text.startsWith("Bonjour,\n\nVoici votre facture.")).toBe(true);
  });
});
