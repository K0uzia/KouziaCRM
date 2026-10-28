/** Ressource chargée hors du message : image, fond, feuille de style (pixel espion possible). */
const REMOTE_RESOURCE =
  /(?:\b(?:src|background|srcset)\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:|<link\b[^>]*href\s*=\s*["']?https?:)/i;

export function hasRemoteResource(html: string): boolean {
  return REMOTE_RESOURCE.test(html);
}

/** Images distantes : envoi de l'ERP, ou expéditeur reconnu par l'API ; à défaut (copie hors ligne), masquées. */
export function remoteImagesAllowed(
  direction: string,
  security: { remoteImagesAllowed: boolean } | null | undefined,
): boolean {
  return direction === "OUTBOUND" || security?.remoteImagesAllowed === true;
}
