import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import type { Client } from "@/components/clients/ClientForm";

export type DocLine = {
  description: string;
  quantity: string;
  unitPriceEuros: string;
  isSubscription: boolean;
  billingDay: string;
  serviceId: string;
};

export type DocumentFormValues = {
  clientId: string;
  notes: string;
  paymentTerms: string;
  serviceDate: string;
  purchaseOrderRef: string;
  validUntil: string;
  lines: DocLine[];
  discountType: "NONE" | "PERCENT" | "FIXED";
  discountPercent: string;
  discountEuros: string;
};

type ServiceOpt = {
  id: string;
  name: string;
  description: string | null;
  unitPriceCents: number;
  isSubscription?: boolean;
  defaultBillingDay?: number;
};

const emptyLine = (): DocLine => ({
  description: "",
  quantity: "1",
  unitPriceEuros: "",
  isSubscription: false,
  billingDay: "1",
  serviceId: "",
});

export function DocumentFormEditor({
  mode,
  documentType,
  documentId,
  initial,
  clients,
  onSuccess,
  onCancel,
}: {
  mode: "create" | "edit";
  documentType: "INVOICE" | "QUOTE";
  documentId?: string;
  initial?: Partial<DocumentFormValues>;
  clients: Array<{ id: string; displayName: string; clientNumber?: string | null }>;
  onSuccess: (doc: { id: string }) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<DocumentFormValues>({
    clientId: initial?.clientId ?? clients[0]?.id ?? "",
    notes: initial?.notes ?? "",
    paymentTerms:
      initial?.paymentTerms ??
      (documentType === "QUOTE" ? "Devis valable 30 jours" : "Paiement à réception"),
    serviceDate: initial?.serviceDate ?? "",
    purchaseOrderRef: initial?.purchaseOrderRef ?? "",
    validUntil: initial?.validUntil ?? "",
    lines: initial?.lines?.length
      ? initial.lines.map((l) => ({ ...emptyLine(), ...l }))
      : [emptyLine()],
    discountType: initial?.discountType ?? "NONE",
    discountPercent: initial?.discountPercent ?? "",
    discountEuros: initial?.discountEuros ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [services, setServices] = useState<ServiceOpt[]>([]);

  useEffect(() => {
    if (!form.clientId && clients[0]) {
      setForm((f) => ({ ...f, clientId: clients[0].id }));
    }
  }, [clients, form.clientId]);

  useEffect(() => {
    api<ServiceOpt[]>("/api/services?active=1")
      .then(setServices)
      .catch(() => setServices([]));
  }, []);

  function updateLine(index: number, patch: Partial<DocLine>) {
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));
  }

  function applyService(index: number, serviceId: string) {
    const s = services.find((x) => x.id === serviceId);
    if (!s) return;
    const isSub = Boolean(s.isSubscription);
    updateLine(index, {
      serviceId,
      description: s.description ? `${s.name} - ${s.description}` : s.name,
      unitPriceEuros: (s.unitPriceCents / 100).toFixed(2),
      isSubscription: isSub,
      billingDay: String(s.defaultBillingDay ?? 1),
      quantity: isSub ? "1" : form.lines[index]?.quantity || "1",
    });
  }

  function addLine() {
    setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }));
  }

  function removeLine(index: number) {
    setForm((f) => ({
      ...f,
      lines: f.lines.length <= 1 ? f.lines : f.lines.filter((_, i) => i !== index),
    }));
  }

  const subtotalPreview = form.lines.reduce((sum, l) => {
    const q = l.isSubscription ? 1 : Number(l.quantity) || 0;
    const p = Number(l.unitPriceEuros) || 0;
    return sum + q * p;
  }, 0);

  const discountPreview =
    form.discountType === "PERCENT"
      ? Math.min(subtotalPreview, (subtotalPreview * (Number(form.discountPercent) || 0)) / 100)
      : form.discountType === "FIXED"
        ? Math.min(subtotalPreview, Number(form.discountEuros) || 0)
        : 0;

  const totalPreview = Math.max(0, subtotalPreview - discountPreview);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    for (const l of form.lines) {
      if (l.isSubscription && !l.serviceId) {
        toast.error("Chaque ligne abonnement doit être liée à une prestation");
        return;
      }
    }
    setBusy(true);
    try {
      const body = {
        clientId: form.clientId,
        documentType,
        notes: form.notes || null,
        paymentTerms: form.paymentTerms || null,
        serviceDate: documentType === "INVOICE" ? form.serviceDate || null : null,
        purchaseOrderRef: form.purchaseOrderRef || null,
        validUntil: form.validUntil || null,
        discountType: form.discountType,
        discountPercent:
          form.discountType === "PERCENT" ? Number(form.discountPercent) || 0 : undefined,
        discountEuros:
          form.discountType === "FIXED" ? Number(form.discountEuros) || 0 : undefined,
        lines: form.lines.map((l) => ({
          description: l.description,
          quantity: l.isSubscription ? 1 : Number(l.quantity),
          unitPriceEuros: Number(l.unitPriceEuros),
          isSubscription: l.isSubscription,
          billingDay: l.isSubscription ? Number(l.billingDay) || 1 : null,
          serviceId: l.isSubscription ? l.serviceId : null,
        })),
      };
      const doc = await api<{ id: string }>(
        mode === "edit" && documentId ? `/api/invoices/${documentId}` : "/api/invoices",
        {
          method: mode === "edit" ? "PUT" : "POST",
          body: JSON.stringify(body),
        },
      );
      toast.success(
        mode === "edit"
          ? "Document mis à jour"
          : documentType === "QUOTE"
            ? "Devis créé"
            : "Facture créée",
      );
      onSuccess(doc);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <Field label="Client" hint="Choisissez le destinataire du document">
        <Select
          required
          value={form.clientId}
          onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
        >
          {clients.length === 0 ? (
            <option value="">Aucun client - créez-en un d&apos;abord</option>
          ) : (
            clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.clientNumber ? `${c.clientNumber} · ` : ""}
                {c.displayName}
              </option>
            ))
          )}
        </Select>
      </Field>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Lignes</p>
          <Button type="button" variant="secondary" className="h-8 px-3 text-xs" onClick={addLine}>
            Ajouter une ligne
          </Button>
        </div>
        {form.lines.map((line, i) => (
          <div
            key={i}
            className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] p-3"
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={line.isSubscription}
                onChange={(e) =>
                  updateLine(i, {
                    isSubscription: e.target.checked,
                    quantity: e.target.checked ? "1" : line.quantity,
                  })
                }
              />
              Prestation d&apos;abonnement mensuel
              {line.isSubscription ? (
                <span className="text-xs text-[var(--muted)]">
                  Inclus dans le total (1re échéance), puis facturé chaque mois le{" "}
                  {line.billingDay || "…"}
                </span>
              ) : null}
            </label>

            {line.isSubscription ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Prestation catalogue">
                  <Select
                    required
                    value={line.serviceId}
                    onChange={(e) => applyService(i, e.target.value)}
                  >
                    <option value="">Choisir…</option>
                    {services
                      .filter((s) => s.isSubscription)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({(s.unitPriceCents / 100).toFixed(2)} € / mois)
                        </option>
                      ))}
                    {services.some((s) => !s.isSubscription) ? (
                      <optgroup label="Autres prestations">
                        {services
                          .filter((s) => !s.isSubscription)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} ({(s.unitPriceCents / 100).toFixed(2)} €)
                            </option>
                          ))}
                      </optgroup>
                    ) : null}
                  </Select>
                </Field>
                <Field label="Jour de facturation">
                  <Select
                    value={line.billingDay}
                    onChange={(e) => updateLine(i, { billingDay: e.target.value })}
                  >
                    {Array.from({ length: 28 }, (_, d) => d + 1).map((d) => (
                      <option key={d} value={String(d)}>
                        Le {d}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : services.length > 0 ? (
              <Select
                value=""
                onChange={(e) => {
                  if (e.target.value) applyService(i, e.target.value);
                }}
              >
                <option value="">Prestation du catalogue…</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.isSubscription ? "[Abo] " : ""}
                    {s.name} ({(s.unitPriceCents / 100).toFixed(2)} €
                    {s.isSubscription ? " / mois" : ""})
                  </option>
                ))}
              </Select>
            ) : null}

            <div className="grid gap-2 sm:grid-cols-[1fr_88px_110px_36px]">
              <Input
                required
                placeholder="Description de la prestation"
                value={line.description}
                onChange={(e) => updateLine(i, { description: e.target.value })}
              />
              <Input
                required
                type="number"
                step="0.01"
                min="0.01"
                placeholder="Qté"
                value={line.isSubscription ? "1" : line.quantity}
                disabled={line.isSubscription}
                onChange={(e) => updateLine(i, { quantity: e.target.value })}
              />
              <Input
                required
                type="number"
                step="0.01"
                placeholder={line.isSubscription ? "€ / mois" : "Prix HT €"}
                value={line.unitPriceEuros}
                onChange={(e) => updateLine(i, { unitPriceEuros: e.target.value })}
              />
              <button
                type="button"
                className="text-sm text-[var(--muted)] hover:text-[var(--danger)]"
                onClick={() => removeLine(i)}
                aria-label="Supprimer la ligne"
              >
                ×
              </button>
            </div>
          </div>
        ))}
        <div className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] p-3">
          <p className="text-sm font-medium">Remise globale</p>
          <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
            <Select
              value={form.discountType}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  discountType: e.target.value as DocumentFormValues["discountType"],
                }))
              }
            >
              <option value="NONE">Aucune</option>
              <option value="PERCENT">Pourcentage (%)</option>
              <option value="FIXED">Montant fixe (€ HT)</option>
            </Select>
            {form.discountType === "PERCENT" ? (
              <Input
                type="number"
                step="0.01"
                min="0"
                max="100"
                placeholder="Ex. 10"
                value={form.discountPercent}
                onChange={(e) => setForm((f) => ({ ...f, discountPercent: e.target.value }))}
              />
            ) : form.discountType === "FIXED" ? (
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="Ex. 50.00"
                value={form.discountEuros}
                onChange={(e) => setForm((f) => ({ ...f, discountEuros: e.target.value }))}
              />
            ) : (
              <p className="self-center text-xs text-[var(--muted)]">Pas de remise</p>
            )}
          </div>
        </div>
        <div className="space-y-1 text-right text-sm text-[var(--muted)]">
          {discountPreview > 0 ? (
            <>
              <p>
                Sous-total :{" "}
                {subtotalPreview.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}
              </p>
              <p>
                Remise : −
                {discountPreview.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}
              </p>
            </>
          ) : null}
          <p>
            Total HT estimé :{" "}
            <span className="font-semibold text-[var(--text)]">
              {totalPreview.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}
            </span>
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={documentType === "QUOTE" ? "Conditions / validité" : "Conditions de paiement"}
        >
          <Input
            value={form.paymentTerms}
            onChange={(e) => setForm((f) => ({ ...f, paymentTerms: e.target.value }))}
          />
        </Field>
        {documentType === "QUOTE" ? (
          <Field label="Valable jusqu’au" hint="Défaut J+30 si vide">
            <Input
              type="date"
              value={form.validUntil}
              onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))}
            />
          </Field>
        ) : (
          <Field label="Date de la prestation" hint="Obligatoire si différente de l’émission">
            <Input
              type="date"
              value={form.serviceDate}
              onChange={(e) => setForm((f) => ({ ...f, serviceDate: e.target.value }))}
            />
          </Field>
        )}
      </div>

      <Field label="Bon de commande du client" hint="Sa référence, s’il en a fourni un">
        <Input
          value={form.purchaseOrderRef}
          onChange={(e) => setForm((f) => ({ ...f, purchaseOrderRef: e.target.value }))}
          placeholder="Facultatif"
        />
      </Field>

      <Field label="Notes" hint="Apparaissent sur le PDF">
        <Textarea
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          rows={3}
        />
      </Field>

      <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <Button type="submit" disabled={busy || !form.clientId}>
          {busy
            ? "Enregistrement…"
            : mode === "edit"
              ? "Enregistrer"
              : documentType === "QUOTE"
                ? "Créer le devis"
                : "Créer la facture"}
        </Button>
      </div>
    </form>
  );
}

export type { Client };
