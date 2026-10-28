import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { proposalTitle, splitLineLabel } from "@/lib/quote-totals";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";

type PendingQuote = {
  id: string;
  number: string | null;
  totalCents: number;
  issueDate: string | null;
  /** Devis à propositions : le client en retient une. */
  options?: Array<{ id: string; position: number; label: string; totalCents: number }>;
};

const LETTERS = ["A", "B"];

/** Ligne en option d'un devis en paiement unique (28/10/2026) : le client la retient ou non à la signature. */
type OptionalLine = { id: string; description: string; unitPriceCents: number; commitmentMonths: number | null; optionId: string | null };

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
  const [optionId, setOptionId] = useState("");
  const [busy, setBusy] = useState(false);
  // Options du devis à valider : lues à l'ouverture de la fenêtre, un choix explicite pour chacune (pas de défaut).
  const [optionalLines, setOptionalLines] = useState<OptionalLine[] | null>(null);
  const [optionalChoices, setOptionalChoices] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOptionalChoices({});
    if (!confirmQuote) {
      setOptionalLines(null);
      return;
    }
    let alive = true;
    api<{ lines?: Array<OptionalLine & { isOptional?: boolean }> }>(`/api/invoices/${confirmQuote.id}`)
      .then((q) => alive && setOptionalLines((q.lines ?? []).filter((l) => l.isOptional)))
      .catch(() => alive && setOptionalLines([]));
    return () => {
      alive = false;
    };
  }, [confirmQuote]);
  const shownOptional = (optionalLines ?? []).filter((l) => (confirmQuote?.options?.length ? l.optionId === optionId : !l.optionId));
  const optionalMissing = optionalLines === null || shownOptional.some((l) => optionalChoices[l.id] === undefined);

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
          ...(confirmQuote.options?.length ? { optionId } : {}),
          ...(shownOptional.length ? { optionalLines: shownOptional.map((l) => ({ id: l.id, accepted: optionalChoices[l.id] })) } : {}),
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
    <div className="mb-4 rounded-[var(--radius)] border border-[var(--info)]/40 bg-[var(--info-soft)] p-4">
      {pendingQuotes.length > 0 ? (
        <>
          <p className="text-sm font-semibold text-[var(--text)]">Devis en attente de validation</p>
          {quoteConfirmationHint ? (
            <p className="mt-2 rounded-[var(--radius-sm)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--warning)]">
              Ce fil contient une formulation de validation (ex. « je valide », « bon pour accord »).
              Vérifiez le message du client, puis validez le devis ci-dessous.
            </p>
          ) : null}
          <ul className="mt-2 space-y-2">
            {pendingQuotes.map((q) => (
              <li
                key={q.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-sm"
              >
                <span>
                  {q.number ?? "Sans numéro"} · {q.options?.length ? `${q.options.length} propositions` : formatEUR(q.totalCents)}
                  {q.issueDate ? ` · ${formatDate(q.issueDate)}` : ""}
                </span>
                <Button
                  type="button"
                  className="text-xs"
                  onClick={() => {
                    setConfirmQuote(q);
                    setSignerName("");
                    setOptionId("");
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
        <div className={pendingQuotes.length > 0 ? "mt-3 border-t border-[var(--border)] pt-3" : ""}>
          <p className="text-xs font-medium text-[var(--muted)]">Validations récentes sur ce fil</p>
          <ul className="mt-1 space-y-1 text-xs text-[var(--text)]">
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
        {confirmQuote?.options?.length ? (
          <fieldset className="mt-4 space-y-1">
            <legend className="text-sm font-medium">Proposition retenue par le client</legend>
            {confirmQuote.options.map((o) => (
              <label key={o.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name="thread-option" value={o.id} checked={optionId === o.id} onChange={() => setOptionId(o.id)} />
                {proposalTitle(LETTERS[o.position] ?? String(o.position + 1), o.label)} ({formatEUR(o.totalCents)})
              </label>
            ))}
          </fieldset>
        ) : null}
        {shownOptional.map((l) => (
          <fieldset key={l.id} className="mt-4 space-y-1">
            <legend className="text-sm font-medium">
              Option : {splitLineLabel(l.description).title} ({formatEUR(l.unitPriceCents)} par an, engagement {l.commitmentMonths ?? 12} mois)
            </legend>
            {(
              [
                [true, "Retenue par le client"],
                [false, "Non retenue"],
              ] as const
            ).map(([value, label]) => (
              <label key={String(value)} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`thread-optional-${l.id}`}
                  checked={optionalChoices[l.id] === value}
                  onChange={() => setOptionalChoices((c) => ({ ...c, [l.id]: value }))}
                />
                {label}
              </label>
            ))}
          </fieldset>
        ))}
        <ModalActions>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirmQuote(null)}>
            Annuler
          </Button>
          <Button
            type="button"
            disabled={busy || !signerName.trim() || Boolean(confirmQuote?.options?.length && !optionId) || optionalMissing}
            onClick={() => void validateQuote()}
          >
            {busy ? "Validation…" : "Confirmer la validation"}
          </Button>
        </ModalActions>
      </Modal>
    </div>
  );
}
