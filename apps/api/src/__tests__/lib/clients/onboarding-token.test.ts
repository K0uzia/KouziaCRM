import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createOnboardingToken,
  verifyOnboardingToken,
  isLegacyOnboardingToken,
} from "@/lib/clients/onboarding-token.js";

describe("onboarding HMAC token", () => {
  beforeEach(() => {
    process.env.ONBOARDING_HMAC_SECRET = "test-hmac-secret-for-unit-tests-32b";
  });

  afterEach(() => {
    delete process.env.ONBOARDING_HMAC_SECRET;
  });

  it("crée et vérifie un token valide", () => {
    const { token, jti, payload } = createOnboardingToken({
      email: "Client@Test.fr",
      existingClientId: null,
    });
    expect(jti).toBeTruthy();
    expect(token.includes(".")).toBe(true);
    const verified = verifyOnboardingToken(token);
    expect(verified).not.toBeNull();
    expect(verified!.email).toBe("client@test.fr");
    expect(verified!.jti).toBe(jti);
    expect(verified!.exp).toBe(payload.exp);
  });

  it("rejette une signature altérée", () => {
    const { token } = createOnboardingToken({ email: "a@b.fr" });
    const [payload] = token.split(".");
    const bad = `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(verifyOnboardingToken(bad)).toBeNull();
  });

  it("rejette un token expiré", () => {
    const { token } = createOnboardingToken({
      email: "a@b.fr",
      ttlDays: -1,
    });
    expect(verifyOnboardingToken(token)).toBeNull();
  });

  it("détecte un token legacy hex", () => {
    expect(isLegacyOnboardingToken("a".repeat(32))).toBe(true);
    expect(isLegacyOnboardingToken("not-hex")).toBe(false);
  });
});
