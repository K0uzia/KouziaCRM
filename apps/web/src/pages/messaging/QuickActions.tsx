import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field, Select } from "@/components/ui/Field";

type Doc = {
  id: string;
  number: string | null;
  documentType: string;
  status: string;
};

type Props = {
  threadId: string;
  clientId?: string | null;
  clientName?: string | null;
  subject: string;
  onRefresh: () => void;
};

export function QuickActions({ threadId, clientId, clientName, subject, onRefresh }: Props) {
  const navigate = useNavigate();
  const [clients, setClients] = useState<Array<{ id: string; displayName: string }>>([]);
  const [linkClientId, setLinkClientId] = useState(clientId ?? "");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Array<{ id: string; displayName: string }>>("/api/clients").then(setClients);
  }, []);

  useEffect(() => {
    if (!clientId) return;
    void Promise.all([
      api<Doc[]>(`/api/invoices?clientId=${clientId}&pageSize=50`),
      api<Doc[]>(`/api/invoices?type=QUOTE&clientId=${clientId}&pageSize=50`),
    ]).then(([inv, quotes]) => setDocs([...inv, ...quotes].filter((d) => d.number)));
  }, [clientId]);

  async function linkClient() {
    if (!linkClientId) return;
    setBusy(true);
    try {
      await api(`/api/emails/${threadId}`, {
        method: "PATCH",
        body: JSON.stringify({ clientId: linkClientId }),
      });
      toast.success("Client lié au fil");
      onRefresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  async function sendDocument(documentId: string) {
    setBusy(true);
    try {
      await api("/api/emails/send", {
        method: "POST",
        body: JSON.stringify({
          clientId,
          subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
          body: "Veuillez trouver ci-joint le document demandé.",
          threadId,
          documentId,
        }),
      });
      toast.success("Document en file d'envoi");
      onRefresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-[var(--border)] pt-3">
      {!clientId ? (
        <>
          <Field label="Lier au client" className="min-w-[200px]">
            <Select value={linkClientId} onChange={(e) => setLinkClientId(e.target.value)}>
              <option value="">Choisir…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="button" variant="secondary" disabled={busy || !linkClientId} onClick={() => void linkClient()}>
            Lier
          </Button>
        </>
      ) : null}
      {clientId ? (
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              navigate(
                `/inbox/compose?clientId=${clientId}&template=relance&docNumber=`,
              )
            }
          >
            Relancer
          </Button>
          {docs.length > 0 ? (
            <Field label="Envoyer un document" className="min-w-[220px]">
              <Select
                defaultValue=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) void sendDocument(id);
                  e.target.value = "";
                }}
              >
                <option value="">Choisir un document émis…</option>
                {docs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.documentType === "QUOTE" ? "Devis" : "Facture"} {d.number}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {clientName ? (
            <Link to={`/clients/${clientId}`}>
              <Button type="button" variant="secondary" className="h-8 text-xs">
                Fiche client
              </Button>
            </Link>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
