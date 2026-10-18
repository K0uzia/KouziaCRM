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
): Promise<{ ok: true; address: NormalizedAddress } | { ok: false; error: string }> {
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
    };
  }
  return {
    ok: false,
    error:
      "Adresse introuvable. Corrigez-la ou confirmez que l'adresse est correcte.",
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
export async function verifyCompanyIdentifiers(opts: {
  siren?: string | null;
  siret?: string | null;
  companyName?: string | null;
  apeCode?: string | null;
}): Promise<{ ok: true; data: SirenVerifyResult } | { ok: false; error: string }> {
  const siretRaw = opts.siret?.replace(/\s/g, "") || null;
  const sirenRaw =
    opts.siren?.replace(/\s/g, "") ||
    (siretRaw && siretRaw.length === 14 ? siretRaw.slice(0, 9) : null);

  if (siretRaw && !isValidSiret(siretRaw)) {
    return { ok: false, error: "SIRET invalide (14 chiffres, contrôle Luhn)" };
  }
  if (sirenRaw && !isValidSiren(sirenRaw)) {
    return { ok: false, error: "SIREN invalide (9 chiffres, contrôle Luhn)" };
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
      return { ok: false, error: "SIREN invalide" };
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
