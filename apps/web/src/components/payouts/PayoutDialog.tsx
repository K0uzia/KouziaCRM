import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";

type Preview = {
  availableCents: number;
  pendingCents: number;
  destination: { bankName: string | null; last4: string } | null;
  mode: "test" | "live";
  delayText: string;
};

/**
 * « Verser » : versement du solde Stripe vers le compte bancaire. Montant proposé = salaire
 * disponible (encaissé moins URSSAF et provisions), plafonné au solde Stripe disponible.
 */
export function PayoutDialog({
  open,
  onClose,
  suggestedCents,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  suggestedCents: number;
  onDone: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  // Clé d'idempotence tirée à l'ouverture : un double clic ou un renvoi ne verse jamais deux fois.
  const requestId = useRef("");

  useEffect(() => {
    if (!open) return;
    requestId.current = crypto.randomUUID();
    setPreview(null);
    setError(null);
    api<Preview>("/api/stripe/payouts/preview")
      .then((p) => {
        setPreview(p);
        const proposed = Math.max(0, Math.min(suggestedCents, p.availableCents));
        setAmount((proposed / 100).toFixed(2));
      })
      .catch((e: Error) => setError(e.message));
  }, [open, suggestedCents]);

  const amountCents = Math.round(Number(amount || 0) * 100);
  const tooMuch = preview ? amountCents > preview.availableCents : false;
  const invalid = !preview || amountCents <= 0 || tooMuch;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    setBusy(true);
    try {
      await api("/api/stripe/payouts", {
        method: "POST",
        body: JSON.stringify({ amountCents, requestId: requestId.current }),
      });
      toast.success(`Versement de ${formatEUR(amountCents)} demandé : ${preview?.delayText ?? ""}`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Versement impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Verser sur mon compte">
      {error ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : !preview ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          Lecture du solde Stripe…
        </p>
      ) : (
        <form className="space-y-4" onSubmit={(e) => void submit(e)}>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-[var(--muted)]">Disponible chez Stripe</dt>
              <dd className="font-semibold tabular-nums">{formatEUR(preview.availableCents)}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Salaire disponible</dt>
              <dd className="font-semibold tabular-nums">{formatEUR(suggestedCents)}</dd>
            </div>
          </dl>
          <Field
            label="Montant à verser (€)"
            error={tooMuch ? `Au plus ${formatEUR(preview.availableCents)} (solde disponible).` : undefined}
          >
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              max={(preview.availableCents / 100).toFixed(2)}
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <p className="text-sm text-[var(--muted)]">
            Vers{" "}
            {preview.destination
              ? `le compte ${preview.destination.bankName ? `${preview.destination.bankName} ` : ""}se terminant par ${preview.destination.last4}`
              : "le compte bancaire enregistré dans Stripe"}
            , {preview.delayText}.
            {preview.mode === "test" ? " Mode test Stripe : aucun argent réel." : ""}
          </p>
          <ModalActions>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy || invalid}>
              {busy ? "Versement…" : `Verser ${amountCents > 0 ? formatEUR(amountCents) : ""}`}
            </Button>
          </ModalActions>
        </form>
      )}
    </Modal>
  );
}
