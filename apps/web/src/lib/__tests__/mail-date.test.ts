import { describe, expect, it } from "vitest";
import { formatMailDate, formatMailDateTime, formatTime } from "../format";

// Instants en UTC : le résultat ne dépend pas du fuseau du poste (affichage à Paris, UTC+2 l'été, UTC+1 l'hiver).
const now = new Date("2026-10-18T13:00:00Z"); // 15:00 à Paris

describe("date et heure d'un message dans la liste (Europe/Paris)", () => {
  it("aujourd'hui : « Aujourd'hui » et l'heure", () => {
    expect(formatMailDate(new Date("2026-10-18T07:42:00Z"), now)).toBe("Aujourd'hui 09:42");
    // 22:05 UTC la veille = 00:05 à Paris le jour même.
    expect(formatMailDate(new Date("2026-10-17T22:05:00Z"), now)).toBe("Aujourd'hui 00:05");
  });

  it("la veille : « Hier » et l'heure, au changement de mois comme au passage à l'heure d'hiver", () => {
    expect(formatMailDate(new Date("2026-10-17T21:59:00Z"), now)).toBe("Hier 23:59");
    expect(formatMailDate(new Date("2026-10-31T07:00:00Z"), new Date("2026-11-01T08:00:00Z"))).toBe("Hier 08:00");
    // Passage à l'heure d'hiver dans la nuit du 24 au 25 octobre 2026.
    expect(formatMailDate(new Date("2026-10-24T20:30:00Z"), new Date("2026-10-25T10:00:00Z"))).toBe("Hier 22:30");
  });

  it("cette année : date courte et heure ; avant : avec l'année", () => {
    expect(formatMailDate(new Date("2026-10-12T14:40:00Z"), now)).toBe("12 oct. 16:40");
    expect(formatMailDate(new Date("2026-02-14T15:05:00Z"), now)).toBe("14 févr. 16:05");
    expect(formatMailDate(new Date("2025-11-03T10:20:00Z"), now)).toBe("3 nov. 2025 11:20");
    expect(formatMailDate(new Date("2025-12-31T21:00:00Z"), new Date("2026-01-01T08:00:00Z"))).toBe("Hier 22:00");
  });

  it("dans le fil : date et heure exactes, à Paris", () => {
    expect(formatMailDateTime(new Date("2026-10-18T07:42:00Z"))).toBe("18 oct. 2026 à 09:42");
    expect(formatTime(new Date("2026-01-15T07:42:00Z"))).toBe("08:42");
    expect(formatMailDate(null)).toBe("");
  });
});
