import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faLock } from "@fortawesome/free-solid-svg-icons";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useUnsavedGuard } from "@/lib/unsaved";
import { useUrlFilters } from "@/lib/use-url-filters";
import { templatePath } from "@/lib/email-review";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { FilterBar, FilterSegment, FilterSelect } from "@/components/ui/ListFilters";
import { StatStrip } from "@/components/ui/StatStrip";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";

type TemplateSummary = {
  key: string;
  label: string;
  familyLabel: string | null;
  locked: string | null;
  subject: string;
  modified: boolean;
  updatedAt: string | null;
};
type TemplateVariable = { name: string; label: string; example: string };
type TemplateIssue = { field: "subject" | "body"; code: string; variable?: string; message: string };
type TemplateView = Omit<TemplateSummary, "subject"> & {
  variables: TemplateVariable[];
  required: string[];
  original: { subject: string; body: string };
  current: { subject: string; body: string };
};
type Preview = { subject: string; text: string; html: string; templateIssues: TemplateIssue[] };
type PreviewSource = { id: string; label: string };

const LIST_PATH = "/settings/modeles-emails";
const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Banner level="error" role="alert" action={<Button variant="secondary" onClick={onRetry}>Réessayer</Button>}>
      {message}
    </Banner>
  );
}

/** Famille d'un modèle, identifiant lisible dans l'URL (« relance », « acces-et-securite »). */
const familyId = (label: string | null) =>
  (label ?? "Autres")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

type StateFilter = "tous" | "modifies" | "verrouilles";
type Row = TemplateSummary & { familyName: string; family: string };

function StateText({ row }: { row: TemplateSummary }) {
  if (row.locked)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
        <FontAwesomeIcon icon={faLock} className="h-3 w-3" aria-hidden />
        Verrouillé
      </span>
    );
  if (row.modified) return <span className="text-xs text-[var(--primary)]">Modifié le {formatDate(row.updatedAt)}</span>;
  return <span className="text-xs text-[var(--muted)]">Texte d&apos;origine</span>;
}

/** Réglages, Modèles d'e-mails : une seule liste (gabarit des listes), recherche, filtres par famille et par état. */
export function EmailTemplatesPage() {
  const navigate = useNavigate();
  const filters = useUrlFilters();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<{ templates: TemplateSummary[] }>("/api/email-templates")
      .then((r) => !cancelled && setTemplates(r.templates))
      .catch((e: unknown) => !cancelled && setError(errorText(e, "Modèles indisponibles")));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const all: Row[] = (templates ?? []).map((t) => ({ ...t, familyName: t.familyLabel ?? "Autres", family: familyId(t.familyLabel) }));
  // Familles dans l'ordre du registre, avec le nombre de modèles de chacune.
  const families = [...new Map(all.map((t) => [t.family, t.familyName])).entries()];
  const familyFilter = filters.pick("famille", ["toutes", ...families.map(([id]) => id)], "toutes");
  const stateFilter = filters.pick<StateFilter>("etat", ["tous", "modifies", "verrouilles"], "tous");
  const byFamily = all.filter((t) => familyFilter === "toutes" || t.family === familyFilter);
  const rows = byFamily.filter((t) => (stateFilter === "modifies" ? t.modified : stateFilter === "verrouilles" ? Boolean(t.locked) : true));
  const modified = all.filter((t) => t.modified).length;
  const locked = all.filter((t) => t.locked).length;
  const pathOf = (t: TemplateSummary) => templatePath(t.key);

  const columns: DataColumn<Row>[] = [
    {
      name: "Modèle",
      grow: 3,
      cell: (t) => (
        <div className="min-w-0 py-2">
          <Link to={pathOf(t)} className="block max-w-full font-medium hover:text-[var(--primary)]">
            {t.label}
          </Link>
          <p className="truncate text-xs text-[var(--muted)]">{t.familyName}</p>
        </div>
      ),
    },
    { name: "Objet", grow: 3, showFrom: 1024, cell: (t) => <span className="line-clamp-2 break-words text-sm text-[var(--muted)]">{t.subject}</span> },
    { name: "État", width: "11rem", cell: (t) => <StateText row={t} /> },
  ];

  return (
    <div>
      <PageHeader
        title="Modèles d'e-mails"
        subtitle="Texte des e-mails envoyés aux clients. Une modification s'applique aux e-mails préparés ensuite ; la signature, le bouton de paiement et le pied légal restent gérés par l'ERP."
        back={{ to: "/settings?tab=email", label: "Réglages" }}
      />
      {error ? (
        <LoadError message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : (
        <>
          <StatStrip
            className="mb-4"
            items={[
              { label: "Modèles", value: templates ? all.length : "…" },
              { label: "Modifiés", value: templates ? modified : "…" },
              { label: "Verrouillés", value: templates ? locked : "…" },
            ]}
          />
          <Card className="overflow-hidden">
            <DataTable
              columns={columns}
              data={rows}
              loading={!templates}
              onRowClick={(t) => navigate(pathOf(t))}
              countLabel={rows.length > 1 ? "modèles" : "modèle"}
              searchable={["label", "subject", "familyName"]}
              searchLabel="Rechercher"
              searchPlaceholder="Libellé, objet ou famille"
              search={filters.text("q")}
              onSearchChange={(q) => filters.set({ q })}
              emptyTitle="Aucun modèle ne correspond"
              emptyHint="Changez la recherche ou les filtres."
              toolbar={
                <FilterBar>
                  <FilterSelect
                    label="Famille"
                    value={familyFilter}
                    onChange={(v) => filters.set({ famille: v === "toutes" ? null : v })}
                    options={[
                      { id: "toutes", label: "Toutes les familles", count: all.length },
                      ...families.map(([id, name]) => ({ id, label: name, count: all.filter((t) => t.family === id).length })),
                    ]}
                  />
                  <FilterSegment<StateFilter>
                    label="État"
                    value={stateFilter}
                    onChange={(v) => filters.set({ etat: v === "tous" ? null : v })}
                    options={[
                      { id: "tous", label: "Tous", count: byFamily.length },
                      { id: "modifies", label: "Modifiés", count: byFamily.filter((t) => t.modified).length },
                      { id: "verrouilles", label: "Verrouillés", count: byFamily.filter((t) => t.locked).length },
                    ]}
                  />
                </FilterBar>
              }
              renderMobileCard={(t) => (
                <Link to={pathOf(t)} className="block min-h-11 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5">
                  <span className="block break-words font-medium">{t.label}</span>
                  <span className="mt-0.5 block break-words text-xs text-[var(--muted)]">{t.subject}</span>
                  <span className="mt-1 block">
                    <StateText row={t} />
                  </span>
                </Link>
              )}
            />
          </Card>
        </>
      )}
    </div>
  );
}

/** Fiche d'un modèle : objet et texte, variables, contrôle et aperçu à la saisie, retour au texte d'origine. */
export function EmailTemplatePage() {
  // Clé « document.invoice » en deux segments d'URL : un point ferait prendre l'adresse pour un fichier au rechargement.
  const { group = "", name = "" } = useParams();
  const key = `${group}.${name}`;
  const [view, setView] = useState<TemplateView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [issues, setIssues] = useState<TemplateIssue[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // « Aperçu pour » : données d'exemple ("") ou une des 10 dernières données réelles du type du modèle.
  const [sources, setSources] = useState<PreviewSource[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<"subject" | "body">("body");
  const variablesId = useId();

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api<TemplateView>(`/api/email-templates/${encodeURIComponent(key)}`)
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setSubject(v.current.subject);
        setBody(v.current.body);
      })
      .catch((e: unknown) => !cancelled && setLoadError(errorText(e, "Modèle indisponible")));
    return () => {
      cancelled = true;
    };
  }, [key, attempt]);

  // Sans donnée réelle (modèle verrouillé, aucune donnée) ou en erreur : le choix reste aux données d'exemple.
  useEffect(() => {
    let cancelled = false;
    setSources([]);
    setSourceId("");
    api<{ sources: PreviewSource[] }>(`/api/email-templates/${encodeURIComponent(key)}/sources`)
      .then((r) => !cancelled && setSources(r.sources))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Aperçu et contrôle à la saisie, après une courte pause : rien n'est enregistré ni envoyé.
  useEffect(() => {
    if (!view) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<Preview>(`/api/email-templates/${encodeURIComponent(view.key)}/preview`, {
        method: "POST",
        body: JSON.stringify({ subject, body, ...(sourceId ? { sourceId } : {}) }),
      })
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          setIssues(p.templateIssues);
          setPreviewError(null);
        })
        .catch((e: unknown) => !cancelled && setPreviewError(errorText(e, "Aperçu indisponible")));
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [view, subject, body, sourceId]);

  const dirty = Boolean(view) && !view!.locked && (subject !== view!.current.subject || body !== view!.current.body);
  useUnsavedGuard(dirty);

  const fieldError = (field: "subject" | "body") =>
    issues.filter((i) => i.field === field).map((i) => i.message).join(" ") || undefined;

  function insertVariable(name: string) {
    const token = `{{${name}}}`;
    const target = lastField.current === "subject" ? subjectRef.current : bodyRef.current;
    const value = lastField.current === "subject" ? subject : body;
    const start = target?.selectionStart ?? value.length;
    const end = target?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    if (lastField.current === "subject") setSubject(next);
    else setBody(next);
    requestAnimationFrame(() => {
      target?.focus();
      target?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function save() {
    if (!view) return;
    setBusy(true);
    try {
      const v = await api<TemplateView>(`/api/email-templates/${encodeURIComponent(view.key)}`, { method: "PUT", body: JSON.stringify({ subject, body }) });
      setView(v);
      setSubject(v.current.subject);
      setBody(v.current.body);
      toast.success(v.modified ? "Modèle enregistré" : "Texte d'origine conservé");
    } catch (e) {
      const sent = (e as { data?: { templateIssues?: TemplateIssue[] } } | null)?.data?.templateIssues;
      if (sent) setIssues(sent);
      toast.error(errorText(e, "Enregistrement impossible"));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!view) return;
    setBusy(true);
    try {
      const v = await api<TemplateView>(`/api/email-templates/${encodeURIComponent(view.key)}`, { method: "DELETE" });
      setView(v);
      setSubject(v.current.subject);
      setBody(v.current.body);
      setConfirmReset(false);
      toast.success("Texte d'origine rétabli");
    } catch (e) {
      toast.error(errorText(e, "Retour impossible"));
    } finally {
      setBusy(false);
    }
  }

  const back = { to: LIST_PATH, label: "Modèles d'e-mails" };
  if (loadError) {
    return (
      <div>
        <PageHeader title="Modèle d'e-mail" back={back} />
        <LoadError message={loadError} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    );
  }
  if (!view) {
    return (
      <div>
        <PageHeader title="Modèle d'e-mail" back={back} />
        <p className="text-sm text-[var(--muted)]" role="status">
          Chargement…
        </p>
      </div>
    );
  }

  const locked = Boolean(view.locked);
  const differsFromOriginal = subject !== view.original.subject || body !== view.original.body;
  return (
    <div>
      <PageHeader
        title={view.label}
        subtitle={view.familyLabel ?? undefined}
        back={back}
        actions={
          locked ? null : (
            <>
              <Button variant="secondary" disabled={busy || (!view.modified && !differsFromOriginal)} onClick={() => setConfirmReset(true)}>
                Revenir au texte d&apos;origine
              </Button>
              <Button disabled={busy || !dirty || issues.length > 0} onClick={() => void save()}>
                {busy ? "Enregistrement…" : "Enregistrer"}
              </Button>
            </>
          )
        }
      />
      {view.locked ? (
        <Banner className="mb-4">
          <span className="inline-flex items-center gap-2">
            <FontAwesomeIcon icon={faLock} className="h-3.5 w-3.5" aria-hidden />
            {view.locked}
          </span>
        </Banner>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,32rem)] lg:items-start">
        <Card className="space-y-4 border border-[var(--border)] p-5">
          <Field label="Objet" error={fieldError("subject")}>
            <Input
              ref={subjectRef}
              value={subject}
              readOnly={locked}
              maxLength={300}
              autoComplete="off"
              onFocus={() => (lastField.current = "subject")}
              onChange={(e) => setSubject(e.target.value)}
            />
          </Field>
          <Field label="Texte" hint="Une ligne dont toutes les variables sont vides n'est pas envoyée." error={fieldError("body")}>
            <Textarea
              ref={bodyRef}
              value={body}
              readOnly={locked}
              rows={12}
              maxLength={20000}
              className="font-mono"
              onFocus={() => (lastField.current = "body")}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <section aria-labelledby={variablesId} className="space-y-2">
            <h2 id={variablesId} className="text-sm font-semibold">
              Variables
            </h2>
            <p className="text-xs text-[var(--muted)]">
              {locked ? "Variables de ce modèle." : "Insère la variable à la position du curseur, dans l'objet ou le texte."}
            </p>
            <ul className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))]">
              {view.variables.map((v) => (
                <li key={v.name}>
                  <Button
                    variant="secondary"
                    className="w-full justify-start! text-left!"
                    disabled={locked}
                    aria-label={`Insérer {{${v.name}}} : ${v.label}`}
                    onClick={() => insertVariable(v.name)}
                  >
                    <span className="min-w-0">
                      <code className="block break-all text-[var(--primary)]">{`{{${v.name}}}`}</code>
                      <span className="block whitespace-normal text-xs font-normal text-[var(--muted)]">
                        {v.label}
                        {view.required.includes(v.name) ? " (obligatoire)" : ""}
                      </span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </Card>

        <Card className="space-y-3 border border-[var(--border)] p-5">
          <h2 className="text-base font-semibold">Aperçu</h2>
          {sources.length > 0 ? (
            <Field label="Aperçu pour" hint="Valeurs calculées comme à l'envoi. Rien n'est envoyé ni enregistré.">
              <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">Données d&apos;exemple</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <p className="text-xs text-[var(--muted)]">
            {sourceId ? "Donnée réelle choisie" : "Données d'exemple"}, signature réelle de l&apos;onglet E-mail.
          </p>
          {previewError ? (
            <Banner level="error" role="alert">
              {previewError}
            </Banner>
          ) : !preview ? (
            <p className="text-sm text-[var(--muted)]" role="status">
              Chargement de l&apos;aperçu…
            </p>
          ) : (
            <>
              <p className="break-words text-sm">
                <span className="text-[var(--muted)]">Objet : </span>
                {preview.subject}
              </p>
              <iframe
                title={sourceId ? "Aperçu de l'e-mail avec la donnée choisie" : "Aperçu de l'e-mail avec les données d'exemple"}
                sandbox=""
                srcDoc={preview.html}
                className="block h-[32rem] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--apercu-logo-fond)]"
              />
            </>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="Revenir au texte d'origine ?"
        message="Le texte modifié est supprimé. Les e-mails préparés ensuite reprennent le texte d'origine ; ceux déjà en file ne changent pas."
        confirmLabel="Revenir au texte d'origine"
        danger
        busy={busy}
        onConfirm={() => void reset()}
        onClose={() => setConfirmReset(false)}
      />
    </div>
  );
}
