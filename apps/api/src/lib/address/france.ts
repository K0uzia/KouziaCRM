import { validateAdresse, lookupEntreprise, isValidSiren, isValidSiret } from "@kouzia/forms";

export type AddressInput = {
  addressLine1?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  addressCityCode?: string | null;
  addressLat?: number | null;
  addressLon?: number | null;
  addressManualConfirmed?: boolean;
};

export type NormalizedAddress = {
  addressLine1: string | null;
  postalCode: string | null;
  city: string | null;
  addressCityCode: string | null;
  addressLat: number | null;
  addressLon: number | null;
  /** true si l'utilisateur a forcé la saisie manuelle */
  manual: boolean;
  /** true si l'API BAN était injoignable */
  unavailable: boolean;
};

/** Refus d'adresse, repris tel quel par l'API publique (/nouveau-client) : voir le README, section API publique. */
export type AddressErrorCode = "address_suggestion" | "address_ambiguous" | "address_not_found";

/** Adresse proposée par la base nationale, déjà géocodée : renvoyée telle quelle, elle est acceptée sans revérification. */
export type AddressSuggestion = {
  addressLine1: string;
  postalCode: string;
  city: string;
  addressCityCode: string;
  addressLat: number;
  addressLon: number;
};

export type AddressRefusal = { ok: false; error: string; code: AddressErrorCode; suggestion?: AddressSuggestion };

/**
 * Revalide une adresse française côté serveur.
 * Ne bloque jamais si l'API est down ; bloque not_found sauf confirmation manuelle.
 */
/** Même texte à la casse, aux accents, à la ponctuation et aux espaces près. */
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) =>
    (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}

export async function normalizeFrenchAddress(
  input: AddressInput,
  opts: {
    /**
     * Fiches de l'ERP : la base nationale ne remplace jamais une voie ou une commune par une autre (elle
     * proposait « 3 Chemin de Caucetey » pour « 3 chemin de Recette ») ; seules la casse et les accents sont
     * corrigés, sinon la proposition est renvoyée en erreur pour que la personne choisisse.
     */
    rejectOtherStreet?: boolean;
  } = {},
): Promise<{ ok: true; address: NormalizedAddress } | AddressRefusal> {
  const country = (input.country ?? "FRANCE").trim().toUpperCase();
  const line1 = input.addressLine1?.trim() || null;
  const postalCode = input.postalCode?.trim() || null;
  const city = input.city?.trim() || null;

  const base: NormalizedAddress = {
    addressLine1: line1,
    postalCode,
    city,
    addressCityCode: input.addressCityCode?.trim() || null,
    addressLat: input.addressLat ?? null,
    addressLon: input.addressLon ?? null,
    manual: Boolean(input.addressManualConfirmed),
    unavailable: false,
  };

  if (country !== "FRANCE") {
    return { ok: true, address: base };
  }

  // Déjà géocodée côté client
  if (base.addressLat != null && base.addressLon != null && base.addressCityCode) {
    return { ok: true, address: base };
  }

  if (!line1 || !postalCode || !city) {
    return { ok: true, address: base };
  }

  if (input.addressManualConfirmed) {
    return { ok: true, address: { ...base, manual: true } };
  }

  const result = await validateAdresse(line1, postalCode, city);
  if (result.status === "unavailable") {
    return { ok: true, address: { ...base, unavailable: true } };
  }
  if (result.status === "ok") {
    if (opts.rejectOtherStreet && (!sameText(result.address.addressLine1, line1) || !sameText(result.address.city, city))) {
      return {
        ok: false,
        error: `La base nationale propose « ${result.address.addressLine1}, ${result.address.postalCode} ${result.address.city} ». Choisissez une suggestion ou confirmez votre saisie.`,
        code: "address_suggestion",
        suggestion: {
          addressLine1: result.address.addressLine1,
          postalCode: result.address.postalCode,
          city: result.address.city,
          addressCityCode: result.address.citycode,
          addressLat: result.address.lat,
          addressLon: result.address.lon,
        },
      };
    }
    return {
      ok: true,
      address: {
        addressLine1: result.address.addressLine1,
        postalCode: result.address.postalCode,
        city: result.address.city,
        addressCityCode: result.address.citycode,
        addressLat: result.address.lat,
        addressLon: result.address.lon,
        manual: false,
        unavailable: false,
      },
    };
  }
  if (result.status === "ambiguous") {
    return {
      ok: false,
      error:
        "Adresse ambiguë : choisissez une suggestion ou confirmez que l'adresse est correcte.",
      code: "address_ambiguous",
    };
  }
  return {
    ok: false,
    error:
      "Adresse introuvable. Corrigez-la ou confirmez que l'adresse est correcte.",
    code: "address_not_found",
  };
}

export type SirenVerifyResult = {
  siren: string | null;
  siret: string | null;
  apeCode: string | null;
  companyName: string | null;
  companyVerifiedAt: Date | null;
  warnings: string[];
};

/**
 * Revérifie SIREN/SIRET à l'enregistrement B2B.
 * Si l'API est down, on accepte la saisie (dégradation).
 */
/** Refus d'identifiants d'entreprise, repris par l'API publique (README, section Formulaire client public). */
export type CompanyErrorCode = "siret_invalid" | "siren_invalid" | "siret_siren_mismatch";

export async function verifyCompanyIdentifiers(opts: {
  siren?: string | null;
  siret?: string | null;
  companyName?: string | null;
  apeCode?: string | null;
}): Promise<{ ok: true; data: SirenVerifyResult } | { ok: false; error: string; code: CompanyErrorCode }> {
  const siretRaw = opts.siret?.replace(/\s/g, "") || null;
  const sirenRaw =
    opts.siren?.replace(/\s/g, "") ||
    (siretRaw && siretRaw.length === 14 ? siretRaw.slice(0, 9) : null);

  if (siretRaw && !isValidSiret(siretRaw)) {
    return { ok: false, error: "SIRET invalide (14 chiffres, contrôle Luhn)", code: "siret_invalid" };
  }
  if (sirenRaw && !isValidSiren(sirenRaw)) {
    return { ok: false, error: "SIREN invalide (9 chiffres, contrôle Luhn)", code: "siren_invalid" };
  }
  // SIRET et SIREN saisis tous les deux : le SIRET commence par le SIREN, sinon la fiche serait fausse.
  if (opts.siren?.trim() && siretRaw && sirenRaw && siretRaw.slice(0, 9) !== sirenRaw) {
    return {
      ok: false,
      error: "Le SIRET ne correspond pas au SIREN : ses 9 premiers chiffres doivent être le SIREN.",
      code: "siret_siren_mismatch",
    };
  }

  if (!sirenRaw) {
    return {
      ok: true,
      data: {
        siren: null,
        siret: siretRaw,
        apeCode: opts.apeCode?.trim() || null,
        companyName: opts.companyName?.trim() || null,
        companyVerifiedAt: null,
        warnings: [],
      },
    };
  }

  const lookup = await lookupEntreprise(sirenRaw);
  if (!lookup.ok) {
    if (lookup.reason === "invalid_siren") {
      return { ok: false, error: "SIREN invalide", code: "siren_invalid" };
    }
    // not_found ou unavailable : on laisse passer (saisie manuelle)
    return {
      ok: true,
      data: {
        siren: sirenRaw,
        siret: siretRaw,
        apeCode: opts.apeCode?.trim() || null,
        companyName: opts.companyName?.trim() || null,
        companyVerifiedAt: null,
        warnings:
          lookup.reason === "not_found"
            ? ["Entreprise introuvable dans l'open data : saisie manuelle conservée."]
            : ["API entreprises indisponible : saisie manuelle conservée."],
      },
    };
  }

  const e = lookup.entreprise;
  return {
    ok: true,
    data: {
      siren: e.siren,
      siret: siretRaw ?? e.siret,
      apeCode: e.apeCode ?? opts.apeCode?.trim() ?? null,
      companyName: opts.companyName?.trim() || e.legalName,
      companyVerifiedAt: new Date(),
      warnings: e.warnings,
    },
  };
}
