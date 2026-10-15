import { describe, expect, it } from "vitest";
import { frenchPublicHolidays, startAfterWithdrawal, withdrawalEndsAt } from "@/lib/quotes/withdrawal.js";

describe("délai de rétractation (14 jours, art. L221-18)", () => {
  it("jours fériés 2026, dont ceux liés à Pâques (5 avril)", () => {
    const h = frenchPublicHolidays(2026);
    expect([...h].sort()).toEqual([
      "2026-01-01", "2026-04-06", "2026-05-01", "2026-05-08", "2026-05-14", "2026-05-25",
      "2026-07-14", "2026-08-15", "2026-11-01", "2026-11-11", "2026-12-25",
    ]);
  });

  it("14 jours après la signature, jusqu'à 23:59:59 à Paris (heure d'hiver)", () => {
    // Lundi 19 octobre 2026, 15 h à Paris : fin le lundi 2 novembre.
    const end = withdrawalEndsAt(new Date("2026-10-19T13:00:00Z"));
    expect(end.toISOString()).toBe("2026-11-02T22:59:59.999Z");
    expect(startAfterWithdrawal(end).toISOString()).toBe("2026-11-02T23:00:00.000Z");
  });

  it("heure d'été : fin de journée à 21:59:59 UTC", () => {
    expect(withdrawalEndsAt(new Date("2026-07-01T10:00:00Z")).toISOString()).toBe("2026-07-15T21:59:59.999Z");
  });

  it("prolongé au premier jour ouvrable : férié (11 novembre) puis week-end et férié", () => {
    // Signé le mercredi 28 octobre : le 11 novembre est férié, fin le jeudi 12.
    expect(withdrawalEndsAt(new Date("2026-10-28T09:00:00Z")).toISOString()).toBe("2026-11-12T22:59:59.999Z");
    // Signé le samedi 17 octobre : samedi 31, dimanche 1er novembre (férié), fin le lundi 2.
    expect(withdrawalEndsAt(new Date("2026-10-17T09:00:00Z")).toISOString()).toBe("2026-11-02T22:59:59.999Z");
  });

  it("signature à 23 h 30 à Paris : le jour de signature est celui de Paris, pas d'UTC", () => {
    // 1er novembre 23:30 UTC = 2 novembre 00:30 à Paris : fin le 16 novembre (lundi).
    expect(withdrawalEndsAt(new Date("2026-11-01T23:30:00Z")).toISOString()).toBe("2026-11-16T22:59:59.999Z");
  });
});
