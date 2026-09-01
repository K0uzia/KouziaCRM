import { describe, expect, it } from "vitest";
import { detectQuoteConfirmationIntent } from "@/lib/email/quote-confirmation-intent.js";

describe("detectQuoteConfirmationIntent", () => {
  it("détecte les formulations courantes de validation", () => {
    expect(detectQuoteConfirmationIntent("Bonjour, je valide le devis.")).toBe(true);
    expect(detectQuoteConfirmationIntent("C'est confirmé pour moi.")).toBe(true);
    expect(detectQuoteConfirmationIntent("OK pour moi, on part là-dessus.")).toBe(true);
    expect(detectQuoteConfirmationIntent("Bon pour accord.")).toBe(true);
  });

  it("ignore les messages sans intention claire", () => {
    expect(detectQuoteConfirmationIntent("Merci pour le devis, je reviens vers vous.")).toBe(
      false,
    );
    expect(detectQuoteConfirmationIntent("")).toBe(false);
    expect(detectQuoteConfirmationIntent(null)).toBe(false);
  });
});
