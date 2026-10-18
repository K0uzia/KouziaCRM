import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage, isNetworkFailure, useOnline } from "@/lib/network";
import { offlineEnabled } from "@/lib/offline/config";
import { isLocalClientId, submitCreation, useOfflineQueue, useRequestId } from "@/lib/offline/queue";
import { useReadOnly } from "@/lib/offline/read-only";
import { Badge, Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Textarea } from "@/components/ui/Field";

type Note = { id: string; body: string; preparedAt: string };

const when = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(" ", " à ").replace(":", " h ");

/**
 * Journal « Notes de rendez-vous » de la fiche client, en lecture et en ajout. Hors ligne (origine du hors ligne) :
 * la note est mise en file, chiffrée, et partira au retour du réseau ; les notes déjà lues restent consultables.
 */
export function ClientNotesCard({ clientId, clientName }: { clientId: string; clientName: string }) {
  const requestId = useRequestId();
  const local = isLocalClientId(clientId);
  const online = useOnline();
  const { readOnly, canPrepare } = useReadOnly();
  const { items } = useOfflineQueue();
  const pending = items.filter((i) => i.kind === "note" && i.clientId === clientId);
  const [notes, setNotes] = useState<Note[] | null>(local ? [] : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  // Relue à l'ouverture, au retour du réseau et quand une note de la file vient de partir.
  useEffect(() => {
    if (local) return;
    let alive = true;
    api<Note[]>(`/api/clients/${encodeURIComponent(clientId)}/notes`)
      .then((rows) => {
        if (!alive) return;
        setNotes(rows);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setLoadError(isNetworkFailure(e) ? "Notes consultables avec le réseau." : errorMessage(e, "Notes non chargées."));
      });
    return () => {
      alive = false;
    };
  }, [clientId, local, online, pending.length]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      if (offlineEnabled()) {
        const result = await submitCreation<Note>({ kind: "note", label: `Note pour ${clientName}`, clientId, clientName, body: { body }, requestId: requestId.current });
        if (result.queued) toast.success("Note préparée hors ligne : elle partira au retour du réseau.");
        else {
          setNotes((list) => [result.data, ...(list ?? []).filter((n) => n.id !== result.data.id)]);
          toast.success("Note ajoutée.");
        }
      } else {
        const note = await api<Note>(`/api/clients/${encodeURIComponent(clientId)}/notes`, {
          method: "POST",
          body: JSON.stringify({ body, clientRequestId: requestId.current }),
        });
        setNotes((list) => [note, ...(list ?? [])]);
        toast.success("Note ajoutée.");
      }
      setText("");
      // Note créée ou mise en file : la suivante aura son propre identifiant.
      requestId.renew();
    } catch (err) {
      toast.error(errorMessage(err, "Note non enregistrée."));
    } finally {
      setBusy(false);
    }
  }

  const blocked = readOnly && !canPrepare;
  const empty = notes !== null && notes.length === 0 && pending.length === 0;

  return (
    <Card className="p-5" data-client-notes>
      <h2 className="mb-3 text-sm font-semibold">Notes de rendez-vous</h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Nouvelle note" hint={readOnly && canPrepare ? "Hors ligne : la note partira au retour du réseau." : undefined}>
          <Textarea rows={3} maxLength={5000} value={text} disabled={blocked || busy} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={blocked || busy || !text.trim()}>
            {busy ? "Enregistrement…" : "Ajouter la note"}
          </Button>
        </div>
      </form>

      {loadError && pending.length === 0 ? <p className="mt-4 text-sm text-[var(--muted)]">{loadError}</p> : null}
      {notes === null && !loadError ? <div className="mt-4 h-12 animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-raised)]" aria-hidden /> : null}
      {empty ? <p className="mt-4 text-sm text-[var(--muted)]">Aucune note pour ce client.</p> : null}

      {pending.length || notes?.length ? (
        <ol className="mt-4 divide-y divide-[var(--border)] border-t border-[var(--border)]">
          {pending
            .slice()
            .reverse()
            .map((p) => (
              <li key={p.id} className="py-3" data-note-pending>
                <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                  <span>{when(p.preparedAt)}</span>
                  <Badge tone="amber">À envoyer</Badge>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">{String(p.body.body ?? "")}</p>
              </li>
            ))}
          {(notes ?? []).map((n) => (
            <li key={n.id} className="py-3">
              <p className="text-xs text-[var(--muted)]">{when(n.preparedAt)}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">{n.body}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </Card>
  );
}
