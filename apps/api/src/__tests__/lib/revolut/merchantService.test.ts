import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractMilestoneReference,
  extractRevolutEventId,
  extractRevolutEventType,
  revolutMerchantBaseUrl,
  verifyRevolutWebhookSignature,
} from "@/lib/revolut/merchantService.js";

describe("Revolut Merchant service", () => {
  it("utilise la bonne URL sandbox vs production", () => {
    expect(revolutMerchantBaseUrl("sandbox")).toBe(
      "https://sandbox-merchant.revolut.com",
    );
    expect(revolutMerchantBaseUrl("production")).toBe(
      "https://merchant.revolut.com",
    );
  });

  it("vérifie la signature HMAC du webhook", () => {
    const secret = "whsec_test";
    const rawBody = JSON.stringify({ event: "ORDER_COMPLETED", id: "evt_1" });
    const timestamp = String(Date.now());

    const payloadToSign = `v1.${timestamp}.${rawBody}`;
    const signature =
      "v1=" +
      createHmac("sha256", secret).update(payloadToSign).digest("hex");

    expect(
      verifyRevolutWebhookSignature({
        rawBody,
        timestamp,
        signatureHeader: signature,
        signingSecret: secret,
      }),
    ).toBe(true);

    expect(
      verifyRevolutWebhookSignature({
        rawBody,
        timestamp,
        signatureHeader: "v1=deadbeef",
        signingSecret: secret,
      }),
    ).toBe(false);
  });

  it("extrait l'identifiant d'événement et la référence jalon", () => {
    const payload = {
      id: "evt_abc",
      event: "ORDER_COMPLETED",
      order: {
        id: "ord_1",
        merchant_order_data: { reference: "milestone-123" },
      },
    };

    expect(extractRevolutEventId(payload)).toBe("evt_abc");
    expect(extractRevolutEventType(payload)).toBe("ORDER_COMPLETED");
    expect(extractMilestoneReference(payload)).toBe("milestone-123");
  });
});
