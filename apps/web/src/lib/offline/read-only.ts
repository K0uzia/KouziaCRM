import { useRef } from "react";
import { useLocation } from "react-router-dom";
import { useOnline } from "../network";
import { useReconnectPhase } from "../reconnect";
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
type ReadOnlyState = { readOnly: boolean; copyNotice: string | null; reason: string | null; canPrepare: boolean };

export function useReadOnly(): ReadOnlyState {
  const online = useOnline();
  const { pathname } = useLocation();
  const copyDate = useCopyDate(pathname);
  const refreshing = useReconnectPhase() === "refreshing";
  const last = useRef<ReadOnlyState | null>(null);
  let state: ReadOnlyState;
  if (copyDate !== null) {
    const copyNotice = `${formatCopyDate(copyDate)}. ${READ_ONLY_HINT}`;
    state = { readOnly: true, copyNotice, reason: copyNotice, canPrepare: offlineEnabled() };
  } else if (!online) {
    state = { readOnly: true, copyNotice: null, reason: `Hors ligne. ${READ_ONLY_HINT}`, canPrepare: offlineEnabled() };
  } else {
    state = { readOnly: false, copyNotice: null, reason: null, canPrepare: true };
  }
  // Retour du réseau en cours : l'écran affiché garde son état (mention de date, actions coupées) jusqu'à ce que
  // l'écran rechargé le remplace d'un coup ; sinon la mention disparaîtrait d'abord et le contenu remonterait (CLS).
  if (refreshing && last.current) return last.current;
  last.current = state;
  return state;
}
