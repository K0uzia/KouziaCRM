import { useLocation } from "react-router-dom";
import { useOnline } from "../network";
import { offlineEnabled } from "./config";
import { formatCopyDate, useCopyDate } from "./served";

export const READ_ONLY_HINT = "Modifications et envois disponibles au retour du réseau.";

/**
 * Consultation seule : hors ligne, ou écran servi depuis la copie locale (serveur injoignable). Les actions
 * d'écriture sont désactivées, sauf les créations mises en file (lib/offline/queue) sur l'origine du hors ligne.
 * - copyNotice : « Données du JJ/MM à HH h MM. … », affiché sous le titre de l'écran servi depuis la copie ;
 * - reason : explication liée aux actions désactivées ;
 * - canPrepare : client, devis brouillon ou note préparables malgré tout (mis en file, envoyés au retour du réseau).
 */
export function useReadOnly(): { readOnly: boolean; copyNotice: string | null; reason: string | null; canPrepare: boolean } {
  const online = useOnline();
  const { pathname } = useLocation();
  const copyDate = useCopyDate(pathname);
  if (copyDate !== null) {
    const copyNotice = `${formatCopyDate(copyDate)}. ${READ_ONLY_HINT}`;
    return { readOnly: true, copyNotice, reason: copyNotice, canPrepare: offlineEnabled() };
  }
  if (!online) return { readOnly: true, copyNotice: null, reason: `Hors ligne. ${READ_ONLY_HINT}`, canPrepare: offlineEnabled() };
  return { readOnly: false, copyNotice: null, reason: null, canPrepare: true };
}
