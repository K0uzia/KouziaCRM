import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { DateInput, Field, Input, Select, Textarea } from "@/components/ui/Field";

export type ManualPaymentInput = {
  method: "BANK_TRANSFER" | "CHECK" | "CASH" | "OTHER";
  reference: string | null;
  notes: string | null;
  /** Date du règlement (AAAA-MM-JJ) : virement reçu, chèque encaissé ; pas dans le futur. */
  paidAt: string;
  /** Reçu du règlement et facture en PDF envoyés au client. */
  notifyClient: boolean;
};

/** Jour local au format AAAA-MM-JJ (valeur d'un champ date). */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const METHODS: Array<{ value: ManualPaymentInput["method"]; label: string }> = [
  { value: "BANK_TRANSFER", label: "Virement" },
  { value: "CHECK", label: "Chèque" },
  { value: "CASH", label: "Espèces" },
  { value: "OTHER", label: "Autre" },
];

/** Pointage d'un acompte reçu hors paiement en ligne (virement, chèque…). */
export function ManualPaymentDialog({
  open,
  label,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  label: string;
  busy: boolean;
  onConfirm: (input: ManualPaymentInput) => void;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<ManualPaymentInput["method"]>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [notifyClient, setNotifyClient] = useState(true);
  const [paidAt, setPaidAt] = useState(todayIso);

  useEffect(() => {
    if (!open) return;
    setMethod("BANK_TRANSFER");
    setReference("");
    setNotes("");
    setNotifyClient(true);
    setPaidAt(todayIso());
  }, [open]);

  function submit(e: FormEvent) {
    e.preventDefault();
    onConfirm({ method, paidAt, reference: reference.trim() || null, notes: notes.trim() || null, notifyClient });
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Marquer comme payé"
      description={label}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Moyen de paiement">
          <Select value={method} onChange={(e) => setMethod(e.target.value as ManualPaymentInput["method"])}>
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date du règlement" hint="Jour où le virement est arrivé ou le chèque encaissé.">
          <DateInput required max={todayIso()} value={paidAt} onChange={setPaidAt} />
        </Field>
        <Field label="Référence" hint="Libellé du virement ou numéro de chèque (facultatif).">
          <Input maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Commentaire interne" hint="Non visible par le client (facultatif).">
          <Textarea maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={notifyClient}
            onChange={(e) => setNotifyClient(e.target.checked)}
          />
          <span>
            Envoyer le reçu au client
            <span className="block text-xs text-[var(--muted)]">Email avec le reçu du paiement et la facture en PDF.</span>
          </span>
        </label>
        <ModalActions>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={busy}>
            Enregistrer le paiement
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
