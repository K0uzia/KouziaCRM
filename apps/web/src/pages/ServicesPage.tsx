import { useEffect, useState, type FormEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";

type Service = {
  id: string;
  name: string;
  description: string | null;
  unitPriceCents: number;
  unit: "HEURE" | "JOUR" | "FORFAIT";
  active: boolean;
  isSubscription: boolean;
  defaultBillingDay: number;
};

const unitLabel: Record<string, string> = {
  HEURE: "Heure",
  JOUR: "Jour",
  FORFAIT: "Forfait",
};

const emptyForm = {
  name: "",
  description: "",
  unitPriceEuros: "",
  unit: "FORFAIT" as Service["unit"],
  active: true,
  isSubscription: false,
  defaultBillingDay: "1",
};

export function ServicesPage() {
  const [rows, setRows] = useState<Service[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);

  async function load() {
    setRows(await api<Service[]>("/api/services"));
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, []);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function openEdit(s: Service) {
    setEditing(s);
    setForm({
      name: s.name,
      description: s.description ?? "",
      unitPriceEuros: (s.unitPriceCents / 100).toFixed(2),
      unit: s.unit,
      active: s.active,
      isSubscription: Boolean(s.isSubscription),
      defaultBillingDay: String(s.defaultBillingDay ?? 1),
    });
    setOpen(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        name: form.name,
        description: form.description || null,
        unitPriceEuros: Number(form.unitPriceEuros),
        unit: form.unit,
        active: form.active,
        isSubscription: form.isSubscription,
        defaultBillingDay: Number(form.defaultBillingDay) || 1,
      };
      if (editing) {
        await api(`/api/services/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        toast.success("Prestation mise à jour");
      } else {
        await api("/api/services", { method: "POST", body: JSON.stringify(body) });
        toast.success("Prestation créée");
      }
      setOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Prestations"
        subtitle="Catalogue pour devis et factures (ponctuel ou abonnement mensuel)"
        actions={
          <Button onClick={openCreate}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
            Nouvelle prestation
          </Button>
        }
      />

      <Card>
        {rows.length === 0 ? (
          <EmptyState title="Aucune prestation" hint="Ajoutez vos tarifs types." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--bg)]/80 text-[var(--muted)]">
              <tr>
                <th className="px-4 py-3 font-medium">Nom</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 text-right font-medium">Prix HT</th>
                <th className="px-4 py-3 font-medium">Statut</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-t border-[var(--border)]">
                  <td className="px-4 py-3">
                    <p className="font-medium">{s.name}</p>
                    {s.description ? (
                      <p className="text-xs text-[var(--muted)]">{s.description}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {s.isSubscription ? (
                      <span className="inline-flex flex-col gap-0.5">
                        <Badge tone="amber">Abonnement mensuel</Badge>
                        <span className="text-xs text-[var(--muted)]">
                          Facturation le {s.defaultBillingDay}
                        </span>
                      </span>
                    ) : (
                      unitLabel[s.unit] ?? s.unit
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatEUR(s.unitPriceCents)}
                    {s.isSubscription ? (
                      <span className="block text-xs text-[var(--muted)]">par mois</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">{s.active ? "Active" : "Inactive"}</td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      className="h-8 px-2 text-xs"
                      onClick={() => openEdit(s)}
                    >
                      Modifier
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Modifier la prestation" : "Nouvelle prestation"}
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Nom">
            <Input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Prix HT (€)">
              <Input
                required
                type="number"
                step="0.01"
                min="0"
                value={form.unitPriceEuros}
                onChange={(e) => setForm({ ...form, unitPriceEuros: e.target.value })}
              />
            </Field>
            {!form.isSubscription ? (
              <Field label="Unité">
                <Select
                  value={form.unit}
                  onChange={(e) =>
                    setForm({ ...form, unit: e.target.value as Service["unit"] })
                  }
                >
                  <option value="HEURE">Heure</option>
                  <option value="JOUR">Jour</option>
                  <option value="FORFAIT">Forfait</option>
                </Select>
              </Field>
            ) : (
              <Field label="Jour de facturation">
                <Select
                  value={form.defaultBillingDay}
                  onChange={(e) =>
                    setForm({ ...form, defaultBillingDay: e.target.value })
                  }
                >
                  {Array.from({ length: 28 }, (_, d) => d + 1).map((d) => (
                    <option key={d} value={String(d)}>
                      Le {d} de chaque mois
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isSubscription}
              onChange={(e) =>
                setForm({
                  ...form,
                  isSubscription: e.target.checked,
                  unit: e.target.checked ? "FORFAIT" : form.unit,
                })
              }
            />
            Abonnement mensuel (prestation récurrente)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />
            Active (visible dans les devis)
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "…" : "Enregistrer"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
