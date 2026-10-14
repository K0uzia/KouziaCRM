import { useState, type FormEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatDate } from "@/lib/api";
import { useCreateParam } from "@/lib/use-create-param";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { StatStrip } from "@/components/ui/StatStrip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  dateToIso,
  fieldErrorsOf,
  isoToDate,
  LoadState,
  OrderButtons,
  saveOrder,
  STATUS_OPTIONS,
  StatusBadge,
  todayIso,
  useSiteCollection,
  type FieldErrors,
  type SiteItemStatus,
  type SiteReview,
} from "./shared";

const BASE = "/api/site/reviews";

const emptyForm = {
  author: "",
  reviewedOn: todayIso(),
  text: "",
  rating: "",
  googleUrl: "",
  consentAt: "",
  consentChannel: "",
  consentProof: "",
  withdrawalRequestedAt: "",
  status: "DRAFT" as SiteItemStatus,
};

/** Retrait demandé par l'auteur et pas encore appliqué : à traiter sous 7 jours. */
export const withdrawalPending = (r: SiteReview) => Boolean(r.withdrawalRequestedAt) && r.status !== "WITHDRAWN";

export function SiteReviewsPage() {
  const { rows, setRows, loading, error, reload } = useSiteCollection<SiteReview>(BASE);
  const [editing, setEditing] = useState<SiteReview | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function openForm(r: SiteReview | null) {
    setEditing(r);
    setErrors({});
    setForm(
      r
        ? {
            author: r.author,
            reviewedOn: r.reviewedOn,
            text: r.text,
            rating: r.rating ? String(r.rating) : "",
            googleUrl: r.googleUrl ?? "",
            consentAt: isoToDate(r.consentAt),
            consentChannel: r.consentChannel ?? "",
            consentProof: r.consentProof ?? "",
            withdrawalRequestedAt: isoToDate(r.withdrawalRequestedAt),
            status: r.status,
          }
        : { ...emptyForm, reviewedOn: todayIso() },
    );
    setOpen(true);
  }
  useCreateParam(() => openForm(null));

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const locked = Boolean(editing?.publishedAt);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (form.status === "PUBLISHED" && !form.consentAt) {
      setErrors({ consentAt: "Accord de l'auteur requis avant de mettre l'avis sur le site." });
      return;
    }
    setBusy(true);
    setErrors({});
    const body = {
      author: form.author,
      reviewedOn: form.reviewedOn,
      text: form.text,
      rating: form.rating ? Number(form.rating) : null,
      googleUrl: form.googleUrl.trim() || null,
      consentAt: dateToIso(form.consentAt),
      consentChannel: form.consentChannel.trim() || null,
      consentProof: form.consentProof.trim() || null,
      withdrawalRequestedAt: dateToIso(form.withdrawalRequestedAt),
      status: form.status,
    };
    try {
      await api(editing ? `${BASE}/${editing.id}` : BASE, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      toast.success(editing ? "Avis enregistré" : "Avis ajouté");
      setOpen(false);
      await reload();
    } catch (err) {
      setErrors(fieldErrorsOf(err));
      toast.error(err instanceof Error ? err.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    setBusy(true);
    try {
      await api(`${BASE}/${editing.id}`, { method: "DELETE" });
      toast.success("Avis supprimé");
      setDeleting(false);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  }

  const move = (id: string, dir: -1 | 1) => void saveOrder(BASE, rows, rows, id, dir, setRows);

  const consentBadge = (r: SiteReview) =>
    r.consentAt ? (
      <span className="text-sm">Le {formatDate(r.consentAt)}</span>
    ) : (
      <Badge tone="red">Accord manquant</Badge>
    );

  const columns: DataColumn<SiteReview>[] = [
    {
      name: "Auteur",
      grow: 2,
      cell: (r) => (
        <div className="min-w-0 py-2">
          <button type="button" onClick={() => openForm(r)} className="block max-w-full truncate text-left font-medium hover:text-[var(--primary)]">
            {r.author}
          </button>
          <p className="truncate text-xs text-[var(--muted)]">{r.text}</p>
        </div>
      ),
    },
    { name: "Date de l'avis", width: "9rem", showFrom: 1280, cell: (r) => formatDate(r.reviewedOn) },
    { name: "Accord", width: "10rem", cell: consentBadge },
    {
      name: "Statut",
      width: "11rem",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <StatusBadge row={r} />
          {withdrawalPending(r) ? <Badge tone="red">Retrait demandé</Badge> : null}
        </div>
      ),
    },
    {
      name: "Ordre",
      width: "7rem",
      cell: (r, i) => <OrderButtons name={r.author} first={i === 0} last={i === rows.length - 1} onMove={(d) => move(r.id, d)} />,
    },
  ];

  const missingConsent = rows.filter((r) => r.status === "PUBLISHED" && !r.consentAt).length;
  const withdrawals = rows.filter(withdrawalPending).length;

  return (
    <div>
      <PageHeader
        title="Avis"
        subtitle="Avis Google repris sur kouzia.com avec l'accord écrit de leur auteur. Texte exact, jamais réécrit : une fois publié, il ne se modifie plus."
        actions={
          <Button onClick={() => openForm(null)}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouvel avis
          </Button>
        }
      />
      <LoadState loading={loading} error={error} onRetry={() => void reload()}>
        <StatStrip
          className="mb-4"
          items={[
            { label: "Sur le site", value: rows.filter((r) => r.status === "PUBLISHED").length, tone: "success" },
            { label: "Accords manquants", shortLabel: "Sans accord", value: missingConsent, tone: missingConsent ? "danger" : "default" },
            { label: "Retraits à faire", shortLabel: "Retraits", value: withdrawals, tone: withdrawals ? "warning" : "default" },
          ]}
        />
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={rows}
            onRowClick={(r) => openForm(r)}
            countLabel="avis"
            emptyTitle="Aucun avis"
            emptyHint="Ajoutez un avis Google dont l'auteur a donné son accord écrit."
            renderMobileCard={(r, i) => (
              <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5">
                <button type="button" onClick={() => openForm(r)} className="min-h-11 min-w-0 flex-1 text-left">
                  <span className="line-clamp-2 break-words font-medium">{r.author}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <StatusBadge row={r} />
                    {r.consentAt ? null : <Badge tone="red">Accord manquant</Badge>}
                    {withdrawalPending(r) ? <Badge tone="red">Retrait demandé</Badge> : null}
                  </span>
                </button>
                <OrderButtons name={r.author} first={i === 0} last={i === rows.length - 1} onMove={(d) => move(r.id, d)} />
              </div>
            )}
          />
        </Card>
      </LoadState>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Avis de ${editing.author}` : "Nouvel avis"}
        description={locked ? "Avis publié : auteur, date et texte sont figés. Pour corriger, le retirer puis le recréer." : undefined}
        fullScreenMobile
        wide
      >
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <Field label="Auteur" hint="Tel qu'affiché sur Google." error={errors.author}>
            <Input required disabled={locked} value={form.author} onChange={(e) => set("author", e.target.value)} />
          </Field>
          <Field label="Date de l'avis" error={errors.reviewedOn}>
            <Input required type="date" disabled={locked} value={form.reviewedOn} onChange={(e) => set("reviewedOn", e.target.value)} />
          </Field>
          <Field label="Texte exact de l'avis" error={errors.text}>
            <Textarea required rows={5} disabled={locked} value={form.text} onChange={(e) => set("text", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Note (facultatif)" hint="Gardée dans l'ERP, jamais publiée." error={errors.rating}>
              <Select value={form.rating} onChange={(e) => set("rating", e.target.value)}>
                <option value="">Non renseignée</option>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {n} sur 5
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Lien de l'avis Google (facultatif)" error={errors.googleUrl}>
              <Input type="url" inputMode="url" value={form.googleUrl} onChange={(e) => set("googleUrl", e.target.value)} />
            </Field>
          </div>

          <fieldset className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-4">
            <legend className="px-1 text-sm font-medium">Accord de l'auteur (jamais publié)</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date de l'accord" error={errors.consentAt}>
                <Input type="date" value={form.consentAt} onChange={(e) => set("consentAt", e.target.value)} />
              </Field>
              <Field label="Canal" hint="E-mail, SMS, courrier…" error={errors.consentChannel}>
                <Input value={form.consentChannel} onChange={(e) => set("consentChannel", e.target.value)} />
              </Field>
            </div>
            <Field label="Preuve" hint="Copie du message d'accord. Chiffrée dans l'ERP." error={errors.consentProof}>
              <Textarea rows={3} value={form.consentProof} onChange={(e) => set("consentProof", e.target.value)} />
            </Field>
            <Field
              label="Retrait demandé le (facultatif)"
              hint="Si l'auteur retire son accord : passer l'avis en « Retiré du site » et publier sous 7 jours."
              error={errors.withdrawalRequestedAt}
            >
              <Input type="date" value={form.withdrawalRequestedAt} onChange={(e) => set("withdrawalRequestedAt", e.target.value)} />
            </Field>
          </fieldset>

          <Field label="Statut" hint="« Sur le site » exige l'accord de l'auteur." error={errors.status}>
            <Select value={form.status} onChange={(e) => set("status", e.target.value as SiteItemStatus)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          <ModalActions>
            {editing && !editing.publishedAt ? (
              <Button
                variant="danger-ghost"
                disabled={busy}
                className="sm:mr-auto"
                onClick={() => {
                  setOpen(false);
                  setDeleting(true);
                }}
              >
                Supprimer
              </Button>
            ) : null}
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </ModalActions>
        </form>
      </Modal>
      <ConfirmDialog
        open={deleting}
        title="Supprimer cet avis ?"
        message="Il n'a jamais été publié : il disparaît de l'ERP, preuve d'accord comprise."
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}
