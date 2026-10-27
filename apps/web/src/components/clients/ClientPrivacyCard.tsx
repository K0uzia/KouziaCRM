import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload, faUserSlash } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type ErasureResult = { mode: "DELETED" | "ANONYMIZED"; keptDocuments: number };

/**
 * Droits de la personne (RGPD) depuis la fiche : export complet de ses données (JSON) et effacement. Un client facturé
 * est anonymisé : ses documents émis restent 10 ans (obligation comptable) ; un abonnement en cours bloque l'effacement.
 */
export function ClientPrivacyCard({ clientId, clientName, onErased }: { clientId: string; clientName: string; onErased: () => void }) {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function erase() {
    setBusy(true);
    try {
      const r = await api<ErasureResult>(`/api/clients/${clientId}`, { method: "DELETE" });
      setConfirm(false);
      if (r.mode === "DELETED") {
        toast.success("Fiche effacée.");
        navigate("/clients");
      } else {
        toast.success(
          `Données personnelles effacées. ${r.keptDocuments} document${r.keptDocuments > 1 ? "s" : ""} émis gardé${r.keptDocuments > 1 ? "s" : ""} 10 ans (obligation comptable).`,
        );
        onErased();
      }
    } catch (e) {
      setConfirm(false);
      toast.error(e instanceof Error ? e.message : "Effacement impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-5 text-sm">
      <h2 className="text-sm font-semibold">Données personnelles</h2>
      <p className="text-xs text-[var(--muted)]">
        À la demande du client : copie de toutes ses données, ou effacement de la fiche. Les documents émis sont gardés
        10 ans.
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={`/api/clients/${encodeURIComponent(clientId)}/export`} download className={buttonClass("secondary")}>
          <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" aria-hidden />
          Exporter
        </a>
        <Button variant="danger" onClick={() => setConfirm(true)}>
          <FontAwesomeIcon icon={faUserSlash} className="h-3.5 w-3.5" aria-hidden />
          Effacer
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        title={`Effacer les données de ${clientName} ?`}
        message="Coordonnées, bloc-notes, contacts, besoins, messagerie, accès à l'espace client et témoignages sont supprimés. S'il a des documents émis, ils restent 10 ans avec les coordonnées figées à leur émission, et la fiche devient « Client effacé ». Action définitive : exportez d'abord ses données s'il les demande."
        confirmLabel="Effacer"
        danger
        busy={busy}
        onClose={() => setConfirm(false)}
        onConfirm={() => void erase()}
      />
    </Card>
  );
}
