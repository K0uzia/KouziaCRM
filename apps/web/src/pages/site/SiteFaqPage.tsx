import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowsUpDown, faCheck, faPlus } from "@fortawesome/free-solid-svg-icons";
import { useCreateParam } from "@/lib/use-create-param";
import { Card, PageHeader } from "@/components/ui/Card";
import { Button, ButtonLink } from "@/components/ui/Button";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { FilterSegment } from "@/components/ui/ListFilters";
import { useUrlFilters } from "@/lib/use-url-filters";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EditorFooter, EditorLayout, useItemEditor } from "./editor";
import { QuestionPreview } from "./preview";
import { reorderVisible, saveIds, SortableList } from "./sortable";
import {
  FAQ_PAGE_LABEL,
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
const isPage = (p: string | null): p is FaqPage => (PAGES as string[]).includes(p ?? "");

export function SiteFaqPage() {
  const navigate = useNavigate();
  const { rows, setRows, loading, error, reload } = useSiteCollection<SiteFaq>(BASE);
  const filters = useUrlFilters();
  const page = filters.pick("page", PAGES, "HOME");
  const setPage = (p: FaqPage) => filters.set({ page: p === "HOME" ? null : p });
  const newPath = `/site/faq/nouvelle?page=${page}`;
  useCreateParam(() => navigate(newPath, { replace: true }));

  const visible = rows.filter((q) => q.page === page);
  const move = (id: string, dir: -1 | 1) => void saveOrder(BASE, rows, visible, id, dir, setRows, (q) => q.question);
  const [reordering, setReordering] = useState(false);
  const reorder = (ids: string[]) => void saveIds(BASE, rows, reorderVisible(rows, visible, ids), setRows);
  const pageChips = (
    <FilterSegment
      label="Page du site"
      value={page}
      onChange={setPage}
      options={PAGES.map((p) => ({ id: p, label: FAQ_PAGE_LABEL[p], count: rows.filter((q) => q.page === p).length }))}
    />
  );

  const columns: DataColumn<SiteFaq>[] = [
    {
      name: "Question",
      grow: 4,
      cell: (q) => (
        <div className="min-w-0 py-2">
          <Link to={`/site/faq/${q.id}`} className="block max-w-full truncate font-medium hover:text-[var(--primary)]">
            {q.question}
          </Link>
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
        subtitle="Chaque question est rattachée à une page (Accueil, Sites web ou Logiciels) et figure aussi sur la page FAQ du site, dans l'ordre de cette liste."
        actions={
          <>
          <Button variant="secondary" aria-pressed={reordering} onClick={() => setReordering((v) => !v)}>
            <FontAwesomeIcon icon={reordering ? faCheck : faArrowsUpDown} className="h-3.5 w-3.5" aria-hidden />
            {reordering ? "Terminer" : "Réorganiser"}
          </Button>
          <ButtonLink to={newPath}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouvelle question
          </ButtonLink>
          </>
        }
      />
      <LoadState loading={loading} error={error} onRetry={() => void reload()}>
        {reordering ? (
          <Card className="space-y-2 p-2 sm:p-3">
            <div className="px-2 pt-2">{pageChips}</div>
            <p className="px-2 pb-2 text-sm text-[var(--muted)]">
              Glisser une question par sa poignée, ou au clavier : Espace pour prendre, flèches pour déplacer, Espace pour poser. L'ordre est enregistré à chaque déplacement et suit au site à la prochaine publication.
            </p>
            {visible.length ? (
              <SortableList items={visible} name={(q) => q.question} onReorder={reorder} render={(q) => <span className="line-clamp-2 break-words font-medium">{q.question}</span>} />
            ) : (
              <p className="px-2 pb-2 text-sm text-[var(--muted)]">Aucune question sur cette page.</p>
            )}
          </Card>
        ) : (
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={visible}
            onRowClick={(q) => navigate(`/site/faq/${q.id}`)}
            countLabel={visible.length > 1 ? "questions" : "question"}
            emptyTitle="Aucune question sur cette page"
            toolbar={pageChips}
            renderMobileCard={(q, i) => (
              <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5">
                <Link to={`/site/faq/${q.id}`} className="block min-h-11 min-w-0 flex-1">
                  <span className="line-clamp-2 font-medium">{q.question}</span>
                  <span className="mt-1 block">
                    <StatusBadge row={q} />
                  </span>
                </Link>
                <OrderButtons name={q.question} first={i === 0} last={i === visible.length - 1} onMove={(d) => move(q.id, d)} />
              </div>
            )}
          />
        </Card>
        )}
      </LoadState>
    </div>
  );
}

type FaqForm = { page: FaqPage; question: string; answer: string; status: SiteItemStatus };

function faqErrors(f: FaqForm): FieldErrors {
  const e: FieldErrors = {};
  if (!f.question.trim()) e.question = "Question obligatoire.";
  if (!f.answer.trim()) e.answer = "Réponse obligatoire.";
  return e;
}

export function SiteFaqItemPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const creating = id === "nouvelle";
  const [deleting, setDeleting] = useState(false);
  const ed = useItemEditor<SiteFaq, FaqForm>({
    base: BASE,
    id,
    creating,
    empty: { page: isPage(params.get("page")) ? (params.get("page") as FaqPage) : "HOME", question: "", answer: "", status: "DRAFT" },
    toForm: (q) => ({ page: q.page, question: q.question, answer: q.answer, status: q.status }),
    toBody: (f) => f,
    validate: faqErrors,
    itemPath: (q) => `/site/faq/${q.id}`,
    listPath: "/site/faq",
    labels: { created: "Question créée : la suite s'enregistre toute seule", deleted: "Question supprimée", notFound: "Question introuvable" },
  });
  const { form, set, errors, item } = ed;

  const question = (
    <div className="space-y-4">
      <Field label="Page de rattachement" hint="Où la question s'affiche, en plus de la page FAQ du site." error={errors.page}>
        <Select value={form.page} onChange={(e) => set("page", e.target.value as FaqPage)}>
          {PAGES.map((p) => (
            <option key={p} value={p}>
              {FAQ_PAGE_LABEL[p]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Question" hint={`${form.question.length} / 300 caractères`} error={errors.question}>
        <Input required maxLength={300} autoComplete="off" value={form.question} onChange={(e) => set("question", e.target.value)} />
      </Field>
      <Field
        label="Réponse"
        hint={`Reprise telle quelle sur le site et dans les données lues par Google : écrire la réponse complète. ${form.answer.length} / 2000 caractères`}
        error={errors.answer}
      >
        <Textarea required rows={7} maxLength={2000} value={form.answer} onChange={(e) => set("answer", e.target.value)} />
      </Field>
    </div>
  );

  const publication = (
    <div className="space-y-4">
      <Field label="Statut" hint="« Sur le site » : incluse à la prochaine publication (bouton Publier en haut)." error={errors.status}>
        <Select value={form.status} onChange={(e) => set("status", e.target.value as SiteItemStatus)}>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      {item?.publishedAt ? (
        <p className="text-sm text-[var(--muted)]">Déjà publiée : pour l'enlever du site, choisir « Retiré du site » plutôt que la supprimer.</p>
      ) : item ? (
        <Button variant="danger-ghost" disabled={ed.busy} onClick={() => setDeleting(true)}>
          Supprimer la question
        </Button>
      ) : null}
    </div>
  );

  return (
    <div>
      <PageHeader
        back={{ to: `/site/faq?page=${form.page}`, label: "FAQ" }}
        title={creating ? "Nouvelle question" : item?.question ?? "Question"}
        subtitle={item ? <StatusBadge row={item} /> : undefined}
      />
      <LoadState loading={ed.loading} error={ed.loadError} onRetry={() => void ed.load()}>
        <form onSubmit={ed.onSubmit} noValidate>
          <EditorLayout
            label="Sections de la question"
            tabs={[
              { id: "question", label: "Question", content: question, errors: ed.countErrors(["page", "question", "answer"]) },
              { id: "publication", label: "Publication", content: publication, errors: ed.countErrors(["status"]) },
            ]}
            preview={() => (
              <div className="space-y-3">
                <QuestionPreview question={form.question} answer={form.answer} />
                <p className="text-xs text-[var(--muted)]">Page {FAQ_PAGE_LABEL[form.page]} et page FAQ du site.</p>
              </div>
            )}
            footer={<EditorFooter auto={ed.auto} creating={creating} busy={ed.busy} createLabel="Créer la question" />}
          />
        </form>
      </LoadState>
      <ConfirmDialog
        open={deleting}
        title="Supprimer cette question ?"
        message="Elle n'a jamais été publiée : elle disparaît de l'ERP."
        confirmLabel="Supprimer"
        danger
        busy={ed.busy}
        onConfirm={() => void ed.remove().catch(() => setDeleting(false))}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}
