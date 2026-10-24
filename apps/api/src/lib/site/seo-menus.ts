import { z } from "zod";
import { getCompanySettings } from "@/lib/company.js";
import {
  MENU_TARGETS,
  SEO_DESCRIPTION_MAX,
  SEO_DESCRIPTION_MIN,
  SEO_TITLE_MAX,
  SITE_PAGE_IDS,
  SITE_PAGE_LABEL,
  type menusValue,
  type seoValue,
  type SiteIssue,
  type SitePageId,
} from "@/lib/site/contract.js";
import { readSiteText } from "@/lib/site/texts.js";

/**
 * Référencement par page (seo.json) et menus (menus.json). Les valeurs actuelles du site (titres, descriptions,
 * menus, libellés des cibles) ne sont pas recopiées ici : le site les exporte sous « defauts » de contenu.schema.json,
 * généré depuis sa source unique (src/data/defauts-erp.json).
 */

export type SeoValue = z.output<typeof seoValue>;
export type MenusValue = z.output<typeof menusValue>;

const defaultsSchema = z.object({
  seo: z.record(z.string(), z.object({ titre: z.string(), description: z.string() })),
  menus: z.object({ entete: z.array(z.object({ cible: z.string() })), pied: z.array(z.object({ cible: z.string() })) }),
  cibles: z.record(z.string(), z.object({ libelle: z.string(), chemin: z.string() })),
  image: z.string(),
  imageAlt: z.string(),
  /** Valeurs des variables exportées par le site (site.city pour {ville}) ; absent d'un contrat antérieur. */
  variables: z.object({ ville: z.string().min(1) }).partial().optional(),
});
export type SiteDefaults = z.output<typeof defaultsSchema>;

/** Valeurs actuelles exportées par le contrat, null si ce contrat ne les porte pas (site antérieur au lot 6). */
export function defaultsFromContract(contract: unknown): SiteDefaults | null {
  const parsed = defaultsSchema.safeParse((contract as { defauts?: unknown } | null)?.defauts);
  if (!parsed.success) return null;
  const d = parsed.data;
  // Contrat incomplet (page ou cible manquante) : inutilisable plutôt que faux.
  const complete = SITE_PAGE_IDS.every((p) => d.seo[p]) && MENU_TARGETS.every((c) => d.cibles[c]);
  return complete ? d : null;
}

export type TextVariables = { ville: string; delaiReponse: string };

/**
 * Valeurs des variables, comme au build du site : {ville} est celle que le site exporte (defauts.variables.ville,
 * tirée de site.city), à défaut la ville de l'entreprise (réglages) pour un contrat antérieur ; {delaiReponse} vient
 * des coordonnées que l'ERP publie (infos.json). null : coordonnées non renseignées.
 */
export async function textVariables(siteCity?: string | null): Promise<TextVariables | null> {
  const [settings, infos] = await Promise.all([getCompanySettings(), readSiteText("infos")]);
  const ville = siteCity?.trim() || settings.city.trim();
  if (!infos || !ville) return null;
  return { ville, delaiReponse: infos.delaiReponse };
}

export const fillVariables = (text: string, vars: TextVariables) =>
  text.replace(/\{(ville|delaiReponse)\}/g, (_, k: keyof TextVariables) => vars[k]);

export type FinalSeo = { title: string; description: string; image: string; imageAlt: string };

/** Ce que le site affichera pour chaque page : valeur de l'ERP, sinon valeur actuelle, variables remplacées. */
export function finalSeo(seo: SeoValue | null, defaults: SiteDefaults, vars: TextVariables): Record<SitePageId, FinalSeo> {
  const out = {} as Record<SitePageId, FinalSeo>;
  for (const id of SITE_PAGE_IDS) {
    const own: { titre?: string; description?: string; image?: string; imageAlt?: string } = seo?.pages[id] ?? {};
    out[id] = {
      // Accueil : titre fixé par la charte, jamais modifiable.
      title: fillVariables((id === "accueil" ? undefined : own.titre) ?? defaults.seo[id]!.titre, vars),
      description: fillVariables(own.description ?? defaults.seo[id]!.description, vars),
      image: own.image ?? defaults.image,
      imageAlt: fillVariables(own.imageAlt ?? defaults.imageAlt, vars),
    };
  }
  return out;
}

/** Contrôles du build du site (valider.ts) sur les valeurs finales : longueurs et descriptions toutes distinctes. */
export function finalSeoIssues(seo: SeoValue | null, defaults: SiteDefaults, vars: TextVariables): SiteIssue[] {
  const issues: SiteIssue[] = [];
  const final = finalSeo(seo, defaults, vars);
  const seen = new Map<string, SitePageId>();
  for (const id of SITE_PAGE_IDS) {
    const { title, description } = final[id];
    if (title.length > SEO_TITLE_MAX) issues.push({ file: "seo", path: `${id}.titre`, message: `${title.length} caractères une fois les variables remplacées (${SEO_TITLE_MAX} au plus)` });
    if (description.length < SEO_DESCRIPTION_MIN || description.length > SEO_DESCRIPTION_MAX) {
      issues.push({
        file: "seo",
        path: `${id}.description`,
        message: `${description.length} caractères une fois les variables remplacées (${SEO_DESCRIPTION_MIN} à ${SEO_DESCRIPTION_MAX})`,
      });
    }
    const twin = seen.get(description);
    if (twin) issues.push({ file: "seo", path: `${id}.description`, message: `Même description que la page « ${SITE_PAGE_LABEL[twin]} » : chaque page doit avoir la sienne` });
    else seen.set(description, id);
  }
  return issues;
}

/** Menus affichés : ceux de l'ERP, sinon ceux du site, avec le libellé et le chemin de chaque cible. */
export function finalMenus(menus: MenusValue | null, defaults: SiteDefaults) {
  const resolve = (list: Array<{ cible: string; libelle?: string }>) =>
    list.map((e) => ({ cible: e.cible, libelle: e.libelle ?? defaults.cibles[e.cible]!.libelle, chemin: defaults.cibles[e.cible]!.chemin }));
  return { entete: resolve(menus?.entete ?? defaults.menus.entete), pied: resolve(menus?.pied ?? defaults.menus.pied) };
}
