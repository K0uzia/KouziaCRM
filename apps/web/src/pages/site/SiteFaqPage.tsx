import { useState, type FormEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useCreateParam } from "@/lib/use-create-param";
import { Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { FilterChips } from "@/components/ui/FilterChips";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  FAQ_PAGE_LABEL,
  fieldErrorsOf,
  LoadState,
  OrderButtons,
  saveOrder,
  STATUS_OPTIONS,
  StatusBadge,
  useSiteCollection,
  type FieldErrors,
  type SiteFaq,
  type SiteFaqPage as FaqPage,
  type SiteItemStatus,
} from "./shared";

const BASE = "/api/site/faq";
const PAGES = Object.keys(FAQ_PAGE_LABEL) as FaqPage[];

export function SiteFaqPage() {
  const { rows, setRows, loading, error, reload } = useSiteCollection<SiteFaq>(BASE);
  const [page, setPage] = useState<FaqPage>("HOME");
  const [editing, setEditing] = useState<SiteFaq | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ page: "HOME" as FaqPage, question: "", answer: "", status: "DRAFT" as SiteItemStatus });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function openForm(q: SiteFaq | null) {
    setEditing(q);
    setErrors({});
    setForm(q ? { page: q.page, question: q.question, answer: q.answer, status: q.status } : { page, question: "", answer: "", status: "DRAFT" });
    setOpen(true);
  }
  useCreateParam(() => openForm(null));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await api(editing ? `${BASE}/${editing.id}` : BASE, { method: editing ? "PUT" : "POST", body: JSON.stringify(form) });
      toast.success(editing ? "Question enregistrée" : "Question ajoutée");
      setOpen(false);
      setPage(form.page);
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
      toast.success("Question supprimée");
      setDeleting(false);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  }

  const visible = rows.filter((q) => q.page === page);
  const move = (id: string, dir: -1 | 1) => void saveOrder(BASE, rows, visible, id, dir, setRows);

  const columns: DataColumn<SiteFaq>[] = [
    {
      name: "Question",
      grow: 4,
      cell: (q) => (
        <div className="min-w-0 py-2">
          <button type="button" onClick={() => openForm(q)} className="block max-w-full truncate text-left font-medium hover:text-[var(--primary)]">
            {q.question}
          </button>
          <p className="truncate text-xs text-[var(--muted)]">{q.answer}</p>
        </div>
      ),
    },
    { name: "Statut", width: "9rem", cell: (q) => <StatusBadge row={q} /> },
    {
      name: "Ordre",
      width: "7rem",
      cell: (q, i) => <OrderButtons name={q.question} first={i === 0} last={i === visible.length - 1} onMove={(d) => move(q.id, d)} />,
    },
  ];

  return (
    <div>
      <PageHeader
        title="FAQ"
        subtitle="Questions affichées sur l'accueil et les pages Sites web et Logiciels, dans l'ordre de cette liste."
        actions={
          <Button onClick={() => openForm(null)}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouvelle question
          </Button>
        }
      />
      <LoadState loading={loading} error={error} onRetry={() => void reload()}>
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={visible}
            onRowClick={(q) => openForm(q)}
            countLabel={visible.length > 1 ? "questions" : "question"}
            emptyTitle="Aucune question sur cette page"
            toolbar={
              <FilterChips
                label="Page du site"
                value={page}
                onChange={setPage}
                wrap
                options={PAGES.map((p) => ({ id: p, label: FAQ_PAGE_LABEL[p], count: rows.filter((q) => q.page === p).length }))}
              />
            }
            renderMobileCard={(q, i) => (
              <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5">
                <button type="button" onClick={() => openForm(q)} className="min-h-11 min-w-0 flex-1 text-left">
                  <span className="line-clamp-2 font-medium">{q.question}</span>
                  <span className="mt-1 block">
                    <StatusBadge row={q} />
                  </span>
                </button>
                <OrderButtons name={q.question} first={i === 0} last={i === visible.length - 1} onMove={(d) => move(q.id, d)} />
              </div>
            )}
          />
        </Card>
      </LoadState>

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? "Modifier la question" : "Nouvelle question"} fullScreenMobile>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <Field label="Page du site" error={errors.page}>
            <Select value={form.page} onChange={(e) => setForm((f) => ({ ...f, page: e.target.value as FaqPage }))}>
              {PAGES.map((p) => (
                <option key={p} value={p}>
                  {FAQ_PAGE_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Question" error={errors.question}>
            <Input required maxLength={300} value={form.question} onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))} />
          </Field>
          <Field label="Réponse" error={errors.answer}>
            <Textarea required rows={5} maxLength={2000} value={form.answer} onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))} />
          </Field>
          <Field label="Statut" error={errors.status}>
            <Select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as SiteItemStatus }))}>
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
        title="Supprimer cette question ?"
        message="Elle n'a jamais été publiée : elle disparaît de l'ERP."
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}
