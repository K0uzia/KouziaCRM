import { pagesValue } from "@/lib/site/contract.js";
import { readRepoFileAt, siteBranch, SITE_CONTENT_DIR } from "@/lib/site/github.js";

/**
 * Textes actuels des pages du site (lot 6 A) : exportés par le site sous « defauts.pages » de contenu.schema.json,
 * depuis sa source unique (src/data/defauts-erp.json), jamais recopiés dans l'ERP. Ils servent d'exemple sous chaque
 * champ vide (clé absente = texte actuel du site) et de point de départ.
 */
export type PagesValue = (typeof pagesValue)["_output"]["pages"];

/** Textes actuels portés par le contrat, null si ce contrat ne les porte pas ou s'ils ne respectent pas le schéma. */
export function pagesDefaultsFromContract(contract: unknown): PagesValue | null {
  const parsed = pagesValue.shape.pages.safeParse((contract as { defauts?: { pages?: unknown } } | null)?.defauts?.pages);
  return parsed.success ? parsed.data : null;
}

const CACHE_MS = 10 * 60_000;
let cache: { at: number; value: PagesValue | null } | null = null;

/** Textes actuels lus sur la branche du site (10 min de cache). Erreur GitHub : propagée à l'appelant. */
export async function readPagesDefaults(force = false): Promise<PagesValue | null> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const contract = JSON.parse(await readRepoFileAt(`${SITE_CONTENT_DIR}/contenu.schema.json`, siteBranch()));
  cache = { at: Date.now(), value: pagesDefaultsFromContract(contract) };
  return cache.value;
}
