import { describe, expect, it } from "vitest";
import { extractCompanyDates } from "@/lib/company/inpi.js";

describe("inpi dates", () => {
  it("extrait immatriculation RNE et début d'activité depuis l'open data", () => {
    const hit = {
      date_creation: "2026-09-01",
      date_mise_a_jour_rne: "2026-08-10T15:39:27",
    };
    const siege = {
      date_debut_activite: "2026-09-01",
      date_creation: "2026-09-01",
    };
    expect(extractCompanyDates(hit, siege)).toEqual({
      rneRegistrationDate: "2026-08-10",
      businessStartDate: "2026-09-01",
    });
  });

  it("privilégie date_debut_activite pour le début d'activité", () => {
    const hit = {
      date_creation: "2026-08-10",
      date_mise_a_jour_rne: "2026-08-10T15:39:27",
    };
    const siege = { date_debut_activite: "2026-09-01" };
    expect(extractCompanyDates(hit, siege).businessStartDate).toBe("2026-09-01");
    expect(extractCompanyDates(hit, siege).rneRegistrationDate).toBe("2026-08-10");
  });
});
