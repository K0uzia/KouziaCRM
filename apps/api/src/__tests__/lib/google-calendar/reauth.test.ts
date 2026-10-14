import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { encryptOptional } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// Réponse réelle de Google pour un jeton expiré ou révoqué (GaxiosError, corps OAuth).
const refreshAccessToken = vi.fn(async () => {
  throw Object.assign(new Error("invalid_grant"), {
    response: { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
    config: { body: "refresh_token=SECRET-REFRESH" },
  });
});
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        refreshAccessToken = refreshAccessToken;
      },
    },
  },
}));

const { getGoogleAccessToken, GoogleReauthRequiredError, isGoogleCalendarConnected } = await import(
  "@/lib/google-calendar/oauth.js"
);
const { listNotifications } = await import("@/lib/notifications/feed.js");

beforeEach(async () => {
  process.env.GOOGLE_CLIENT_ID = "id-test";
  process.env.GOOGLE_CLIENT_SECRET = "secret-test";
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({
    data: {
      googleCalendarEnabled: true,
      googleCalendarConnectedEmail: "contact@kouzia.test",
      googleCalendarRefreshTokenEncrypted: encryptOptional("SECRET-REFRESH"),
    },
  });
  invalidateCompanySettingsCache();
  refreshAccessToken.mockClear();
});

afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

describe("Google Agenda : jeton refusé (invalid_grant)", () => {
  it("connexion marquée à reconnecter, une ligne de journal sans jeton, plus aucune tentative", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(getGoogleAccessToken()).rejects.toBeInstanceOf(GoogleReauthRequiredError);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("SECRET");
    warn.mockRestore();

    const s = await prisma.companySettings.findFirstOrThrow();
    expect(s.googleCalendarReauthRequiredAt).toBeInstanceOf(Date);
    expect(s.googleCalendarRefreshTokenEncrypted).toBeNull();
    expect(s.googleCalendarConnectedEmail).toBe("contact@kouzia.test");
    expect(await isGoogleCalendarConnected()).toBe(false);

    // Passages suivants du worker : rien n'est retenté.
    expect(await getGoogleAccessToken()).toBeNull();
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("une seule notification admin, qui mène à Réglages > Fiscalité", async () => {
    const before = new Date(Date.now() - 1000);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(getGoogleAccessToken()).rejects.toThrow();
    const items = (await listNotifications(before)).filter((i) => i.kind === "google_reauth");
    expect(items).toHaveLength(1);
    expect(items[0]!.href).toBe("/settings?tab=declarations");
    // Plus tard (curseur passé) : plus rien.
    expect((await listNotifications(new Date())).filter((i) => i.kind === "google_reauth")).toHaveLength(0);
  });
});
