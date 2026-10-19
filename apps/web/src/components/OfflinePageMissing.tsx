import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCloudArrowDown } from "@fortawesome/free-solid-svg-icons";
import { useLocation } from "react-router-dom";
import { Card } from "@/components/ui/Card";
import { useOfflineCopy } from "@/lib/offline/sync";

/**
 * Écran hors ligne dont aucune donnée n'est sur l'appareil : un état propre à la place d'un chargement sans fin ou
 * d'une erreur brute. L'écran se recharge de lui-même au retour du réseau (lib/reconnect).
 */
export function OfflinePageMissing() {
  const copy = useOfflineCopy();
  // Module Site : jamais copié (décision du 19/10/2026), il s'ouvre au retour du réseau.
  const site = /^\/site(\/|$)/.test(useLocation().pathname);
  const progress =
    copy.running && copy.phase
      ? `La copie est en cours (${copy.phase.toLowerCase()} ${copy.done} sur ${copy.total}) : la page sera lisible ensuite.`
      : "Elle sera copiée au prochain passage en ligne.";
  return (
    <Card role="status" className="mx-auto my-6 max-w-xl space-y-3 p-5" data-offline-page-missing>
      <div className="flex items-start gap-3">
        <FontAwesomeIcon icon={faCloudArrowDown} className="mt-1 h-4 w-4 shrink-0 text-[var(--primary)]" aria-hidden />
        <div className="min-w-0 space-y-2">
          <h1 className="text-lg font-semibold">{site ? "Le module Site ne s'utilise pas hors ligne" : "Cette page n'est pas encore sur l'appareil"}</h1>
          <p className="text-sm text-[var(--muted)]">
            {site ? "" : `${progress} `}Elle s&apos;affichera d&apos;elle-même au retour du réseau.
          </p>
        </div>
      </div>
    </Card>
  );
}
