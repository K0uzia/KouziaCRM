import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { fieldErrorsOf, LoadState, type FieldErrors } from "./shared";
import { EditorFooter, EditorLayout, useDocumentEditor } from "./editor";
import { ContactPreview, OfferCardPreview } from "./preview";

/** Textes uniques du site (table SiteText), un écran chacun : coordonnées, accroche, offres. */

type Infos = {
  email: string;
  telephone: string;
  delaiReponse: string;
  anneesExperience: number;
  zone: string;
  villes: string[];
  github: string;
  instagram: string;
  ficheGoogle: string;
  avisGoogle: string;
};
type Accroche = { titre: string; texte: string };
type Formule = { titre: string; items: string[] };
type Offres = { formules: { site: Formule; logiciel: Formule }; tarif: string };
type Texts = { infos: Infos | null; accroche: Accroche | null; offres: Offres | null };

/** Lignes d'une zone de texte (repli quand field-sizing n'est pas pris en charge) : contenu plus une ligne libre. */
const rowsFor = (s: string, min = 3) => Math.max(min, s.split("\n").length + 1);

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Premier message d'erreur dont le chemin commence par `prefix` (listes : villes.2, formules.site.items.0). */
const errorFor = (errors: FieldErrors, prefix: string) =>
  Object.entries(errors).find(([k]) => k === prefix || k.startsWith(`${prefix}.`))?.[1];

/** Ancienne adresse /site/textes?tab=… : redirigée vers l'écran correspondant. */
export function SiteTextsRedirect() {
  const [params] = useSearchParams();
  const tab = params.get("tab");
  return <Navigate to={tab === "accroche" ? "/site/accroche" : tab === "offres" ? "/site/offres" : "/site/coordonnees"} replace />;
}

/** Chargement commun : les trois textes viennent d'un seul appel. */
function TextScreen<K extends keyof Texts>({
  textKey,
  title,
  subtitle,
  render,
}: {
  textKey: K;
  title: string;
  subtitle: string;
  render: (initial: Texts[K], onSaved: (v: NonNullable<Texts[K]>) => void) => ReactNode;
}) {
  const [texts, setTexts] = useState<Texts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setTexts(await api<Texts>("/api/site/texts"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <LoadState loading={loading} error={error} onRetry={() => void load()}>
        {texts ? render(texts[textKey], (v) => setTexts({ ...texts, [textKey]: v })) : null}
      </LoadState>
    </div>
  );
}

export function SiteContactPage() {
  return (
    <TextScreen
      textKey="infos"
      title="Coordonnées et réseaux"
      subtitle="Comment vous joindre et où vous trouver : ces informations sont reprises sur kouzia.com."
      render={(initial, onSaved) => <InfosForm initial={initial} onSaved={onSaved} />}
    />
  );
}

export function SiteHeroPage() {
  return (
    <TextScreen
      textKey="accroche"
      title="Accroche de l'accueil"
      subtitle="Le grand titre et le texte d'introduction, en haut de la page d'accueil de kouzia.com."
      render={(initial, onSaved) => <AccrocheForm initial={initial} onSaved={onSaved} />}
    />
  );
}

export function SiteOffersPage() {
  return (
    <TextScreen
      textKey="offres"
      title="Offres et tarifs"
      subtitle="Les deux formules de suivi après la mise en ligne (site web, logiciel) et la phrase sur le tarif."
      render={(initial, onSaved) => <OffresForm initial={initial} onSaved={onSaved} />}
    />
  );
}

/** Formulaire d'un document : enregistrement par PUT /api/site/texts/:key, erreurs par champ. */
function useTextForm<T>(key: string, onSaved: (v: T) => void) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  async function save(value: T) {
    setBusy(true);
    setErrors({});
    try {
      const saved = await api<T>(`/api/site/texts/${key}`, { method: "PUT", body: JSON.stringify(value) });
      onSaved(saved);
      toast.success("Enregistré");
    } catch (e) {
      setErrors(fieldErrorsOf(e));
      toast.error(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }
  return { errors, busy, save };
}

/** Carte de formulaire pleine largeur, comme les Réglages ; `columns` : sections côte à côte sur grand écran. */
function FormCard({ onSubmit, busy, columns = false, children }: { onSubmit: (e: FormEvent) => void; busy: boolean; columns?: boolean; children: ReactNode }) {
  return (
    <Card className="p-4 sm:p-6">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <div className={columns ? "grid gap-x-8 gap-y-6 xl:grid-cols-2" : "space-y-4"}>{children}</div>
        <div className="flex justify-end border-t border-[var(--border)] pt-4">
          <Button type="submit" disabled={busy}>
            {busy ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

type InfosDraft = {
  email: string;
  telephone: string;
  delaiReponse: string;
  anneesExperience: string;
  zone: string;
  villes: string;
  github: string;
  instagram: string;
  ficheGoogle: string;
  avisGoogle: string;
};

const infosValue = (f: InfosDraft): Infos => ({ ...f, anneesExperience: Number(f.anneesExperience), villes: lines(f.villes) });
const HTTPS = /^https:\/\/[^\s/]+\.[^\s]+$/;

/** Règles de l'API (infos.json) reprises avant l'envoi. */
function infosErrors(f: InfosDraft): FieldErrors {
  const e: FieldErrors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = "Adresse e-mail complète attendue.";
  if (!/^0\d( \d\d){4}$/.test(f.telephone.trim())) e.telephone = "Téléphone au format 06 12 34 56 78.";
  if (!f.delaiReponse.trim()) e.delaiReponse = "Délai obligatoire (affiché sous le bloc contact).";
  const annees = Number(f.anneesExperience);
  if (f.anneesExperience.trim() === "" || !Number.isInteger(annees) || annees < 0 || annees > 80) e.anneesExperience = "Nombre entier de 0 à 80.";
  if (!f.zone.trim()) e.zone = "Zone obligatoire.";
  if (!lines(f.villes).length) e.villes = "Au moins une ville.";
  for (const k of ["github", "instagram", "ficheGoogle", "avisGoogle"] as const) {
    if (!HTTPS.test(f[k].trim())) e[k] = "Adresse https complète attendue.";
  }
  return e;
}

/** Coordonnées et réseaux : fiche en onglets, enregistrement automatique, aperçu des moyens de contact du site. */
function InfosForm({ initial, onSaved }: { initial: Infos | null; onSaved: (v: Infos) => void }) {
  const doc = useDocumentEditor<InfosDraft, Infos>({
    textKey: "infos",
    initial: {
      email: initial?.email ?? "",
      telephone: initial?.telephone ?? "",
      delaiReponse: initial?.delaiReponse ?? "",
      anneesExperience: initial ? String(initial.anneesExperience) : "",
      zone: initial?.zone ?? "",
      villes: initial?.villes.join("\n") ?? "",
      github: initial?.github ?? "",
      instagram: initial?.instagram ?? "",
      ficheGoogle: initial?.ficheGoogle ?? "",
      avisGoogle: initial?.avisGoogle ?? "",
    },
    toValue: infosValue,
    validate: infosErrors,
    onSaved,
  });
  const { form: f, errorFor } = doc;
  const set = (k: keyof InfosDraft) => (e: { target: { value: string } }) => doc.set(k, e.target.value);

  const joindre = (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Adresse e-mail affichée" error={errorFor("email")}>
          <Input type="email" autoComplete="email" value={f.email} onChange={set("email")} />
        </Field>
        <Field label="Téléphone affiché" hint="Sous la forme 06 12 34 56 78" error={errorFor("telephone")}>
          <Input type="tel" inputMode="tel" autoComplete="tel" value={f.telephone} onChange={set("telephone")} />
        </Field>
      </div>
      <Field label="Délai de réponse annoncé" hint="Exemple : sous 24 à 48 h. Affiché « Réponse sous 24 à 48 h. »" error={errorFor("delaiReponse")}>
        <Input autoComplete="off" value={f.delaiReponse} onChange={set("delaiReponse")} />
      </Field>
    </div>
  );
  const activite = (
    <div className="space-y-4">
      <Field label="Années d'expérience" error={errorFor("anneesExperience")}>
        <Input type="number" inputMode="numeric" min={0} max={80} value={f.anneesExperience} onChange={set("anneesExperience")} />
      </Field>
      <Field label="Zone d'intervention" hint="Une ou deux phrases : sur place et à distance." error={errorFor("zone")}>
        <Textarea rows={3} value={f.zone} onChange={set("zone")} />
      </Field>
      <Field label="Villes mises en avant" hint="Une ville par ligne." error={errorFor("villes")}>
        <Textarea className="field-sizing-content" rows={rowsFor(f.villes)} value={f.villes} onChange={set("villes")} />
      </Field>
    </div>
  );
  const reseaux = (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Profil GitHub" error={errorFor("github")}>
        <Input type="url" inputMode="url" autoComplete="url" value={f.github} onChange={set("github")} />
      </Field>
      <Field label="Compte Instagram" error={errorFor("instagram")}>
        <Input type="url" inputMode="url" autoComplete="url" value={f.instagram} onChange={set("instagram")} />
      </Field>
      <Field label="Fiche Google de l'entreprise" error={errorFor("ficheGoogle")}>
        <Input type="url" inputMode="url" autoComplete="url" value={f.ficheGoogle} onChange={set("ficheGoogle")} />
      </Field>
      <Field label="Lien « Laisser un avis Google »" error={errorFor("avisGoogle")}>
        <Input type="url" inputMode="url" autoComplete="url" value={f.avisGoogle} onChange={set("avisGoogle")} />
      </Field>
    </div>
  );

  return (
    <form noValidate onSubmit={doc.onSubmit}>
      <EditorLayout
        label="Sections des coordonnées"
        tabs={[
          { id: "joindre", label: "Pour vous joindre", content: joindre, errors: doc.count("email", "telephone", "delaiReponse") },
          { id: "activite", label: "Activité", content: activite, errors: doc.count("anneesExperience", "zone", "villes") },
          { id: "reseaux", label: "Réseaux et Google", content: reseaux, errors: doc.count("github", "instagram", "ficheGoogle", "avisGoogle") },
        ]}
        preview={() => (
          <ContactPreview
            email={f.email.trim()}
            telephone={f.telephone.trim()}
            zone={f.zone.trim()}
            delaiReponse={f.delaiReponse.trim()}
            liens={[
              { label: "GitHub", url: f.github.trim() },
              { label: "Instagram", url: f.instagram.trim() },
              { label: "Fiche Google", url: f.ficheGoogle.trim() },
            ]}
          />
        )}
        footer={<EditorFooter auto={doc.auto} creating={false} busy={false} createLabel="" />}
      />
    </form>
  );
}

function AccrocheForm({ initial, onSaved }: { initial: Accroche | null; onSaved: (v: Accroche) => void }) {
  const [f, setF] = useState<Accroche>(() => initial ?? { titre: "", texte: "" });
  const { errors, busy, save } = useTextForm<Accroche>("accroche", onSaved);
  return (
    <FormCard
      busy={busy}
      onSubmit={(e) => {
        e.preventDefault();
        void save(f);
      }}
    >
      <Field label="Grand titre" hint="La première phrase lue sur le site." error={errorFor(errors, "titre")}>
        <Input value={f.titre} onChange={(e) => setF({ ...f, titre: e.target.value })} />
      </Field>
      <Field label="Texte d'introduction" hint="Sous le titre : qui vous êtes, ce que vous faites, où." error={errorFor(errors, "texte")}>
        <Textarea rows={5} value={f.texte} onChange={(e) => setF({ ...f, texte: e.target.value })} />
      </Field>
    </FormCard>
  );
}

type OffresDraft = { siteTitre: string; siteItems: string; logicielTitre: string; logicielItems: string; tarif: string };

const offresValue = (f: OffresDraft): Offres => ({
  formules: {
    site: { titre: f.siteTitre, items: lines(f.siteItems) },
    logiciel: { titre: f.logicielTitre, items: lines(f.logicielItems) },
  },
  tarif: f.tarif,
});

/** Champs obligatoires des offres, signalés avant l'envoi (l'API garde le dernier mot). */
function offresErrors(f: OffresDraft): FieldErrors {
  const e: FieldErrors = {};
  if (!f.siteTitre.trim()) e["formules.site.titre"] = "Titre obligatoire.";
  if (!lines(f.siteItems).length) e["formules.site.items"] = "Au moins un point.";
  if (!f.logicielTitre.trim()) e["formules.logiciel.titre"] = "Titre obligatoire.";
  if (!lines(f.logicielItems).length) e["formules.logiciel.items"] = "Au moins un point.";
  if (!f.tarif.trim()) e.tarif = "Phrase sur le tarif obligatoire.";
  return e;
}

/** Offres : deux formules et le tarif, enregistrés automatiquement, avec l'aperçu de la formule sur le site. */
function OffresForm({ initial, onSaved }: { initial: Offres | null; onSaved: (v: Offres) => void }) {
  const doc = useDocumentEditor<OffresDraft, Offres>({
    textKey: "offres",
    initial: {
      siteTitre: initial?.formules.site.titre ?? "",
      siteItems: initial?.formules.site.items.join("\n") ?? "",
      logicielTitre: initial?.formules.logiciel.titre ?? "",
      logicielItems: initial?.formules.logiciel.items.join("\n") ?? "",
      tarif: initial?.tarif ?? "",
    },
    toValue: offresValue,
    validate: offresErrors,
    onSaved,
  });
  const { form: f, errors, auto } = doc;
  const setF = doc.setForm;
  const set = (k: keyof OffresDraft) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const count = (prefix: string) => doc.count(prefix);
  const value = offresValue(f);

  const formule = (kind: "site" | "logiciel") => (
    <div className="space-y-4">
      <Field label="Titre de la formule" error={errorFor(errors, `formules.${kind}.titre`)}>
        <Input autoComplete="off" value={kind === "site" ? f.siteTitre : f.logicielTitre} onChange={set(kind === "site" ? "siteTitre" : "logicielTitre")} />
      </Field>
      <Field label="Ce qui est compris" hint="Un point par ligne, affiché coché sur le site." error={errorFor(errors, `formules.${kind}.items`)}>
        <Textarea
          className="field-sizing-content"
          rows={rowsFor(kind === "site" ? f.siteItems : f.logicielItems)}
          value={kind === "site" ? f.siteItems : f.logicielItems}
          onChange={set(kind === "site" ? "siteItems" : "logicielItems")}
        />
      </Field>
    </div>
  );

  return (
    <form noValidate onSubmit={doc.onSubmit}>
      <EditorLayout
        label="Sections des offres"
        tabs={[
          { id: "site", label: "Site web", content: formule("site"), errors: count("formules.site") },
          { id: "logiciel", label: "Logiciel", content: formule("logiciel"), errors: count("formules.logiciel") },
          {
            id: "tarif",
            label: "Tarif",
            content: (
              <Field label="Phrase sur le tarif" hint="Affichée sous chaque formule." error={errorFor(errors, "tarif")}>
                <Textarea rows={3} value={f.tarif} onChange={set("tarif")} />
              </Field>
            ),
            errors: count("tarif"),
          },
        ]}
        preview={() => (
          <div className="space-y-4">
            <p className="font-mono text-[0.8125rem] uppercase tracking-[0.14em] text-[var(--muted)]">Page Sites web</p>
            <OfferCardPreview titre={value.formules.site.titre} items={value.formules.site.items} tarif={value.tarif} />
            <p className="font-mono text-[0.8125rem] uppercase tracking-[0.14em] text-[var(--muted)]">Page Logiciels</p>
            <OfferCardPreview titre={value.formules.logiciel.titre} items={value.formules.logiciel.items} tarif={value.tarif} />
          </div>
        )}
        footer={<EditorFooter auto={auto} creating={false} busy={false} createLabel="" />}
      />
    </form>
  );
}
