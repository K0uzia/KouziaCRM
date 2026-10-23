import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { ModalActions } from "@/components/ui/Modal";
import { DateInput, Field, Input, Select, Textarea } from "@/components/ui/Field";
import { paymentMethodLabel } from "@/lib/format";
import { ReceiptDialog } from "@/components/messaging/document-email-dialogs";

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
  const [notifyClient, setNotifyClient] = useState(true);
  const [busy, setBusy] = useState(false);
  // Paiement enregistré dont le reçu est à relire avant l'envoi (« Vérifier l'e-mail »).
  const [receiptPaymentId, setReceiptPaymentId] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Reçu jamais envoyé d'office : relu ensuite dans « Vérifier l'e-mail ».
      const res = await api<{ id: string }>(
        `/api/invoices/${invoiceId}/pay`,
        {
          method: "POST",
          body: JSON.stringify({
            amountEuros: Number(amount),
            paidAt,
            method,
            reference: reference || null,
            notes: notes || null,
            notifyClient: false,
          }),
        },
      );
      toast.success("Paiement enregistré");
      if (notifyClient) {
        setReceiptPaymentId(res.id);
        return;
      }
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Montant encaissé (€)" hint="Montant réellement reçu">
          <Input
            required
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Date d’encaissement">
          <DateInput required value={paidAt} onChange={(v) => setPaidAt(v)} />
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
      <label className="flex min-h-11 items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={notifyClient}
          onChange={(e) => setNotifyClient(e.target.checked)}
        />
        <span>
          Envoyer le reçu au client
          <span className="block text-xs text-[var(--muted)]">
            Email avec le reçu du paiement et la facture en PDF, relu avant l'envoi.
          </span>
        </span>
      </label>
      <ModalActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Enregistrement…" : "Enregistrer le paiement"}
        </Button>
      </ModalActions>
    </form>
    {/* Fermeture (envoyé ou non) : le paiement est enregistré, la fiche se met à jour. */}
    <ReceiptDialog
      invoiceId={receiptPaymentId ? invoiceId : null}
      paymentId={receiptPaymentId}
      onClose={() => {
        setReceiptPaymentId(null);
        onSuccess();
      }}
    />
    </>
  );
}
