/** Charte Kouzia : nuit #0b1020, ambre #fe9a00. */
export const KOUZIA_PRIMARY = "#fe9a00";
export const KOUZIA_SECONDARY = "#0b1020";

/**
 * Anciennes valeurs par défaut du schéma (vert d'avant la charte) : traitées comme « non personnalisées ».
 * Le défaut du schéma Prisma reste à changer (migration à valider) ; aucune donnée n'est réécrite.
 */
export const LEGACY_BRAND_DEFAULTS: ReadonlySet<string> = new Set(["#0f766e", "#0f172a"]);

function pick(value: string | null | undefined, fallback: string): string {
  const v = value?.trim().toLowerCase();
  if (!v || !/^#[0-9a-f]{6}$/.test(v) || LEGACY_BRAND_DEFAULTS.has(v)) return fallback;
  return v;
}

export function resolveBrandColors(
  settings?: { brandPrimaryColor?: string | null; brandSecondaryColor?: string | null } | null,
): { primary: string; secondary: string } {
  return {
    primary: pick(settings?.brandPrimaryColor, KOUZIA_PRIMARY),
    secondary: pick(settings?.brandSecondaryColor, KOUZIA_SECONDARY),
  };
}

/** Couleur de texte lisible sur un fond donné : blanc ou encre sombre de la charte, selon le contraste. */
export function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // Encre #1a1103 : luminance ≈ 0,006.
  const withWhite = 1.05 / (l + 0.05);
  const withInk = (l + 0.05) / 0.056;
  return withWhite >= withInk ? "#ffffff" : "#1a1103";
}
