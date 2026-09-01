import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptOptional } from "@/lib/crypto.js";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";
import {
  saveEmailTab,
  savePaymentsTab,
  toPublicSettings,
} from "@/lib/settings/service.js";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

afterEach(async () => {
  await resetDb();
});

describe("settings secrets", () => {
  it("conserve le mot de passe SMTP si le champ est laissé vide", async () => {
    await saveEmailTab({
      smtpHost: "smtp.hostinger.com",
      smtpPort: 465,
      smtpEncryption: "SSL",
      smtpUser: "contact@kouzia.com",
      smtpFrom: "KOUZIA <contact@kouzia.com>",
      smtpPass: "SecretPass1234",
    });
    const afterSet = await getCompanySettings();
    expect(decryptOptional(afterSet.smtpPassEncrypted)).toBe("SecretPass1234");
    expect(afterSet.smtpPassHint).toBe("••••••••1234");

    await saveEmailTab({
      smtpHost: "smtp.hostinger.com",
      smtpUser: "contact@kouzia.com",
      smtpFrom: "KOUZIA <contact@kouzia.com>",
      smtpPass: "",
    });
    invalidateCompanySettingsCache();
    const afterEmpty = await getCompanySettings();
    expect(decryptOptional(afterEmpty.smtpPassEncrypted)).toBe("SecretPass1234");
  });

  it("rechiffre quand une nouvelle valeur est fournie", async () => {
    await saveEmailTab({
      smtpHost: "smtp.hostinger.com",
      smtpUser: "contact@kouzia.com",
      smtpFrom: "KOUZIA <contact@kouzia.com>",
      smtpPass: "OldSecret9999",
    });
    await saveEmailTab({ smtpPass: "NewSecret0001" });
    invalidateCompanySettingsCache();
    const s = await getCompanySettings();
    expect(decryptOptional(s.smtpPassEncrypted)).toBe("NewSecret0001");
    expect(s.smtpPassHint).toBe("••••••••0001");
  });

  it("n'expose jamais les secrets dans toPublicSettings", async () => {
    await saveEmailTab({
      smtpHost: "smtp.hostinger.com",
      smtpUser: "contact@kouzia.com",
      smtpFrom: "KOUZIA <contact@kouzia.com>",
      smtpPass: "HiddenPass42",
    });
    await savePaymentsTab({
      revolutMerchantApiKey: "sk_test_abcdef",
      revolutWebhookSecret: "whsec_xyz",
    });
    invalidateCompanySettingsCache();
    const pub = toPublicSettings(await getCompanySettings());
    expect(JSON.stringify(pub)).not.toContain("HiddenPass42");
    expect(JSON.stringify(pub)).not.toContain("sk_test_abcdef");
    expect(JSON.stringify(pub)).not.toContain("whsec_xyz");
    expect(pub).not.toHaveProperty("smtpPassEncrypted");
    expect(pub.secrets.smtpPass.set).toBe(true);
    expect(pub.secrets.smtpPass.hint).toBe("••••••••ss42");
    expect(pub.secrets.revolutMerchantApiKey.set).toBe(true);
  });

  it("journalise les champs modifiés sans valeur secrète", async () => {
    await saveEmailTab(
      {
        smtpHost: "imap.hostinger.com",
        smtpUser: "contact@kouzia.com",
        smtpFrom: "KOUZIA <contact@kouzia.com>",
        smtpPass: "AuditSecret99",
      },
      { userId: "u1", userEmail: "admin@kouzia.com" },
    );
    const logs = await prisma.settingsAuditLog.findMany({
      where: { tab: "email" },
      orderBy: { createdAt: "desc" },
    });
    expect(logs.some((l) => l.field === "smtpPass")).toBe(true);
    expect(logs.every((l) => !l.field.includes("Encrypted"))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("AuditSecret99");
  });

  it("refuse des pourcentages acompte + solde qui ne font pas 100 %", async () => {
    await expect(
      savePaymentsTab({
        depositPercent1Bps: 5000,
        depositPercent2Bps: 4000,
      }),
    ).rejects.toThrow(/100 %/);
  });

  it("accepte un échéancier à deux jalons (acompte + solde)", async () => {
    await savePaymentsTab({
      depositPercent1Bps: 3000,
      depositPercent2Bps: 7000,
    });
    const s = await getCompanySettings();
    expect(s.depositCount).toBe(2);
    expect(s.depositPercent1Bps).toBe(3000);
    expect(s.depositPercent2Bps).toBe(7000);
    expect(s.depositPercent3Bps).toBe(0);
  });
});
