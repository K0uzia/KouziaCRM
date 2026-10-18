import { describe, expect, it } from "vitest";
import { formatMailDate, formatMailDateTime } from "../format";

const now = new Date(2026, 9, 18, 15, 0);

describe("date d'un message dans la liste", () => {
  it("aujourd'hui : l'heure seule", () => {
    expect(formatMailDate(new Date(2026, 9, 18, 9, 42), now)).toBe("09:42");
    expect(formatMailDate(new Date(2026, 9, 18, 0, 5), now)).toBe("00:05");
  });

  it("la veille : « hier », même juste avant minuit ou au changement de mois", () => {
    expect(formatMailDate(new Date(2026, 9, 17, 23, 59), now)).toBe("hier");
    expect(formatMailDate(new Date(2026, 9, 31, 8, 0), new Date(2026, 10, 1, 9, 0))).toBe("hier");
  });

  it("cette année : la date courte ; avant : la date complète", () => {
    expect(formatMailDate(new Date(2026, 9, 16, 10, 0), now)).toBe("16 oct.");
    expect(formatMailDate(new Date(2026, 1, 14, 16, 5), now)).toBe("14 févr.");
    expect(formatMailDate(new Date(2025, 10, 3, 11, 20), now)).toBe("3 nov. 2025");
    expect(formatMailDate(new Date(2025, 11, 31, 22, 0), new Date(2026, 0, 1, 9, 0))).toBe("hier");
  });

  it("dans le fil : la date et l'heure exactes", () => {
    expect(formatMailDateTime(new Date(2026, 9, 18, 9, 42))).toBe("18 oct. 2026 à 09:42");
    expect(formatMailDate(null)).toBe("");
  });
});
