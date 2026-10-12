/**
 * Formulaire du site relayé (Web3Forms) : le message arrive « de » contact@, le prospect est dans
 * Reply-To et son nom dans le corps (« Nom : Jean-Baptiste Lefebvre-Dumoulin »).
 */
export function formProspectName(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/(?:^|[\n.]\s*)Nom\s*:\s*([^\n.]{2,80})/i);
  return match?.[1]?.trim() || null;
}
