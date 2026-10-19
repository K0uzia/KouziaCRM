import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowRotateRight, faTrash } from "@fortawesome/free-solid-svg-icons";
import { useAuth } from "@/lib/auth";
import { useOnline } from "@/lib/network";
import { offlineEnabled } from "@/lib/offline/config";
import {
  dependentsOf,
  dismissSignal,
  isLocalClientId,
  itemsLabel,
  removeItem,
  replayQueue,
  retryItem,
  useOfflineQueue,
  type QueueItem,
} from "@/lib/offline/queue";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatStrip } from "@/components/ui/StatStrip";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

const KIND_LABEL: Record<QueueItem["kind"], string> = { client: "Client", quote: "Devis brouillon", note: "Note de rendez-vous", notepad: "Bloc-notes" };

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(":", " h ");

/** Écran où voir l'élément : la fiche du client (préparée hors ligne ou existante). */
const targetOf = (item: QueueItem) => `/clients/${item.clientId}`;

function stateOf(item: QueueItem, items: QueueItem[], sending: boolean): { label: string; tone: "neutral" | "amber" | "red" | "teal"; detail: string | null } {
  if (item.state === "review") return { label: "À revoir", tone: "red", detail: item.message };
  if (item.state === "error") return { label: "Échec, nouvel essai", tone: "amber", detail: item.message };
  const parent = isLocalClientId(item.clientId) && item.kind !== "client" ? items.find((i) => i.kind === "client" && i.clientId === item.clientId) : null;
  if (parent) return { label: "En attente", tone: "neutral", detail: `Attend la création du client ${parent.clientName}.` };
  return { label: sending ? "Envoi…" : "En attente", tone: sending ? "teal" : "neutral", detail: null };
}

/**
 * « À envoyer » : créations préparées hors ligne (file chiffrée de l'appareil), avec leur état, un nouvel essai et
 * la suppression ; puis les créations envoyées avec un écart à relire.
 */
export function OutboxPage() {
  const online = useOnline();
  const { refresh } = useAuth();
  const { ready, items, signals, sessionExpired, sending } = useOfflineQueue();
  const [deleting, setDeleting] = useState<QueueItem | null>(null);
  const [busy, setBusy] = useState(false);

  async function retry(id?: string) {
    setBusy(true);
    try {
      const status = id ? await retryItem(id, refresh) : await replayQueue({ onSessionExpired: refresh });
      if (status === "offline") toast.error("Pas de connexion. Réessayez dès le retour du réseau.");
      else if (status === "error") toast.error("Le serveur de l'ERP ne répond pas. Nouvel essai automatique dans un instant.");
    } finally {
      setBusy(false);
    }
  }

  if (!offlineEnabled()) {
    return (
      <div>
        <PageHeader title="À envoyer" subtitle="Créations préparées hors ligne, envoyées au retour du réseau." />
        <Card>
          <EmptyState title="Hors ligne inactif sur cette adresse" hint="Les créations hors ligne se préparent sur l'adresse publique de l'ERP." />
        </Card>
      </div>
    );
  }

  const waiting = items.filter((i) => i.state !== "review").length;
  const review = items.length - waiting;
  const deletingChildren = deleting ? dependentsOf(deleting).length : 0;

  const actions = (item: QueueItem) => (
    <div className="flex flex-wrap justify-end gap-1">
      <Button
        variant="ghost"
        className="px-3 text-sm"
        disabled={!online || busy || sending}
        title={online ? undefined : "Disponible au retour du réseau"}
        onClick={() => void retry(item.id)}
      >
        <FontAwesomeIcon icon={faArrowRotateRight} className="h-3.5 w-3.5" aria-hidden />
        Nouvel essai
        <span className="sr-only"> : {item.label}</span>
      </Button>
      <Button variant="danger-ghost" className="px-3 text-sm" disabled={sending} onClick={() => setDeleting(item)}>
        <FontAwesomeIcon icon={faTrash} className="h-3.5 w-3.5" aria-hidden />
        Supprimer
        <span className="sr-only"> : {item.label}</span>
      </Button>
    </div>
  );

  const columns: DataColumn<QueueItem>[] = [
    {
      name: "Élément",
      grow: 3,
      cell: (item) => (
        <div className="min-w-0 py-2">
          <Link to={targetOf(item)} className="block break-words font-medium hover:text-[var(--primary)]">
            {item.label}
          </Link>
          <p className="text-xs text-[var(--muted)]">{KIND_LABEL[item.kind]}</p>
        </div>
      ),
    },
    { name: "Préparé le", width: "9rem", cell: (item) => <span className="tabular-nums text-[var(--muted)]">{dateTime(item.preparedAt)}</span> },
    {
      name: "État",
      grow: 2,
      cell: (item) => {
        const st = stateOf(item, items, sending);
        return (
          <div className="min-w-0 py-2" data-queue-state={item.state}>
            <Badge tone={st.tone}>{st.label}</Badge>
            {st.detail ? <p className="mt-1 break-words text-xs text-[var(--muted)]">{st.detail}</p> : null}
          </div>
        );
      },
    },
    { name: "", width: "15rem", right: true, button: true, ignoreRowClick: true, cell: actions },
  ];

  return (
    <div data-queue-count={items.length}>
      <PageHeader
        title="À envoyer"
        subtitle="Créations préparées hors ligne sur cet appareil, chiffrées. Elles partent au retour du réseau, dans l'ordre de préparation."
        actions={
          <Button disabled={!online || busy || sending || waiting === 0} onClick={() => void retry()}>
            <FontAwesomeIcon icon={faArrowRotateRight} className="h-3.5 w-3.5" aria-hidden />
            {sending ? "Envoi…" : "Tout envoyer"}
          </Button>
        }
      />

      {sessionExpired && items.length > 0 ? (
        <p role="status" className="mb-6 rounded-[var(--radius-sm)] border border-[var(--warning)]/40 bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--text)]">
          Reconnectez-vous pour envoyer {itemsLabel(items.length)}.
        </p>
      ) : null}

      <StatStrip
        busy={!ready}
        className="mb-6"
        items={[
          { label: "À envoyer", value: String(waiting), tone: waiting ? "primary" : "default" },
          { label: "À revoir", value: String(review), tone: review ? "danger" : "default", hint: review ? "client supprimé ou donnée refusée" : undefined },
          { label: "À relire", value: String(signals.length), tone: signals.length ? "warning" : "default", hint: signals.length ? "créé avec un écart" : undefined },
        ]}
      />

      <DataTable
        columns={columns}
        data={items}
        loading={!ready}
        countLabel={items.length > 1 ? "éléments" : "élément"}
        emptyTitle="Rien à envoyer"
        emptyHint="Hors ligne, un client, un devis brouillon ou une note de rendez-vous préparés ici attendent le retour du réseau."
        renderMobileCard={(item) => {
          const st = stateOf(item, items, sending);
          return (
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5" data-queue-state={item.state}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link to={targetOf(item)} className="inline-flex min-h-11 items-center break-words font-medium hover:text-[var(--primary)]">
                    {item.label}
                  </Link>
                  <p className="text-xs text-[var(--muted)]">
                    {KIND_LABEL[item.kind]} · préparé le {dateTime(item.preparedAt)}
                  </p>
                </div>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              {st.detail ? <p className="mt-2 break-words text-xs text-[var(--muted)]">{st.detail}</p> : null}
              <div className="mt-2">{actions(item)}</div>
            </div>
          );
        }}
      />

      {signals.length > 0 ? (
        <Card className="mt-6 overflow-hidden">
          <h2 className="border-b border-[var(--border)] px-5 py-3 text-sm font-semibold">
            À relire
          </h2>
          <ul className="divide-y divide-[var(--border)]">
            {signals.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <Link to={s.to} className="inline-flex min-h-11 items-center break-words font-medium hover:text-[var(--primary)]">
                    {s.label}
                  </Link>
                  <Badge tone="amber" className="ml-2">
                    À relire
                  </Badge>
                  <ul className="mt-1 space-y-1 text-sm text-[var(--muted)]">
                    {s.messages.map((m) => (
                      <li key={m} className="break-words">
                        {m}
                      </li>
                    ))}
                  </ul>
                </div>
                <Button variant="secondary" className="shrink-0" onClick={() => void dismissSignal(s.id)}>
                  Marquer comme relu
                  <span className="sr-only"> : {s.label}</span>
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title="Supprimer cet élément ?"
        message={
          deleting
            ? `« ${deleting.label} » ne sera pas envoyé : la préparation est perdue.${
                deletingChildren ? ` ${itemsLabel(deletingChildren)} qui en dépend${deletingChildren > 1 ? "ent" : ""} passer${deletingChildren > 1 ? "ont" : "a"} « à revoir ».` : ""
              }`
            : ""
        }
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          setBusy(true);
          void removeItem(deleting.id)
            .then(() => {
              toast.success("Élément supprimé de la file.");
              setDeleting(null);
            })
            .catch(() => toast.error("Suppression impossible sur cet appareil."))
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}
