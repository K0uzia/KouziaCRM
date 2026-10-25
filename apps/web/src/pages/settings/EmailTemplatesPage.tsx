import { useEffect, useId, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronRight, faLock } from "@fortawesome/free-solid-svg-icons";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useUnsavedGuard } from "@/lib/unsaved";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Input, Textarea } from "@/components/ui/Field";

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

const LIST_PATH = "/settings/modeles-emails";
const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Banner level="error" role="alert" action={<Button variant="secondary" onClick={onRetry}>Réessayer</Button>}>
      {message}
    </Banner>
  );
}

/** Réglages, Modèles d'e-mails : modèles par famille, état (texte d'origine, modifié, verrouillé). */
export function EmailTemplatesPage() {
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

  const groups = new Map<string, TemplateSummary[]>();
  for (const t of templates ?? []) {
    const name = t.familyLabel ?? "Autres";
    groups.set(name, [...(groups.get(name) ?? []), t]);
  }

  return (
    <div>
      <PageHeader
        title="Modèles d'e-mails"
        subtitle="Texte des e-mails envoyés aux clients. Une modification s'applique aux e-mails préparés ensuite ; la signature, le bouton de paiement et le pied légal restent gérés par l'ERP."
        back={{ to: "/settings?tab=email", label: "Réglages" }}
      />
      {error ? (
        <LoadError message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : !templates ? (
        <p className="text-sm text-[var(--muted)]" role="status">
          Chargement…
        </p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">Aucun modèle.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[repeat(auto-fit,minmax(min(100%,28rem),1fr))] lg:items-start">
          {[...groups].map(([name, list]) => (
            <Card key={name} className="border border-[var(--border)] p-2 sm:p-3">
              <h2 className="px-3 pb-1 pt-2 text-base font-semibold">{name}</h2>
              <ul>
                {list.map((t) => (
                  <li key={t.key}>
                    <Link
                      to={`${LIST_PATH}/${t.key.split(".").map(encodeURIComponent).join("/")}`}
                      className="flex min-h-11 items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 hover:bg-[var(--surface-hover)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-[var(--text)]">{t.label}</span>
                        <span className="block break-words text-sm text-[var(--muted)]">{t.subject}</span>
                      </span>
                      <span className="shrink-0 text-right text-xs text-[var(--muted)]">
                        {t.locked ? (
                          <span className="inline-flex items-center gap-1.5">
                            <FontAwesomeIcon icon={faLock} className="h-3 w-3" aria-hidden />
                            Verrouillé
                          </span>
                        ) : t.modified ? (
                          <span className="text-[var(--primary)]">Modifié le {formatDate(t.updatedAt)}</span>
                        ) : (
                          "Texte d'origine"
                        )}
                      </span>
                      <FontAwesomeIcon icon={faChevronRight} className="h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
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

  // Aperçu et contrôle à la saisie, après une courte pause : rien n'est enregistré.
  useEffect(() => {
    if (!view) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<Preview>(`/api/email-templates/${encodeURIComponent(view.key)}/preview`, { method: "POST", body: JSON.stringify({ subject, body }) })
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
  }, [view, subject, body]);

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
          <p className="text-xs text-[var(--muted)]">Données d&apos;exemple, signature réelle de l&apos;onglet E-mail.</p>
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
                title="Aperçu de l'e-mail avec les données d'exemple"
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
