import { afterEach, describe, expect, it, vi } from "vitest";
import { addressChanged, matchCommune, sameAddressText } from "../address-compare";
import { revalidateAddressBeforeSubmit, type AddressValue } from "@/components/forms/AddressAutocomplete";

const COMMUNES_33880 = [
  { nom: "Baurech", code: "33033" },
  { nom: "Cambes", code: "33084" },
  { nom: "Saint-Caprais-de-Bordeaux", code: "33381" },
];

const saisie: AddressValue = {
  addressLine1: "3 chemin de Recette",
  addressLine2: "",
  postalCode: "33880",
  city: "Saint-Caprais-de-Bordeaux",
  country: "FRANCE",
  addressCityCode: "",
  addressLat: null,
  addressLon: null,
  addressManualConfirmed: false,
};

/** Réponse de la base nationale (api-adresse) avec un seul résultat au score élevé. */
function banRepond(label: string, city: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          features: [
            {
              geometry: { coordinates: [-0.43, 44.76] },
              properties: { label: `${label} 33880 ${city}`, name: label, postcode: "33880", city, citycode: "33381", score: 0.92, type: "housenumber" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("adresse : la ville enregistrée reste affichée, la voie saisie n'est jamais remplacée", () => {
  it("commune retrouvée à la casse et aux accents près ; autre commune ou ville vide : aucune", () => {
    expect(matchCommune("Saint-Caprais-De-Bordeaux", COMMUNES_33880)?.nom).toBe("Saint-Caprais-de-Bordeaux");
    expect(matchCommune("saint caprais de bordeaux", COMMUNES_33880)?.nom).toBe("Saint-Caprais-de-Bordeaux");
    expect(matchCommune("Quinsac", COMMUNES_33880)).toBeNull();
    expect(matchCommune("", COMMUNES_33880)).toBeNull();
    expect(sameAddressText("3 Chemin de Recette", "3 chemin de recette")).toBe(true);
    expect(sameAddressText("3 Chemin de Caucetey", "3 chemin de Recette")).toBe(false);
  });

  it("« Modifier » : adresse inchangée détectée (seul un autre champ a bougé)", () => {
    const initial = { addressLine1: "3 chemin de Recette", addressLine2: "Bât. R", postalCode: "33880", city: "Saint-Caprais-de-Bordeaux", country: "FRANCE" };
    expect(addressChanged({ ...initial }, initial)).toBe(false);
    expect(addressChanged({ ...initial, city: "Cambes" }, initial)).toBe(true);
    expect(addressChanged({ ...initial }, undefined)).toBe(true);
  });

  it("autre voie proposée par la base nationale : refus avec la proposition, saisie intacte", async () => {
    banRepond("3 Chemin de Caucetey", "Saint-Caprais-de-Bordeaux");
    const onChange = vi.fn();
    const erreur = await revalidateAddressBeforeSubmit(saisie, onChange);
    expect(onChange).not.toHaveBeenCalled();
    expect(erreur).toContain("3 Chemin de Caucetey");
    expect(erreur).toContain("confirmez votre saisie");
  });

  it("même voie à la casse près : normalisée et géocodée sans question", async () => {
    banRepond("3 Chemin de Recette", "Saint-Caprais-de-Bordeaux");
    const onChange = vi.fn();
    expect(await revalidateAddressBeforeSubmit(saisie, onChange)).toBeNull();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ addressLine1: "3 Chemin de Recette", city: "Saint-Caprais-de-Bordeaux", addressCityCode: "33381" }));
  });
});
