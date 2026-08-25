import Engine from "publicodes";
import rules from "modele-social";

export type SocialBreakdown = {
  totalCents: number;
  cotisationsCents: number;
  cfpCents: number;
  impotLiberatoireCents: number;
  impotRevenuMensuelCents: number;
  caCents: number;
  effectiveRateBps: number;
};

const AE_SITUATION_BASE = {
  dirigeant: "'auto-entrepreneur'",
  "entreprise . catégorie juridique": "'EI'",
  "entreprise . catégorie juridique . EI . auto-entrepreneur": "oui",
  "entreprise . activité . nature": "'libérale'",
  "entreprise . activité . nature . libérale . réglementée": "non",
  "entreprise . imposition": "'IR'",
  "entreprise . imposition . IR . type de bénéfices": "'BNC'",
  "dirigeant . auto-entrepreneur": "oui",
} as const;

let engine: Engine | null = null;
const resultCache = new Map<number, SocialBreakdown>();

/** Coupe le spam console de modele-social (très coûteux en Node). */
function silenceWarnings<T>(fn: () => T): T {
  const warn = console.warn;
  const info = console.info;
  console.warn = () => {};
  console.info = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
    console.info = info;
  }
}

export function getPublicodesEngine(): Engine {
  if (!engine) {
    engine = silenceWarnings(() => new Engine(rules as never));
  }
  return engine;
}

function eurosToCents(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : 0;
}

const ZERO: SocialBreakdown = {
  totalCents: 0,
  cotisationsCents: 0,
  cfpCents: 0,
  impotLiberatoireCents: 0,
  impotRevenuMensuelCents: 0,
  caCents: 0,
  effectiveRateBps: 0,
};

/**
 * Cotisations AE  -  cache par montant + une seule evaluate « total »
 * (pas d'impôt.montant, très lent / expérimental).
 */
export function computeSocialChargesForEncaisse(caCents: number): SocialBreakdown {
  const ca = Math.max(0, Math.round(caCents));
  if (ca <= 0) return ZERO;

  const hit = resultCache.get(ca);
  if (hit) return hit;

  const result = silenceWarnings(() => {
    const caEuros = ca / 100;
    const eng = getPublicodesEngine();
    eng.setSituation({
      ...AE_SITUATION_BASE,
      "dirigeant . auto-entrepreneur . chiffre d'affaires": `${caEuros} €/mois`,
    } as never);

    const total = eurosToCents(
      eng.evaluate("dirigeant . auto-entrepreneur . cotisations et contributions").nodeValue,
    );
    const cotisations = eurosToCents(
      eng.evaluate(
        "dirigeant . auto-entrepreneur . cotisations et contributions . cotisations",
      ).nodeValue,
    );
    const cfp = eurosToCents(
      eng.evaluate("dirigeant . auto-entrepreneur . cotisations et contributions . CFP")
        .nodeValue,
    );

    return {
      totalCents: total,
      cotisationsCents: cotisations,
      cfpCents: cfp,
      impotLiberatoireCents: 0,
      impotRevenuMensuelCents: 0,
      caCents: ca,
      effectiveRateBps: ca > 0 ? Math.round((total * 10_000) / ca) : 0,
    } satisfies SocialBreakdown;
  });

  resultCache.set(ca, result);
  return result;
}

export function computeUrssafDueCents(encaisseCents: number): number {
  return computeSocialChargesForEncaisse(encaisseCents).totalCents;
}
