import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { isNetworkFailure } from "@/lib/network";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ResendDocumentDialog } from "@/components/messaging/document-email-dialogs";

type TimelineItem = {
  id: string;
  kind: "thread" | "event";
  at: string;
  subject: string;
  direction?: string;
  eventKind?: string;
  documentId?: string | null;
  documentNumber?: string | null;
  success?: boolean;
  threadId?: string;
};

export function ClientMessagesTab({ clientId }: { clientId: string }) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [offlineBlock, setOfflineBlock] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await api<{ items: TimelineItem[] }>(`/api/clients/${clientId}/emails`);
      setItems(res.items);
    } catch (e) {
      // Messagerie jamais copiée sur l'appareil (liste fermée) : état du bloc, pas une erreur.
      if (isNetworkFailure(e)) setOfflineBlock(true);
      else toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [clientId]);

  // « Renvoyer PDF » : e-mail relu dans « Vérifier l'e-mail » avant l'envoi (E6c).
  const [resendFor, setResendFor] = useState<string | null>(null);

  if (loading) return <p className="text-sm text-[var(--muted)]">Chargement…</p>;
  if (offlineBlock) {
    return (
      <Card className="p-5">
        <p className="text-sm text-[var(--muted)]">Non disponible hors ligne : les échanges ne sont pas copiés sur l&apos;appareil.</p>
      </Card>
    );
  }

  return (
    <Card className="space-y-3 p-5">
      <ResendDocumentDialog documentId={resendFor} onClose={() => setResendFor(null)} onSent={() => load()} />
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Messages</h2>
        <Link to={`/inbox/compose?clientId=${clientId}`}>
          <Button type="button" variant="secondary" className="text-xs">
            Écrire
          </Button>
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">Aucun échange enregistré.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {items.map((item) => (
            <li key={item.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{item.subject}</p>
                  <p className="text-xs text-[var(--muted)]">
                    {item.kind === "thread"
                      ? `Fil · ${item.direction ?? "mixte"}`
                      : `Envoi · ${item.eventKind ?? "email"}`}
                    {" · "}
                    {formatDate(item.at)}
                    {item.success === false ? " · échec" : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  {item.kind === "thread" && item.threadId ? (
                    <Link to={`/inbox/${item.threadId}`}>
                      <Button type="button" variant="secondary" className="h-7 px-2 text-xs">
                        Ouvrir
                      </Button>
                    </Link>
                  ) : null}
                  {item.documentId && item.documentNumber ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => setResendFor(item.documentId!)}
                    >
                      Renvoyer PDF
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
