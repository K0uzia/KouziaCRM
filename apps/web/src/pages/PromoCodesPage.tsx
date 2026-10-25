import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useUrlFilters } from "@/lib/use-url-filters";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Checkbox, DateInput, Field, Input, Select } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { StatStrip } from "@/components/ui/StatStrip";
import { Segmented } from "@/components/ui/Segmented";
import { LoadState } from "@/pages/site/shared";

type State = "ACTIVE" | "INACTIVE" | "EXPIRED" | "UPCOMING" | "EXHAUSTED";
type PromoCode = {
  id: string;
  code: string;
  kind: "PERCENT" | "FIXED";
  value: number;
  months: number | null;
  validFrom: string | null;
  validUntil: string | null;
  maxUses: number | null;
  serviceIds: string[] | null;
  conditionText: string | null;
  active: boolean;
  uses: number;
  state: State;
};
type Service = { id: string; name: string; isSubscription?: boolean; annualPriceCents?: number | null; active?: boolean };
type Form = {
  code: string;
  kind: "PERCENT" | "FIXED";
  amount: string;
  months: string;
  validFrom: string;
  validUntil: string;
  maxUses: string;
  serviceIds: string[];
  conditionText: string;
  active: boolean;
};

const STATE_LABEL: Record<State, { label: string; tone: "green" | "neutral" | "amber" | "blue" | "red" }> = {
  ACTIVE: { label: "Actif", tone: "green" },
  UPCOMING: { label: "À venir", tone: "blue" },
  EXHAUSTED: { label: "Épuisé", tone: "amber" },
  EXPIRED: { label: "Expiré", tone: "neutral" },
  INACTIVE: { label: "Désactivé", tone: "neutral" },
};
const EMPTY: Form = { code: "", kind: "PERCENT", amount: "", months: "", validFrom: "", validUntil: "", maxUses: "", serviceIds: [], conditionText: "", active: true };
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** Remise d'un code, en clair : « 30 % sur 12 mois », « 200,00 € par échéance, tout l'engagement ». */
export const promoDiscountText = (c: Pick<PromoCode, "kind" | "value" | "months">) =>
  `${c.kind === "PERCENT" ? `${String(c.value / 100).replace(".", ",")} %` : `${formatEUR(c.value)} par échéance`}${c.months ? ` sur ${c.months} mois` : ", tout l’engagement"}`;

/** Offre > Codes promo (R3) : codes saisis sur un devis récurrent avant émission ; usages calculés par l'API. */
export function PromoCodesPage() {
  const filters = useUrlFilters();
  const view = filters.pick<"tous" | "actifs" | "termines">("vue", ["tous", "actifs", "termines"], "tous");
  const [codes, setCodes] = useState<PromoCode[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PromoCode | "new" | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, svc] = await Promise.all([api<{ codes: PromoCode[] }>("/api/promo-codes"), api<Service[]>("/api/services")]);
      setCodes(list.codes);
      setServices(svc.filter((s) => s.active !== false && (s.isSubscription || s.annualPriceCents)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Codes indisponibles");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function open(code: PromoCode | "new") {
    setEditing(code);
    setForm(
      code === "new"
        ? EMPTY
        : {
            code: code.code,
            kind: code.kind,
            amount: code.kind === "PERCENT" ? String(code.value / 100) : (code.value / 100).toFixed(2),
            months: code.months ? String(code.months) : "",
            validFrom: day(code.validFrom),
            validUntil: day(code.validUntil),
            maxUses: code.maxUses ? String(code.maxUses) : "",
            serviceIds: code.serviceIds ?? [],
            conditionText: code.conditionText ?? "",
            active: code.active,
          },
    );
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    const amount = Number(form.amount.replace(",", "."));
    const body = {
      kind: form.kind,
      ...(form.kind === "PERCENT" ? { percent: amount } : { euros: amount }),
      months: form.months ? Number(form.months) : null,
      validFrom: form.validFrom || null,
      validUntil: form.validUntil || null,
      maxUses: form.maxUses ? Number(form.maxUses) : null,
      serviceIds: form.serviceIds.length ? form.serviceIds : null,
      conditionText: form.conditionText.trim() || null,
      active: form.active,
    };
    try {
      if (editing === "new") await api("/api/promo-codes", { method: "POST", body: JSON.stringify({ code: form.code, ...body }) });
      else await api(`/api/promo-codes/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      toast.success(editing === "new" ? "Code promo créé" : "Code promo enregistré");
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing || editing === "new") return;
    setBusy(true);
    try {
      await api(`/api/promo-codes/${editing.id}`, { method: "DELETE" });
      toast.success(`Code ${editing.code} supprimé`);
      setConfirmDelete(false);
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  }

  const live = (c: PromoCode) => c.state === "ACTIVE" || c.state === "UPCOMING";
  const rows = codes.filter((c) => (view === "actifs" ? live(c) : view === "termines" ? !live(c) : true));
  const columns: DataColumn<PromoCode>[] = [
    {
      name: "Code",
      grow: 2,
      cell: (c) => (
        <button type="button" className="min-h-11 py-2 text-left font-mono font-medium hover:text-[var(--primary)]" onClick={() => open(c)}>
          {c.code}
        </button>
      ),
    },
    { name: "Remise", grow: 3, cell: (c) => promoDiscountText(c) },
    {
      name: "Validité",
      grow: 2,
      showFrom: 1024,
      cell: (c) => (c.validFrom || c.validUntil ? `${c.validFrom ? `du ${formatDate(c.validFrom)} ` : ""}${c.validUntil ? `au ${formatDate(c.validUntil)}` : ""}`.trim() : "Sans limite"),
    },
    { name: "Usages", width: "7rem", cell: (c) => (c.maxUses ? `${c.uses} / ${c.maxUses}` : String(c.uses)) },
    { name: "État", width: "8rem", cell: (c) => <Badge tone={STATE_LABEL[c.state].tone}>{STATE_LABEL[c.state].label}</Badge> },
  ];
  const editingCode = editing && editing !== "new" ? editing : null;

  return (
    <div>
      <PageHeader
        title="Codes promo"
        subtitle="Remises à appliquer sur un devis d’abonnement, avant son émission. Un code par devis, un usage par client, sans cumul avec une autre remise."
        actions={
          <Button onClick={() => open("new")}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouveau code
          </Button>
        }
      />
      <LoadState loading={loading} error={error} onRetry={() => void load()}>
        <StatStrip
          className="mb-4"
          items={[
            { label: "Actifs", value: codes.filter((c) => c.state === "ACTIVE").length },
            { label: "Devis avec un code", shortLabel: "Utilisés", value: codes.reduce((n, c) => n + c.uses, 0) },
            { label: "Terminés", value: codes.filter((c) => !live(c)).length },
          ]}
        />
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={rows}
            onRowClick={(c) => open(c)}
            countLabel={rows.length > 1 ? "codes" : "code"}
            searchable={["code", "conditionText"]}
            searchLabel="Rechercher"
            searchPlaceholder="Code ou condition"
            search={filters.text("q")}
            onSearchChange={(q) => filters.set({ q })}
            emptyTitle={codes.length ? "Aucun code ne correspond" : "Aucun code promo"}
            emptyHint={codes.length ? "Changez la recherche ou le filtre." : "Créez un code, puis choisissez-le dans le bloc Remise d’un devis d’abonnement."}
            toolbar={
              <Segmented
                label="Codes affichés"
                value={view}
                onChange={(v) => filters.set({ vue: v === "tous" ? null : v })}
                options={[
                  { id: "tous", label: "Tous", count: codes.length },
                  { id: "actifs", label: "Actifs", count: codes.filter(live).length },
                  { id: "termines", label: "Terminés", count: codes.filter((c) => !live(c)).length },
                ]}
              />
            }
            renderMobileCard={(c) => (
              <button type="button" onClick={() => open(c)} className="block min-h-11 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5 text-left">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono font-medium">{c.code}</span>
                  <Badge tone={STATE_LABEL[c.state].tone}>{STATE_LABEL[c.state].label}</Badge>
                </span>
                <span className="mt-0.5 block text-xs text-[var(--muted)]">
                  {promoDiscountText(c)}, {c.maxUses ? `${c.uses} / ${c.maxUses} usages` : `${c.uses} usage${c.uses > 1 ? "s" : ""}`}
                </span>
              </button>
            )}
          />
        </Card>
      </LoadState>

      <Modal open={editing !== null} onClose={() => !busy && setEditing(null)} title={editingCode ? `Code ${editingCode.code}` : "Nouveau code promo"} wide fullScreenMobile>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
            <Field label="Code" hint={editingCode ? "Le code ne change plus : il figure sur les devis émis." : "Lettres, chiffres et tiret, 3 à 32 caractères."}>
              <Input
                value={form.code}
                readOnly={Boolean(editingCode)}
                required
                minLength={3}
                maxLength={32}
                autoComplete="off"
                className="font-mono uppercase"
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field label="Remise">
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Form["kind"] })}>
                <option value="PERCENT">Pourcentage</option>
                <option value="FIXED">Montant par échéance</option>
              </Select>
            </Field>
            <Field label={form.kind === "PERCENT" ? "Pourcentage" : "Montant par échéance (€)"}>
              <Input type="number" inputMode="decimal" min={0} step={0.01} max={form.kind === "PERCENT" ? 99.99 : undefined} required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </Field>
            <Field label="Durée (mois)" hint="Vide : toute la durée de l’engagement.">
              <Input type="number" inputMode="numeric" min={1} max={36} value={form.months} onChange={(e) => setForm({ ...form, months: e.target.value })} />
            </Field>
            <Field label="Valable à partir du">
              <DateInput value={form.validFrom} onChange={(v) => setForm({ ...form, validFrom: v })} />
            </Field>
            <Field label="Valable jusqu’au">
              <DateInput value={form.validUntil} onChange={(v) => setForm({ ...form, validUntil: v })} />
            </Field>
            <Field label="Nombre d’usages maximum" hint="Vide : illimité. Un usage = un devis émis avec ce code.">
              <Input type="number" inputMode="numeric" min={1} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
            </Field>
          </div>
          <Field label="Condition imprimée sur le devis" hint="Facultatif. Ex. : structure créée il y a moins de 12 mois.">
            <Input value={form.conditionText} maxLength={200} onChange={(e) => setForm({ ...form, conditionText: e.target.value })} />
          </Field>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Offres concernées</legend>
            <p className="text-xs text-[var(--muted)]">Aucune cochée : toutes les offres.</p>
            {services.map((s) => (
              <Checkbox
                key={s.id}
                label={s.name}
                checked={form.serviceIds.includes(s.id)}
                onChange={(e) => setForm({ ...form, serviceIds: e.target.checked ? [...form.serviceIds, s.id] : form.serviceIds.filter((x) => x !== s.id) })}
              />
            ))}
          </fieldset>
          <Checkbox label="Actif" hint="Désactivé : plus proposé sur les devis ; les devis émis gardent leur remise." checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          <ModalActions>
            {editingCode && editingCode.uses === 0 ? (
              <Button type="button" variant="danger-ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
                Supprimer
              </Button>
            ) : null}
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setEditing(null)}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </ModalActions>
        </form>
      </Modal>
      <ConfirmDialog
        open={confirmDelete}
        title={`Supprimer le code ${editingCode?.code ?? ""} ?`}
        message="Il n’a jamais servi : il disparaît de la liste. Un code déjà utilisé se désactive à la place."
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
