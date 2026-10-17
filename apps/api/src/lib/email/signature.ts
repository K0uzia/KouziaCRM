import DOMPurify from "isomorphic-dompurify";
import type { CompanySettings } from "@prisma/client";
import type { EmailBrand } from "@/lib/email/templates.js";

/** Raison sociale, SIRET et adresse : dans le pied de mail seulement (layout.ts), jamais ici. */
function defaultBrandSignature(brand: EmailBrand): string {
  return [
    "Cordialement,",
    brand.tradeName || brand.legalName,
    brand.email || "",
    brand.website || "",
  ]
    .filter(Boolean)
    .join("\n");
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  // Tirets typographiques ramenés au trait d'union (charte).
  ndash: "-", mdash: "-", hellip: "...", laquo: "«", raquo: "»",
  lsquo: "'", rsquo: "'", sbquo: "'", ldquo: '"', rdquo: '"', bdquo: '"',
  euro: "€", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", deg: "°",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â", auml: "ä",
  icirc: "î", iuml: "ï", ocirc: "ô", ouml: "ö", ugrave: "ù", ucirc: "û", uuml: "ü",
  ccedil: "ç", oelig: "œ", aelig: "æ", yuml: "ÿ",
  Eacute: "É", Egrave: "È", Ecirc: "Ê", Agrave: "À", Acirc: "Â", Icirc: "Î", Ocirc: "Ô",
  Ugrave: "Ù", Ucirc: "Û", Ccedil: "Ç", OElig: "Œ",
};

function decodeEntity(match: string, name: string): string {
  if (name.startsWith("#")) {
    const hex = name[1] === "x" || name[1] === "X";
    const code = hex ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
    if (code === 0x2013 || code === 0x2014) return "-";
    return code === 0xa0 ? " " : String.fromCodePoint(code);
  }
  return NAMED_ENTITIES[name] ?? match;
}

/** Signature HTML (éditeur des paramètres) → texte : retours à la ligne et entités conservés. */
export function htmlSignatureToPlain(html: string): string {
  return html
    .replace(/\r\n/g, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<a\s[^>]*href="(?:mailto:|tel:)?([^"]+)"[^>]*>\s*\1\s*<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Signature texte pour les emails automatiques : personnalisée si configurée, sinon marque. */
export function formatPlainTextSignature(
  settings: Pick<CompanySettings, "emailSignatureHtml">,
  brand: EmailBrand,
): string {
  const custom = settings.emailSignatureHtml?.trim();
  if (custom) return htmlSignatureToPlain(custom);
  return defaultBrandSignature(brand);
}

/** Longueur maximale de la signature saisie dans les réglages (HTML brut, avant assainissement). */
export const SIGNATURE_HTML_MAX = 4000;

/**
 * Signature HTML enregistrée : liste blanche p, br, strong, em, a (href http, https, mailto, tel).
 * Tout le reste est retiré (balises, attributs, gestionnaires d'événements, styles), le texte est gardé.
 * Tirets typographiques ramenés au trait d'union (charte). Signature vide une fois nettoyée : null.
 */
export function sanitizeSignatureHtml(html: string | null | undefined): string | null {
  if (html == null) return null;
  const clean = DOMPurify.sanitize(html.replace(/[\u2013\u2014]/g, "-"), {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "a"],
    ALLOWED_ATTR: ["href"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:)/i,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  }).trim();
  return htmlSignatureToPlain(clean) ? clean : null;
}
