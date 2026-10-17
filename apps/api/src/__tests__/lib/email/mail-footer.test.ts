import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { renderEmailHtml, renderEmailTextFooter } from "@/lib/email/layout.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

type Sent = { text?: string; html?: string };
const sent: Sent[] = [];

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
  resolveFromAddress: async () => "Kouzia <contact@kouzia.test>",
  getSharedTransport: async () => ({
    sendMail: async (opts: Sent) => {
      sent.push(opts);
      return { messageId: `<${sent.length}@smtp>` };
    },
  }),
}));

const { enqueueEmail } = await import("@/lib/email/mailer/outbox.js");
const { sendOutboxNow } = await import("@/lib/email/mailer/processor.js");
const { brandFromSettings, buildEmailContent } = await import("@/lib/email/templates.js");

const brand = {
  tradeName: "Kouzia",
  legalName: "Alexandre Kouziaeff",
  siret: "10858002800018",
  email: "contact@kouzia.com",
  website: "kouzia.com",
  addressLine1: "13 Le Petit Moulin",
  postalCode: "29690",
  city: "Huelgoat",
};

const count = (s: string, part: string) => s.split(part).length - 1;

describe("signature par défaut", () => {
  it("nom commercial, e-mail et site, sans SIRET, adresse ni raison sociale", () => {
    expect(formatPlainTextSignature({ emailSignatureHtml: null }, brand)).toBe(
      "Cordialement,\nKouzia\ncontact@kouzia.com\nkouzia.com",
    );
  });

  it("sans nom commercial : raison sociale, une seule fois", () => {
    const sig = formatPlainTextSignature({ emailSignatureHtml: "" }, { ...brand, tradeName: "" });
    expect(count(sig, "Alexandre Kouziaeff")).toBe(1);
    expect(sig).not.toContain("SIRET");
  });
});

describe("pied de mail", () => {
  it("HTML : mentions légales une seule fois, dans le pied", () => {
    const text = `Bonjour,\n\nMerci.\n\n${formatPlainTextSignature({ emailSignatureHtml: null }, brand)}`;
    const html = renderEmailHtml({ text, brand });
    expect(count(html, "SIRET 10858002800018")).toBe(1);
    expect(count(html, "13 Le Petit Moulin")).toBe(1);
    expect(count(html, "Alexandre Kouziaeff")).toBe(1);
  });

  it("texte : même contenu que le pied HTML", () => {
    expect(renderEmailTextFooter(brand)).toBe(
      "Alexandre Kouziaeff · SIRET 10858002800018 · 13 Le Petit Moulin, 29690 Huelgoat\nkouzia.com",
    );
  });
});

describe("envoi : parties texte et HTML", () => {
  beforeEach(async () => {
    sent.length = 0;
    await resetDb();
    await seedCompanySettings();
    await prisma.companySettings.updateMany({ data: { emailSignatureHtml: null, website: "kouzia.test" } });
    invalidateCompanySettingsCache();
  });

  it("e-mail de document : SIRET et adresse une seule fois dans chaque partie", async () => {
    const built = await buildEmailContent({ kind: "invoice", clientName: "Lou", docNumber: "F-1", brand: await brandFromSettings() });
    const { outboxId } = await enqueueEmail({ to: "c@example.com", subject: "F-1", text: built.text, html: built.html, kind: "invoice" });
    await sendOutboxNow(outboxId);
    const mail = sent.at(-1)!;
    for (const part of [mail.text!, mail.html!]) {
      expect(count(part, "SIRET 00000000000000")).toBe(1);
      expect(count(part, "1 rue Test, 29000 Quimper")).toBe(1);
      expect(count(part, "Test SARL")).toBe(1);
    }
    expect(mail.text!.endsWith("Test SARL · SIRET 00000000000000 · 1 rue Test, 29000 Quimper\nkouzia.test")).toBe(true);
  });

  it("e-mail automatique en texte seul : pied ajouté au texte et au HTML généré", async () => {
    const { outboxId } = await enqueueEmail({ to: "c@example.com", subject: "x", text: "Bonjour", kind: "access" });
    await sendOutboxNow(outboxId);
    const mail = sent.at(-1)!;
    expect(count(mail.text!, "SIRET 00000000000000")).toBe(1);
    expect(count(mail.html!, "SIRET 00000000000000")).toBe(1);
  });

  it("message rédigé à la main : texte inchangé, sans pied", async () => {
    const { outboxId } = await enqueueEmail({ to: "c@example.com", subject: "x", text: "Bonjour", kind: "custom" });
    await sendOutboxNow(outboxId);
    expect(sent.at(-1)!.text).toBe("Bonjour");
  });
});
