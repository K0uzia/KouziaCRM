import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// SMTP « configuré » et mise en file en échec : on observe le journal d'erreur.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  mailEnqueue: async () => {
    throw new Error("file indisponible");
  },
}));

const { sendOnboardingInvite } = await import("@/lib/clients/onboarding.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

describe("invitation onboarding : journal", () => {
  it("un échec d'envoi journalise l'adresse masquée, jamais en clair", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await sendOnboardingInvite({ email: "marie.dupont@example.test" });
    expect(res).toMatchObject({ ok: true, sent: false, reason: "error" });
    const logged = spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("m***@example.test");
    expect(logged).not.toContain("marie.dupont@example.test");
  });
});
