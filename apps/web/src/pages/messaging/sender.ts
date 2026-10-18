/**
 * Formulaire du site relayé (Web3Forms) : le message arrive « de » contact@, le prospect est dans
 * Reply-To et son nom dans le corps (« Nom : Jean-Baptiste Lefebvre-Dumoulin »).
 */
export function formProspectName(text: string | null | undefined): string | null {
  if (!text) return null;
  // Aperçu sur une ligne (« nom : Camille Martin email : … ») : le nom s'arrête au champ suivant.
  const match = text.match(/(?:^|[\n.]\s*)Nom\s*:\s*(.{2,80}?)(?=\s*(?:[\n.]|$|\s[\p{L}-]+\s*:))/iu);
  return match?.[1]?.trim() || null;
}

/** Expéditeur technique du formulaire du site (notify+…@web3forms.com) : on ne lui répond jamais. */
export function isFormSender(address: string | null | undefined): boolean {
  return /@(?:[a-z0-9-]+\.)*web3forms\.com$/i.test(address?.trim() ?? "");
}
