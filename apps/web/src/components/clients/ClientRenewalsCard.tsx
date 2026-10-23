import { useEffect, useState, type FormEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPen, faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { isOnline } from "@/lib/network";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DateInput, Field, Input, Select } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** Renouvellement payé par le client chez un tiers (hébergement, domaine, adresses e-mail en gestion autonome). */
export type ClientRenewal = {
  id: string;
  label: string;
  provider: string | null;
  renewsAt: string;
  interval: "MONTH" | "YEAR";
  notifyClient: boolean;
};

type Form = { label: string; provider: string; renewsAt: string; interval: "MONTH" | "YEAR"; notifyClient: boolean };
const emptyForm: Form = { label: "", provider: "", renewsAt: "", interval: "YEAR", notifyClient: false };

/** Date du champ (AAAA-MM-JJ) à minuit heure locale, pas en UTC. */
function localDay(iso: string) {
  return `${iso}T00:00:00`;
}

function toInputDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Fiche client : renouvellements chez l'hébergeur, rappelés 30 jours avant dans « À traiter » (et au client si coché). */
export function ClientRenewalsCard({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<ClientRenewal[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<ClientRenewal | "new" | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<ClientRenewal | null>(null);

  function load() {
    api<ClientRenewal[]>(`/api/clients/${clientId}/renewals`)
      .then((r) => {
        setRows(r);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }

  useEffect(load, [clientId]);

  // Lien « Voir » de « À traiter » (#renouvellements) : la carte arrive après la fiche, on s'y place une fois chargée.
  const loaded = rows !== null;
  useEffect(() => {
    if (loaded && window.location.hash === "#renouvellements") document.getElementById("renouvellements")?.scrollIntoView({ block: "start" });
  }, [loaded]);

  function openNew() {
    setForm(emptyForm);
    setEditing("new");
  }

  function openEdit(r: ClientRenewal) {
    setForm({ label: r.label, provider: r.provider ?? "", renewsAt: toInputDate(r.renewsAt), interval: r.interval, notifyClient: r.notifyClient });
    setEditing(r);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    const body = JSON.stringify({
      label: form.label,
      provider: form.provider.trim() || null,
      renewsAt: localDay(form.renewsAt),
      interval: form.interval,
      notifyClient: form.notifyClient,
    });
    try {
      if (editing === "new") {
        await api(`/api/clients/${clientId}/renewals`, { method: "POST", body });
        toast.success("Renouvellement ajouté");
      } else {
        await api(`/api/clients/${clientId}/renewals/${editing.id}`, { method: "PUT", body });
        toast.success("Renouvellement mis à jour");
      }
      setEditing(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!toDelete) return;
    setBusy(true);
    try {
      await api(`/api/clients/${clientId}/renewals/${toDelete.id}`, { method: "DELETE" });
      toast.success("Renouvellement supprimé");
      setToDelete(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="renouvellements" className="overflow-hidden">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[var(--border)] px-5">
        <h2 className="text-sm font-semibold">Renouvellements</h2>
        <Button variant="ghost" className="text-sm" onClick={openNew}>
          <FontAwesomeIcon icon={faPlus} className="h-3 w-3" aria-hidden />
          Ajouter
        </Button>
      </div>
      {failed && !isOnline() ? (
        // Renouvellements hors de la liste fermée : jamais copiés, état du bloc sans faire tomber la fiche.
        <p className="px-5 py-4 text-sm text-[var(--muted)]">Non disponible hors ligne : les renouvellements ne sont pas copiés sur l&apos;appareil.</p>
      ) : failed ? (
        <p className="px-5 py-4 text-sm text-[var(--danger)]">
          Renouvellements indisponibles.{" "}
          <button type="button" className="link min-h-11" onClick={load}>
            Réessayer
          </button>
        </p>
      ) : rows === null ? (
        <p className="px-5 py-4 text-sm text-[var(--muted)]">Chargement…</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-[var(--muted)]">
          Aucun. Notez ici ce que le client paie lui-même chez son hébergeur (domaine, hébergement, adresses e-mail) : un rappel apparaît dans « À traiter » 30 jours avant.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-2">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{r.label}</p>
                <p className="break-words text-xs text-[var(--muted)]">
                  {r.interval === "MONTH" ? "Chaque mois" : "Chaque année"}, prochain le {formatDate(r.renewsAt)}
                  {r.provider ? ` chez ${r.provider}` : ""}
                  {r.notifyClient ? " · client prévenu par e-mail" : ""}
                </p>
              </div>
              <Button variant="ghost" className="shrink-0 px-3" aria-label={`Modifier ${r.label}`} onClick={() => openEdit(r)}>
                <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button variant="ghost" className="shrink-0 px-3" aria-label={`Supprimer ${r.label}`} onClick={() => setToDelete(r)}>
                <FontAwesomeIcon icon={faTrash} className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Nouveau renouvellement" : "Modifier le renouvellement"}>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Libellé">
            <Input required maxLength={200} value={form.label} placeholder="Nom de domaine" onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </Field>
          <Field label="Hébergeur (facultatif)">
            <Input maxLength={120} value={form.provider} autoComplete="organization" onChange={(e) => setForm({ ...form, provider: e.target.value })} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Prochain renouvellement">
              <DateInput required value={form.renewsAt} onChange={(v) => setForm({ ...form, renewsAt: v })} />
            </Field>
            <Field label="Périodicité">
              <Select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value === "MONTH" ? "MONTH" : "YEAR" })}>
                <option value="YEAR">Annuelle</option>
                <option value="MONTH">Mensuelle</option>
              </Select>
            </Field>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={form.notifyClient} onChange={(e) => setForm({ ...form, notifyClient: e.target.checked })} />
            Prévenir aussi le client par e-mail, 30 jours avant
          </label>
          <ModalActions>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <ConfirmDialog
        open={toDelete !== null}
        title="Supprimer ce renouvellement ?"
        message={`« ${toDelete?.label ?? ""} » ne sera plus rappelé.`}
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void onDelete()}
        onClose={() => setToDelete(null)}
      />
    </Card>
  );
}
