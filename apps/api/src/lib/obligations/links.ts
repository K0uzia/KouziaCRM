/** Liens officiels par défaut (modifiables via CompanySettings.officialLinks) */
export const DEFAULT_OFFICIAL_LINKS = {
  urssafDeclaration: "https://autoentrepreneur.urssaf.fr",
  impotsPro: "https://cfspro-idp.impots.gouv.fr",
  impotsParticulier: "https://www.impots.gouv.fr",
} as const;

export type OfficialLinks = {
  urssafDeclaration: string;
  impotsPro: string;
  impotsParticulier: string;
};

export function resolveOfficialLinks(raw: unknown): OfficialLinks {
  const base = { ...DEFAULT_OFFICIAL_LINKS };
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(base) as Array<keyof OfficialLinks>) {
    if (typeof o[key] === "string" && (o[key] as string).trim()) {
      base[key] = (o[key] as string).trim();
    }
  }
  return base;
}

export function officialLinkForObligationType(
  type: string,
  links: OfficialLinks,
): string {
  switch (type) {
    case "URSSAF_DECLARATION":
    case "ACTIVITY_QUESTIONNAIRE":
      return links.urssafDeclaration;
    case "CFE_PAYMENT":
    case "CFE_INITIAL_DECLARATION":
      return links.impotsPro;
    case "INCOME_TAX_DECLARATION":
      return links.impotsParticulier;
    default:
      return links.impotsPro;
  }
}
