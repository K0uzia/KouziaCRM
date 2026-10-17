import { useLocation } from "react-router-dom";
import { useOnline } from "../network";
import { formatCopyDate, useCopyDate } from "./served";

export const READ_ONLY_HINT = "Consultation seule jusqu'au retour du réseau.";

/**
 * Consultation seule : hors ligne, ou écran servi depuis la copie locale (serveur injoignable). Les actions
 * d'écriture sont désactivées en attendant le lot 3 (modifications mises en file).
 * - copyNotice : « Données du JJ/MM à HH h MM. … », affiché sous le titre de l'écran servi depuis la copie ;
 * - reason : explication liée aux actions désactivées (le bandeau « Hors ligne · consultation seule » la montre).
 */
export function useReadOnly(): { readOnly: boolean; copyNotice: string | null; reason: string | null } {
  const online = useOnline();
  const { pathname } = useLocation();
  const copyDate = useCopyDate(pathname);
  if (copyDate !== null) {
    const copyNotice = `${formatCopyDate(copyDate)}. ${READ_ONLY_HINT}`;
    return { readOnly: true, copyNotice, reason: copyNotice };
  }
  if (!online) return { readOnly: true, copyNotice: null, reason: `Hors ligne. ${READ_ONLY_HINT}` };
  return { readOnly: false, copyNotice: null, reason: null };
}
