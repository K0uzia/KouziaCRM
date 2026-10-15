import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { fieldErrorsOf, LoadState, type FieldErrors } from "./shared";

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

function Section({ title, wide = false, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <fieldset className={`min-w-0 space-y-4${wide ? " xl:col-span-2" : ""}`}>
      <legend className="text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function InfosForm({ initial, onSaved }: { initial: Infos | null; onSaved: (v: Infos) => void }) {
  const [f, setF] = useState(() => ({
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
  }));
  const { errors, busy, save } = useTextForm<Infos>("infos", onSaved);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void save({ ...f, anneesExperience: Number(f.anneesExperience), villes: lines(f.villes) });
  };
  return (
    <FormCard onSubmit={onSubmit} busy={busy} columns>
      <Section title="Pour vous joindre">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Adresse e-mail affichée" error={errorFor(errors, "email")}>
            <Input type="email" autoComplete="off" value={f.email} onChange={set("email")} />
          </Field>
          <Field label="Téléphone affiché" hint="Sous la forme 06 12 34 56 78" error={errorFor(errors, "telephone")}>
            <Input type="tel" inputMode="tel" autoComplete="off" value={f.telephone} onChange={set("telephone")} />
          </Field>
        </div>
        <Field label="Délai de réponse annoncé" hint="Exemple : sous 24 à 48 h" error={errorFor(errors, "delaiReponse")}>
          <Input value={f.delaiReponse} onChange={set("delaiReponse")} />
        </Field>
      </Section>
      <Section title="Votre activité">
        <Field label="Années d'expérience" error={errorFor(errors, "anneesExperience")}>
          <Input type="number" inputMode="numeric" min={0} max={80} value={f.anneesExperience} onChange={set("anneesExperience")} />
        </Field>
        <Field label="Zone d'intervention" hint="Une ou deux phrases : sur place et à distance." error={errorFor(errors, "zone")}>
          <Textarea rows={3} value={f.zone} onChange={set("zone")} />
        </Field>
        <Field label="Villes mises en avant" hint="Une ville par ligne." error={errorFor(errors, "villes")}>
          <Textarea className="field-sizing-content" rows={rowsFor(f.villes)} value={f.villes} onChange={set("villes")} />
        </Field>
      </Section>
      <Section title="Réseaux et Google" wide>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Profil GitHub" error={errorFor(errors, "github")}>
            <Input type="url" inputMode="url" value={f.github} onChange={set("github")} />
          </Field>
          <Field label="Compte Instagram" error={errorFor(errors, "instagram")}>
            <Input type="url" inputMode="url" value={f.instagram} onChange={set("instagram")} />
          </Field>
          <Field label="Fiche Google de l'entreprise" error={errorFor(errors, "ficheGoogle")}>
            <Input type="url" inputMode="url" value={f.ficheGoogle} onChange={set("ficheGoogle")} />
          </Field>
          <Field label="Lien « Laisser un avis Google »" error={errorFor(errors, "avisGoogle")}>
            <Input type="url" inputMode="url" value={f.avisGoogle} onChange={set("avisGoogle")} />
          </Field>
        </div>
      </Section>
    </FormCard>
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

function OffresForm({ initial, onSaved }: { initial: Offres | null; onSaved: (v: Offres) => void }) {
  const [f, setF] = useState(() => ({
    siteTitre: initial?.formules.site.titre ?? "",
    siteItems: initial?.formules.site.items.join("\n") ?? "",
    logicielTitre: initial?.formules.logiciel.titre ?? "",
    logicielItems: initial?.formules.logiciel.items.join("\n") ?? "",
    tarif: initial?.tarif ?? "",
  }));
  const { errors, busy, save } = useTextForm<Offres>("offres", onSaved);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <FormCard
      busy={busy}
      columns
      onSubmit={(e) => {
        e.preventDefault();
        void save({
          formules: {
            site: { titre: f.siteTitre, items: lines(f.siteItems) },
            logiciel: { titre: f.logicielTitre, items: lines(f.logicielItems) },
          },
          tarif: f.tarif,
        });
      }}
    >
      <Section title="Suivi d'un site web">
        <Field label="Titre de la formule" error={errorFor(errors, "formules.site.titre")}>
          <Input value={f.siteTitre} onChange={set("siteTitre")} />
        </Field>
        <Field label="Ce qui est compris" hint="Un point par ligne." error={errorFor(errors, "formules.site.items")}>
          <Textarea className="field-sizing-content" rows={rowsFor(f.siteItems)} value={f.siteItems} onChange={set("siteItems")} />
        </Field>
      </Section>
      <Section title="Suivi d'un logiciel ou d'une application">
        <Field label="Titre de la formule" error={errorFor(errors, "formules.logiciel.titre")}>
          <Input value={f.logicielTitre} onChange={set("logicielTitre")} />
        </Field>
        <Field label="Ce qui est compris" hint="Un point par ligne." error={errorFor(errors, "formules.logiciel.items")}>
          <Textarea className="field-sizing-content" rows={rowsFor(f.logicielItems)} value={f.logicielItems} onChange={set("logicielItems")} />
        </Field>
      </Section>
      <div className="xl:col-span-2">
        <Field label="Phrase sur le tarif" hint="Affichée sous les deux formules." error={errorFor(errors, "tarif")}>
          <Textarea rows={2} value={f.tarif} onChange={set("tarif")} />
        </Field>
      </div>
    </FormCard>
  );
}
