import { describe, expect, it } from "vitest";
import { assertSecretKeyFormat, assertWebhookSecretFormat, lengthHint } from "@/lib/stripe/key-check.js";

describe("contrôle des clés Stripe collées", () => {
  it("clé secrète : espaces retirés", () => {
    expect(assertSecretKeyFormat(" sk_test_abc123 \n")).toBe("sk_test_abc123");
  });
  it("clé publiable : message précis", () => {
    expect(() => assertSecretKeyFormat("pk_test_abc")).toThrow("C'est une clé publiable (pk_…)");
  });
  it("secret de webhook collé dans le champ de la clé", () => {
    expect(() => assertSecretKeyFormat("whsec_abc")).toThrow("C'est le secret de signature des webhooks");
  });
  it("valeur sans préfixe Stripe", () => {
    expect(() => assertSecretKeyFormat("abc")).toThrow("Ce n'est pas une clé secrète Stripe");
  });
  it("clé restreinte acceptée", () => {
    expect(assertSecretKeyFormat("rk_live_abc")).toBe("rk_live_abc");
  });
  it("secret de webhook : clé d'API refusée, whsec_ exigé", () => {
    expect(() => assertWebhookSecretFormat("sk_test_abc")).toThrow("C'est une clé d'API");
    expect(assertWebhookSecretFormat("whsec_x ")).toBe("whsec_x");
  });
  it("longueur inhabituelle signalée", () => {
    expect(lengthHint(`sk_test_${"a".repeat(384)}`)).toContain("392 caractères");
    expect(lengthHint(`sk_test_${"a".repeat(99)}`)).toBe("");
  });
});
