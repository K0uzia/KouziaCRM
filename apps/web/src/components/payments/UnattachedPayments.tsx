import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate, paymentMethodLabel } from "@/lib/format";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Field, Select } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";

type Unattached = {
  payments: Array<{ id: string; amountCents: number; paidAt: string; method: string; reference: string | null }>;
  invoices: Array<{ id: string; number: string | null; clientName: string; dueCents: number }>;
};

/**
 * Paiements reçus sans facture (paiement Stripe sans facture rattachable) : bandeau tant qu'il en reste, et fenêtre pour
 * rattacher chacun à une facture émise encore due. Ouverte d'office depuis « À traiter » (?rattacher=1).
 */
export function UnattachedPayments({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<Unattached | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const open = params.get("rattacher") === "1";

  const load = useCallback(() => {
    setError(null);
    api<Unattached>("/api/payments/unattached")
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Paiements sans facture indisponibles"));
  }, []);
  useEffect(load, [load]);

  const setOpen = (value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set("rattacher", "1");
    else next.delete("rattacher");
    setParams(next, { replace: true });
  };

  async function attach(paymentId: string) {
    const invoiceId = choice[paymentId] ?? data?.invoices[0]?.id;
    if (!invoiceId) return;
    setBusyId(paymentId);
    try {
      await api(`/api/payments/${paymentId}/attach`, { method: "POST", body: JSON.stringify({ invoiceId }) });
      const number = data?.invoices.find((i) => i.id === invoiceId)?.number ?? "";
      toast.success(`Paiement rattaché à ${number}`.trim());
      load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rattachement impossible");
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return (
      <Banner level="error" className="mb-6" action={<Button variant="secondary" onClick={load}>Réessayer</Button>}>
        Paiements reçus sans facture : {error}
      </Banner>
    );
  }
  if (!data || data.payments.length === 0) return null;
  const total = data.payments.reduce((s, p) => s + p.amountCents, 0);

  return (
    <>
      <Banner level="warning" className="mb-6" action={<Button variant="secondary" onClick={() => setOpen(true)}>Rattacher</Button>}>
        {data.payments.length} paiement{data.payments.length > 1 ? "s" : ""} reçu{data.payments.length > 1 ? "s" : ""} sans facture (
        {formatEUR(total)}) : rattachez-le{data.payments.length > 1 ? "s" : ""} à la facture correspondante, ou remboursez le client.
      </Banner>
      <Modal open={open} onClose={busyId ? () => undefined : () => setOpen(false)} title="Rattacher les paiements sans facture">
        <div className="space-y-5">
          {data.invoices.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              Aucune facture émise n&apos;est encore due. Émettez d&apos;abord la facture correspondante, ou remboursez le client.
            </p>
          ) : null}
          <ul className="space-y-4">
            {data.payments.map((p) => (
              <li key={p.id} className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] p-4">
                <p className="text-sm">
                  <span className="font-semibold tabular-nums">{formatEUR(p.amountCents)}</span>
                  <span className="text-[var(--muted)]">
                    {" "}
                    reçu le {formatDate(p.paidAt)} ({paymentMethodLabel[p.method] ?? p.method}
                    {p.reference ? `, ${p.reference}` : ""})
                  </span>
                </p>
                {data.invoices.length > 0 ? (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <Field label="Facture" className="min-w-0 flex-1">
                      <Select value={choice[p.id] ?? data.invoices[0]!.id} onChange={(e) => setChoice({ ...choice, [p.id]: e.target.value })}>
                        {data.invoices.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.number} : {i.clientName}, reste dû {formatEUR(i.dueCents)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button disabled={busyId !== null} onClick={() => void attach(p.id)}>
                      {busyId === p.id ? "Rattachement…" : "Rattacher"}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <ModalActions>
            <Button variant="secondary" disabled={busyId !== null} onClick={() => setOpen(false)}>
              Fermer
            </Button>
          </ModalActions>
        </div>
      </Modal>
    </>
  );
}
