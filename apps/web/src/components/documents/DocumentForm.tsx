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
};

export type DocumentFormValues = {
  clientId: string;
  notes: string;
  paymentTerms: string;
  validUntil: string;
  lines: DocLine[];
};

type ServiceOpt = {
  id: string;
  name: string;
  description: string | null;
  unitPriceCents: number;
};

const emptyLine = (): DocLine => ({
  description: "",
  quantity: "1",
  unitPriceEuros: "",
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
    validUntil: initial?.validUntil ?? "",
    lines: initial?.lines?.length ? initial.lines : [emptyLine()],
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
    updateLine(index, {
      description: s.description ? `${s.name} - ${s.description}` : s.name,
      unitPriceEuros: (s.unitPriceCents / 100).toFixed(2),
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

  const totalPreview = form.lines.reduce((sum, l) => {
    const q = Number(l.quantity) || 0;
    const p = Number(l.unitPriceEuros) || 0;
    return sum + q * p;
  }, 0);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        clientId: form.clientId,
        documentType,
        notes: form.notes || null,
        paymentTerms: form.paymentTerms || null,
        validUntil: form.validUntil || null,
        lines: form.lines.map((l) => ({
          description: l.description,
          quantity: Number(l.quantity),
          unitPriceEuros: Number(l.unitPriceEuros),
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
            {services.length > 0 ? (
              <Select
                value=""
                onChange={(e) => {
                  if (e.target.value) applyService(i, e.target.value);
                }}
              >
                <option value="">Prestation du catalogue…</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({(s.unitPriceCents / 100).toFixed(2)} €)
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
                value={line.quantity}
                onChange={(e) => updateLine(i, { quantity: e.target.value })}
              />
              <Input
                required
                type="number"
                step="0.01"
                placeholder="Prix HT €"
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
        <p className="text-right text-sm text-[var(--muted)]">
          Total HT estimé :{" "}
          <span className="font-semibold text-[var(--text)]">
            {totalPreview.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}
          </span>
        </p>
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
          <div />
        )}
      </div>

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
