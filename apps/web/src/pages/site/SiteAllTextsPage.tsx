import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowDown, faArrowUp, faArrowUpRightFromSquare, faPlus } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import {
  childFields,
  choices,
  collectFields,
  getAt,
  issueBelongsTo,
  pageLabel,
  setAt,
  skeleton,
  textConstraints,
  type Doc,
  type Editeur,
  type Field as SchemaField,
  type SchemaNode,
} from "@/lib/site-editor";
import { ImageField, LoadState } from "./shared";

/**
 * « Tous les textes » (lot générique) : chaque texte du site, généré depuis le contrat (clé « editeur »), rangé par
 * page puis par section, avec l'endroit où il paraît. Un champ vide garde le texte actuel du site.
 */

type Issue = { path: string; message: string };
type EditorDoc = { id: string; file: string; label: string; schema: SchemaNode; value: Doc | null; defaults: Doc | null };
type EditorResponse =
  | {
      available: true;
      siteUrls: { online: string; local: string | null };
      editeur: { pages: string[]; types: string[] } | null;
      cibles: Record<string, { libelle: string; chemin: string }>;
      docs: EditorDoc[];
    }
  | { available: false; error: string };

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Erreur inattendue.");

export function SiteAllTextsPage() {
  const [data, setData] = useState<Extract<EditorResponse, { available: true }> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, Doc | null>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [issues, setIssues] = useState<Record<string, Issue[]>>({});
  const [saving, setSaving] = useState(false);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api<EditorResponse>(`/api/site/editor${force ? "?force=1" : ""}`);
      if (!res.available) {
        setLoadError(`Contrat du site illisible : ${res.error}`);
        return;
      }
      setData(res);
      setDrafts(Object.fromEntries(res.docs.map((d) => [d.id, d.value])));
      setDirty(new Set());
      setIssues({});
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Modifications non enregistrées : avertir avant de quitter la page du navigateur.
  useEffect(() => {
    if (dirty.size === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const fields = useMemo(() => (data ? data.docs.flatMap((d) => collectFields(d.id, d.schema)) : []), [data]);
  const pages = useMemo(() => {
    const order = data?.editeur?.pages ?? [];
    const used = new Set(fields.map((f) => f.editeur.page));
    return [...order.filter((p) => used.has(p)), ...[...used].filter((p) => !order.includes(p))];
  }, [data, fields]);
  const page = pages.includes(params.get("page") ?? "") ? params.get("page")! : pages[0];

  const docOf = (id: string) => data!.docs.find((d) => d.id === id)!;
  const change = (f: SchemaField, v: unknown) => {
    setDrafts((all) => ({ ...all, [f.doc]: setAt(all[f.doc] ?? skeleton(docOf(f.doc).schema), f.path, v) }));
    setDirty((s) => new Set(s).add(f.doc));
  };

  async function save() {
    if (!data) return;
    setSaving(true);
    const nextIssues: Record<string, Issue[]> = {};
    let saved = 0;
    for (const id of dirty) {
      const doc = docOf(id);
      try {
        await api(`/api/site/editor/${id}`, { method: "PUT", body: JSON.stringify({ value: drafts[id] ?? skeleton(doc.schema) }) });
        saved++;
        setDirty((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      } catch (e) {
        const details = (e as { data?: { issues?: Issue[] } }).data?.issues;
        nextIssues[id] = details ?? [{ path: "", message: errorText(e) }];
      }
    }
    setIssues(nextIssues);
    setSaving(false);
    const failed = Object.keys(nextIssues).length;
    if (failed) toast.error(failed > 1 ? `${failed} documents à corriger : voir les champs signalés.` : "Un document à corriger : voir les champs signalés.");
    else if (saved) toast.success("Textes enregistrés. Le site change à la prochaine publication.");
  }

  const issuesOf = (f: SchemaField) => (issues[f.doc] ?? []).filter((i) => issueBelongsTo(i.path, f)).map((i) => i.message);
  const unplaced = Object.entries(issues).flatMap(([doc, list]) =>
    list.filter((i) => !fields.some((f) => f.doc === doc && issueBelongsTo(i.path, f))).map((i) => `${docOf(doc).label} : ${i.path || "document"} : ${i.message}`),
  );

  const q = query.trim().toLowerCase();
  const visible = q
    ? fields.filter((f) => `${f.editeur.libelle} ${f.editeur.section} ${JSON.stringify(getAt(drafts[f.doc], f.path) ?? "")}`.toLowerCase().includes(q))
    : fields.filter((f) => f.editeur.page === page);
  const sections = groupBy(visible, (f) => `${f.editeur.page}\u0000${f.editeur.section}`);

  return (
    <div>
      <PageHeader
        title="Tous les textes"
        subtitle="Chaque texte de kouzia.com, rangé par page et par section. Un champ vide garde le texte actuel du site ; le site change à la prochaine publication."
      />
      <LoadState loading={loading} error={loadError} onRetry={() => void load(true)}>
        {data ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)]">
            <nav aria-label="Pages du site" className="lg:sticky lg:top-20 lg:self-start">
              <label className="mb-3 block space-y-1.5">
                <span className="block text-sm font-medium">Chercher un texte</span>
                <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Mot, libellé ou section" />
              </label>
              <label className="block space-y-1.5 lg:hidden">
                <span className="block text-sm font-medium">Page</span>
                <Select value={page} onChange={(e) => setParams({ page: e.target.value })}>
                  {pages.map((p) => (
                    <option key={p} value={p}>
                      {pageLabel(p, data.cibles)} ({fields.filter((f) => f.editeur.page === p).length})
                    </option>
                  ))}
                </Select>
              </label>
              <ul className="hidden space-y-0.5 lg:block">
                {pages.map((p) => (
                  <li key={p}>
                    <Link
                      to={`?page=${p}`}
                      aria-current={p === page && !q ? "page" : undefined}
                      className={`flex min-h-11 items-center justify-between gap-2 rounded-[var(--radius-sm)] px-3 text-sm ${
                        p === page && !q ? "bg-[var(--primary-soft)] font-medium text-[var(--text)]" : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                      }`}
                    >
                      <span className="min-w-0 truncate">{pageLabel(p, data.cibles)}</span>
                      <span className="text-xs">{fields.filter((f) => f.editeur.page === p).length}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="min-w-0 space-y-4">
              {unplaced.length ? (
                <Banner level="error">
                  <ul className="list-disc space-y-1 pl-4">
                    {unplaced.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </Banner>
              ) : null}
              {q ? (
                <p className="text-sm text-[var(--muted)]" role="status">
                  {visible.length ? `${visible.length} texte${visible.length > 1 ? "s" : ""} trouvé${visible.length > 1 ? "s" : ""}` : "Aucun texte ne correspond."}
                </p>
              ) : null}
              {[...sections.entries()].map(([key, list]) => {
                const { page: p, section } = list[0]!.editeur;
                return (
                  <Card key={key} className="p-5" id={`section-${slug(p)}-${slug(section)}`}>
                    <h2 className="font-display text-base font-semibold">{section}</h2>
                    <WhereItAppears page={p} section={section} cibles={data.cibles} siteUrls={data.siteUrls} />
                    <div className="mt-4 space-y-5">
                      {list.map((f) => (
                        <FieldControl
                          key={`${f.doc}:${f.path.join(".")}`}
                          editeur={f.editeur}
                          node={f.node}
                          value={getAt(drafts[f.doc], f.path)}
                          defaultValue={getAt(docOf(f.doc).defaults, f.path)}
                          errors={issuesOf(f)}
                          onChange={(v) => change(f, v)}
                        />
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        ) : null}
      </LoadState>
      {dirty.size ? (
        <div className="sticky bottom-0 z-20 -mx-1 mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto text-sm" role="status">
              {dirty.size > 1 ? `${dirty.size} documents modifiés` : "1 document modifié"} : {[...dirty].map((id) => docOf(id).label).join(", ")}
            </p>
            <Button variant="secondary" disabled={saving} onClick={() => void load()}>
              Annuler les modifications
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Anciennes adresses (coordonnées, accroche, textes des pages, offres, référencement, menus, ancien écran à onglets) :
 * même texte, dans l'écran généré, sur la page du site concernée.
 */
export function SiteTextsRedirect({ page }: { page?: string }) {
  const params = useParams();
  const [search] = useSearchParams();
  const tab = search.get("tab");
  const target = params.page ?? page ?? (tab === "accroche" ? "accueil" : tab === "offres" ? "sitesWeb" : "global");
  return <Navigate to={`/site/tous-les-textes?page=${encodeURIComponent(target)}`} replace />;
}

function groupBy<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const t of list) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return m;
}

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

/** « Où ce texte paraît » : page et section du site, avec un lien vers la page en ligne et en local. */
function WhereItAppears({
  page,
  section,
  cibles,
  siteUrls,
}: {
  page: string;
  section: string;
  cibles: Record<string, { libelle: string; chemin: string }>;
  siteUrls: { online: string; local: string | null };
}) {
  const chemin = cibles[page]?.chemin;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-[var(--muted)]">
      <span>
        Sur le site : {pageLabel(page, cibles)}, section « {section} »
      </span>
      {chemin ? (
        <>
          <a className="link inline-flex min-h-11 items-center gap-1.5" href={`${siteUrls.online}${chemin}`} target="_blank" rel="noopener noreferrer">
            Voir la page en ligne
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3" aria-hidden />
            <span className="sr-only">(nouvel onglet)</span>
          </a>
          {siteUrls.local ? (
            <a className="link inline-flex min-h-11 items-center gap-1.5" href={`${siteUrls.local}${chemin}`} target="_blank" rel="noopener noreferrer">
              Voir en local
              <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3" aria-hidden />
              <span className="sr-only">(nouvel onglet)</span>
            </a>
          ) : null}
        </>
      ) : null}
    </p>
  );
}

/** Aide sous un champ : aide du contrat, longueur, variables et liens permis, texte actuel du site. */
function hintOf(ed: Editeur, node: SchemaNode, value: unknown, def: unknown): string {
  const parts: string[] = [];
  // Phrases jointes par « . » : le point final de l'aide du contrat est retiré pour ne pas le doubler.
  if (ed.aide) parts.push(ed.aide.replace(/\.\s*$/, ""));
  const { maxLength } = textConstraints(node);
  if (maxLength && (typeof value === "string" || value === undefined)) parts.push(`${typeof value === "string" ? value.length : 0} / ${maxLength} caractères`);
  if (ed.variables?.length) parts.push(`Variables : ${ed.variables.map((v) => `{${v}}`).join(", ")}`);
  if (ed.liens) parts.push("Liens : [libellé](page)");
  if (ed.type === "titreAccent") parts.push("Un passage *entre astérisques* paraît en couleur");
  if (value === undefined && typeof def === "string" && def) parts.push("Vide : le texte actuel du site reste");
  return parts.length ? `${parts.join(". ")}.` : "";
}

const INPUT_TYPE: Record<string, string> = { lien: "url", email: "email", telephone: "tel", date: "date", nombre: "number" };

function FieldControl({
  editeur: ed,
  node,
  value,
  defaultValue,
  errors,
  onChange,
}: {
  editeur: Editeur;
  node: SchemaNode;
  value: unknown;
  defaultValue: unknown;
  errors: string[];
  onChange: (v: unknown) => void;
}) {
  const error = errors.length ? errors.join(" ") : undefined;
  const hint = hintOf(ed, node, value, defaultValue);
  const text = (v: string) => onChange(v === "" ? undefined : v);
  switch (ed.type) {
    case "objet":
      return <ObjectControl editeur={ed} node={node} value={value} defaultValue={defaultValue} error={error} onChange={onChange} />;
    case "listeObjets":
      return <ObjectListControl editeur={ed} node={node} value={value} defaultValue={defaultValue} error={error} onChange={onChange} />;
    case "booleen":
      return (
        <div className="space-y-1">
          <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
            <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked || undefined)} />
            {ed.libelle}
          </label>
          {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : ed.aide ? <p className="text-xs text-[var(--muted)]">{ed.aide}</p> : null}
        </div>
      );
    case "choix":
      return (
        <Field label={ed.libelle} hint={hint} error={error}>
          <Select value={typeof value === "string" ? value : ""} onChange={(e) => text(e.target.value)}>
            <option value="">{typeof defaultValue === "string" ? `Valeur actuelle du site (${defaultValue})` : "Choisir"}</option>
            {choices(node).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "image":
      return (
        <ImageField
          label={ed.libelle}
          kind={JSON.stringify(node).includes("jpg") ? "PARTAGE" : "CAPTURE"}
          allowRepoPath={false}
          optional
          value={typeof value === "string" ? value : null}
          onChange={(p) => onChange(p ?? undefined)}
          error={error}
        />
      );
    case "liste":
      return (
        <Field label={ed.libelle} hint={[hint, "Un élément par ligne."].filter(Boolean).join(". ")} error={error}>
          <Textarea
            rows={Math.min(8, Math.max(3, (Array.isArray(value) ? value.length : 0) + 1))}
            value={Array.isArray(value) ? value.join("\n") : ""}
            placeholder={Array.isArray(defaultValue) ? defaultValue.join("\n") : undefined}
            onChange={(e) => {
              const lines = e.target.value.split("\n");
              onChange(lines.some((l) => l.trim()) ? lines : undefined);
            }}
            onBlur={() => Array.isArray(value) && onChange(value.map((l) => String(l).trim()).filter(Boolean))}
          />
        </Field>
      );
    case "nombre":
      return (
        <Field label={ed.libelle} hint={hint} error={error}>
          <Input
            type="number"
            inputMode="numeric"
            min={node.minimum}
            max={node.maximum}
            value={typeof value === "number" ? value : ""}
            placeholder={typeof defaultValue === "number" ? String(defaultValue) : undefined}
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          />
        </Field>
      );
    case "long":
      return (
        <Field label={ed.libelle} hint={hint} error={error}>
          <Textarea
            rows={4}
            maxLength={textConstraints(node).maxLength}
            value={typeof value === "string" ? value : ""}
            placeholder={typeof defaultValue === "string" ? defaultValue : undefined}
            onChange={(e) => text(e.target.value)}
          />
        </Field>
      );
    default:
      return (
        <Field label={ed.libelle} hint={hint} error={error}>
          <Input
            type={INPUT_TYPE[ed.type] ?? "text"}
            className={ed.type === "identifiant" ? "font-mono" : undefined}
            maxLength={textConstraints(node).maxLength}
            autoComplete="off"
            value={typeof value === "string" ? value : ""}
            placeholder={typeof defaultValue === "string" ? defaultValue : undefined}
            onChange={(e) => text(e.target.value)}
          />
        </Field>
      );
  }
}

/** Groupe de champs : chaque enfant « editeur » de l'objet. */
function ObjectControl({
  editeur: ed,
  node,
  value,
  defaultValue,
  error,
  onChange,
}: {
  editeur: Editeur;
  node: SchemaNode;
  value: unknown;
  defaultValue: unknown;
  error?: string;
  onChange: (v: unknown) => void;
}) {
  return (
    <fieldset className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-4">
      <legend className="px-1 text-sm font-medium">{ed.libelle}</legend>
      {ed.aide ? <p className="text-xs text-[var(--muted)]">{ed.aide}</p> : null}
      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
      {childFields(node).map((c) => (
        <FieldControl
          key={c.key}
          editeur={c.editeur}
          node={c.node}
          value={getAt(value, [c.key])}
          defaultValue={getAt(defaultValue, [c.key])}
          errors={[]}
          onChange={(v) => onChange(setAt(value ?? {}, [c.key], v))}
        />
      ))}
    </fieldset>
  );
}

/**
 * Liste d'éléments à plusieurs champs. Vide : la liste actuelle du site reste ; « Modifier » part de cette liste pour la
 * changer sans tout ressaisir.
 */
function ObjectListControl({
  editeur: ed,
  node,
  value,
  defaultValue,
  error,
  onChange,
}: {
  editeur: Editeur;
  node: SchemaNode;
  value: unknown;
  defaultValue: unknown;
  error?: string;
  onChange: (v: unknown) => void;
}) {
  const headingId = useId();
  const items = Array.isArray(value) ? (value as unknown[]) : null;
  const def = Array.isArray(defaultValue) ? (defaultValue as unknown[]) : null;
  const itemNode = node.items ?? {};
  const max = node.maxItems;
  const labelOf = (item: unknown, i: number) => {
    const first = childFields(itemNode).map((c) => getAt(item, [c.key])).find((v) => typeof v === "string" && v.trim());
    return `${i + 1}. ${typeof first === "string" ? first : "élément"}`;
  };
  const move = (from: number, to: number) => {
    const next = [...items!];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    onChange(next);
  };
  return (
    <fieldset className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] p-4" aria-describedby={headingId}>
      <legend className="px-1 text-sm font-medium">{ed.libelle}</legend>
      <p id={headingId} className="text-xs text-[var(--muted)]">
        {[ed.aide, max ? `${max} au plus` : null].filter(Boolean).join(". ")}
      </p>
      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
      {items === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-[var(--muted)]">{def ? `Liste actuelle du site : ${def.length} élément${def.length > 1 ? "s" : ""}.` : "Aucun élément."}</p>
          <Button variant="secondary" onClick={() => onChange(def ? structuredClone(def) : [skeleton(itemNode)])}>
            {def ? "Modifier cette liste" : "Commencer la liste"}
          </Button>
        </div>
      ) : (
        <>
          {items.map((item, i) => (
            <details key={i} className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-subtle)]" open={items.length <= 3}>
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">{labelOf(item, i)}</summary>
              <div className="space-y-4 border-t border-[var(--border)] p-3">
                {childFields(itemNode).map((c) => (
                  <FieldControl
                    key={c.key}
                    editeur={c.editeur}
                    node={c.node}
                    value={getAt(item, [c.key])}
                    defaultValue={undefined}
                    errors={[]}
                    onChange={(v) => {
                      const next = [...items];
                      next[i] = setAt(item ?? {}, [c.key], v);
                      onChange(next);
                    }}
                  />
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Monter l'élément ${i + 1}`}>
                    <FontAwesomeIcon icon={faArrowUp} className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  <Button variant="secondary" disabled={i === items.length - 1} onClick={() => move(i, i + 1)} aria-label={`Descendre l'élément ${i + 1}`}>
                    <FontAwesomeIcon icon={faArrowDown} className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  <Button variant="danger-ghost" onClick={() => onChange(items.filter((_, j) => j !== i))}>
                    Retirer l'élément {i + 1}
                  </Button>
                </div>
              </div>
            </details>
          ))}
          <div className="flex flex-wrap gap-2">
            {max === undefined || items.length < max ? (
              <Button variant="secondary" onClick={() => onChange([...items, skeleton(itemNode)])}>
                <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
                Ajouter un élément
              </Button>
            ) : null}
            {def ? (
              <Button variant="ghost" onClick={() => onChange(undefined)}>
                Revenir à la liste actuelle du site
              </Button>
            ) : null}
          </div>
        </>
      )}
    </fieldset>
  );
}
