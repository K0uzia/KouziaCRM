import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { useVersionState } from "@/lib/version";

/**
 * Interface plus ancienne que le serveur (en-têtes X-Kouzia-Build et X-Kouzia-Contract) : bandeau persistant pour
 * un nouveau build ; fenêtre sans fermeture quand le contrat de l'API a changé (rechargement obligatoire).
 */
export function VersionNotice() {
  const state = useVersionState();
  if (state === "ok") return null;
  const reload = () => window.location.reload();
  if (state === "contract") {
    return (
      <Modal open onClose={() => undefined} title="L'ERP a été mis à jour">
        <p className="text-sm">
          Cette page date d&apos;une version précédente et ne peut plus échanger avec le serveur sans risque. Rechargez
          pour continuer ; une saisie en cours non enregistrée sera perdue.
        </p>
        <ModalActions>
          <Button onClick={reload}>Recharger maintenant</Button>
        </ModalActions>
      </Modal>
    );
  }
  return (
    <div className="shrink-0 px-[var(--gutter)] pt-3">
      <Banner level="info" role="status" action={<Button variant="secondary" onClick={reload}>Recharger</Button>}>
        Une nouvelle version de l&apos;ERP est en ligne. Rechargez la page quand vous voulez pour en profiter.
      </Banner>
    </div>
  );
}
