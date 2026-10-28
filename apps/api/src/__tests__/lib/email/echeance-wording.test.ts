import { beforeEach, describe, expect, it } from "vitest";
import { getCompanySettings } from "@/lib/company.js";
import { buildEmailBrand, instalmentWording, renderDepositCheckoutEmail, renderDepositPaidEmail } from "@/lib/email/deposit-templates.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// E-mails d'échéance (audit du 28/10/2026) : un seul mot pour le lien et le reçu, « solde » pour la vraie dernière
// échéance seulement.
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

const common = async () => {
  const settings = await getCompanySettings();
  return { brand: buildEmailBrand(settings), settings, clientFirstName: "Lou", clientName: "Lou Martin", quoteNumber: "D-2026-0042", amountCents: 165_000 };
};

describe("e-mails d'échéance d'un devis", () => {
  it("mot unique : paiement (comptant), échéance (autres), solde (dernière d'un échéancier)", () => {
    expect(instalmentWording(1, 1).nature).toBe("paiement");
    expect(instalmentWording(1, 3).nature).toBe("échéance");
    expect(instalmentWording(2, 3).nature).toBe("échéance");
    expect(instalmentWording(3, 3).nature).toBe("solde");
  });

  it("paiement comptant (échéance unique) : l'e-mail de lien ne parle pas de « solde »", async () => {
    const mail = await renderDepositCheckoutEmail({ ...(await common()), brandPrimaryColor: "#fe9a00", checkoutUrl: "https://pay.test/a", depositIndex: 1, depositTotal: 1, label: "Paiement comptant" });
    expect(mail.subject).not.toMatch(/solde/);
    expect(mail.subject).toBe("Devis validé : réglez le paiement");
  });

  it("lien et reçu emploient le même mot, pour chaque échéance d'un paiement en 3 fois", async () => {
    const c = await common();
    for (const [index, word] of [[1, "échéance"], [2, "échéance"], [3, "solde"]] as const) {
      const label = `${index}e échéance`;
      const link = await renderDepositCheckoutEmail({ ...c, brandPrimaryColor: "#fe9a00", checkoutUrl: "https://pay.test/a", depositIndex: index, depositTotal: 3, label });
      const paid = await renderDepositPaidEmail({ ...c, depositIndex: index, depositTotal: 3, label });
      expect(link.subject).toContain(word);
      expect(paid.subject).toContain(word);
    }
  });
});
