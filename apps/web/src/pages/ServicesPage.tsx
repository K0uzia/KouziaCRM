import { useEffect, useState, type FormEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPen, faPlus, faTrash, faArrowUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { useFeatures } from "@/lib/features";
import { Button } from "@/components/ui/Button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FilterChips } from "@/components/ui/FilterChips";
import { Segmented } from "@/components/ui/Segmented";
import { INTERVAL_OPTIONS, type BillingInterval } from "@/lib/billing-interval";

type Service = {
  id: string;
  name: string;
  description: string | null;
  unitPriceCents: number;
  unit: "HEURE" | "JOUR" | "FORFAIT";
  active: boolean;
  isSubscription: boolean;
  defaultBillingDay: number;
  stripeProductId?: string | null;
  stripePriceId?: string | null;
  billingInterval?: string | null;
  isPack?: boolean;
  packItems?: Array<{
    serviceId: string;
    quantity: number;
    service: { id: string; name: string; unitPriceCents: number; isSubscription: boolean; billingInterval?: string | null; active: boolean };
  }>;
};

type PackRow = { serviceId: string; quantity: string };

const emptyForm = {
  name: "",
  description: "",
  priceEuros: "",
  active: true,
  kind: "ONE_OFF" as "ONE_OFF" | "SUBSCRIPTION" | "PACK",
  /** Pack : prestations du catalogue et quantités. */
  items: [] as PackRow[],
  // Annuel par défaut : Stripe prélève des frais à chaque transaction (une par an plutôt que douze).
  billingInterval: "YEAR" as BillingInterval,
  billingDay: "1",
};

const KIND_OPTIONS = [
  { id: "ONE_OFF", label: "Ponctuelle" },
  { id: "SUBSCRIPTION", label: "Abonnement" },
  { id: "PACK", label: "Pack" },
] as const;

/** Équivalent hors taxe si l'entreprise devient assujettie (TVA 20 % prise sur le prix affiché). */
export function htEquivalent(cents: number): string {
  return formatEUR(Math.round(cents / 1.2));
}

function stripeProductUrl(productId: string): string {
  return `https://dashboard.stripe.com/products/${productId}`;
}

export function ServicesPage() {
  const { moduleStripeEnabled } = useFeatures();
  const [rows, setRows] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [catalog, setCatalog] = useState<Service[]>([]);
  const [view, setView] = useState<"active" | "archived">("active");
  // Clé d'idempotence Stripe : une par ouverture du formulaire (un double envoi ne crée rien de plus).
  const [requestId, setRequestId] = useState("");

  async function load() {
    // Écran des prestations ponctuelles et packs ; le catalogue entier (abonnements compris) sert à composer un pack.
    const all = await api<Service[]>("/api/services");
    setCatalog(all);
    setRows(all.filter((s) => !s.isSubscription));
  }

  useEffect(() => {
    load()
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setRequestId(crypto.randomUUID());
    setOpen(true);
  }

  function openEdit(s: Service) {
    setEditing(s);
    setForm({
      name: s.name,
      description: s.description ?? "",
      priceEuros: (s.unitPriceCents / 100).toFixed(2),
      active: s.active,
      kind: s.isPack ? "PACK" : s.isSubscription ? "SUBSCRIPTION" : "ONE_OFF",
      billingInterval: s.billingInterval === "YEAR" ? "YEAR" : "MONTH",
      billingDay: String(s.defaultBillingDay ?? 1),
      items: (s.packItems ?? []).map((i) => ({ serviceId: i.serviceId, quantity: String(i.quantity) })),
    });
    setRequestId(crypto.randomUUID());
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
        isSubscription: form.kind === "SUBSCRIPTION",
        billingInterval: form.kind === "SUBSCRIPTION" ? form.billingInterval : null,
        defaultBillingDay: Number(form.billingDay) || 1,
        requestId,
        isPack: form.kind === "PACK",
        ...(form.kind === "PACK"
          ? { packItems: form.items.filter((i) => i.serviceId).map((i) => ({ serviceId: i.serviceId, quantity: Number(i.quantity) || 1 })) }
          : {}),
      };
      if (editing) {
        await api(`/api/services/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
        toast.success(
          linkedPriceChange ? "Prestation mise à jour : nouveau prix créé dans Stripe" : "Prestation mise à jour",
        );
      } else {
        await api("/api/services", { method: "POST", body: JSON.stringify(body) });
        const where = form.kind === "SUBSCRIPTION" ? " (dans Abonnements > Offres)" : "";
        toast.success(
          form.kind === "PACK"
            ? "Pack créé : sur un devis, il ajoute ses prestations et sa remise"
            : moduleStripeEnabled
              ? `Prestation créée dans l'ERP et dans Stripe${where}`
              : `Prestation créée${where}`,
        );
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
          isSubscription: s.isSubscription,
          billingInterval: s.isSubscription ? s.billingInterval ?? "MONTH" : null,
          defaultBillingDay: s.defaultBillingDay,
          isPack: Boolean(s.isPack),
          ...(s.isPack ? { packItems: (s.packItems ?? []).map((i) => ({ serviceId: i.serviceId, quantity: i.quantity })) } : {}),
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
  // Prestation liée : un nouveau montant crée un nouveau prix Stripe.
  const linkedPriceChange = Boolean(editing?.stripePriceId) && priceCents !== editing?.unitPriceCents;
  // Pack : prestations proposables (actives, hors packs) et détail de la partie ponctuelle.
  const components = catalog.filter((r) => r.active && !r.isPack && r.id !== editing?.id);
  const detailCents = form.items.reduce((sum, i) => {
    const svc = catalog.find((r) => r.id === i.serviceId);
    return svc && !svc.isSubscription ? sum + svc.unitPriceCents * (Number(i.quantity) || 1) : sum;
  }, 0);
  const setItem = (index: number, patch: Partial<PackRow>) =>
    setForm((f) => ({ ...f, items: f.items.map((it, k) => (k === index ? { ...it, ...patch } : it)) }));

  return (
    <div>
      <PageHeader
        title="Prestations"
        subtitle={
          moduleStripeEnabled
            ? "Catalogue synchronisé avec Stripe : ce que vous créez, modifiez ou archivez ici l'est aussi dans Stripe."
            : "Catalogue à prix fixe, repris dans les devis et factures. Prix : montant final payé par le client (TVA non applicable)."
        }
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
                    {s.isPack ? <Badge tone="blue">Pack</Badge> : null}
                    {!s.active ? <Badge tone="neutral">Archivée</Badge> : null}
                    {s.unit !== "FORFAIT" ? <Badge tone="amber">Ancien tarif au {s.unit === "JOUR" ? "jour" : "heure"}</Badge> : null}
                  </div>
                  {s.description ? <p className="mt-1 text-sm text-[var(--muted)]">{s.description}</p> : null}
                  {s.isPack && s.packItems?.length ? (
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {s.packItems.map((i) => `${i.service.name}${i.quantity > 1 ? ` × ${i.quantity}` : ""}`).join(" + ")}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:justify-end">
                  <div className="text-left sm:text-right">
                    <p className="font-display text-lg font-semibold tabular-nums">{formatEUR(s.unitPriceCents)}</p>
                    <p className="text-xs text-[var(--muted)]">Prix fixe</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    {moduleStripeEnabled && s.stripeProductId ? (
                      <a
                        href={stripeProductUrl(s.stripeProductId)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-11 items-center gap-1.5 px-2 text-sm text-[var(--primary)] hover:underline"
                      >
                        Modifier dans Stripe
                        <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3" aria-hidden />
                      </a>
                    ) : null}
                    {s.active ? (
                      <Button
                        variant="ghost"
                        className="px-0"
                        aria-label={`Modifier ${s.name}`}
                        title="Modifier"
                        onClick={() => openEdit(s)}
                      >
                        <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    ) : null}
                    {s.active ? (
                      <>
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
                    ) : null}
                    {!s.active && !s.stripeProductId ? (
                      <Button variant="secondary" className="px-3 text-sm" onClick={() => void restore(s)}>
                        Réactiver
                      </Button>
                    ) : null}
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
        description={
          moduleStripeEnabled
            ? "Créée ou modifiée aussi dans Stripe. Prix fixe repris tel quel dans les devis."
            : "Prix fixe repris tel quel dans les devis. Vous pourrez l'ajuster ligne par ligne."
        }
      >
        <form onSubmit={onSubmit} className="space-y-4">
          {/* Groupes de boutons hors d'un <label> (il nommerait le premier bouton). */}
          {editing ? null : (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-[var(--text)]">Type</p>
              <Segmented
                label="Type de prestation"
                options={KIND_OPTIONS}
                value={form.kind}
                onChange={(kind) => setForm({ ...form, kind })}
                className="w-full"
              />
            </div>
          )}
          {!editing && form.kind === "SUBSCRIPTION" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-[var(--text)]">Facturation</p>
                <Segmented
                  label="Périodicité de l'abonnement"
                  options={INTERVAL_OPTIONS}
                  value={form.billingInterval}
                  onChange={(billingInterval) => setForm({ ...form, billingInterval })}
                  className="w-full"
                />
              </div>
              <Field label="Jour de facturation">
                <Select value={form.billingDay} onChange={(e) => setForm({ ...form, billingDay: e.target.value })}>
                  {Array.from({ length: 28 }, (_, d) => d + 1).map((d) => (
                    <option key={d} value={String(d)}>
                      Le {d}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : null}
          <Field label="Nom">
            <Input required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Description" hint="Reprise sur le devis : ce qui est compris dans le prix.">
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
          </Field>
          {form.kind === "PACK" ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-[var(--text)]">Contenu du pack</legend>
              <p className="text-xs text-[var(--muted)]">
                Sur le devis, chaque prestation apparaît avec son prix, puis la remise du pack. Un abonnement inclus reste au prix
                plein, celui qui sera prélevé.
              </p>
              {form.items.map((item, i) => (
                <div key={i} className="flex min-w-0 items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field label={`Prestation ${i + 1}`}>
                      <Select value={item.serviceId} onChange={(e) => setItem(i, { serviceId: e.target.value })}>
                        <option value="">Choisir…</option>
                        {components.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} : {formatEUR(c.unitPriceCents)}
                            {c.isSubscription ? (c.billingInterval === "YEAR" ? " par an" : " par mois") : ""}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <div className="w-20 shrink-0">
                    <Field label="Qté">
                      <Input type="number" inputMode="numeric" min="1" max="999" value={item.quantity} onChange={(e) => setItem(i, { quantity: e.target.value })} />
                    </Field>
                  </div>
                  <Button
                    variant="danger-ghost"
                    aria-label={`Retirer la prestation ${i + 1} du pack`}
                    onClick={() => setForm((f) => ({ ...f, items: f.items.filter((_, k) => k !== i) }))}
                  >
                    <FontAwesomeIcon icon={faTrash} className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              ))}
              <Button variant="secondary" onClick={() => setForm((f) => ({ ...f, items: [...f.items, { serviceId: "", quantity: "1" }] }))}>
                <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
                Ajouter une prestation
              </Button>
            </fieldset>
          ) : null}
          <Field
            label={
              form.kind === "PACK"
                ? "Prix du pack, partie ponctuelle (€)"
                : form.kind === "SUBSCRIPTION"
                ? form.billingInterval === "YEAR"
                  ? "Prix par an (€)"
                  : "Prix par mois (€)"
                : "Prix (€)"
            }
            hint={
              form.kind === "PACK"
                ? `Détail : ${formatEUR(detailCents)}${priceCents > 0 && priceCents <= detailCents ? `, remise du pack : ${formatEUR(detailCents - priceCents)}` : ""}. Le prix du pack ne dépasse jamais le détail. Un pack n'est pas envoyé à Stripe.`
                : linkedPriceChange
                ? `Un nouveau prix est créé dans Stripe et l'ancien (${formatEUR(editing?.unitPriceCents ?? 0)}) est archivé. Les abonnements en cours ne changent pas : ils gardent l'ancien prix.`
                : priceCents > 0
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
        message={`« ${deleting?.name ?? ""} » sera supprimée. Si elle figure déjà sur un devis, une facture ou un abonnement, elle sera archivée à la place pour garder l'historique intact.${deleting?.stripeProductId ? " Elle est aussi archivée dans Stripe : les abonnements Stripe en cours continuent." : ""}`}
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
