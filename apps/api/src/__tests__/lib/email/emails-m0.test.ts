import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailOutboxStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { getCompanySettings } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: vi.fn(async () => true),
}));

const { buildEmailContent } = await import("@/lib/email/templates.js");
const { buildEmailBrand } = await import("@/lib/email/deposit-templates.js");
const { sendPortalWelcomeEmail } = await import("@/lib/clients/access-email.js");
const { onboardingInviteDraft } = await import("@/lib/clients/onboarding.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

describe("M0 : écarts relevés pendant l'inventaire des e-mails", () => {
  it("rappel d'acompte : jalon, étape et échéance dans le texte, avant le lien de paiement", async () => {
    const settings = await getCompanySettings();
    const built = await buildEmailContent({
      kind: "reminder_soft",
      clientName: "Lou Martin",
      clientFirstName: "Lou",
      docNumber: "D-2026-0001",
      docLabel: "acompte",
      brand: buildEmailBrand(settings),
      extraLines: ["Jalon : Acompte de 30 %", "Échéance dans 7 jours", "Échéance : 01/11/2026"],
      paymentUrl: "https://pay.test/x",
    });
    const text = built.text;
    for (const line of ["Jalon : Acompte de 30 %", "Échéance dans 7 jours", "Échéance : 01/11/2026"]) expect(text).toContain(line);
    expect(text.indexOf("Échéance : 01/11/2026")).toBeLessThan(text.indexOf("https://pay.test/x"));
    // Relance sans lignes d'information : texte inchangé (pas de ligne vide en trop).
    const plain = await buildEmailContent({ kind: "reminder_soft", clientName: "Lou Martin", docNumber: "F-1", docLabel: "facture", brand: buildEmailBrand(settings) });
    expect(plain.text).not.toMatch(/\n\n\n/);
  });

  it("bienvenue après la fiche remplie : file « E-mails à valider » (portal_access, le client attend) ; envoi manuel inchangé", async () => {
    const c = await createClient({ displayName: "Lou Martin" });
    await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt("lou@example.test") } });
    await sendPortalWelcomeEmail(c.id, {}, { family: "portal_access", origin: "CLIENT_ACTION", clientWaiting: true });
    await sendPortalWelcomeEmail(c.id);
    const rows = await prisma.emailOutbox.findMany({ where: { reviewKind: "access" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.status, r.reviewFamily, r.clientWaiting])).toEqual([
      [EmailOutboxStatus.REVIEW, "portal_access", true],
      [EmailOutboxStatus.PENDING, null, false],
    ]);
  });

  it("invitation à remplir sa fiche : signature des Réglages, plus de « Cordialement » en dur", async () => {
    await prisma.companySettings.updateMany({ data: { emailSignatureHtml: "<p>Bien à vous,<br>Alexandre</p>" } });
    (await import("@/lib/company.js")).invalidateCompanySettingsCache();
    const draft = await onboardingInviteDraft("lou@example.test", null);
    expect(draft.text.trimEnd().endsWith("Bien à vous,\nAlexandre")).toBe(true);
    expect(draft.text).not.toContain("Cordialement");
  });
});
