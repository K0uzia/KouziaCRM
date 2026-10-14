import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button, ButtonLink } from "@/components/ui/Button";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { StatStrip } from "@/components/ui/StatStrip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  fieldErrorsOf,
  ImageField,
  LoadState,
  OrderButtons,
  PROJECT_KIND_LABEL,
  saveOrder,
  SiteImage,
  STATUS_OPTIONS,
  StatusBadge,
  useSiteCollection,
  type FieldErrors,
  type SiteItemStatus,
  type SiteProject,
} from "./shared";

const BASE = "/api/site/projects";

export function SiteProjectsPage() {
  const navigate = useNavigate();
  const { rows, setRows, loading, error, reload } = useSiteCollection<SiteProject>(BASE);
  const move = (id: string, dir: -1 | 1) => void saveOrder(BASE, rows, rows, id, dir, setRows);

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
          <ButtonLink to="/site/realisations/nouvelle">
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouvelle réalisation
          </ButtonLink>
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
      </LoadState>
    </div>
  );
}

const emptyForm = {
  slug: "",
  name: "",
  subtitle: "",
  kind: "WEBSITE" as SiteProject["kind"],
  text: "",
  role: "",
  tech: "",
  url: "https://",
  linkLabel: "Voir le site",
  imagePath: null as string | null,
  imageMobilePath: null as string | null,
  status: "DRAFT" as SiteItemStatus,
};

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

export function SiteProjectPage() {
  const { id = "" } = useParams();
  const creating = id === "nouvelle";
  const navigate = useNavigate();
  const [project, setProject] = useState<SiteProject | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [slugTouched, setSlugTouched] = useState(!creating);
  const [loading, setLoading] = useState(!creating);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    if (creating) return;
    setLoading(true);
    try {
      const all = await api<SiteProject[]>(BASE);
      const p = all.find((r) => r.id === id);
      if (!p) throw new Error("Réalisation introuvable");
      setProject(p);
      setForm({
        slug: p.slug,
        name: p.name,
        subtitle: p.subtitle ?? "",
        kind: p.kind,
        text: p.text,
        role: p.role ?? "",
        tech: p.tech.join(", "),
        url: p.url,
        linkLabel: p.linkLabel,
        imagePath: p.imagePath,
        imageMobilePath: p.imageMobilePath,
        status: p.status,
      });
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Chargement impossible");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.imagePath) {
      setErrors({ imagePath: "Image obligatoire : la carte du site en affiche une." });
      return;
    }
    setBusy(true);
    setErrors({});
    const body = {
      slug: form.slug.trim(),
      name: form.name,
      subtitle: form.subtitle.trim() || null,
      kind: form.kind,
      text: form.text,
      role: form.role.trim() || null,
      tech: form.tech
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      url: form.url.trim(),
      linkLabel: form.linkLabel,
      imagePath: form.imagePath,
      imageMobilePath: form.imageMobilePath,
      status: form.status,
    };
    try {
      if (creating) {
        const created = await api<SiteProject>(BASE, { method: "POST", body: JSON.stringify(body) });
        toast.success("Réalisation créée");
        navigate(`/site/realisations/${created.id}`, { replace: true });
      } else {
        const saved = await api<SiteProject>(`${BASE}/${id}`, { method: "PUT", body: JSON.stringify(body) });
        setProject(saved);
        toast.success("Réalisation enregistrée");
      }
    } catch (err) {
      const fields = fieldErrorsOf(err);
      // tech.2 : erreur sur une technologie, affichée sous le champ unique.
      const flat = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k.split(".")[0]!, v]));
      setErrors(flat);
      toast.error(err instanceof Error ? err.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`${BASE}/${id}`, { method: "DELETE" });
      toast.success("Réalisation supprimée");
      navigate("/site/realisations", { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
      setBusy(false);
      setDeleting(false);
    }
  }

  const slugLocked = Boolean(project?.publishedAt);

  return (
    <div>
      <PageHeader
        back={{ to: "/site/realisations", label: "Réalisations" }}
        title={creating ? "Nouvelle réalisation" : project?.name ?? "Réalisation"}
        subtitle={project ? <StatusBadge row={project} /> : undefined}
      />
      <LoadState loading={loading} error={loadError} onRetry={() => void load()}>
        <form onSubmit={onSubmit} noValidate className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <Card className="space-y-4 p-4 sm:p-6">
            <Field label="Nom" error={errors.name}>
              <Input
                required
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));
                }}
              />
            </Field>
            <Field label="Sous-titre (facultatif)" error={errors.subtitle}>
              <Input value={form.subtitle} onChange={(e) => set("subtitle", e.target.value)} />
            </Field>
            <Field
              label="Identifiant"
              hint={
                slugLocked
                  ? "Publié : l'identifiant ne change plus (le code du site y fait référence)."
                  : "Minuscules, chiffres et tirets. Il ne change plus une fois publié."
              }
              error={errors.slug}
            >
              <Input
                required
                value={form.slug}
                disabled={slugLocked}
                spellCheck={false}
                className="font-mono"
                onChange={(e) => {
                  setSlugTouched(true);
                  set("slug", e.target.value);
                }}
              />
            </Field>
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
              <Textarea required maxLength={400} rows={4} value={form.text} onChange={(e) => set("text", e.target.value)} />
            </Field>
            <Field label="Rôle (facultatif)" hint="Ce que Kouzia a fait sur ce projet." error={errors.role}>
              <Input value={form.role} onChange={(e) => set("role", e.target.value)} />
            </Field>
            <Field label="Technologies (facultatif)" hint="Séparées par des virgules : Astro, TypeScript" error={errors.tech}>
              <Input value={form.tech} onChange={(e) => set("tech", e.target.value)} />
            </Field>
            <Field label="Lien" hint="https obligatoire, vers le site ou la démo (jamais vers le code source)." error={errors.url}>
              <Input required type="url" inputMode="url" value={form.url} onChange={(e) => set("url", e.target.value)} />
            </Field>
            <Field label="Libellé du lien" hint="40 caractères au plus." error={errors.linkLabel}>
              <Input required maxLength={40} value={form.linkLabel} onChange={(e) => set("linkLabel", e.target.value)} />
            </Field>
            <ImageField
              label="Capture d'écran"
              kind="CAPTURE"
              value={form.imagePath}
              onChange={(p) => set("imagePath", p)}
              error={errors.imagePath}
            />
            <ImageField
              label="Capture de téléphone"
              kind="MOBILE"
              optional
              value={form.imageMobilePath}
              onChange={(p) => set("imageMobilePath", p)}
              error={errors.imageMobilePath}
            />
          </Card>

          <div className="space-y-4 lg:sticky lg:top-4">
            <Card className="space-y-4 p-4 sm:p-5">
              <Field label="Statut" hint="« Sur le site » : inclus à la prochaine publication." error={errors.status}>
                <Select value={form.status} onChange={(e) => set("status", e.target.value as SiteItemStatus)}>
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex flex-col gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? "Enregistrement…" : creating ? "Créer la réalisation" : "Enregistrer"}
                </Button>
                {!creating && project && !project.publishedAt ? (
                  <Button variant="danger-ghost" disabled={busy} onClick={() => setDeleting(true)}>
                    Supprimer
                  </Button>
                ) : null}
              </div>
              {project?.publishedAt ? (
                <p className="text-xs text-[var(--muted)]">
                  Déjà publiée : pour l'enlever du site, choisir « Retiré du site » plutôt que la supprimer.
                </p>
              ) : null}
            </Card>
            <ProjectPreview form={form} />
          </div>
        </form>
      </LoadState>
      <ConfirmDialog
        open={deleting}
        title="Supprimer cette réalisation ?"
        message="Elle n'a jamais été publiée : elle disparaît de l'ERP. Les images envoyées restent disponibles."
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}

/** Aperçu du contenu de la carte (texte et images), dans le style de l'ERP et non celui du site. */
function ProjectPreview({ form }: { form: typeof emptyForm }) {
  return (
    <Card className="overflow-hidden" aria-label="Aperçu du contenu">
      <SiteImage path={form.imagePath} alt="Capture d'écran" className="aspect-video w-full" />
      <div className="space-y-2 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--muted)]">Aperçu du contenu</p>
        <p className="font-display text-lg font-semibold leading-tight">{form.name || "Nom de la réalisation"}</p>
        {form.subtitle ? <p className="text-sm text-[var(--muted)]">{form.subtitle}</p> : null}
        <Badge tone="violet">{PROJECT_KIND_LABEL[form.kind]}</Badge>
        <p className="whitespace-pre-line text-sm leading-relaxed">{form.text || "Texte de présentation."}</p>
        {form.linkLabel ? <p className="text-sm font-medium text-[var(--primary)]">{form.linkLabel}</p> : null}
      </div>
    </Card>
  );
}
