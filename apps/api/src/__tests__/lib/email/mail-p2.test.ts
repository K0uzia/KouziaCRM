import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, ObligationStatus, ObligationType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { sanitizeSignatureHtml, SIGNATURE_HTML_MAX } from "@/lib/email/signature.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

type Sent = { text?: string; html?: string };
const sent: Sent[] = [];

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
  resolveFromAddress: async () => "Test <contact@kouzia.test>",
  getSharedTransport: async () => ({
    sendMail: async (opts: Sent) => {
      sent.push(opts);
      return { messageId: `<${sent.length}@smtp>` };
    },
  }),
}));

const { buildApp } = await import("@/app.js");
const { sendOutboxNow } = await import("@/lib/email/mailer/processor.js");
const { sendDueObligationEmails } = await import("@/lib/obligations/email-reminders.js");

const ADMIN = "admin-mail-p2@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
const SIRET = "SIRET 00000000000000";
const ADDRESS = "1 rue Test, 29000 Quimper";
let app: FastifyInstance;
let cookie = "";

const count = (s: string, part: string) => s.split(part).length - 1;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  sent.length = 0;
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const saveSignature = (emailSignatureHtml: unknown) =>
  app.inject({ method: "PATCH", url: "/api/settings/email", headers: { cookie }, payload: { emailSignatureHtml } });

async function lastOutboxSent(): Promise<Sent> {
  const row = await prisma.emailOutbox.findFirstOrThrow({ orderBy: { scheduledAt: "desc" } });
  await sendOutboxNow(row.id);
  return sent.at(-1)!;
}

async function sendManualReminder() {
  const email = "lou@example.com";
  const client = await prisma.client.create({
    data: { displayName: "Lou", type: "B2B", emailEncrypted: encrypt(email), emailHash: computeEmailHash(email) },
  });
  const invoice = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.INVOICE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.ISSUED,
      number: "F-2026-0700",
      clientId: client.id,
      subtotalCents: 10_000,
      totalCents: 10_000,
      issueDate: new Date(2026, 9, 1),
    },
  });
  const res = await app.inject({ method: "POST", url: `/api/invoices/${invoice.id}/reminders/send`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as { emailed: boolean; mailto: string | null };
}

describe("relance manuelle", () => {
  it("signature des réglages, pied légal une seule fois dans le texte et le HTML", async () => {
    const res = await sendManualReminder();
    expect(res.emailed).toBe(true);
    const mail = await lastOutboxSent();
    expect(mail.text).not.toContain("Cordialement,\nKouzia");
    expect(mail.text).toContain("Cordialement,\nTest");
    for (const part of [mail.text!, mail.html!]) {
      expect(count(part, SIRET)).toBe(1);
      expect(count(part, ADDRESS)).toBe(1);
    }
    // Brouillon mailto (sans SMTP côté client) : même pied, une fois.
    const mailtoBody = decodeURIComponent(res.mailto!.split("&body=")[1]!);
    expect(count(mailtoBody, SIRET)).toBe(1);
  });

  it("signature personnalisée enregistrée : reprise dans l'envoi", async () => {
    expect((await saveSignature("<p>Bien à vous,<br><strong>Alexandre</strong></p>")).statusCode).toBe(200);
    await sendManualReminder();
    const mail = await lastOutboxSent();
    expect(mail.text).toContain("Bien à vous,\nAlexandre");
    expect(mail.text).not.toContain("Cordialement");
    expect(count(mail.text!, SIRET)).toBe(1);
    expect(mail.html).toContain("Alexandre");
  });
});

describe("rappels d'obligations", () => {
  it("HTML de la charte, pied légal identique au texte, une seule fois", async () => {
    await prisma.companySettings.updateMany({
      data: { obligationEmailRemindersEnabled: true, obligationReminderEmail: "moi@kouzia.test" },
    });
    invalidateCompanySettingsCache();
    const due = new Date();
    due.setHours(12, 0, 0, 0);
    await prisma.obligation.create({
      data: {
        type: ObligationType.URSSAF_DECLARATION,
        period: "2026-03",
        dueDate: due,
        status: ObligationStatus.PENDING,
        label: "Déclaration URSSAF : mars 2026",
      },
    });
    expect(await sendDueObligationEmails(due)).toBe(1);
    const mail = await lastOutboxSent();
    for (const part of [mail.text!, mail.html!]) {
      expect(count(part, SIRET)).toBe(1);
      expect(count(part, ADDRESS)).toBe(1);
      expect(part).toContain("Déclaration URSSAF : mars 2026");
    }
    // Mise en page commune (layout.ts) : bandeau, bouton vers la démarche officielle.
    expect(mail.html).toMatch(/^<!doctype html>/);
    expect(mail.html).toContain("Ouvrir la démarche officielle");
  });
});

describe("signature : assainissement", () => {
  it("garde p, br, strong, em et les liens http, https, mailto, tel", () => {
    const html =
      '<p>A<br><strong>B</strong> <em>C</em> <a href="https://kouzia.com">site</a> <a href="mailto:a@b.fr">m</a> <a href="tel:+33600000000">t</a></p>';
    expect(sanitizeSignatureHtml(html)).toBe(html);
  });

  it("retire script, onerror, javascript: et les balises hors liste", () => {
    const out = sanitizeSignatureHtml(
      '<p onclick="x()">Salut<script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">lien</a><a href="/relatif">r</a><span style="color:red">S</span></p>',
    )!;
    expect(out).not.toMatch(/script|onerror|onclick|javascript:|<img|<span|style=|href="\/relatif"/i);
    expect(out).toContain("Salut");
    expect(out).toContain("lien");
    expect(out).toContain("S");
  });

  it("signature vide une fois nettoyée : null (signature par défaut)", () => {
    expect(sanitizeSignatureHtml("<script>alert(1)</script>")).toBeNull();
    expect(sanitizeSignatureHtml("  ")).toBeNull();
    expect(sanitizeSignatureHtml(null)).toBeNull();
  });

  it("tirets typographiques ramenés au trait d'union", () => {
    expect(sanitizeSignatureHtml("<p>A \u2014 B \u2013 C</p>")).toBe("<p>A - B - C</p>");
  });
});

describe("signature : route des réglages", () => {
  it("assainit avant enregistrement et renvoie la valeur propre", async () => {
    const res = await saveSignature('<p>Alexandre<img src=x onerror="alert(1)"></p><script>alert(1)</script>');
    expect(res.statusCode).toBe(200);
    expect(res.json().emailSignatureHtml).toBe("<p>Alexandre</p>");
    expect((await prisma.companySettings.findFirstOrThrow()).emailSignatureHtml).toBe("<p>Alexandre</p>");
  });

  it("valide le type et la longueur, sans rien enregistrer", async () => {
    await saveSignature("<p>Avant</p>");
    expect((await saveSignature(42)).statusCode).toBe(400);
    expect((await saveSignature("x".repeat(SIGNATURE_HTML_MAX + 1))).statusCode).toBe(400);
    expect((await prisma.companySettings.findFirstOrThrow()).emailSignatureHtml).toBe("<p>Avant</p>");
  });

  it("chaîne vide ou null : retour à la signature par défaut", async () => {
    await saveSignature("<p>Avant</p>");
    expect((await saveSignature("")).statusCode).toBe(200);
    expect((await prisma.companySettings.findFirstOrThrow()).emailSignatureHtml).toBeNull();
    await saveSignature("<p>Avant</p>");
    await saveSignature(null);
    expect((await prisma.companySettings.findFirstOrThrow()).emailSignatureHtml).toBeNull();
  });

  it("refuse sans session", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/settings/email", payload: { emailSignatureHtml: "<p>x</p>" } });
    expect(res.statusCode).toBe(401);
  });
});
