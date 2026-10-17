/**
 * Contraste WCAG entre deux couleurs #rrggbb. Même règle que readableOn() de l'API
 * (apps/api/src/lib/brand.ts) : le texte posé sur une couleur de la charte est blanc ou encre sombre.
 * Écrit ici (quelques lignes) plutôt qu'une dépendance : seule la formule WCAG 2 est utile.
 */
const HEX = /^#([0-9a-f]{6})$/i;

/** Encre sombre des documents (texte sur ambre), identique au token --primary-fg. */
export const DOCUMENT_INK = "#1a1103";
export const DOCUMENT_PAPER = "#ffffff";

export function isHexColor(value: string): boolean {
  return HEX.test(value.trim());
}

function luminance(hex: string): number {
  const n = parseInt(HEX.exec(hex.trim())![1]!, 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Texte que les gabarits posent sur ce fond : blanc ou encre, le plus contrasté. */
export function readableOn(hex: string): string {
  return contrastRatio(hex, DOCUMENT_PAPER) >= contrastRatio(hex, DOCUMENT_INK) ? DOCUMENT_PAPER : DOCUMENT_INK;
}

export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(1).replace(".", ",")}:1`;
}
