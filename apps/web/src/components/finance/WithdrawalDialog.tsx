import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { DateInput, Field, Input } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";

export type Withdrawal = { id: string; amountCents: number; date: string; note: string | null };

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Retrait de l'entrepreneur (virement du compte pro vers le compte perso), à saisir à la main.
 * Création : montant prérempli avec le salaire disponible, date du jour. Correction : valeurs existantes.
 */
export function WithdrawalDialog({
  open,
  onClose,
  availableCents,
  editing,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  availableCents: number;
  editing?: Withdrawal | null;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (editing) {
      setAmount((editing.amountCents / 100).toFixed(2));
      setDate(editing.date.slice(0, 10));
      setNote(editing.note ?? "");
    } else {
      setAmount(availableCents > 0 ? (availableCents / 100).toFixed(2) : "");
      setDate(today());
      setNote("");
    }
  }, [open, editing, availableCents]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(amount.replace(",", ".")) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setErrors({ amountCents: "Montant supérieur à 0 attendu" });
      return;
    }
    // Plafond : le disponible (en correction, il inclut le montant actuel du retrait).
    const limit = availableCents + (editing?.amountCents ?? 0);
    if (cents > limit) {
      setErrors({ amountCents: `Au plus ${formatEUR(limit)} disponibles` });
      return;
    }
    setBusy(true);
    try {
      const body = JSON.stringify({ amountCents: cents, date, note: note.trim() || null });
      if (editing) await api(`/api/owner-withdrawals/${editing.id}`, { method: "PATCH", body });
      else await api("/api/owner-withdrawals", { method: "POST", body });
      toast.success(editing ? "Retrait corrigé" : `Retrait de ${formatEUR(cents)} enregistré`);
      onDone();
      onClose();
    } catch (err) {
      const fieldErrors = (err as { fieldErrors?: Record<string, string> }).fieldErrors;
      if (fieldErrors) setErrors(fieldErrors);
      toast.error(err instanceof Error ? err.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={editing ? "Corriger le retrait" : "Enregistrer un retrait"}
      description="Virement du compte pro vers votre compte perso : il est déduit du salaire disponible."
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        <Field
          label="Montant (€)"
          hint={`Disponible : ${formatEUR(availableCents + (editing?.amountCents ?? 0))}`}
          error={errors.amountCents}
        >
          <Input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Date" error={errors.date}>
          <DateInput value={date} max={today()} onChange={(v) => setDate(v)} />
        </Field>
        <Field label="Note (facultatif)" error={errors.note}>
          <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ModalActions>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Enregistrement…" : editing ? "Enregistrer la correction" : "Enregistrer le retrait"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
