import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { fetchSettings } from "@/lib/settings-request";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Textarea } from "@/components/ui/Field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { PublicSettings } from "./types";

/** Même plafond que l'API (SIGNATURE_HTML_MAX), appliqué au HTML produit. */
const SIGNATURE_HTML_MAX = 4000;
const HELP = "Les mentions légales (SIRET, adresse) sont ajoutées automatiquement en pied de mail : ne les répétez pas ici.";

/*
 * Éditeur de signature : champ texte multiligne converti en HTML simple (p, br, strong, em, a), sans
 * dépendance. L'ERP n'a pas d'éditeur riche (l'espace Site n'édite que du texte) et la liste blanche de
 * l'API ne garde que ces balises : un éditeur WYSIWYG offrirait des mises en forme aussitôt retirées.
 * Syntaxe : **gras**, *italique* ; les adresses web et e-mail deviennent des liens.
 */

type Inline =
  | { kind: "text"; value: string }
  | { kind: "strong" | "em"; value: string }
  | { kind: "link"; href: string; label: string };
type Paragraph = Inline[][];

const INLINE =
  /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|(https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]])|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function parseLine(line: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", value: line.slice(last, at) });
    if (m[1]) out.push({ kind: "strong", value: m[1] });
    else if (m[2]) out.push({ kind: "em", value: m[2] });
    else if (m[3]) out.push({ kind: "link", href: m[3], label: m[3] });
    else if (m[4]) out.push({ kind: "link", href: `mailto:${m[4]}`, label: m[4] });
    last = at + m[0].length;
  }
  if (last < line.length) out.push({ kind: "text", value: line.slice(last) });
  return out;
}

function parseSignature(text: string): Paragraph[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[\u2013\u2014]/g, "-")
    .trim()
    .split(/\n{2,}/)
    .filter((block) => block.trim())
    .map((block) => block.split("\n").map((line) => parseLine(line.trimEnd())));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toHtml(paragraphs: Paragraph[]): string {
  const inline = (i: Inline) =>
    i.kind === "text"
      ? escapeHtml(i.value)
      : i.kind === "link"
        ? `<a href="${escapeHtml(i.href)}">${escapeHtml(i.label)}</a>`
        : `<${i.kind}>${escapeHtml(i.value)}</${i.kind}>`;
  return paragraphs.map((p) => `<p>${p.map((line) => line.map(inline).join("")).join("<br>")}</p>`).join("");
}

/** HTML enregistré (déjà assaini par l'API) vers le texte du champ : inverse de toHtml. */
function htmlToText(html: string | null): string {
  if (!html?.trim()) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof Element)) return "";
    const inner = Array.from(node.childNodes).map(walk).join("");
    switch (node.tagName) {
      case "BR":
        return "\n";
      case "P":
        return `${inner.trim()}\n\n`;
      case "STRONG":
      case "B":
        return `**${inner}**`;
      case "EM":
      case "I":
        return `*${inner}*`;
      case "A": {
        const href = (node.getAttribute("href") ?? "").replace(/^mailto:/i, "");
        return !href || inner === href ? inner : `${inner} (${href})`;
      }
      default:
        return inner;
    }
  };
  return walk(doc.body).replace(/\n{3,}/g, "\n\n").trim();
}

function renderInline(i: Inline, key: number): ReactNode {
  if (i.kind === "text") return i.value;
  if (i.kind === "link") {
    return (
      <a key={key} href={i.href} target="_blank" rel="noopener noreferrer" className="break-all text-[var(--primary)] underline">
        {i.label}
      </a>
    );
  }
  return i.kind === "strong" ? <strong key={key}>{i.value}</strong> : <em key={key}>{i.value}</em>;
}

/** Signature par défaut de l'API (signature.ts, defaultBrandSignature) : reprise pour l'aperçu. */
function defaultSignature(s: PublicSettings): string {
  return ["Cordialement,", s.tradeName || s.legalName, s.email ?? "", s.website ?? ""].filter(Boolean).join("\n");
}

/** Pied de mail de l'API (layout.ts, emailLegalFooter) : affiché sous l'aperçu, pour situer les mentions. */
function legalFooter(s: PublicSettings): string {
  return [s.legalName, `SIRET ${s.siret}`, [s.addressLine1, `${s.postalCode} ${s.city}`].filter((x) => x.trim()).join(", ")]
    .filter((x) => x.trim())
    .join(" · ");
}

/** Réglages > E-mails : signature des e-mails envoyés par l'ERP. */
export function EmailSignatureCard() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const s = await fetchSettings<PublicSettings>();
      const initial = htmlToText(s.emailSignatureHtml);
      setSettings(s);
      setText(initial);
      setSaved(initial);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Chargement impossible");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const paragraphs = useMemo(() => parseSignature(text), [text]);
  const html = useMemo(() => toHtml(paragraphs), [paragraphs]);
  const tooLong = html.length > SIGNATURE_HTML_MAX;
  const dirty = text.trim() !== saved.trim();

  async function persist(value: string, success: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api<PublicSettings>("/api/settings/email", {
        method: "PATCH",
        body: JSON.stringify({ emailSignatureHtml: value }),
      });
      const next = htmlToText(updated.emailSignatureHtml);
      setSettings(updated);
      setText(next);
      setSaved(next);
      toast.success(success);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Enregistrement impossible";
      setError(message);
      toast.error(message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (tooLong) return;
    await persist(paragraphs.length ? html : "", paragraphs.length ? "Signature enregistrée" : "Signature par défaut rétablie");
  }

  async function reset() {
    if (await persist("", "Signature par défaut rétablie")) setConfirmReset(false);
  }

  const previewDefault = !paragraphs.length && settings ? parseSignature(defaultSignature(settings)) : null;
  const shown = previewDefault ?? paragraphs;

  return (
    <Card className="space-y-4 border border-[var(--border)] p-5" aria-labelledby="email-signature-title">
      <div>
        <h2 id="email-signature-title" className="text-base font-semibold">
          Signature des e-mails
        </h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Ajoutée aux e-mails envoyés par l&apos;ERP (documents, relances, rappels) et aux nouveaux messages de la messagerie.
          Champ vide : signature par défaut.
        </p>
      </div>

      {loadError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-[var(--danger)]">
          {loadError}
          <Button variant="secondary" onClick={() => void load()}>
            Réessayer
          </Button>
        </div>
      ) : !settings ? (
        <div role="status" aria-busy="true" className="h-24 animate-pulse rounded-[var(--radius)] bg-[var(--surface-raised)]">
          <span className="sr-only">Chargement de la signature…</span>
        </div>
      ) : (
        <>
          <Field
            label="Signature"
            hint={`${HELP} Mise en forme : **gras**, *italique* ; les adresses web et e-mail deviennent des liens.`}
            error={tooLong ? `Signature trop longue (${SIGNATURE_HTML_MAX} caractères de HTML au plus)` : (error ?? undefined)}
          >
            <Textarea
              rows={5}
              value={text}
              placeholder={defaultSignature(settings)}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
            />
          </Field>

          <section aria-labelledby="email-signature-preview" className="space-y-2">
            <h3 id="email-signature-preview" className="text-sm font-medium">
              Aperçu{previewDefault ? " (signature par défaut)" : ""}
            </h3>
            <div className="min-w-0 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-4 text-sm leading-relaxed [overflow-wrap:anywhere]">
              {shown.map((p, pi) => (
                <p key={pi} className="mb-3 last:mb-0">
                  {p.map((line, li) => (
                    <span key={li}>
                      {li > 0 ? <br /> : null}
                      {line.map(renderInline)}
                    </span>
                  ))}
                </p>
              ))}
              <p className="mt-4 border-t border-[var(--border)] pt-3 text-xs text-[var(--muted)]">
                {legalFooter(settings)}
                {settings.website ? (
                  <>
                    <br />
                    {settings.website.replace(/^https?:\/\//i, "")}
                  </>
                ) : null}
              </p>
            </div>
          </section>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="secondary"
              disabled={busy || (!saved && !text.trim())}
              onClick={() => setConfirmReset(true)}
            >
              Revenir à la signature par défaut
            </Button>
            <Button type="button" disabled={busy || !dirty || tooLong} onClick={() => void save()}>
              {busy ? "Enregistrement…" : "Enregistrer la signature"}
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmReset}
        title="Revenir à la signature par défaut ?"
        message="La signature personnalisée est effacée. Les e-mails reprendront la signature par défaut : formule de politesse, nom commercial, e-mail et site."
        confirmLabel="Revenir à la signature par défaut"
        busy={busy}
        onConfirm={() => void reset()}
        onClose={() => setConfirmReset(false)}
      />
    </Card>
  );
}
