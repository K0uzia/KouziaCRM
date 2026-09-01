import { useState } from "react";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";

type PendingQuote = {
  id: string;
  number: string | null;
  totalCents: number;
  issueDate: string | null;
};

type AcceptanceAudit = {
  id: string;
  quoteId: string;
  signerName: string;
  source: string;
  createdAt: string;
  quote: { number: string | null };
};

type Props = {
  threadId: string;
  pendingQuotes: PendingQuote[];
  acceptanceAudits?: AcceptanceAudit[];
  quoteConfirmationHint?: boolean;
  onAccepted: () => void;
};

export function QuoteValidationBlock({
  threadId,
  pendingQuotes,
  acceptanceAudits = [],
  quoteConfirmationHint = false,
  onAccepted,
}: Props) {
  const [confirmQuote, setConfirmQuote] = useState<PendingQuote | null>(null);
  const [signerName, setSignerName] = useState("");
  const [busy, setBusy] = useState(false);

  if (pendingQuotes.length === 0 && acceptanceAudits.length === 0) return null;

  async function validateQuote() {
    if (!confirmQuote || !signerName.trim()) return;
    setBusy(true);
    try {
      await api(`/api/quotes/${confirmQuote.id}/accept-from-thread`, {
        method: "POST",
        body: JSON.stringify({
          threadId,
          signerName: signerName.trim(),
        }),
      });
      toast.success(`Devis ${confirmQuote.number ?? ""} validé. Demande d'acompte envoyée au client.`);
      setConfirmQuote(null);
      setSignerName("");
      onAccepted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Validation impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-teal-200 bg-teal-50/80 p-4">
      {pendingQuotes.length > 0 ? (
        <>
          <p className="text-sm font-semibold text-teal-900">Devis en attente de validation</p>
          {quoteConfirmationHint ? (
            <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Ce fil contient une formulation de validation (ex. « je valide », « bon pour accord »).
              Vérifiez le message du client, puis validez le devis ci-dessous.
            </p>
          ) : null}
          <ul className="mt-2 space-y-2">
            {pendingQuotes.map((q) => (
              <li
                key={q.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-teal-100 bg-white px-3 py-2 text-sm"
              >
                <span>
                  {q.number ?? "Sans numéro"} · {formatEUR(q.totalCents)}
                  {q.issueDate ? ` · ${formatDate(q.issueDate)}` : ""}
                </span>
                <Button
                  type="button"
                  className="h-8 text-xs"
                  onClick={() => {
                    setConfirmQuote(q);
                    setSignerName("");
                  }}
                >
                  Valider ce devis
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {acceptanceAudits.length > 0 ? (
        <div className={pendingQuotes.length > 0 ? "mt-3 border-t border-teal-100 pt-3" : ""}>
          <p className="text-xs font-medium text-teal-800">Validations récentes sur ce fil</p>
          <ul className="mt-1 space-y-1 text-xs text-teal-900">
            {acceptanceAudits.map((a) => (
              <li key={a.id}>
                {a.quote.number ?? "Devis"} validé par {a.signerName} le {formatDate(a.createdAt)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Modal
        open={confirmQuote != null}
        onClose={() => !busy && setConfirmQuote(null)}
        title="Valider ce devis ?"
        description={
          confirmQuote
            ? `Le devis ${confirmQuote.number ?? ""} sera marqué accepté. Le client recevra automatiquement la demande de règlement du premier acompte.`
            : undefined
        }
      >
        <p className="text-sm text-[var(--muted)]">
          Cette action déclenche l&apos;exigibilité de l&apos;acompte et l&apos;envoi du lien de paiement au client.
        </p>
        <div className="mt-4">
          <Field label="Nom du signataire (bon pour accord)">
            <Input
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
              placeholder="Nom et prénom du client"
              required
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirmQuote(null)}>
            Annuler
          </Button>
          <Button
            type="button"
            disabled={busy || !signerName.trim()}
            onClick={() => void validateQuote()}
          >
            {busy ? "Validation…" : "Confirmer la validation"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
