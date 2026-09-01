import { describe, expect, it } from "vitest";
import { senderLabel } from "@/lib/email/sender-label.js";
import { extractDisplayName } from "@/lib/email/mailer/headers.js";

describe("senderLabel", () => {
  it("utilise le nom d'affichage From s'il est réel", () => {
    expect(senderLabel("Revolut Business", "no-reply@revolut.com")).toBe("Revolut Business");
  });

  it("n'utilise pas no-reply comme nom, mais le domaine", () => {
    expect(senderLabel(null, "no-reply@revolut.com")).toBe("Revolut");
    expect(senderLabel("no-reply", "no-reply@revolut.com")).toBe("Revolut");
    expect(senderLabel("", "noreply@stripe.com")).toBe("Stripe");
  });

  it("ne renvoie jamais les deux premieres lettres de no-reply", () => {
    const label = senderLabel(undefined, "no-reply@revolut.com");
    expect(label.toLowerCase()).not.toBe("no");
    expect(label).not.toMatch(/^no$/i);
  });

  it("garde l'adresse s'il n'y a pas de nom ni de marque exploitable", () => {
    expect(senderLabel(null, "marie.dupont@gmail.com")).toBe("marie.dupont@gmail.com");
  });
});

describe("extractDisplayName", () => {
  it("extrait le nom du header From", () => {
    expect(extractDisplayName("Revolut Business <no-reply@revolut.com>")).toBe(
      "Revolut Business",
    );
    expect(extractDisplayName('"Revolut" <no-reply@revolut.com>')).toBe("Revolut");
    expect(extractDisplayName("no-reply@revolut.com")).toBeNull();
  });
});
