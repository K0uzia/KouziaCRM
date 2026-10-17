import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowUpRightFromSquare,
  faRotateLeft,
  faTrash,
  faTriangleExclamation,
  faUpload,
} from "@fortawesome/free-solid-svg-icons";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/network";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { contrastRatio, DOCUMENT_PAPER, formatRatio, isHexColor, readableOn } from "@/lib/contrast";
import type { PublicSettings } from "@/pages/settings/types";

/** Charte Kouzia (repli si l'API ne la renvoie pas) : ambre et nuit, comme apps/api/src/lib/brand.ts. */
const KOUZIA = { primary: "#fe9a00", secondary: "#0b1020" };
const DEBOUNCE_MS = 500;
const MIN_CONTRAST = 4.5;

type DocKind = "QUOTE" | "INVOICE" | "CREDIT_NOTE" | "RECEIPT";
type View = "pdf" | "email";

const KINDS: ReadonlyArray<{ id: DocKind; label: string }> = [
  { id: "QUOTE", label: "Devis" },
  { id: "INVOICE", label: "Facture" },
  { id: "CREDIT_NOTE", label: "Avoir" },
  { id: "RECEIPT", label: "Reçu" },
];
const VIEWS: ReadonlyArray<{ id: View; label: string }> = [
  { id: "pdf", label: "PDF" },
  { id: "email", label: "E-mail" },
];

function kouziaOf(form: PublicSettings) {
  return {
    primary: form.brand?.kouziaPrimary ?? KOUZIA.primary,
    secondary: form.brand?.kouziaSecondary ?? KOUZIA.secondary,
  };
}

/**
 * Formulaire : une couleur enregistrée invalide est remplacée par celle que les documents impriment
 * réellement. Rien n'est enregistré tant que l'onglet n'est pas enregistré.
 */
export function withPrintedBrandColors(s: PublicSettings): PublicSettings {
  if (!s.brand) return s;
  const fix = (v: string, printed: string) => (isHexColor(v) ? v : printed);
  return {
    ...s,
    brandPrimaryColor: fix(s.brandPrimaryColor, s.brand.primary),
    brandSecondaryColor: fix(s.brandSecondaryColor, s.brand.secondary),
  };
}

function ContrastNote({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p
      className={`flex items-start gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-xs ${
        ok ? "bg-[var(--success-soft)] text-[var(--success)]" : "bg-[var(--warning-soft)] text-[var(--warning)]"
      }`}
    >
      {ok ? null : <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

function ColorField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const valid = isHexColor(value);
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-[var(--text)]">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          type="color"
          aria-label={`${label} : nuancier`}
          className="h-11 w-14 shrink-0 cursor-pointer rounded-[var(--radius-sm)] border border-[var(--border-input)] bg-transparent"
          value={valid ? value.toLowerCase() : "#000000"}
          onChange={(e) => onChange(e.target.value)}
        />
        <Input
          id={id}
          value={value}
          spellCheck={false}
          autoComplete="off"
          inputMode="text"
          maxLength={7}
          className="font-mono"
          aria-invalid={valid ? undefined : true}
          aria-describedby={`${id}-note`}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      </div>
      <p id={`${id}-note`} className={`text-xs ${valid ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}>
        {valid ? hint : "Couleur attendue au format #rrggbb, par exemple #fe9a00."}
      </p>
    </div>
  );
}

type PreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; at: Date };

/** Miniature fidèle : première page du PDF rendu par l'API, dessinée par pdf.js (aussi sur Android). */
function PdfThumbnail({
  pdf,
  onPages,
  onError,
}: {
  pdf: ArrayBuffer | null;
  onPages: (n: number) => void;
  onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false;
    const target = canvas.current;
    let destroy: (() => Promise<void>) | null = null;
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const task = pdfjs.getDocument({ data: pdf.slice(0) });
      destroy = () => task.destroy();
      const doc = await task.promise;
      if (cancelled) return;
      onPages(doc.numPages);
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const width = target.parentElement?.clientWidth || 600;
      const viewport = page.getViewport({ scale: (width * Math.min(window.devicePixelRatio || 1, 2)) / base.width });
      const off = document.createElement("canvas");
      off.width = Math.floor(viewport.width);
      off.height = Math.floor(viewport.height);
      await page.render({ canvas: off, viewport }).promise;
      if (cancelled) return;
      // Copie en une fois : pas de page blanche pendant le dessin du nouvel aperçu.
      target.width = off.width;
      target.height = off.height;
      target.getContext("2d")?.drawImage(off, 0, 0);
    })()
      .catch(() => {
        if (!cancelled) onError("La miniature n'a pas pu être dessinée : ouvrez le PDF d'exemple en grand.");
      })
      .finally(() => void destroy?.());
    return () => {
      cancelled = true;
    };
  }, [pdf, onPages, onError]);
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label="Première page du document d'exemple"
      className="block aspect-[210/297] h-auto w-full rounded-[var(--radius-sm)] bg-[var(--apercu-logo-fond)] shadow-[var(--shadow-sm)]"
    />
  );
}

export function CharteTab({
  form,
  setForm,
  saved,
  busy,
  saveBar,
  onSaved,
  onOpenLegal,
}: {
  form: PublicSettings;
  setForm: (next: PublicSettings) => void;
  /** Réglages enregistrés : comparés au formulaire pour signaler les changements en attente. */
  saved: PublicSettings;
  busy: boolean;
  saveBar: ReactNode;
  /** Logo envoyé ou supprimé : enregistré tout de suite, sans toucher au reste du formulaire. */
  onSaved: (updated: PublicSettings) => void;
  onOpenLegal: () => void;
}) {
  const kouzia = kouziaOf(form);
  const primary = form.brandPrimaryColor;
  const secondary = form.brandSecondaryColor;
  const footer = form.pdfFooterText ?? "";
  const colorsValid = isHexColor(primary) && isHexColor(secondary);

  const [kind, setKind] = useState<DocKind>("INVOICE");
  const [view, setView] = useState<View>("pdf");
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [pages, setPages] = useState(1);
  const [emailHtml, setEmailHtml] = useState("");
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const [logoVersion, setLogoVersion] = useState(0);
  const [logoBusy, setLogoBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmLogo, setConfirmLogo] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const onThumbnailError = useCallback((message: string) => setState({ status: "error", message }), []);

  const pending =
    primary.toLowerCase() !== withSavedColor(saved.brandPrimaryColor, saved.brand?.primary) ||
    secondary.toLowerCase() !== withSavedColor(saved.brandSecondaryColor, saved.brand?.secondary) ||
    (footer.trim() || null) !== (saved.pdfFooterText?.trim() || null);

  // Aperçu : rendu réel par l'API après une pause de frappe ; la requête précédente est annulée.
  useEffect(() => {
    if (!colorsValid) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      setState({ status: "loading" });
      const body = JSON.stringify({
        brandPrimaryColor: primary,
        brandSecondaryColor: secondary,
        pdfFooterText: footer,
        kind,
      });
      const pdfRequest =
        view === "pdf"
          ? fetch("/api/settings/identity/preview.pdf", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body,
              signal: ctrl.signal,
            }).then(async (res) => {
              if (!res.ok) throw new Error("Le PDF d'exemple n'a pas pu être rendu.");
              return res.arrayBuffer();
            })
          : Promise.resolve(null);
      Promise.all([
        pdfRequest,
        api<{ emailHtml: string; footerDuplicates: string[] }>("/api/settings/identity/preview", {
          method: "POST",
          body,
          signal: ctrl.signal,
        }),
      ])
        .then(([pdfBytes, json]) => {
          if (pdfBytes) setPdf(pdfBytes);
          setEmailHtml(json.emailHtml);
          setDuplicates(json.footerDuplicates);
          setState({ status: "ready", at: new Date() });
        })
        .catch((e: Error) => {
          if (ctrl.signal.aborted) return;
          setState({ status: "error", message: errorMessage(e, "Aperçu indisponible.") });
        });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [primary, secondary, footer, kind, view, colorsValid, retry, logoVersion]);

  async function uploadLogo(file: File) {
    setLogoBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const updated = await api<PublicSettings>("/api/settings/identity/logo", { method: "POST", body: fd });
      onSaved(updated);
      setLogoVersion((v) => v + 1);
      toast.success("Logo enregistré : il figurera sur les prochains documents.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Envoi du logo impossible");
    } finally {
      setLogoBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function removeLogo() {
    setLogoBusy(true);
    try {
      const updated = await api<PublicSettings>("/api/settings/identity/logo", { method: "DELETE" });
      onSaved(updated);
      setLogoVersion((v) => v + 1);
      setConfirmLogo(false);
      toast.success("Logo supprimé des prochains documents");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Suppression impossible");
    } finally {
      setLogoBusy(false);
    }
  }

  async function openPdf() {
    if (!pdf) return;
    const url = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
    window.open(url, "_blank", "noopener");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const primaryText = isHexColor(primary) ? contrastRatio(primary, readableOn(primary)) : null;
  const secondaryOnPaper = isHexColor(secondary) ? contrastRatio(secondary, DOCUMENT_PAPER) : null;
  const isKouzia = primary.toLowerCase() === kouzia.primary && secondary.toLowerCase() === kouzia.secondary;

  return (
    <div className="space-y-4">
      <p className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--muted)]">
        La charte s&apos;applique aux devis, factures, avoirs et reçus <strong className="text-[var(--text)]">émis après
        l&apos;enregistrement</strong>, ainsi qu&apos;aux e-mails. Un brouillon la prendra à son émission. Un document déjà
        émis garde la charte de son émission : son PDF est archivé et ne change plus.
      </p>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] items-start gap-4">
        <Card className="min-w-0 space-y-6 border border-[var(--border)] p-5">
          <section className="space-y-4" aria-labelledby="charte-couleurs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="charte-couleurs" className="text-base font-semibold">
                Couleurs
              </h2>
              <Button
                variant="ghost"
                disabled={isKouzia}
                aria-haspopup="dialog"
                onClick={() => setConfirmReset(true)}
              >
                <FontAwesomeIcon icon={faRotateLeft} className="h-3.5 w-3.5" aria-hidden />
                Revenir à la charte Kouzia
              </Button>
            </div>
            <ColorField
              label="Couleur principale"
              hint="Filet du haut, encadré du total, bouton de paiement des e-mails."
              value={primary}
              onChange={(v) => setForm({ ...form, brandPrimaryColor: v })}
            />
            {primaryText !== null ? (
              <ContrastNote ok={primaryText >= MIN_CONTRAST}>
                {primaryText >= MIN_CONTRAST
                  ? `Texte lisible sur cette couleur (contraste ${formatRatio(primaryText)}).`
                  : `Contraste de ${formatRatio(primaryText)} seulement pour le texte posé sur cette couleur (total, bouton) : 4,5:1 au moins recommandé. Choisissez une teinte plus claire ou plus foncée.`}
              </ContrastNote>
            ) : null}
            <ColorField
              label="Couleur secondaire"
              hint="Nom de l'entreprise, numéro du document, en-tête du tableau, bandeau des e-mails."
              value={secondary}
              onChange={(v) => setForm({ ...form, brandSecondaryColor: v })}
            />
            {secondaryOnPaper !== null ? (
              <ContrastNote ok={secondaryOnPaper >= MIN_CONTRAST}>
                {secondaryOnPaper >= MIN_CONTRAST
                  ? `Lisible en texte sur le papier blanc (contraste ${formatRatio(secondaryOnPaper)}).`
                  : `Contraste de ${formatRatio(secondaryOnPaper)} seulement sur le papier blanc, où le nom et le numéro sont écrits dans cette couleur : 4,5:1 au moins recommandé. Choisissez une teinte plus foncée.`}
              </ContrastNote>
            ) : null}
          </section>

          <section className="space-y-3" aria-labelledby="charte-logo">
            <h2 id="charte-logo" className="text-base font-semibold">
              Logo
            </h2>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex h-20 w-36 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--apercu-logo-fond)] p-2">
                {form.brandLogoPath ? (
                  <img
                    key={logoVersion}
                    src={`/api/settings/identity/logo?v=${logoVersion}`}
                    alt="Logo actuel des documents"
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <span className="text-center text-xs text-[var(--primary-fg)]">Aucun logo : le nom seul est imprimé</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" disabled={logoBusy} onClick={() => fileInput.current?.click()}>
                  <FontAwesomeIcon icon={faUpload} className="h-3.5 w-3.5" aria-hidden />
                  {logoBusy ? "Envoi…" : form.brandLogoPath ? "Remplacer le logo" : "Ajouter un logo"}
                </Button>
                {form.brandLogoPath ? (
                  <Button
                    variant="danger-ghost"
                    disabled={logoBusy}
                    aria-haspopup="dialog"
                    onClick={() => setConfirmLogo(true)}
                  >
                    <FontAwesomeIcon icon={faTrash} className="h-3.5 w-3.5" aria-hidden />
                    Supprimer le logo
                  </Button>
                ) : null}
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadLogo(f);
                }}
              />
            </div>
            <p className="text-xs text-[var(--muted)]">
              PNG ou JPEG (un WebP est converti), 2 Mo au plus, 128 px de côté au moins, fond transparent conseillé.
              Le logo est enregistré dès l&apos;envoi.
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="charte-pied">
            <h2 id="charte-pied" className="text-base font-semibold">
              Note en bas des documents
            </h2>
            <Field
              label="Texte libre (facultatif)"
              hint="Imprimé après les mentions légales, par exemple un remerciement. Le SIRET, la TVA, les pénalités et l'adresse figurent déjà sur chaque PDF : inutile de les répéter."
            >
              <Textarea
                rows={2}
                maxLength={2000}
                value={footer}
                onChange={(e) => setForm({ ...form, pdfFooterText: e.target.value || null })}
              />
            </Field>
            {duplicates.length ? (
              <div className="rounded-[var(--radius-sm)] bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--warning)]" role="status">
                <p className="flex items-start gap-2 font-medium">
                  <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  Déjà imprimé ailleurs sur le PDF, en double ici :
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-8">
                  {duplicates.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-xs text-[var(--muted)]">
              Mentions TVA, paiement et pénalités : onglet{" "}
              <button
                type="button"
                className="inline-flex min-h-11 items-center font-medium text-[var(--primary)] hover:underline"
                onClick={onOpenLegal}
              >
                Mentions légales
              </button>
              .
            </p>
          </section>
        </Card>

        <Card
          className="min-w-0 space-y-3 border border-[var(--border)] p-5 lg:sticky lg:top-4"
          aria-labelledby="charte-apercu"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="charte-apercu" className="text-base font-semibold">
              Aperçu
            </h2>
            <span className="text-xs text-[var(--muted)]">Données d&apos;exemple, rien n&apos;est enregistré</span>
          </div>
          <Segmented label="Support de l'aperçu" options={VIEWS} value={view} onChange={setView} className="w-full" />
          {view === "pdf" ? (
            <Segmented label="Document de l'aperçu" options={KINDS} value={kind} onChange={setKind} className="w-full" wrap />
          ) : null}

          <p className="min-h-5 text-xs text-[var(--muted)]" role="status" aria-live="polite">
            {!colorsValid
              ? "Aperçu en pause : corrigez la couleur au format #rrggbb."
              : state.status === "loading"
                ? "Mise à jour de l'aperçu…"
                : state.status === "ready"
                  ? `${pending ? "Aperçu des changements non enregistrés" : "Aperçu de la charte enregistrée"}${
                      view === "pdf" && pages > 1 ? ` · page 1 sur ${pages}` : ""
                    }.`
                  : null}
          </p>

          {state.status === "error" ? (
            <div className="space-y-2 rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-3 text-sm text-[var(--danger)]" role="alert">
              <p>{state.message}</p>
              <Button variant="secondary" onClick={() => setRetry((n) => n + 1)}>
                Réessayer
              </Button>
            </div>
          ) : null}

          <div className={`relative transition-opacity duration-150 ${state.status === "loading" ? "opacity-60" : ""}`}>
            {view === "pdf" ? (
              <PdfThumbnail pdf={pdf} onPages={setPages} onError={onThumbnailError} />
            ) : (
              <iframe
                title="Aperçu de l'e-mail d'exemple"
                sandbox=""
                srcDoc={emailHtml}
                className="block h-[32rem] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--apercu-logo-fond)]"
              />
            )}
          </div>
          {view === "pdf" ? (
            <Button variant="secondary" className="w-full" disabled={!pdf} onClick={() => void openPdf()}>
              <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3.5 w-3.5" aria-hidden />
              Ouvrir le PDF d&apos;exemple en grand
            </Button>
          ) : (
            <p className="text-xs text-[var(--muted)]">
              Le texte et la signature des vrais e-mails viennent de leurs modèles et de l&apos;onglet Emails.
            </p>
          )}
        </Card>
      </div>

      {pending ? (
        <p className="text-sm text-[var(--warning)]" role="status">
          Changements non enregistrés : les documents utilisent encore la charte enregistrée.
        </p>
      ) : null}
      {saveBar}

      <ConfirmDialog
        open={confirmReset}
        title="Revenir à la charte Kouzia ?"
        message={`Les couleurs reprennent l'ambre ${kouzia.primary} et la nuit ${kouzia.secondary}. Le logo et la note restent inchangés. Rien n'est enregistré avant « Enregistrer cet onglet ».`}
        confirmLabel="Revenir à la charte Kouzia"
        busy={busy}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => {
          setForm({ ...form, brandPrimaryColor: kouzia.primary, brandSecondaryColor: kouzia.secondary });
          setConfirmReset(false);
        }}
      />
      <ConfirmDialog
        open={confirmLogo}
        title="Supprimer le logo ?"
        message="Les prochains documents n'auront plus de logo, seulement le nom de l'entreprise. Les documents déjà émis gardent le leur."
        confirmLabel="Supprimer le logo"
        danger
        busy={logoBusy}
        onClose={() => setConfirmLogo(false)}
        onConfirm={() => void removeLogo()}
      />
    </div>
  );
}

function withSavedColor(value: string, printed: string | undefined): string {
  return (printed ?? value).toLowerCase();
}
