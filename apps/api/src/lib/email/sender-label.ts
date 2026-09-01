/** Local-parts d'adresses techniques, inutilisables comme nom affiché. */
const GENERIC_LOCAL =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|notifications?|news(letter)?|alertes?|info|contact|support|hello|hi|team|mail)$/i;

function titleCaseBrand(raw: string): string {
  if (!raw) return raw;
  if (/^[A-Z0-9]+$/.test(raw) && raw.length <= 4) return raw;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Libellé d'expéditeur pour la liste / l'en-tête.
 * Préfère le nom d'affichage From, ignore les noms type "no-reply",
 * sinon le domaine (revolut.com -> Revolut), sinon l'adresse.
 */
export function senderLabel(
  fromName: string | null | undefined,
  fromAddress: string,
): string {
  const name = fromName?.trim() ?? "";
  if (name && !GENERIC_LOCAL.test(name) && name.toLowerCase() !== fromAddress.toLowerCase()) {
    return name;
  }

  const at = fromAddress.lastIndexOf("@");
  const local = at >= 0 ? fromAddress.slice(0, at) : fromAddress;
  const domain = at >= 0 ? fromAddress.slice(at + 1) : "";

  if (domain && (!local || GENERIC_LOCAL.test(local))) {
    const host = domain.replace(/^mail\./i, "").replace(/^email\./i, "");
    const brand = host.split(".")[0] ?? "";
    if (brand && brand.toLowerCase() !== "gmail" && brand.toLowerCase() !== "outlook") {
      return titleCaseBrand(brand);
    }
  }

  return fromAddress;
}
