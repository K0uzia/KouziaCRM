import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { useVersionState } from "@/lib/version";
import { preinstallLatest, reloadToLatest, type UpdateProgress } from "@/lib/sw-register";
import { allowLeave, hasUnsavedChanges } from "@/lib/unsaved";

const TOAST_ID = "erp-update";

/** Sonner ferme le toast après le clic sur son action : il resterait fermé au lieu d'afficher l'avancement qui le remplace. */
const keepOpen = (fn: () => void) => (event: { preventDefault: () => void }) => {
  event.preventDefault();
  fn();
};

function progressText(p: UpdateProgress): string {
  if (p.phase === "activate") return "Installation de la nouvelle version…";
  if (p.phase === "reload") return "Rechargement de la page…";
  if (p.total) return `Téléchargement : ${Math.min(p.done, p.total)} fichier${p.total > 1 ? "s" : ""} sur ${p.total}`;
  return "Recherche de la nouvelle version…";
}

/**
 * Mise à jour : toast d'avancement (action retirée : même identifiant, sonner garderait « Recharger »), puis
 * rechargement ; échec ou délai dépassé : erreur avec « Réessayer ».
 */
async function runUpdate(): Promise<void> {
  toast.loading("Mise à jour en cours…", { id: TOAST_ID, description: progressText({ phase: "download", done: 0, total: null }), duration: Infinity, action: undefined });
  try {
    await reloadToLatest((p) => {
      toast.loading("Mise à jour en cours…", { id: TOAST_ID, description: progressText(p), duration: Infinity, action: undefined });
    });
  } catch {
    toast.error("La mise à jour n'a pas abouti", {
      id: TOAST_ID,
      description: "La page n'a pas été rechargée. Vérifiez la connexion, puis réessayez.",
      duration: Infinity,
      action: { label: "Réessayer", onClick: keepOpen(() => void runUpdate()) },
    });
  }
}

/** « Recharger » : saisie non enregistrée, on prévient d'abord ; sinon mise à jour aussitôt. */
function startUpdate(): void {
  if (!hasUnsavedChanges()) {
    void runUpdate();
    return;
  }
  toast.warning("Des modifications ne sont pas enregistrées", {
    id: TOAST_ID,
    description: "Enregistrez-les avant de recharger, sinon elles seront perdues.",
    duration: Infinity,
    action: {
      label: "Recharger quand même",
      onClick: keepOpen(() => {
        allowLeave();
        void runUpdate();
      }),
    },
  });
}

/**
 * Interface plus ancienne que le serveur (en-têtes X-Kouzia-Build et X-Kouzia-Contract) : toast persistant pour un
 * nouveau build (la nouvelle version s'installe en arrière-plan dès qu'elle est connue) ; fenêtre sans fermeture
 * quand le contrat de l'API a changé (rechargement obligatoire).
 */
export function VersionNotice() {
  const state = useVersionState();

  useEffect(() => {
    if (state !== "build") return;
    preinstallLatest();
    toast.info("Une nouvelle version de l'ERP est en ligne", {
      id: TOAST_ID,
      description: "Rechargez quand vous voulez pour en profiter.",
      duration: Infinity,
      action: { label: "Recharger", onClick: keepOpen(startUpdate) },
    });
  }, [state]);

  if (state !== "contract") return null;
  return (
    <Modal open onClose={() => undefined} title="L'ERP a été mis à jour">
      <p className="text-sm">
        Cette page date d&apos;une version précédente et ne peut plus échanger avec le serveur sans risque. Rechargez
        pour continuer ; une saisie en cours non enregistrée sera perdue.
      </p>
      <ModalActions>
        <Button
          onClick={() => {
            allowLeave();
            preinstallLatest();
            void runUpdate();
          }}
        >
          Recharger maintenant
        </Button>
      </ModalActions>
    </Modal>
  );
}
