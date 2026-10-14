import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { Tabs, useTabParam } from "@/components/ui/Tabs";
import { fieldErrorsOf, LoadState, type FieldErrors } from "./shared";

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

const TABS = [
  { id: "coordonnees", label: "Coordonnées" },
  { id: "accroche", label: "Accroche" },
  { id: "offres", label: "Offres de suivi" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Premier message d'erreur dont le chemin commence par `prefix` (listes : villes.2, formules.site.items.0). */
const errorFor = (errors: FieldErrors, prefix: string) =>
  Object.entries(errors).find(([k]) => k === prefix || k.startsWith(`${prefix}.`))?.[1];

export function SiteTextsPage() {
  const [tab, setTab] = useTabParam(
    TABS.map((t) => t.id),
    "coordonnees",
  );
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
      <PageHeader
        title="Textes et coordonnées"
        subtitle="Textes uniques du site : coordonnées et liens, accroche de l'accueil, offres de suivi. Chaque onglet s'enregistre séparément."
      />
      <LoadState loading={loading} error={error} onRetry={() => void load()}>
        <Tabs label="Textes du site" tabs={TABS} value={tab} onChange={(id: TabId) => setTab(id)}>
          {texts ? (
            tab === "coordonnees" ? (
              <InfosForm initial={texts.infos} onSaved={(infos) => setTexts({ ...texts, infos })} />
            ) : tab === "accroche" ? (
              <AccrocheForm initial={texts.accroche} onSaved={(accroche) => setTexts({ ...texts, accroche })} />
            ) : (
              <OffresForm initial={texts.offres} onSaved={(offres) => setTexts({ ...texts, offres })} />
            )
          ) : null}
        </Tabs>
      </LoadState>
    </div>
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

function FormCard({ onSubmit, busy, children }: { onSubmit: (e: FormEvent) => void; busy: boolean; children: ReactNode }) {
  return (
    <Card className="max-w-3xl p-4 sm:p-6">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {children}
        <div className="flex justify-end border-t border-[var(--border)] pt-4">
          <Button type="submit" disabled={busy}>
            {busy ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </div>
      </form>
    </Card>
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
    <FormCard onSubmit={onSubmit} busy={busy}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="E-mail de contact" error={errorFor(errors, "email")}>
          <Input type="email" autoComplete="off" value={f.email} onChange={set("email")} />
        </Field>
        <Field label="Téléphone" hint="Format 06 12 34 56 78" error={errorFor(errors, "telephone")}>
          <Input type="tel" inputMode="tel" autoComplete="off" value={f.telephone} onChange={set("telephone")} />
        </Field>
        <Field label="Délai de réponse" hint="Ex. : sous 24 à 48 h" error={errorFor(errors, "delaiReponse")}>
          <Input value={f.delaiReponse} onChange={set("delaiReponse")} />
        </Field>
        <Field label="Années d'expérience" error={errorFor(errors, "anneesExperience")}>
          <Input type="number" inputMode="numeric" min={0} max={80} value={f.anneesExperience} onChange={set("anneesExperience")} />
        </Field>
      </div>
      <Field label="Zone d'intervention" error={errorFor(errors, "zone")}>
        <Textarea rows={3} value={f.zone} onChange={set("zone")} />
      </Field>
      <Field label="Villes citées" hint="Une ville par ligne." error={errorFor(errors, "villes")}>
        <Textarea rows={3} value={f.villes} onChange={set("villes")} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="GitHub" error={errorFor(errors, "github")}>
          <Input type="url" inputMode="url" value={f.github} onChange={set("github")} />
        </Field>
        <Field label="Instagram" error={errorFor(errors, "instagram")}>
          <Input type="url" inputMode="url" value={f.instagram} onChange={set("instagram")} />
        </Field>
        <Field label="Fiche Google" error={errorFor(errors, "ficheGoogle")}>
          <Input type="url" inputMode="url" value={f.ficheGoogle} onChange={set("ficheGoogle")} />
        </Field>
        <Field label="Lien « Laisser un avis Google »" error={errorFor(errors, "avisGoogle")}>
          <Input type="url" inputMode="url" value={f.avisGoogle} onChange={set("avisGoogle")} />
        </Field>
      </div>
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
      <Field label="Titre de l'accueil" error={errorFor(errors, "titre")}>
        <Input value={f.titre} onChange={(e) => setF({ ...f, titre: e.target.value })} />
      </Field>
      <Field label="Texte d'introduction" error={errorFor(errors, "texte")}>
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
      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold">Formule « site web »</legend>
        <Field label="Titre" error={errorFor(errors, "formules.site.titre")}>
          <Input value={f.siteTitre} onChange={set("siteTitre")} />
        </Field>
        <Field label="Points inclus" hint="Un point par ligne." error={errorFor(errors, "formules.site.items")}>
          <Textarea rows={5} value={f.siteItems} onChange={set("siteItems")} />
        </Field>
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold">Formule « logiciel »</legend>
        <Field label="Titre" error={errorFor(errors, "formules.logiciel.titre")}>
          <Input value={f.logicielTitre} onChange={set("logicielTitre")} />
        </Field>
        <Field label="Points inclus" hint="Un point par ligne." error={errorFor(errors, "formules.logiciel.items")}>
          <Textarea rows={5} value={f.logicielItems} onChange={set("logicielItems")} />
        </Field>
      </fieldset>
      <Field label="Mention sur le tarif" error={errorFor(errors, "tarif")}>
        <Textarea rows={2} value={f.tarif} onChange={set("tarif")} />
      </Field>
    </FormCard>
  );
}
