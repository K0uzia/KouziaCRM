import { describe, expect, it } from "vitest";
import { remainingCommitmentPeriods } from "@/lib/subscriptions/buyout.js";
import { currentPeriodEndOf } from "@/lib/subscriptions/subscription-service.js";
import { parisIsoDate } from "@/lib/format-fr.js";

// Audit du 27/10/2026 : enchaîner commitmentEndOf faisait glisser le jour d'ancrage (31 jan, 28 fév, puis 28 mars au
// lieu du 31) : une mensualité de trop au devis de rachat d'un abonnement ancré du 29 au 31, et une fin de période
// en cours décalée.
const at = (iso: string) => new Date(`${iso}T10:00:00+01:00`);

describe("abonnement ancré au 31 : pas de glissement du jour", () => {
  it("rachat : 11 mensualités restantes du 31/01 au 31/12, pas 12", () => {
    const sub = { nextInvoiceAt: at("2027-01-31"), billingInterval: "MONTH", commitmentEndsAt: at("2027-12-31") };
    const r = remainingCommitmentPeriods(sub, at("2027-01-10"));
    expect(parisIsoDate(r.from)).toBe("2027-01-31");
    expect(r.count).toBe(11);
  });

  it("fin de la période en cours au 30 avril, pas au 28", () => {
    const sub = { nextInvoiceAt: at("2027-01-31"), billingInterval: "MONTH" };
    expect(parisIsoDate(currentPeriodEndOf(sub, at("2027-04-01")))).toBe("2027-04-30");
  });

  it("ancrage au 15 : inchangé", () => {
    const sub = { nextInvoiceAt: at("2027-01-15"), billingInterval: "MONTH", commitmentEndsAt: at("2027-12-15") };
    expect(remainingCommitmentPeriods(sub, at("2027-01-10")).count).toBe(11);
    expect(parisIsoDate(currentPeriodEndOf(sub, at("2027-04-20")))).toBe("2027-05-15");
  });
});
