import { describe, expect, it, vi, afterEach } from "vitest";
import { normalizeFrenchAddress, verifyCompanyIdentifiers } from "@/lib/address/france.js";

describe("normalizeFrenchAddress", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("laisse passer hors France sans appeler BAN", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await normalizeFrenchAddress({
      addressLine1: "1 Main St",
      postalCode: "1000",
      city: "Bruxelles",
      country: "BELGIQUE",
    });
    expect(r.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalise un score élevé", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          features: [
            {
              properties: {
                label: "10 Rue de Rivoli 75001 Paris",
                name: "10 Rue de Rivoli",
                postcode: "75001",
                city: "Paris",
                citycode: "75101",
                score: 0.95,
              },
              geometry: { coordinates: [2.33, 48.86] },
            },
          ],
        }),
      }),
    );
    const r = await normalizeFrenchAddress({
      addressLine1: "10 rue rivoli",
      postalCode: "75001",
      city: "Paris",
      country: "FRANCE",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.address.addressLine1).toBe("10 Rue de Rivoli");
      expect(r.address.addressCityCode).toBe("75101");
      expect(r.address.manual).toBe(false);
    }
  });

  it("bloque not_found sans confirmation manuelle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ features: [] }),
      }),
    );
    const r = await normalizeFrenchAddress({
      addressLine1: "xyz introuvable",
      postalCode: "75001",
      city: "Paris",
      country: "FRANCE",
    });
    expect(r.ok).toBe(false);
  });

  it("accepte confirmation manuelle", async () => {
    const r = await normalizeFrenchAddress({
      addressLine1: "Lieu-dit inventé",
      postalCode: "97100",
      city: "Basse-Terre",
      country: "FRANCE",
      addressManualConfirmed: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address.manual).toBe(true);
  });

  it("dégrade si API injoignable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const r = await normalizeFrenchAddress({
      addressLine1: "10 rue de rivoli",
      postalCode: "75001",
      city: "Paris",
      country: "FRANCE",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address.unavailable).toBe(true);
  });
});

describe("verifyCompanyIdentifiers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejette un SIRET Luhn invalide", async () => {
    const r = await verifyCompanyIdentifiers({ siret: "73282932000075" });
    expect(r.ok).toBe(false);
  });

  it("accepte un SIREN valide même si API down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const r = await verifyCompanyIdentifiers({ siren: "732829320" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.siren).toBe("732829320");
      expect(r.data.companyVerifiedAt).toBeNull();
    }
  });
});
