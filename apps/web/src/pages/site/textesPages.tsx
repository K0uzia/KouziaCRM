import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { Card, PageHeader } from "@/components/ui/Card";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { useTabParam } from "@/components/ui/Tabs";
import { EditorFooter, EditorLayout, useDocumentEditor, type SaveState } from "./editor";
import { LoadState, type FieldErrors } from "./shared";

/**
 * Textes des pages de kouzia.com (pages.json, lot 6 A). Un champ vide garde le texte actuel du site (clé absente) ;
 * les textes actuels viennent du contrat du site (defauts.pages), jamais recopiés dans l'ERP. Le haut de l'accueil
 * (surtitre, titre, introduction) se modifie dans « Accroche de l'accueil », seul écran pour ces champs.
 */

export const PAGE_TABS = [
  { id: "accueil", label: "Accueil" },
  { id: "sitesWeb", label: "Sites web" },
  { id: "logiciels", label: "Logiciels" },
  { id: "aPropos", label: "À propos" },
  { id: "faq", label: "FAQ" },
] as const;
type PageId = (typeof PAGE_TABS)[number]["id"];

type FieldSpec = { key: string; page: PageId; group: string; label: string; max: number; accent?: boolean; long?: boolean; hint?: string };

/** Champs de pages.json, dans l'ordre des clés du contrat du site (sérialisation identique au dépôt). */
export const PAGE_FIELDS: FieldSpec[] = [
  { key: "pages.accueil.hero.surTitre", page: "accueil", group: "Haut de page", label: "Surtitre", max: 60 },
  { key: "pages.accueil.hero.titre", page: "accueil", group: "Haut de page", label: "Titre principal", max: 90, accent: true },
  ...(["services", "realisations"] as const).flatMap((b): FieldSpec[] => [
    { key: `pages.accueil.${b}.surTitre`, page: "accueil", group: b === "services" ? "Services" : "Réalisations", label: "Surtitre", max: 40 },
    { key: `pages.accueil.${b}.titre`, page: "accueil", group: b === "services" ? "Services" : "Réalisations", label: "Titre", max: 90 },
    { key: `pages.accueil.${b}.intro`, page: "accueil", group: b === "services" ? "Services" : "Réalisations", label: "Introduction", max: 300, long: true },
  ]),
  { key: "pages.accueil.maintenanceOption.titre", page: "accueil", group: "Maintenance en option", label: "Titre", max: 60 },
  {
    key: "pages.accueil.maintenanceOption.texte",
    page: "accueil",
    group: "Maintenance en option",
    label: "Texte",
    max: 200,
    long: true,
    hint: "Suit « Maintenance en option, » en gras : commencer par une minuscule.",
  },
  { key: "pages.accueil.zone.titre", page: "accueil", group: "Zone d'intervention", label: "Titre", max: 60 },
  { key: "pages.accueil.zone.texte", page: "accueil", group: "Zone d'intervention", label: "Texte", max: 400, long: true },
  {
    key: "pages.accueil.contact.titre",
    page: "accueil",
    group: "Bloc contact",
    label: "Titre",
    max: 90,
    accent: true,
    hint: "Sert aussi, sans la couleur, aux appels en bas des pages Sites web et Logiciels.",
  },
  { key: "pages.accueil.contact.intro", page: "accueil", group: "Bloc contact", label: "Introduction", max: 300, long: true },
  ...(["sitesWeb", "logiciels"] as const).flatMap((p): FieldSpec[] => [
    { key: `pages.${p}.hero.surTitre`, page: p, group: "Haut de page", label: "Surtitre", max: 60 },
    { key: `pages.${p}.hero.titre`, page: p, group: "Haut de page", label: "Titre", max: 90 },
    { key: `pages.${p}.hero.intro`, page: p, group: "Haut de page", label: "Introduction", max: 300, long: true },
  ]),
  { key: "pages.aPropos.titre", page: "aPropos", group: "Section À propos", label: "Titre (accueil)", max: 90 },
  {
    key: "pages.aPropos.histoire",
    page: "aPropos",
    group: "Section À propos",
    label: "Histoire",
    max: 600,
    long: true,
    hint: "Affichée sur l'accueil et en tête de la page À propos.",
  },
  { key: "pages.faq.intro", page: "faq", group: "Haut de page", label: "Introduction", max: 300, long: true },
];
const HERO_KEYS = ["pages.accueil.hero.surTitre", "pages.accueil.hero.titre"];

export type PagesDraft = Record<string, string>;
type PagesDoc = { pages: Record<string, unknown> };

const get = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
function setPath(obj: Record<string, unknown>, path: string, value: string) {
  const parts = path.split(".");
  let o = obj;
  for (const k of parts.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
  o[parts.at(-1)!] = value;
}

export const pagesToDraft = (doc: PagesDoc | null): PagesDraft =>
  Object.fromEntries(PAGE_FIELDS.map((f) => [f.key, typeof get(doc, f.key) === "string" ? (get(doc, f.key) as string) : ""]));

/** pages.json : seulement les champs remplis, dans l'ordre des clés du contrat ; vide = texte actuel du site. */
export function draftToPages(draft: PagesDraft): PagesDoc {
  const out: Record<string, unknown> = { pages: {} };
  for (const f of PAGE_FIELDS) {
    const v = (draft[f.key] ?? "").trim();
    if (v) setPath(out, f.key, v);
  }
  return out as PagesDoc;
}

// Tirets cadratin et demi-cadratin interdits (charte) ; construits par code pour ne jamais les écrire dans le source.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const VARIABLES_ONLY = /^(?:[^{}]|\{(?:ville|delaiReponse)\})*$/;
const ONE_ACCENT = /^[^*]*(\*[^*\s][^*]*\*[^*]*)?$/;

/** Règles du schéma pages.json (contrat du site) reprises avant l'envoi. */
export function pagesErrors(draft: PagesDraft, keys: string[] = PAGE_FIELDS.map((f) => f.key)): FieldErrors {
  const e: FieldErrors = {};
  for (const f of PAGE_FIELDS.filter((x) => keys.includes(x.key))) {
    const v = (draft[f.key] ?? "").trim();
    if (!v) continue;
    if (v.length > f.max) e[f.key] = `${f.max} caractères au plus (${v.length}).`;
    else if (DASHES.test(v)) e[f.key] = "Tiret long interdit : utiliser une virgule, deux-points ou des parenthèses.";
    else if (!VARIABLES_ONLY.test(v)) e[f.key] = "Variable inconnue : seules {ville} et {delaiReponse} sont permises.";
    else if (f.accent ? !ONE_ACCENT.test(v) : v.includes("*")) e[f.key] = f.accent ? "Un seul passage *entre astérisques* au plus." : "Astérisque interdit ici.";
  }
  return e;
}

export type Variables = { ville: string; delaiReponse: string } | null;
const fill = (text: string, vars: Variables) => (vars ? text.replace(/\{(ville|delaiReponse)\}/g, (_, k: "ville" | "delaiReponse") => vars[k]) : text);

/** Texte tel que le site l'affiche : variables remplacées, passage *entre astérisques* en couleur d'accent. */
export function SiteText({ text, vars }: { text: string; vars: Variables }) {
  const parts = fill(text, vars).split(/\*([^*]+)\*/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <span key={i} className="text-[var(--apercu-accent)]">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

type DefaultsResponse = { defaults: PagesDoc["pages"] | null; variables: Variables; error: string | null };

/** Textes actuels du site et valeurs des variables (contrat du dépôt, via l'API). */
export function usePagesDefaults() {
  const [data, setData] = useState<DefaultsResponse | null>(null);
  useEffect(() => {
    api<DefaultsResponse>("/api/site/textes-pages/defauts")
      .then(setData)
      .catch((e: unknown) => setData({ defaults: null, variables: null, error: e instanceof Error ? e.message : "Textes actuels indisponibles" }));
  }, []);
  const defaultOf = (key: string) => {
    const v = get({ pages: data?.defaults ?? {} }, key);
    return typeof v === "string" ? v : "";
  };
  return { data, defaultOf };
}

function PageField({
  spec,
  value,
  placeholder,
  error,
  onChange,
}: {
  spec: FieldSpec;
  value: string;
  placeholder: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  const hint = [
    spec.hint,
    spec.accent ? "*Entre astérisques* : en couleur, un passage au plus." : null,
    `${value.length} / ${spec.max}`,
    value.trim() ? null : "Vide : texte actuel du site.",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Field label={spec.label} hint={hint} error={error}>
      {spec.long ? (
        <Textarea rows={3} maxLength={spec.max + 40} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input autoComplete="off" maxLength={spec.max + 40} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

/** Aperçu des textes d'une page, tels que le site les montre (styles du site, valeur ou texte actuel). */
function PagePreview({ page, text, vars }: { page: PageId; text: (key: string) => string; vars: Variables }) {
  const groups = [...new Set(PAGE_FIELDS.filter((f) => f.page === page).map((f) => f.group))];
  return (
    <div className="space-y-5 text-[var(--text)]">
      {groups.map((g) => {
        const fields = PAGE_FIELDS.filter((f) => f.page === page && f.group === g);
        return (
          <div key={g} className="space-y-1.5 border-b border-[var(--border)] pb-4 last:border-0">
            {fields.map((f) => {
              const t = text(f.key);
              // Ni saisie ni texte actuel connu (contrat illisible) : le site garde son texte, l'aperçu le nomme.
              if (!t) {
                return (
                  <p key={f.key} className="text-sm italic text-[var(--muted)]">
                    {f.label} : texte actuel du site
                  </p>
                );
              }
              const role = f.label.toLowerCase();
              if (role.startsWith("surtitre")) {
                return (
                  <p key={f.key} className="font-mono text-[0.8125rem] uppercase tracking-[0.14em] text-[var(--apercu-accent)]">
                    <SiteText text={t} vars={vars} />
                  </p>
                );
              }
              if (role.startsWith("titre")) {
                return (
                  <p key={f.key} className="text-[1.3rem] font-bold leading-tight">
                    <SiteText text={t} vars={vars} />
                  </p>
                );
              }
              return (
                <p key={f.key} className="text-[0.95rem] text-[var(--muted)]">
                  <SiteText text={t} vars={vars} />
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Statut commun à deux documents enregistrés ensemble : l'erreur ou l'envoi en cours d'abord, sinon le plus récent. */
function combined(a: { state: SaveState; dirty: boolean }, b: { state: SaveState; dirty: boolean }) {
  const states = [a.state, b.state];
  const pick =
    states.find((s) => s.kind === "error") ??
    states.find((s) => s.kind === "saving") ??
    states.find((s) => s.kind === "dirty") ??
    states.filter((s): s is Extract<SaveState, { kind: "saved" }> => s.kind === "saved").sort((x, y) => y.at.getTime() - x.at.getTime())[0] ?? { kind: "idle" as const };
  return { state: pick, dirty: a.dirty || b.dirty };
}

type Texts = { pages: PagesDoc | null; accroche: { titre: string; texte: string } | null };

function useTexts() {
  const [texts, setTexts] = useState<Texts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setTexts(await api<Texts>("/api/site/texts"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { texts, error, load };
}

/** Écran « Textes des pages » : un onglet par page, aperçu de la page choisie. */
export function SitePagesTextsPage() {
  const { texts, error, load } = useTexts();
  return (
    <div>
      <PageHeader
        title="Textes des pages"
        subtitle="Titres et introductions des pages de kouzia.com. Un champ vide garde le texte actuel du site, affiché en exemple."
      />
      <LoadState loading={!texts && !error} error={error} onRetry={() => void load()}>
        {texts ? <PagesForm initial={texts.pages} /> : null}
      </LoadState>
    </div>
  );
}

function PagesForm({ initial }: { initial: PagesDoc | null }) {
  const { data, defaultOf } = usePagesDefaults();
  const doc = useDocumentEditor<PagesDraft, PagesDoc>({
    textKey: "pages",
    initial: pagesToDraft(initial),
    toValue: draftToPages,
    validate: (d) => pagesErrors(d),
    onSaved: () => undefined,
  });
  const [page] = useTabParam(
    PAGE_TABS.map((t) => t.id),
    "accueil",
  );
  const vars = data?.variables ?? null;
  const editable = (p: PageId) => PAGE_FIELDS.filter((f) => f.page === p && !HERO_KEYS.includes(f.key));
  const fillFromSite = () => {
    doc.setForm((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() ? v : HERO_KEYS.includes(k) ? v : defaultOf(k)])));
  };

  const content = (p: PageId): ReactNode => {
    const groups = [...new Set(editable(p).map((f) => f.group))];
    return (
      <div className="space-y-6">
        {p === "accueil" ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p className="text-[var(--muted)]">Le haut de l'accueil (surtitre, titre principal, introduction) a son écran :</p>
            <ButtonLink to="/site/accroche" variant="secondary">
              Accroche de l'accueil
            </ButtonLink>
          </div>
        ) : null}
        {groups.map((g) => (
          <fieldset key={g} className="min-w-0 space-y-4">
            <legend className="text-sm font-semibold">{g}</legend>
            {editable(p)
              .filter((f) => f.group === g)
              .map((f) => (
                <PageField
                  key={f.key}
                  spec={f}
                  value={doc.form[f.key] ?? ""}
                  placeholder={defaultOf(f.key)}
                  error={doc.errors[f.key]}
                  onChange={(v) => doc.set(f.key, v)}
                />
              ))}
          </fieldset>
        ))}
      </div>
    );
  };

  return (
    <form noValidate onSubmit={doc.onSubmit} className="space-y-4">
      {data?.error ? (
        <Card className="p-4 text-sm text-[var(--warning)]" role="status">
          Textes actuels du site indisponibles ({data.error}) : les exemples sous les champs manquent, la saisie reste possible.
        </Card>
      ) : data?.defaults ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
          <p className="text-[var(--muted)]">Pour retoucher un texte plutôt que l'écrire : remplir les champs vides avec les textes actuels du site.</p>
          <Button variant="secondary" onClick={fillFromSite}>
            Partir des textes actuels
          </Button>
        </Card>
      ) : null}
      <EditorLayout
        label="Pages du site"
        tabs={PAGE_TABS.map((t) => ({ id: t.id, label: t.label, content: content(t.id), errors: doc.count(`pages.${t.id}`) }))}
        preview={() => <PagePreview page={page} text={(k) => (doc.form[k] ?? "").trim() || defaultOf(k)} vars={vars} />}
        footer={<EditorFooter auto={doc.auto} creating={false} busy={false} createLabel="" />}
      />
    </form>
  );
}

/**
 * « Accroche de l'accueil » : le haut de l'accueil tel que le site l'affiche. Surtitre et titre principal (h1, avec
 * accent) viennent de pages.json ; l'introduction est le texte de l'accroche (textes.json). Le titre de l'accroche
 * (accroche.titre) n'est affiché nulle part sur le site : il n'est plus saisi, sa valeur repart telle quelle.
 */
export function SiteHeroScreen() {
  const { texts, error, load } = useTexts();
  return (
    <div>
      <PageHeader title="Accroche de l'accueil" subtitle="Le haut de la page d'accueil de kouzia.com : surtitre, grand titre et introduction." />
      <LoadState loading={!texts && !error} error={error} onRetry={() => void load()}>
        {texts ? <HeroForm pagesInitial={texts.pages} accroche={texts.accroche} /> : null}
      </LoadState>
    </div>
  );
}

function HeroForm({ pagesInitial, accroche }: { pagesInitial: PagesDoc | null; accroche: Texts["accroche"] }) {
  const { data, defaultOf } = usePagesDefaults();
  const pagesDoc = useDocumentEditor<PagesDraft, PagesDoc>({
    textKey: "pages",
    initial: pagesToDraft(pagesInitial),
    toValue: draftToPages,
    validate: (d) => pagesErrors(d, HERO_KEYS),
    onSaved: () => undefined,
  });
  const intro = useDocumentEditor<{ texte: string }, { titre: string; texte: string }>({
    textKey: "accroche",
    initial: { texte: accroche?.texte ?? "" },
    // Titre de l'accroche : exigé par le contrat, affiché nulle part ; renvoyé tel qu'il est enregistré.
    toValue: (d) => ({ titre: accroche?.titre ?? "", texte: d.texte }),
    validate: (d): FieldErrors => (d.texte.trim() ? {} : { texte: "Introduction obligatoire." }),
    onSaved: () => undefined,
  });
  const vars = data?.variables ?? null;
  const spec = (key: string) => PAGE_FIELDS.find((f) => f.key === key)!;
  const auto = combined(pagesDoc.auto, intro.auto);
  const text = (k: string) => (pagesDoc.form[k] ?? "").trim() || defaultOf(k);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void pagesDoc.auto.flush();
        void intro.auto.flush();
      }}
    >
      <EditorLayout
        label="Sections de l'accroche"
        tabs={[
          {
            id: "haut",
            label: "Haut de l'accueil",
            errors: pagesDoc.count(...HERO_KEYS) + intro.count("texte"),
            content: (
              <div className="space-y-4">
                {HERO_KEYS.map((k) => (
                  <PageField
                    key={k}
                    spec={spec(k)}
                    value={pagesDoc.form[k] ?? ""}
                    placeholder={defaultOf(k)}
                    error={pagesDoc.errors[k]}
                    onChange={(v) => pagesDoc.set(k, v)}
                  />
                ))}
                <Field label="Introduction" hint="Sous le titre : qui vous êtes, ce que vous faites, où." error={intro.errorFor("texte")}>
                  <Textarea rows={5} value={intro.form.texte} onChange={(e) => intro.set("texte", e.target.value)} />
                </Field>
              </div>
            ),
          },
        ]}
        preview={() => (
          <div className="space-y-3 text-[var(--text)]">
            {text("pages.accueil.hero.surTitre") ? (
              <p className="font-mono text-[0.8125rem] uppercase tracking-[0.14em] text-[var(--apercu-accent)]">
                <SiteText text={text("pages.accueil.hero.surTitre")} vars={vars} />
              </p>
            ) : (
              <p className="text-sm italic text-[var(--muted)]">Surtitre : texte actuel du site</p>
            )}
            {text("pages.accueil.hero.titre") ? (
              <p className="font-display text-[1.6rem] font-bold leading-tight">
                <SiteText text={text("pages.accueil.hero.titre")} vars={vars} />
              </p>
            ) : (
              <p className="text-sm italic text-[var(--muted)]">Titre principal : texte actuel du site</p>
            )}
            <p className="text-[var(--muted)]">{intro.form.texte}</p>
          </div>
        )}
        footer={<EditorFooter auto={auto} creating={false} busy={false} createLabel="" />}
      />
    </form>
  );
}
