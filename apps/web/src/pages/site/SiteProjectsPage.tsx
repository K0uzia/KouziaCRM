import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowsUpDown, faCheck, faPlus } from "@fortawesome/free-solid-svg-icons";
import { Card, PageHeader } from "@/components/ui/Card";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EditorFooter, EditorLayout, useItemEditor } from "./editor";
import { reorderVisible, saveIds, SortableList } from "./sortable";
import { ProjectCardPreview } from "./preview";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { StatStrip } from "@/components/ui/StatStrip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  ImageField,
  LoadState,
  OrderButtons,
  PROJECT_KIND_LABEL,
  saveOrder,
  SiteImage,
  STATUS_OPTIONS,
  StatusBadge,
  TagInput,
  useSiteCollection,
  type FieldErrors,
  type SiteItemStatus,
  type SiteProject,
} from "./shared";

const BASE = "/api/site/projects";

export function SiteProjectsPage() {
  const navigate = useNavigate();
  const { rows, setRows, loading, error, reload } = useSiteCollection<SiteProject>(BASE);
  const move = (id: string, dir: -1 | 1) => void saveOrder(BASE, rows, rows, id, dir, setRows, (p) => p.name);
  const [reordering, setReordering] = useState(false);
  const reorder = (ids: string[]) => void saveIds(BASE, rows, reorderVisible(rows, rows, ids), setRows);

  const columns: DataColumn<SiteProject>[] = [
    {
      name: "Réalisation",
      grow: 3,
      cell: (p) => (
        <div className="flex min-w-0 items-center gap-3 py-2">
          <SiteImage path={p.imagePath} alt="" className="h-10 w-16 shrink-0 rounded-[var(--radius-sm)]" />
          <div className="min-w-0">
            <Link to={`/site/realisations/${p.id}`} className="block truncate font-medium hover:text-[var(--primary)]">
              {p.name}
            </Link>
            <p className="truncate font-mono text-xs text-[var(--muted)]">{p.slug}</p>
          </div>
        </div>
      ),
    },
    { name: "Type", width: "8rem", cell: (p) => PROJECT_KIND_LABEL[p.kind] },
    {
      name: "Mobile",
      width: "7rem",
      showFrom: 1280,
      cell: (p) => (p.imageMobilePath ? "Oui" : <span className="text-[var(--muted)]">Non</span>),
    },
    { name: "Statut", width: "9rem", cell: (p) => <StatusBadge row={p} /> },
    {
      name: "Ordre",
      width: "7rem",
      cell: (p, i) => <OrderButtons name={p.name} first={i === 0} last={i === rows.length - 1} onMove={(d) => move(p.id, d)} />,
    },
  ];

  const count = (s: SiteItemStatus) => rows.filter((r) => r.status === s).length;

  return (
    <div>
      <PageHeader
        title="Réalisations"
        subtitle="Projets montrés sur kouzia.com, dans l'ordre de cette liste. Un lien vers du code source est refusé (charte du site)."
        actions={
          <>
          <Button variant="secondary" aria-pressed={reordering} onClick={() => setReordering((v) => !v)}>
            <FontAwesomeIcon icon={reordering ? faCheck : faArrowsUpDown} className="h-3.5 w-3.5" aria-hidden />
            {reordering ? "Terminer" : "Réorganiser"}
          </Button>
          <ButtonLink to="/site/realisations/nouvelle">
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouvelle réalisation
          </ButtonLink>
          </>
        }
      />
      <LoadState loading={loading} error={error} onRetry={() => void reload()}>
        <StatStrip
          className="mb-4"
          items={[
            { label: "Sur le site", value: count("PUBLISHED"), tone: "success" },
            { label: "Brouillons", value: count("DRAFT") },
            { label: "Retirées", value: count("WITHDRAWN") },
          ]}
        />
        {reordering ? (
          <Card className="p-2 sm:p-3">
            <p className="px-2 pb-2 text-sm text-[var(--muted)]">
              Glisser une réalisation par sa poignée, ou au clavier : Espace pour prendre, flèches pour déplacer, Espace pour poser. L'ordre est enregistré à chaque déplacement et suit au site à la prochaine publication.
            </p>
            <SortableList
              items={rows}
              name={(p) => p.name}
              onReorder={reorder}
              render={(p) => (
                <span className="flex min-w-0 items-center gap-3">
                  <SiteImage path={p.imagePath} alt="" className="hidden h-9 w-14 shrink-0 rounded-[var(--radius-sm)] sm:block" />
                  <span className="line-clamp-2 min-w-0 break-words font-medium">{p.name}</span>
                </span>
              )}
            />
          </Card>
        ) : (
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={rows}
            onRowClick={(p) => navigate(`/site/realisations/${p.id}`)}
            countLabel={rows.length > 1 ? "réalisations" : "réalisation"}
            emptyTitle="Aucune réalisation"
            emptyHint="Ajoutez-en une, ou reprenez le contenu actuel du site depuis « Connexion au dépôt »."
            renderMobileCard={(p, i) => (
              <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5">
                <Link to={`/site/realisations/${p.id}`} className="flex min-h-11 min-w-0 flex-1 items-center gap-3">
                  <SiteImage path={p.imagePath} alt="" className="h-10 w-14 shrink-0 rounded-[var(--radius-sm)]" />
                  <span className="min-w-0">
                    <span className="line-clamp-2 break-words font-medium">{p.name}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
                      <StatusBadge row={p} />
                      {PROJECT_KIND_LABEL[p.kind]}
                    </span>
                  </span>
                </Link>
                <OrderButtons name={p.name} first={i === 0} last={i === rows.length - 1} onMove={(d) => move(p.id, d)} />
              </div>
            )}
          />
        </Card>
        )}
      </LoadState>
    </div>
  );
}

const emptyForm = {
  slug: "",
  name: "",
  subtitle: "",
  mention: "",
  kind: "WEBSITE" as SiteProject["kind"],
  text: "",
  role: "",
  tech: [] as string[],
  url: "https://",
  linkLabel: "Voir le site",
  imagePath: null as string | null,
  imageMobilePath: null as string | null,
  status: "DRAFT" as SiteItemStatus,
};
type ProjectForm = typeof emptyForm;

/** Identifiant publié depuis le nom : minuscules sans accents, chiffres et tirets. */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function projectBody(form: ProjectForm) {
  return {
    slug: form.slug.trim(),
    name: form.name,
    subtitle: form.subtitle.trim() || null,
    mention: form.mention.trim() || null,
    kind: form.kind,
    text: form.text,
    role: form.role.trim() || null,
    tech: form.tech,
    url: form.url.trim(),
    linkLabel: form.linkLabel,
    imagePath: form.imagePath,
    imageMobilePath: form.imageMobilePath,
    status: form.status,
  };
}

/** Champs obligatoires vérifiés avant l'envoi (l'API garde le dernier mot). */
function projectErrors(form: ProjectForm): FieldErrors {
  const e: FieldErrors = {};
  if (!form.name.trim()) e.name = "Nom obligatoire.";
  if (!form.slug.trim()) e.slug = "Identifiant obligatoire.";
  if (!form.text.trim()) e.text = "Texte obligatoire.";
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(form.url.trim())) e.url = "Adresse https complète attendue (https://exemple.fr).";
  if (!form.linkLabel.trim()) e.linkLabel = "Libellé obligatoire.";
  if (!form.imagePath) e.imagePath = "Image obligatoire : la carte du site en affiche une.";
  return e;
}

const TAB_FIELDS = {
  contenu: ["name", "subtitle", "mention", "kind", "text", "role", "tech"],
  images: ["imagePath", "imageMobilePath"],
  lien: ["url", "linkLabel", "slug"],
  publication: ["status"],
} as const;

export function SiteProjectPage() {
  const { id = "" } = useParams();
  const creating = id === "nouvelle";
  const [slugTouched, setSlugTouched] = useState(!creating);
  const [deleting, setDeleting] = useState(false);
  const ed = useItemEditor<SiteProject, ProjectForm>({
    base: BASE,
    id,
    creating,
    empty: emptyForm,
    toForm: (p) => ({
      slug: p.slug,
      name: p.name,
      subtitle: p.subtitle ?? "",
      mention: p.mention ?? "",
      kind: p.kind,
      text: p.text,
      role: p.role ?? "",
      tech: p.tech,
      url: p.url,
      linkLabel: p.linkLabel,
      imagePath: p.imagePath,
      imageMobilePath: p.imageMobilePath,
      status: p.status,
    }),
    toBody: projectBody,
    validate: projectErrors,
    itemPath: (p) => `/site/realisations/${p.id}`,
    listPath: "/site/realisations",
    labels: { created: "Réalisation créée : la suite s'enregistre toute seule", deleted: "Réalisation supprimée", notFound: "Réalisation introuvable" },
  });
  const { form, set, setForm, errors, busy, auto, item: project } = ed;
  const remove = () => ed.remove().catch(() => setDeleting(false));
  const slugLocked = Boolean(project?.publishedAt);
  const countErrors = ed.countErrors;

  const contenu = (
    <div className="space-y-4">
      <Field label="Nom" error={errors.name}>
        <Input
          required
          maxLength={80}
          autoComplete="off"
          value={form.name}
          onChange={(e) => {
            const name = e.target.value;
            setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));
          }}
        />
      </Field>
      <Field label="Sous-titre (facultatif)" error={errors.subtitle}>
        <Input autoComplete="off" value={form.subtitle} onChange={(e) => set("subtitle", e.target.value)} />
      </Field>
      <Field
        label="Mention sous le projet (facultatif)"
        hint={`Ex. : Développé par Kouzia au sein de La Capsule. ${form.mention.length} / 60 caractères`}
        error={errors.mention}
      >
        <Input maxLength={60} autoComplete="off" value={form.mention} onChange={(e) => set("mention", e.target.value)} />
      </Field>
      {form.mention.trim() && form.role.trim() ? (
        // Les deux s'affichent sur la carte : signaler un doublon possible (ex. « Réalisé dans le cadre de… »).
        <p className="-mt-2 text-xs text-[var(--warning)]" aria-live="polite">
          Le rôle est aussi rempli : les deux paraissent sur la carte. Videz l'un des deux s'ils disent la même chose.
        </p>
      ) : null}
      <div className="space-y-1.5">
        <p className="text-sm font-medium" aria-hidden>
          Type
        </p>
        <Segmented
          className="w-full max-w-sm"
          label="Type de réalisation"
          value={form.kind}
          onChange={(k) => set("kind", k)}
          options={[
            { id: "WEBSITE", label: PROJECT_KIND_LABEL.WEBSITE },
            { id: "SOFTWARE", label: PROJECT_KIND_LABEL.SOFTWARE },
          ]}
        />
      </div>
      <Field label="Texte" hint={`${form.text.length} / 400 caractères`} error={errors.text}>
        <Textarea required maxLength={400} rows={5} value={form.text} onChange={(e) => set("text", e.target.value)} />
      </Field>
      <Field label="Rôle (facultatif)" hint="Ce que Kouzia a fait sur ce projet." error={errors.role}>
        <Input autoComplete="off" value={form.role} onChange={(e) => set("role", e.target.value)} />
      </Field>
      <TagInput
        label="Technologies (facultatif)"
        hint="Entrée ou virgule pour ajouter, 12 au plus ; Retour arrière sur le champ vide retire la dernière."
        error={errors.tech}
        values={form.tech}
        onChange={(v) => set("tech", v)}
      />
    </div>
  );

  const images = (
    <div className="space-y-6">
      <ImageField label="Capture d'écran" kind="CAPTURE" value={form.imagePath} onChange={(p) => set("imagePath", p)} error={errors.imagePath} />
      <ImageField
        label="Capture de téléphone"
        kind="MOBILE"
        optional
        value={form.imageMobilePath}
        onChange={(p) => set("imageMobilePath", p)}
        error={errors.imageMobilePath}
      />
    </div>
  );

  const lien = (
    <div className="space-y-4">
      <Field label="Lien" hint="https obligatoire, vers le site ou la démo (jamais vers le code source)." error={errors.url}>
        <Input required type="url" inputMode="url" autoComplete="url" value={form.url} onChange={(e) => set("url", e.target.value)} />
      </Field>
      <Field label="Libellé du lien" hint={`${form.linkLabel.length} / 40 caractères`} error={errors.linkLabel}>
        <Input required maxLength={40} autoComplete="off" value={form.linkLabel} onChange={(e) => set("linkLabel", e.target.value)} />
      </Field>
      <Field
        label="Identifiant"
        hint={
          slugLocked
            ? "Publié : l'identifiant ne change plus (le code du site y fait référence)."
            : "Minuscules, chiffres et tirets, tiré du nom. Il ne change plus une fois publié."
        }
        error={errors.slug}
      >
        <Input
          required
          value={form.slug}
          disabled={slugLocked}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          onChange={(e) => {
            setSlugTouched(true);
            set("slug", e.target.value);
          }}
        />
      </Field>
    </div>
  );

  const publication = (
    <div className="space-y-4">
      <Field label="Statut" hint="« Sur le site » : inclus à la prochaine publication (bouton Publier en haut)." error={errors.status}>
        <Select value={form.status} onChange={(e) => set("status", e.target.value as SiteItemStatus)}>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      {project?.publishedAt ? (
        <p className="text-sm text-[var(--muted)]">Déjà publiée : pour l'enlever du site, choisir « Retiré du site » plutôt que la supprimer.</p>
      ) : !creating && project ? (
        <Button variant="danger-ghost" disabled={busy} onClick={() => setDeleting(true)}>
          Supprimer la réalisation
        </Button>
      ) : null}
    </div>
  );

  return (
    <div>
      <PageHeader
        back={{ to: "/site/realisations", label: "Réalisations" }}
        title={creating ? "Nouvelle réalisation" : project?.name ?? "Réalisation"}
        subtitle={project ? <StatusBadge row={project} /> : undefined}
      />
      <LoadState loading={ed.loading} error={ed.loadError} onRetry={() => void ed.load()}>
        <form onSubmit={ed.onSubmit} noValidate>
          <EditorLayout
            label="Sections de la réalisation"
            tabs={[
              { id: "contenu", label: "Contenu", content: contenu, errors: countErrors(TAB_FIELDS.contenu) },
              { id: "images", label: "Images", content: images, errors: countErrors(TAB_FIELDS.images) },
              { id: "lien", label: "Lien", content: lien, errors: countErrors(TAB_FIELDS.lien) },
              { id: "publication", label: "Publication", content: publication, errors: countErrors(TAB_FIELDS.publication) },
            ]}
            preview={(device) => (
              <ProjectCardPreview
                device={device}
                p={{ ...form, kindLabel: PROJECT_KIND_LABEL[form.kind] }}
              />
            )}
            footer={<EditorFooter auto={auto} creating={creating} busy={busy} createLabel="Créer la réalisation" />}
          />
        </form>
      </LoadState>
      <ConfirmDialog
        open={deleting}
        title="Supprimer cette réalisation ?"
        message="Elle n'a jamais été publiée : elle disparaît de l'ERP. Les images envoyées restent dans la médiathèque."
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}
