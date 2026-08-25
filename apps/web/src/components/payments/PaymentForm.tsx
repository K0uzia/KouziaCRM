import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { paymentMethodLabel } from "@/lib/format";

export function PaymentForm({
  invoiceId,
  defaultAmountEuros,
  onSuccess,
  onCancel,
}: {
  invoiceId: string;
  defaultAmountEuros?: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(defaultAmountEuros ?? "");
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/invoices/${invoiceId}/pay`, {
        method: "POST",
        body: JSON.stringify({
          amountEuros: Number(amount),
          paidAt,
          method,
          reference: reference || null,
          notes: notes || null,
        }),
      });
      toast.success("Paiement enregistré");
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Montant encaissé (€)" hint="HT, franchise TVA">
          <Input
            required
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Date d’encaissement">
          <Input type="date" required value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </Field>
      </div>
      <Field label="Mode de paiement">
        <Select value={method} onChange={(e) => setMethod(e.target.value)}>
          {Object.entries(paymentMethodLabel).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Référence" hint="N° de virement, chèque…">
        <Input value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <Field label="Note">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Enregistrement…" : "Enregistrer le paiement"}
        </Button>
      </div>
    </form>
  );
}
