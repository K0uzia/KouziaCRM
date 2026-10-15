import { afterEach, describe, expect, it } from "vitest";
import { assertSecurityEnv, isExampleSecret, requireEnv } from "@/lib/env.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("secrets de l'environnement", () => {
  it("valeur d'exemple « change-me » refusée en production, quelle que soit la casse", () => {
    for (const v of ["change-me", "CHANGE-ME-openssl-rand-base64-24", "Change-Me-onboarding"]) expect(isExampleSecret(v), v).toBe(true);
    expect(isExampleSecret("k3J9-vrai-secret")).toBe(false);
    process.env.NODE_ENV = "production";
    process.env.ESSAI_SECRET = "CHANGE-ME-quelque-chose";
    expect(() => requireEnv("ESSAI_SECRET")).toThrow(/trop faible/);
    process.env.ESSAI_SECRET = "";
    expect(() => requireEnv("ESSAI_SECRET")).toThrow(/requise/);
  });

  it("production : ONBOARDING_HMAC_SECRET obligatoire au démarrage ; dev : repli autorisé", () => {
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "un-secret-de-session-assez-long-pour-la-prod";
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    delete process.env.ONBOARDING_HMAC_SECRET;
    expect(() => assertSecurityEnv()).toThrow(/ONBOARDING_HMAC_SECRET/);
    process.env.ONBOARDING_HMAC_SECRET = "change-me-onboarding-hmac";
    expect(() => assertSecurityEnv()).toThrow(/trop faible/);
    process.env.ONBOARDING_HMAC_SECRET = "b".repeat(64);
    expect(() => assertSecurityEnv()).not.toThrow();
    process.env.NODE_ENV = "test";
    delete process.env.ONBOARDING_HMAC_SECRET;
    expect(() => assertSecurityEnv()).not.toThrow();
  });
});
