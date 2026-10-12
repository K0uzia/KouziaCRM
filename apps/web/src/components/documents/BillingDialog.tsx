import { useEffect, useState } from "react";
import { formatEUR } from "@/lib/api";
import { useFeatures } from "@/lib/features";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Field, Input, Textarea } from "@/components/ui/Field";

/** Choix envoyé à l'API : aucun lien, lien collé, ou lien Stripe automatique. */
export type PaymentChoice = { mode: "none" } | { mode: "manual"; url: string } | { mode: "auto" };

export type PaymentFieldsState = { mode: "none" | "manual" | "auto"; url: string };

export function paymentChoiceOf(state: PaymentFieldsState): PaymentChoice {
  if (state.mode === "manual") return { mode: "manual", url: state.url.trim() };
  if (state.mode === "auto") return { mode: "auto" };
  return { mode: "none" };
}

export function paymentFieldsValid(state: PaymentFieldsState): boolean {
  return state.mode !== "manual" || /^https:\/\/\S+$/i.test(state.url.trim());
}

/** Bloc « Paiement en ligne » : partagé par l'émission, la facturation d'acompte et la fiche facture. */
export function PaymentLinkFields({
  value,
  onChange,
  noneLabel = "Pas de lien (virement, IBAN indiqué sur la facture)",
}: {
  value: PaymentFieldsState;
  onChange: (next: PaymentFieldsState) => void;
  noneLabel?: string;
}) {
  const { moduleStripeEnabled } = useFeatures();
  const options: Array<{ mode: PaymentFieldsState["mode"]; label: string; hint?: string }> = [
    {
      mode: "manual",
      label: "Coller un lien de paiement",
      hint: "URL https de paiement (exception).",
    },
    ...(moduleStripeEnabled
      ? [{ mode: "auto" as const, label: "Lien Stripe automatique (carte ou virement)" }]
      : []),
    { mode: "none", label: noneLabel },
  ];
  const invalid = value.mode === "manual" && value.url.trim() !== "" && !paymentFieldsValid(value);
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">Paiement en ligne</legend>
      {options.map((o) => (
        <label
          key={o.mode}
          className={`flex cursor-pointer items-start gap-3 rounded-[var(--radius)] border p-3 text-sm transition-colors ${
            value.mode === o.mode
              ? "border-[var(--primary)]/60 bg-[var(--primary-soft)]"
              : "border-[var(--border)] hover:bg-[var(--surface-hover)]"
          }`}
        >
          <input
            type="radio"
            name="payment-mode"
            className="mt-0.5"
            checked={value.mode === o.mode}
            onChange={() => onChange({ ...value, mode: o.mode })}
          />
          <span className="min-w-0">
            <span className="block">{o.label}</span>
            {o.hint ? <span className="block text-xs text-[var(--muted)]">{o.hint}</span> : null}
          </span>
        </label>
      ))}
      {value.mode === "manual" ? (
        <Field
          label="Lien de paiement"
          hint="Il apparaît en bouton « Payer en ligne » dans l'email et dans l'espace client."
          error={invalid ? "Le lien doit commencer par https://" : undefined}
        >
          <Input
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={value.url}
            onChange={(e) => onChange({ ...value, url: e.target.value })}
            autoFocus
          />
        </Field>
      ) : null}
    </fieldset>
  );
}

export type BillingRequest = {
  payment: PaymentChoice;
  email: { send: boolean; subject: string; body: string };
};

/**
 * Fenêtre « Facturer » (acompte, solde) : récapitulatif, lien de paiement puis email.
 * Rien n'est émis avant validation.
 */
export function BillingDialog({
  open,
  title,
  description,
  amountCents,
  clientEmail,
  defaultSubject,
  defaultBody,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  amountCents: number;
  clientEmail: string | null | undefined;
  defaultSubject: string;
  defaultBody: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: (req: BillingRequest) => void;
  onClose: () => void;
}) {
  const [payment, setPayment] = useState<PaymentFieldsState>({ mode: "manual", url: "" });
  const [send, setSend] = useState(Boolean(clientEmail));
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);

  useEffect(() => {
    if (!open) return;
    setPayment({ mode: "manual", url: "" });
    setSend(Boolean(clientEmail));
    setSubject(defaultSubject);
    setBody(defaultBody);
  }, [open, clientEmail, defaultSubject, defaultBody]);

  const valid = paymentFieldsValid(payment) && (payment.mode !== "manual" || payment.url.trim() !== "");

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title={title} description={description} wide>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onConfirm({ payment: paymentChoiceOf(payment), email: { send, subject, body } });
        }}
      >
        <div className="flex items-baseline justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3">
          <span className="text-sm text-[var(--muted)]">Montant facturé</span>
          <span className="font-display text-2xl font-semibold tabular-nums">{formatEUR(amountCents)}</span>
        </div>

        <PaymentLinkFields value={payment} onChange={setPayment} />

        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={send}
              disabled={!clientEmail}
              onChange={(e) => setSend(e.target.checked)}
            />
            Envoyer la facture par email au client
            <span className="text-xs text-[var(--muted)]">
              {clientEmail ? `(${clientEmail})` : "(pas d'adresse)"}
            </span>
          </label>
          {send ? (
            <>
              <Field label="Objet">
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} required />
              </Field>
              <Field
                label="Message"
                hint="{{numero}} est remplacé par le numéro de la facture. Le lien de paiement est ajouté en bouton s'il n'est pas déjà dans le texte."
              >
                <Textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} required />
              </Field>
            </>
          ) : null}
        </div>

        <ModalActions>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={busy || !valid}>
            {busy ? "Facturation…" : confirmLabel}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
