import { useEffect, useState, type FormEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPen, faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FilterChips } from "@/components/ui/FilterChips";

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

const emptyForm = { name: "", description: "", priceEuros: "", active: true };

/** Équivalent hors taxe si l'entreprise devient assujettie (TVA 20 % prise sur le prix affiché). */
export function htEquivalent(cents: number): string {
  return formatEUR(Math.round(cents / 1.2));
}

export function ServicesPage() {
  const [rows, setRows] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [view, setView] = useState<"active" | "archived">("active");

  async function load() {
    setRows(await api<Service[]>("/api/services?subscription=0"));
  }

  useEffect(() => {
    load()
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setLoading(false));
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
      priceEuros: (s.unitPriceCents / 100).toFixed(2),
      active: s.active,
    });
    setOpen(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        unitPriceEuros: Number(form.priceEuros),
        unit: "FORFAIT",
        active: form.active,
        isSubscription: false,
      };
      if (editing) {
        await api(`/api/services/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
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

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      const res = await api<{ archived: boolean }>(`/api/services/${deleting.id}`, { method: "DELETE" });
      toast.success(
        res.archived
          ? "Prestation archivée : elle figure sur des documents, elle reste visible dans les archives."
          : "Prestation supprimée",
      );
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  }

  async function restore(s: Service) {
    try {
      await api(`/api/services/${s.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: s.name,
          description: s.description,
          unitPriceEuros: s.unitPriceCents / 100,
          unit: "FORFAIT",
          active: true,
          isSubscription: false,
        }),
      });
      toast.success("Prestation réactivée");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    }
  }

  const active = rows.filter((r) => r.active);
  const archived = rows.filter((r) => !r.active);
  const visible = view === "active" ? active : archived;
  const priceCents = Math.round(Number(form.priceEuros || 0) * 100);

  return (
    <div>
      <PageHeader
        title="Prestations"
        subtitle="Catalogue à prix fixe, repris dans les devis et factures. Prix TTC : montant final payé par le client."
        actions={
          <Button onClick={openCreate}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouvelle prestation
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[var(--border)] p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <FilterChips
            label="Afficher"
            value={view}
            onChange={setView}
            options={[
              { id: "active", label: "Actives", count: active.length },
              { id: "archived", label: "Archivées", count: archived.length },
            ]}
          />
          <p className="text-xs text-[var(--muted)]">Franchise de TVA : aucun montant de TVA n&apos;est facturé.</p>
        </div>

        {loading ? (
          <div className="h-40 animate-pulse" aria-busy="true" />
        ) : visible.length === 0 ? (
          <EmptyState
            title={view === "active" ? "Aucune prestation" : "Aucune prestation archivée"}
            hint={view === "active" ? "Ajoutez vos tarifs avec le bouton Nouvelle prestation." : undefined}
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {visible.map((s) => (
              <li
                key={s.id}
                className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-[var(--surface-raised)] sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{s.name}</p>
                    {!s.active ? <Badge tone="neutral">Archivée</Badge> : null}
                    {s.unit !== "FORFAIT" ? <Badge tone="amber">Ancien tarif au {s.unit === "JOUR" ? "jour" : "heure"}</Badge> : null}
                  </div>
                  {s.description ? <p className="mt-1 text-sm text-[var(--muted)]">{s.description}</p> : null}
                </div>
                <div className="flex shrink-0 items-center justify-between gap-4 sm:justify-end">
                  <div className="text-left sm:text-right">
                    <p className="font-display text-lg font-semibold tabular-nums">{formatEUR(s.unitPriceCents)}</p>
                    <p className="text-xs text-[var(--muted)]">TTC, prix fixe</p>
                  </div>
                  <div className="flex gap-1">
                    {s.active ? (
                      <>
                        <Button
                          variant="ghost"
                          className="px-0"
                          aria-label={`Modifier ${s.name}`}
                          title="Modifier"
                          onClick={() => openEdit(s)}
                        >
                          <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button
                          variant="danger-ghost"
                          className="px-0"
                          aria-label={`Supprimer ${s.name}`}
                          title="Supprimer"
                          onClick={() => setDeleting(s)}
                        >
                          <FontAwesomeIcon icon={faTrash} className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </>
                    ) : (
                      <Button variant="secondary" className="px-3 text-sm" onClick={() => void restore(s)}>
                        Réactiver
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Modifier la prestation" : "Nouvelle prestation"}
        description="Prix fixe repris tel quel dans les devis. Vous pourrez l'ajuster ligne par ligne."
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Nom">
            <Input required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Description" hint="Reprise sur le devis : ce qui est compris dans le prix.">
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
          </Field>
          <Field
            label="Prix TTC (€)"
            hint={
              priceCents > 0
                ? `Montant payé par le client. Si vous devenez assujetti à la TVA, ce prix reste le même : ${htEquivalent(priceCents)} HT + TVA 20 %.`
                : "Montant payé par le client (franchise de TVA : rien n'est ajouté)."
            }
          >
            <Input
              required
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={form.priceEuros}
              onChange={(e) => setForm({ ...form, priceEuros: e.target.value })}
            />
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--primary)]"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />
            Proposée dans les devis
          </label>
          <ModalActions>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Supprimer la prestation"
        message={`« ${deleting?.name ?? ""} » sera supprimée. Si elle figure déjà sur un devis, une facture ou un abonnement, elle sera archivée à la place pour garder l'historique intact.`}
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
