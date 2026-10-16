import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faRotateLeft, faXmark } from "@fortawesome/free-solid-svg-icons";
import { api } from "@/lib/api";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ImageField, LoadState, siteImageSrc, type FieldErrors } from "./shared";
import { EditorFooter, EditorLayout, useDocumentEditor } from "./editor";
import { SortableList } from "./sortable";

/**
 * Référencement par page (seo.json) et menus (menus.json) de kouzia.com. Les valeurs actuelles du site viennent de
 * son contrat (GET /api/site/defauts) : un champ vide garde la valeur du site, affichée en aide.
 */

const PAGE_IDS = ["accueil", "sitesWeb", "logiciels", "faq", "aPropos"] as const;
type PageId = (typeof PAGE_IDS)[number];
const PAGE_LABEL: Record<PageId, string> = { accueil: "Accueil", sitesWeb: "Sites web", logiciels: "Logiciels", faq: "Questions fréquentes", aPropos: "À propos" };
const isPageId = (s: string | undefined): s is PageId => PAGE_IDS.includes(s as PageId);

const HEADER_TARGETS = [...PAGE_IDS, "services", "realisations", "methode", "contact"] as const;
const ALL_TARGETS = [...HEADER_TARGETS, "espaceClient"] as const;
type Target = (typeof ALL_TARGETS)[number];

const TITLE_MAX = 60;
const DESCRIPTION_MIN = 140;
const DESCRIPTION_MAX = 155;
const IMAGE_ALT_MAX = 120;
const LABEL_MAX = 30;
const HEADER_MAX = 6;
const FOOTER_MAX = 10;

type SeoPage = { titre?: string; description?: string; image?: string; imageAlt?: string };
type SeoValue = { pages: Partial<Record<PageId, SeoPage>> };
type MenuEntry = { cible: Target; libelle?: string };
type MenusValue = { entete?: MenuEntry[]; pied?: MenuEntry[] };
type Defaults = {
  seo: Record<PageId, { titre: string; description: string }>;
  menus: { entete: Array<{ cible: Target }>; pied: Array<{ cible: Target }> };
  cibles: Record<Target, { libelle: string; chemin: string }>;
  image: string;
  imageAlt: string;
};
type Variables = { ville: string; delaiReponse: string };
type Data = { seo: SeoValue | null; menus: MenusValue | null; defaults: Defaults | null; variables: Variables | null; defaultsError: string | null };

const fill = (text: string, vars: Variables | null) =>
  vars ? text.replace(/\{(ville|delaiReponse)\}/g, (_, k: keyof Variables) => vars[k]) : text;

/** Textes du site et valeurs actuelles, chargés ensemble. */
function useSeoMenusData() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const [texts, defaults] = await Promise.all([
        api<{ seo: SeoValue | null; menus: MenusValue | null }>("/api/site/texts"),
        api<{ defaults: Defaults | null; variables: Variables | null; error: string | null }>(`/api/site/defauts${refresh ? "?rafraichir=1" : ""}`),
      ]);
      setData({ seo: texts.seo, menus: texts.menus, defaults: defaults.defaults, variables: defaults.variables, defaultsError: defaults.error });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, setData, loading, error, load };
}

/** Valeurs actuelles absentes (site pas encore à jour, dépôt injoignable) : rien n'est modifiable sans elles. */
function DefaultsMissing({ data, onRetry }: { data: Data; onRetry: () => void }) {
  return (
    <Card className="space-y-3 p-5 text-sm" role="status">
      <p className="font-medium">Valeurs actuelles du site indisponibles</p>
      <p className="text-[var(--muted)]">
        {data.defaultsError
          ? `Le contrat du site n'a pas pu être lu : ${data.defaultsError}`
          : "Le site en ligne n'exporte pas encore ses valeurs actuelles (contrat du lot 6). Elles servent à montrer ce qui reste affiché et à vérifier les descriptions."}
      </p>
      <Button variant="secondary" onClick={onRetry}>
        Réessayer
      </Button>
    </Card>
  );
}

/** Taille d'un texte une fois les variables remplacées, avec la plage attendue (aide du champ). */
function lengthHint(text: string, vars: Variables | null, range: { min?: number; max: number }, fallback: string): string {
  if (!text.trim()) return `Vide : le site garde « ${fallback} ».`;
  const n = fill(text.trim(), vars).length;
  const expected = range.min ? `${range.min} à ${range.max}` : `${range.max} au plus`;
  const vary = /\{(ville|delaiReponse)\}/.test(text) ? " une fois les variables remplacées" : "";
  return `${n} caractère${n > 1 ? "s" : ""}${vary} (${expected}).`;
}

// --- Référencement ----------------------------------------------------------------------------

type SeoRow = { id: PageId; title: string; description: string; custom: boolean; image: boolean };

export function SiteSeoListPage() {
  const { data, loading, error, load } = useSeoMenusData();
  const navigate = useNavigate();
  const rows = useMemo<SeoRow[]>(() => {
    if (!data?.defaults) return [];
    const d = data.defaults;
    return PAGE_IDS.map((id) => {
      const own = data.seo?.pages[id] ?? {};
      return {
        id,
        title: fill((id === "accueil" ? undefined : own.titre) ?? d.seo[id].titre, data.variables),
        description: fill(own.description ?? d.seo[id].description, data.variables),
        custom: Boolean(own.titre || own.description || own.image || own.imageAlt),
        image: Boolean(own.image),
      };
    });
  }, [data]);
  const columns: DataColumn<SeoRow>[] = [
    {
      name: "Page",
      cell: (r) => (
        <Link to={`/site/referencement/${r.id}`} className="link font-medium">
          {PAGE_LABEL[r.id]}
        </Link>
      ),
      width: "11rem",
    },
    { name: "Titre dans Google", cell: (r) => <span className="line-clamp-2">{r.title}</span>, grow: 2 },
    { name: "Description", cell: (r) => `${r.description.length} caractères`, width: "9rem", showFrom: 768 },
    { name: "Image de partage", cell: (r) => (r.image ? "Propre à la page" : "Image du site"), width: "10rem", showFrom: 1024 },
    { name: "Valeurs", cell: (r) => <Badge tone={r.custom ? "blue" : "neutral"}>{r.custom ? "Modifiées" : "Du site"}</Badge>, width: "8rem" },
  ];
  return (
    <div>
      <PageHeader title="Référencement des pages" subtitle="Titre et description dans Google, image et texte de la carte de partage, page par page." />
      <LoadState loading={loading} error={error} onRetry={() => void load()}>
        {data && !data.defaults ? (
          <DefaultsMissing data={data} onRetry={() => void load(true)} />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            onRowClick={(r) => navigate(`/site/referencement/${r.id}`)}
            countLabel="pages indexables"
            renderMobileCard={(r) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Link to={`/site/referencement/${r.id}`} className="link font-medium">
                    {PAGE_LABEL[r.id]}
                  </Link>
                  <Badge tone={r.custom ? "blue" : "neutral"}>{r.custom ? "Modifiées" : "Du site"}</Badge>
                </div>
                <p className="text-sm">{r.title}</p>
                <p className="text-xs text-[var(--muted)]">{r.description.length} caractères de description</p>
              </div>
            )}
          />
        )}
      </LoadState>
    </div>
  );
}

type SeoDraft = Record<PageId, { titre: string; description: string; image: string | null; imageAlt: string }>;

const toSeoDraft = (seo: SeoValue | null): SeoDraft =>
  Object.fromEntries(
    PAGE_IDS.map((id) => {
      const p = seo?.pages[id] ?? {};
      return [id, { titre: p.titre ?? "", description: p.description ?? "", image: p.image ?? null, imageAlt: p.imageAlt ?? "" }];
    }),
  ) as SeoDraft;

/** Valeur envoyée : seuls les champs remplis, une page sans champ est omise (valeurs du site). */
function toSeoValue(draft: SeoDraft): SeoValue {
  const pages: SeoValue["pages"] = {};
  for (const id of PAGE_IDS) {
    const d = draft[id];
    const page: SeoPage = {};
    if (id !== "accueil" && d.titre.trim()) page.titre = d.titre.trim();
    if (d.description.trim()) page.description = d.description.trim();
    if (d.image) page.image = d.image;
    if (d.imageAlt.trim()) page.imageAlt = d.imageAlt.trim();
    if (Object.keys(page).length) pages[id] = page;
  }
  return { pages };
}

/** Règles du site (valider.ts) sur les valeurs finales : longueurs et descriptions distinctes. */
function seoErrors(draft: SeoDraft, defaults: Defaults, vars: Variables | null): FieldErrors {
  const errors: FieldErrors = {};
  const seen = new Map<string, PageId>();
  for (const id of PAGE_IDS) {
    const d = draft[id];
    const title = fill(d.titre.trim() || defaults.seo[id].titre, vars);
    if (id !== "accueil" && title.length > TITLE_MAX) errors[`pages.${id}.titre`] = `${title.length} caractères : ${TITLE_MAX} au plus.`;
    const description = fill(d.description.trim() || defaults.seo[id].description, vars);
    if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
      errors[`pages.${id}.description`] = `${description.length} caractères : ${DESCRIPTION_MIN} à ${DESCRIPTION_MAX} attendus.`;
    }
    const twin = seen.get(description);
    if (twin && !errors[`pages.${id}.description`]) errors[`pages.${id}.description`] = `Même description que la page « ${PAGE_LABEL[twin]} ».`;
    seen.set(description, id);
    if (d.imageAlt.trim().length > IMAGE_ALT_MAX) errors[`pages.${id}.imageAlt`] = `${IMAGE_ALT_MAX} caractères au plus.`;
    if (/\*/.test(d.titre) || /\*/.test(d.imageAlt)) errors[`pages.${id}.${/\*/.test(d.titre) ? "titre" : "imageAlt"}`] = "Astérisque interdit ici.";
  }
  return errors;
}

export function SiteSeoPageEditor() {
  const { page } = useParams();
  const { data, setData, loading, error, load } = useSeoMenusData();
  if (!isPageId(page)) return <Navigate to="/site/referencement" replace />;
  return (
    <div>
      <PageHeader back={{ to: "/site/referencement", label: "Référencement" }} title={`Référencement : ${PAGE_LABEL[page]}`} />
      <LoadState loading={loading} error={error} onRetry={() => void load()}>
        {data && !data.defaults ? <DefaultsMissing data={data} onRetry={() => void load(true)} /> : null}
        {data?.defaults ? (
          <SeoForm
            key={page}
            page={page}
            initial={data.seo}
            defaults={data.defaults}
            vars={data.variables}
            onSaved={(seo) => setData((d) => (d ? { ...d, seo } : d))}
          />
        ) : null}
      </LoadState>
    </div>
  );
}

function SeoForm({ page, initial, defaults, vars, onSaved }: { page: PageId; initial: SeoValue | null; defaults: Defaults; vars: Variables | null; onSaved: (v: SeoValue) => void }) {
  const doc = useDocumentEditor<SeoDraft, SeoValue>({
    textKey: "seo",
    initial: toSeoDraft(initial),
    toValue: toSeoValue,
    validate: (d) => seoErrors(d, defaults, vars),
    onSaved,
  });
  const f = doc.form[page];
  const setPage = (patch: Partial<SeoDraft[PageId]>) => doc.setForm((all) => ({ ...all, [page]: { ...all[page], ...patch } }));
  const site = defaults.seo[page];
  const path = defaults.cibles[page].chemin;
  const title = fill((page === "accueil" ? "" : f.titre.trim()) || site.titre, vars);
  const description = fill(f.description.trim() || site.description, vars);
  const image = f.image ?? defaults.image;
  const imageAlt = fill(f.imageAlt.trim() || defaults.imageAlt, vars);
  const key = (field: string) => `pages.${page}.${field}`;

  const google = (
    <div className="space-y-4">
      {page === "accueil" ? (
        <div className="space-y-1.5 text-sm">
          <p className="font-medium">Titre dans Google</p>
          <p>{site.titre}</p>
          <p className="text-xs text-[var(--muted)]">Titre de l'accueil fixé par la charte du site : il n'est pas modifiable.</p>
        </div>
      ) : (
        <Field label="Titre dans Google" hint={lengthHint(f.titre, vars, { max: TITLE_MAX }, site.titre)} error={doc.errorFor(key("titre"))}>
          <Input autoComplete="off" value={f.titre} placeholder={site.titre} onChange={(e) => setPage({ titre: e.target.value })} />
        </Field>
      )}
      <Field
        label="Description dans Google"
        hint={lengthHint(f.description, vars, { min: DESCRIPTION_MIN, max: DESCRIPTION_MAX }, site.description)}
        error={doc.errorFor(key("description"))}
      >
        <Textarea rows={4} value={f.description} placeholder={site.description} onChange={(e) => setPage({ description: e.target.value })} />
      </Field>
      <p className="text-xs text-[var(--muted)]">
        Variables permises : {"{ville}"} ({vars?.ville ?? "ville des réglages"}) et {"{delaiReponse}"} ({vars?.delaiReponse ?? "délai des coordonnées"}).
      </p>
    </div>
  );
  const share = (
    <div className="space-y-4">
      <ImageField label="Image de partage (1200×630)" kind="PARTAGE" value={f.image} optional onChange={(p) => setPage({ image: p })} error={doc.errorFor(key("image"))} />
      {!f.image ? <p className="text-xs text-[var(--muted)]">Sans image propre, la carte de partage montre l'image du site.</p> : null}
      <Field
        label="Description de l'image"
        hint={f.imageAlt.trim() ? `${fill(f.imageAlt.trim(), vars).length} caractères (${IMAGE_ALT_MAX} au plus).` : `Vide : « ${defaults.imageAlt} ».`}
        error={doc.errorFor(key("imageAlt"))}
      >
        <Input autoComplete="off" value={f.imageAlt} placeholder={defaults.imageAlt} onChange={(e) => setPage({ imageAlt: e.target.value })} />
      </Field>
    </div>
  );

  return (
    <form noValidate onSubmit={doc.onSubmit}>
      <EditorLayout
        label={`Sections du référencement de la page ${PAGE_LABEL[page]}`}
        tabs={[
          { id: "google", label: "Google", content: google, errors: doc.count(key("titre"), key("description")) },
          { id: "partage", label: "Partage", content: share, errors: doc.count(key("image"), key("imageAlt")) },
        ]}
        preview={() => (
          <div className="space-y-4">
            <GoogleResultPreview title={title} description={description} path={path} />
            <ShareCardPreview title={title} description={description} image={image} imageAlt={imageAlt} />
          </div>
        )}
        footer={<EditorFooter auto={doc.auto} creating={false} busy={false} createLabel="" />}
      />
    </form>
  );
}

function PreviewLabel({ children }: { children: ReactNode }) {
  return <p className="font-ui text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{children}</p>;
}

/** Résultat de recherche : Google coupe le titre et la description selon la largeur, le texte complet est montré ici. */
function GoogleResultPreview({ title, description, path }: { title: string; description: string; path: string }) {
  const crumbs = path.split("/").filter(Boolean).join(" › ");
  return (
    <div className="space-y-1.5 font-ui">
      <PreviewLabel>Résultat Google</PreviewLabel>
      <div className="space-y-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-3">
        <p className="truncate text-xs text-[var(--muted)]">kouzia.com{crumbs ? ` › ${crumbs}` : ""}</p>
        <p className="text-base leading-snug text-[var(--accent-2)]">{title}</p>
        <p className="text-sm text-[var(--muted)]">{description}</p>
      </div>
    </div>
  );
}

/** Carte de partage (réseaux sociaux, messageries) : image 1200×630, titre, description et domaine. */
function ShareCardPreview({ title, description, image, imageAlt }: { title: string; description: string; image: string; imageAlt: string }) {
  const src = siteImageSrc(image) ?? (/^\/[a-z0-9-]+\.jpg$/.test(image) ? `https://kouzia.com${image}` : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <div className="space-y-1.5 font-ui">
      <PreviewLabel>Carte de partage</PreviewLabel>
      <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)]">
        {src && !failed ? (
          <img src={src} alt={imageAlt} referrerPolicy="no-referrer" onError={() => setFailed(true)} className="aspect-[1200/630] w-full bg-[var(--surface-raised)] object-cover" />
        ) : (
          <div className="flex aspect-[1200/630] w-full items-center justify-center bg-[var(--surface-raised)] text-xs text-[var(--muted)]" role="img" aria-label={`${imageAlt} : aperçu indisponible`}>
            Aperçu de l'image indisponible
          </div>
        )}
        <div className="space-y-0.5 p-3">
          <p className="text-xs uppercase text-[var(--muted)]">kouzia.com</p>
          <p className="text-sm font-medium">{title}</p>
          <p className="line-clamp-2 text-xs text-[var(--muted)]">{description}</p>
        </div>
      </div>
    </div>
  );
}

// --- Menus ------------------------------------------------------------------------------------

type DraftEntry = { id: string; cible: Target; libelle: string };
type MenusDraft = { entete: DraftEntry[]; pied: DraftEntry[] };
type MenuZone = keyof MenusDraft;
const ZONE: Record<MenuZone, { label: string; max: number; targets: readonly Target[] }> = {
  entete: { label: "En-tête", max: HEADER_MAX, targets: HEADER_TARGETS },
  pied: { label: "Pied de page", max: FOOTER_MAX, targets: ALL_TARGETS },
};

let entrySeq = 0;
const entry = (cible: Target, libelle = ""): DraftEntry => ({ id: `lien-${++entrySeq}`, cible, libelle });
const toMenusDraft = (menus: MenusValue | null, defaults: Defaults): MenusDraft => ({
  entete: ((menus?.entete ?? defaults.menus.entete) as MenuEntry[]).map((e) => entry(e.cible, e.libelle ?? "")),
  pied: ((menus?.pied ?? defaults.menus.pied) as MenuEntry[]).map((e) => entry(e.cible, e.libelle ?? "")),
});
const toMenusValue = (draft: MenusDraft): MenusValue => {
  const out = (list: DraftEntry[]) => list.map((e) => (e.libelle.trim() ? { cible: e.cible, libelle: e.libelle.trim() } : { cible: e.cible }));
  return { entete: out(draft.entete), pied: out(draft.pied) };
};

function menusErrors(draft: MenusDraft): FieldErrors {
  const errors: FieldErrors = {};
  for (const zone of ["entete", "pied"] as const) {
    const list = draft[zone];
    if (!list.length) errors[zone] = "Au moins un lien.";
    if (list.length > ZONE[zone].max) errors[zone] = `${ZONE[zone].max} liens au plus.`;
    const seen = new Set<string>();
    list.forEach((e, i) => {
      if (seen.has(e.cible)) errors[`${zone}.${i}.cible`] = "Déjà dans ce menu.";
      seen.add(e.cible);
      if (!ZONE[zone].targets.includes(e.cible)) errors[`${zone}.${i}.cible`] = "L'espace client a déjà son lien fixe dans l'en-tête.";
      if (e.libelle.trim().length > LABEL_MAX) errors[`${zone}.${i}.libelle`] = `${LABEL_MAX} caractères au plus.`;
      if (/\*/.test(e.libelle)) errors[`${zone}.${i}.libelle`] = "Astérisque interdit ici.";
    });
  }
  return errors;
}

export function SiteMenusPage() {
  const { data, setData, loading, error, load } = useSeoMenusData();
  return (
    <div>
      <PageHeader title="Menus" subtitle="Liens de l'en-tête et du pied de page de kouzia.com : pages et sections existantes seulement." />
      <LoadState loading={loading} error={error} onRetry={() => void load()}>
        {data && !data.defaults ? <DefaultsMissing data={data} onRetry={() => void load(true)} /> : null}
        {data?.defaults ? (
          <MenusForm initial={data.menus} defaults={data.defaults} vars={data.variables} onSaved={(menus) => setData((d) => (d ? { ...d, menus } : d))} />
        ) : null}
      </LoadState>
    </div>
  );
}

function MenusForm({ initial, defaults, vars, onSaved }: { initial: MenusValue | null; defaults: Defaults; vars: Variables | null; onSaved: (v: MenusValue) => void }) {
  const doc = useDocumentEditor<MenusDraft, MenusValue>({
    textKey: "menus",
    initial: toMenusDraft(initial, defaults),
    toValue: toMenusValue,
    validate: menusErrors,
    onSaved,
  });
  const [resetting, setResetting] = useState(false);
  const labelOf = (e: DraftEntry) => fill(e.libelle.trim() || defaults.cibles[e.cible].libelle, vars);
  const setZone = (zone: MenuZone, list: DraftEntry[]) => doc.setForm((f) => ({ ...f, [zone]: list }));
  const update = (zone: MenuZone, id: string, patch: Partial<DraftEntry>) => setZone(zone, doc.form[zone].map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const editor = (zone: MenuZone) => {
    const list = doc.form[zone];
    const free = ZONE[zone].targets.filter((t) => !list.some((e) => e.cible === t));
    return (
      <div className="space-y-3">
        {doc.errorFor(zone) && !Object.keys(doc.errors).some((k) => k.startsWith(`${zone}.`)) ? (
          <p className="text-sm text-[var(--danger)]" role="alert">
            {doc.errorFor(zone)}
          </p>
        ) : null}
        <SortableList
          items={list}
          name={labelOf}
          onReorder={(ids) => setZone(zone, ids.map((id) => list.find((e) => e.id === id)!))}
          render={(e) => {
            const i = list.indexOf(e);
            return (
              <div className="grid min-w-0 gap-2 py-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
                <Field label="Page ou section" error={doc.errorFor(`${zone}.${i}.cible`)}>
                  <Select value={e.cible} onChange={(ev) => update(zone, e.id, { cible: ev.target.value as Target })}>
                    {ZONE[zone].targets
                      .filter((t) => t === e.cible || free.includes(t))
                      .map((t) => (
                        <option key={t} value={t}>
                          {defaults.cibles[t].libelle} ({defaults.cibles[t].chemin})
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Libellé (facultatif)" error={doc.errorFor(`${zone}.${i}.libelle`)}>
                  <Input autoComplete="off" maxLength={LABEL_MAX + 10} value={e.libelle} placeholder={defaults.cibles[e.cible].libelle} onChange={(ev) => update(zone, e.id, { libelle: ev.target.value })} />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  className="self-end"
                  aria-label={`Retirer ${labelOf(e)} du menu ${ZONE[zone].label.toLowerCase()}`}
                  disabled={list.length <= 1}
                  onClick={() => setZone(zone, list.filter((x) => x.id !== e.id))}
                >
                  <FontAwesomeIcon icon={faXmark} className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            );
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" disabled={list.length >= ZONE[zone].max || free.length === 0} onClick={() => setZone(zone, [...list, entry(free[0]!)])}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Ajouter un lien
          </Button>
          <p className="text-xs text-[var(--muted)]">
            {list.length} sur {ZONE[zone].max} au plus.
            {zone === "entete" ? " « Espace client » et « Devis gratuit » restent toujours affichés à droite." : " Les pages légales, le contact et les réseaux restent toujours affichés."}
          </p>
        </div>
      </div>
    );
  };

  return (
    <form noValidate onSubmit={doc.onSubmit}>
      <EditorLayout
        label="Menus du site"
        tabs={[
          { id: "entete", label: "En-tête", content: editor("entete"), errors: doc.count("entete") },
          { id: "pied", label: "Pied de page", content: editor("pied"), errors: doc.count("pied") },
        ]}
        preview={(device) => <MenusPreview entete={doc.form.entete.map(labelOf)} pied={doc.form.pied.map(labelOf)} compact={device === "phone"} />}
        footer={
          <>
            <EditorFooter auto={doc.auto} creating={false} busy={false} createLabel="" />
            <Button type="button" variant="ghost" onClick={() => setResetting(true)}>
              <FontAwesomeIcon icon={faRotateLeft} className="h-3.5 w-3.5" aria-hidden />
              Revenir aux menus du site
            </Button>
          </>
        }
      />
      <ConfirmDialog
        open={resetting}
        title="Revenir aux menus du site ?"
        message="Les deux menus reprennent les liens et libellés actuels de kouzia.com. Le site ne change qu'avec « Publier »."
        confirmLabel="Revenir aux menus du site"
        onConfirm={() => {
          doc.setForm(toMenusDraft(null, defaults));
          setResetting(false);
        }}
        onClose={() => setResetting(false)}
      />
    </form>
  );
}

function MenusPreview({ entete, pied, compact }: { entete: string[]; pied: string[]; compact: boolean }) {
  return (
    <div className="space-y-4 font-ui text-sm">
      <div className="space-y-1.5">
        <PreviewLabel>En-tête</PreviewLabel>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-3">
          <span className="font-display font-semibold">Kouzia</span>
          {compact ? (
            <span className="text-xs text-[var(--muted)]">Menu replié : {entete.join(", ")}</span>
          ) : (
            entete.map((l, i) => <span key={`${l}-${i}`}>{l}</span>)
          )}
          <span className="text-[var(--muted)]">Espace client</span>
          <span className="rounded-[var(--radius-sm)] bg-[var(--primary)] px-2 py-1 text-[var(--primary-fg)]">Devis gratuit</span>
        </div>
      </div>
      <div className="space-y-1.5">
        <PreviewLabel>Pied de page, plan du site</PreviewLabel>
        <ul className="space-y-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-3">
          {pied.map((l, i) => (
            <li key={`${l}-${i}`}>{l}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
