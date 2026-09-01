import type { CompanySettings } from "@prisma/client";
import type { EmailBrand } from "@/lib/email/templates.js";

function defaultBrandSignature(brand: EmailBrand): string {
  return [
    "Cordialement,",
    brand.tradeName || brand.legalName,
    brand.legalName,
    `EI · SIRET ${brand.siret}`,
    [brand.addressLine1, `${brand.postalCode} ${brand.city}`].filter(Boolean).join(", "),
    brand.email || "",
    brand.website || "",
  ]
    .filter(Boolean)
    .join("\n");
}

function htmlSignatureToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
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
