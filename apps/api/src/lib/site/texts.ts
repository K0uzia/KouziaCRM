import { z } from "zod";
import { prisma } from "@/lib/prisma.js";
import { accrocheValue, avisMethodeValue, infosValue, menusValue, offresValue, pagesValue, seoValue } from "@/lib/site/contract.js";

/** Documents uniques de l'espace Site (table SiteText) : coordonnées, accroche, offres, méthode des avis, textes des pages, référencement et menus. */
export const SITE_TEXT_SCHEMAS = {
  infos: infosValue,
  accroche: accrocheValue,
  offres: offresValue,
  avisMethode: avisMethodeValue,
  pages: pagesValue,
  seo: seoValue,
  menus: menusValue,
  // Document décrit par le contrat du site seulement (éditeur généré, routes /api/site/editor).
  "espace-client": z.record(z.string(), z.unknown()),
} as const;

export type SiteTextKey = keyof typeof SITE_TEXT_SCHEMAS;
export type SiteTextValue<K extends SiteTextKey> = z.output<(typeof SITE_TEXT_SCHEMAS)[K]>;

export function isSiteTextKey(key: string): key is SiteTextKey {
  return Object.hasOwn(SITE_TEXT_SCHEMAS, key);
}

export async function readSiteText<K extends SiteTextKey>(key: K): Promise<SiteTextValue<K> | null> {
  const row = await prisma.siteText.findUnique({ where: { key } });
  return row ? (JSON.parse(row.valueJson) as SiteTextValue<K>) : null;
}

/**
 * Documents décrits par le contrat du site (éditeur généré) : leur forme est celle du site, vérifiée à l'enregistrement
 * dans l'éditeur et à la publication ; une copie ancienne dans l'ERP refuserait un champ nouveau (version restaurée).
 */
const CONTRACT_DOCUMENTS: readonly SiteTextKey[] = ["pages", "seo", "menus", "espace-client"];

/** Valide puis enregistre (valeur nettoyée par zod : espaces de bord retirés). */
export async function writeSiteText<K extends SiteTextKey>(key: K, value: unknown): Promise<SiteTextValue<K>> {
  const schema = CONTRACT_DOCUMENTS.includes(key) ? z.record(z.string(), z.unknown()) : SITE_TEXT_SCHEMAS[key];
  const parsed = schema.parse(value) as SiteTextValue<K>;
  const valueJson = JSON.stringify(parsed);
  await prisma.siteText.upsert({ where: { key }, create: { key, valueJson }, update: { valueJson } });
  return parsed;
}
