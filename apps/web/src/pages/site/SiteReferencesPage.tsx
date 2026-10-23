import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowsUpDown, faCheck, faPlus } from "@fortawesome/free-solid-svg-icons";
import { useCreateParam } from "@/lib/use-create-param";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button, ButtonLink } from "@/components/ui/Button";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { DateInput, Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Banner } from "@/components/ui/Banner";
import { FilterSegment } from "@/components/ui/ListFilters";
import { useUrlFilters } from "@/lib/use-url-filters";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { slugify } from "./SiteProjectsPage";
import { EditorFooter, EditorLayout, useItemEditor } from "./editor";
import { LogoTilePreview } from "./preview";
import { reorderVisible, saveIds, SortableList } from "./sortable";
import {
  Checkbox,
  dateToIso,
  ImageField,
  isoToDate,
  LoadState,
  OrderButtons,
  REFERENCE_TYPE_LABEL,
  saveOrder,
  SCOPE_LABEL,
  SiteImage,
  STATUS_OPTIONS,
  StatusBadge,
  useSiteCollection,
  type FieldErrors,
  type SiteAuthorizationScope,
  type SiteItemStatus,
  type SiteProject,
  type SiteReference,
  type SiteReferenceType,
} from "./shared";

const BASE = "/api/site/references";

const emptyForm = {
  slug: "",
  type: "CLIENT" as SiteReferenceType,
  name: "",
  logoPath: null as string | null,
  logoAlt: "",
  url: "",
  productSlug: "",
  testimonialText: "",
  testimonialAuthor: "",
  testimonialRole: "",
  authorizationAt: "",
  authorizationChannel: "",
  authorizationScope: "NAME_LOGO" as SiteAuthorizationScope | "",
  contact: "",
  onHome: true,
  onProjects: false,
  status: "DRAFT" as SiteItemStatus,
};

const PLACEMENT_LABEL = { onHome: "Bandeau de l'accueil", onProjects: "Sous les réalisations" } as const;

const TYPE_SLUG = { toutes: "all", clients: "CLIENT", partenaires: "PARTNER", utilisateurs: "USER" } as const;
const SLUG_OF: Record<"all" | SiteReferenceType, string | null> = { all: null, CLIENT: "clients", PARTNER: "partenaires", USER: "utilisateurs" };
/** Référence en ligne que l'autorisation enregistrée ne couvre pas (nom, logo ou témoignage affiché sans accord). */
const unauthorizedOnline = (r: SiteReference) => r.status === "PUBLISHED" && authorizationGap(r) !== null;

/** Ce que l'autorisation enregistrée ne couvre pas (même règle que l'API, affichée avant l'envoi). */
export function authorizationGap(r: {
  authorizationAt: string | null;
  authorizationScope: SiteAuthorizationScope | null | "";
  logoPath: string | null;
  testimonialText: string | null;
}): string | null {
  if (!r.authorizationAt || !r.authorizationScope) return "Autorisation manquante";
  if (r.logoPath && r.authorizationScope === "NAME") return "Logo non autorisé";
  if (r.testimonialText && r.authorizationScope !== "TESTIMONIAL") return "Témoignage non autorisé";
  return null;
}

export function SiteReferencesPage() {
  const { rows, setRows, loading, error, reload } = useSiteCollection<SiteReference>(BASE);
  const projects = useSiteCollection<SiteProject>("/api/site/projects");
  const filters = useUrlFilters();
  const filter = TYPE_SLUG[filters.pick("type", ["toutes", "clients", "partenaires", "utilisateurs"] as const, "toutes")];
  const gaps = rows.filter(unauthorizedOnline).length;
  const gapsOnly = gaps > 0 && filters.params.get("autorisation") === "manquante";
  const navigate = useNavigate();
  useCreateParam(() => navigate("/site/references/nouvelle", { replace: true }));

  const visible = rows.filter((r) => (filter === "all" || r.type === filter) && (!gapsOnly || unauthorizedOnline(r)));
  const move = (id: string, dir: -1 | 1) => void saveOrder(BASE, rows, visible, id, dir, setRows, (r) => r.name);
  const [reordering, setReordering] = useState(false);
  const reorder = (ids: string[]) => void saveIds(BASE, rows, reorderVisible(rows, visible, ids), setRows);
  const productName = (slug: string | null) => projects.rows.find((p) => p.slug === slug)?.name ?? slug;

  const columns: DataColumn<SiteReference>[] = [
    {
      name: "Référence",
      grow: 3,
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-3 py-2">
          <SiteImage path={r.logoPath} alt="" className="h-10 w-16 shrink-0 rounded-[var(--radius-sm)] object-contain" />
          <div className="min-w-0">
            <Link to={`/site/references/${r.id}`} className="block max-w-full truncate font-medium hover:text-[var(--primary)]">
              {r.name}
            </Link>
            <p className="truncate text-xs text-[var(--muted)]">
              {r.type === "USER" && r.productSlug ? `Utilise ${productName(r.productSlug)}` : r.slug}
            </p>
          </div>
        </div>
      ),
    },
    { name: "Type", width: "8rem", cell: (r) => REFERENCE_TYPE_LABEL[r.type] },
    {
      name: "Emplacements",
      width: "11rem",
      showFrom: 1280,
      cell: (r) =>
        r.type === "USER"
          ? "-"
          : (["onHome", "onProjects"] as const).filter((k) => r[k]).map((k) => PLACEMENT_LABEL[k]).join(", ") || "Aucun",
    },
    {
      name: "Autorisation",
      width: "12rem",
      cell: (r) => {
        const gap = authorizationGap(r);
        return gap ? <Badge tone={r.status === "PUBLISHED" ? "red" : "neutral"}>{gap}</Badge> : <span className="text-sm">{SCOPE_LABEL[r.authorizationScope!]}</span>;
      },
    },
    { name: "Statut", width: "9rem", cell: (r) => <StatusBadge row={r} /> },
    {
      name: "Ordre",
      width: "7rem",
      cell: (r, i) => <OrderButtons name={r.name} first={i === 0} last={i === visible.length - 1} onMove={(d) => move(r.id, d)} />,
    },
  ];

  const count = (t: SiteReferenceType) => rows.filter((r) => r.type === t).length;

  return (
    <div>
      <PageHeader
        title="Références"
        subtitle="Le mur de logos « Ils m'ont fait confiance » : chaque logo mène au site de la structure. Un logo ne paraît qu'avec son autorisation écrite."
        actions={
          <>
          <Button variant="secondary" aria-pressed={reordering} onClick={() => setReordering((v) => !v)}>
            <FontAwesomeIcon icon={reordering ? faCheck : faArrowsUpDown} className="h-3.5 w-3.5" aria-hidden />
            {reordering ? "Terminer" : "Réorganiser"}
          </Button>
          <ButtonLink to="/site/references/nouvelle">
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouvelle référence
          </ButtonLink>
          </>
        }
      />
      <LoadState loading={loading} error={error} onRetry={() => void reload()}>
        {gaps ? (
          <Banner
            level="error"
            className="mb-4"
            action={
              <Link to={gapsOnly ? "?" : "?autorisation=manquante"} replace className="link inline-flex min-h-11 items-center text-sm font-medium">
                {gapsOnly ? "Afficher toutes les références" : gaps > 1 ? "Afficher ces références" : "Afficher cette référence"}
              </Link>
            }
          >
            {gaps > 1 ? `${gaps} références en ligne ne sont pas couvertes` : "1 référence en ligne n'est pas couverte"} par l'autorisation enregistrée (nom, logo ou témoignage).
          </Banner>
        ) : null}
        {reordering ? (
          <Card className="p-2 sm:p-3">
            <p className="px-2 pb-2 text-sm text-[var(--muted)]">
              Glisser une référence par sa poignée, ou au clavier : Espace pour prendre, flèches pour déplacer, Espace pour poser. L'ordre est enregistré à chaque déplacement et suit au site à la prochaine publication.
            </p>
            <SortableList
              items={visible}
              name={(r) => r.name}
              onReorder={reorder}
              render={(r) => (
                <span className="flex min-w-0 items-center gap-3">
                  <SiteImage path={r.logoPath} alt="" className="hidden h-9 w-14 shrink-0 rounded-[var(--radius-sm)] object-contain sm:block" />
                  <span className="line-clamp-2 min-w-0 break-words font-medium">{r.name}</span>
                </span>
              )}
            />
          </Card>
        ) : (
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={visible}
            onRowClick={(r) => navigate(`/site/references/${r.id}`)}
            countLabel={visible.length > 1 ? "références" : "référence"}
            emptyTitle={
              filter === "CLIENT"
                ? "Aucun client pour l'instant"
                : filter === "PARTNER"
                  ? "Aucun partenaire pour l'instant"
                  : filter === "USER"
                    ? "Aucun utilisateur"
                    : "Aucune référence pour l'instant"
            }
            emptyHint="Ajoutez une structure qui vous a fait confiance, avec son logo et son accord écrit."
            toolbar={
              <FilterSegment
                label="Type"
                value={filter}
                onChange={(t) => filters.set({ type: SLUG_OF[t] })}
                options={[
                  { id: "all", label: "Toutes", count: rows.length },
                  { id: "CLIENT", label: "Clients", count: count("CLIENT") },
                  { id: "PARTNER", label: "Partenaires", count: count("PARTNER") },
                  // Ancien type « Ils l'utilisent » : affiché seulement s'il en reste.
                  ...(count("USER") ? [{ id: "USER" as const, label: "Utilisateurs", count: count("USER") }] : []),
                ]}
              />
            }
            renderMobileCard={(r, i) => (
              <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5">
                <Link to={`/site/references/${r.id}`} className="flex min-h-11 min-w-0 flex-1 items-center gap-3">
                  <SiteImage path={r.logoPath} alt="" className="h-10 w-14 shrink-0 rounded-[var(--radius-sm)] object-contain" />
                  <span className="min-w-0">
                    <span className="line-clamp-2 break-words font-medium">{r.name}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
                      <StatusBadge row={r} />
                      {REFERENCE_TYPE_LABEL[r.type]}
                    </span>
                  </span>
                </Link>
                <OrderButtons name={r.name} first={i === 0} last={i === visible.length - 1} onMove={(d) => move(r.id, d)} />
              </div>
            )}
          />
        </Card>
        )}
      </LoadState>
    </div>
  );
}

type ReferenceForm = typeof emptyForm;

/** Règles de l'API reprises avant l'envoi (mur de logos, témoignage complet, autorisation couvrant ce qui est publié). */
function referenceErrors(form: ReferenceForm): FieldErrors {
  const local: FieldErrors = {};
  if (!form.name.trim()) local.name = "Nom obligatoire.";
  if (!form.slug.trim()) local.slug = "Identifiant obligatoire.";
  if (form.url.trim() && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(form.url.trim())) local.url = "Adresse https complète attendue (https://exemple.fr).";
  if (form.type === "USER" && !form.productSlug) local.productSlug = "Produit obligatoire pour « Ils l'utilisent ».";
  if (form.status === "PUBLISHED" && form.type !== "USER") {
    if (!form.url.trim()) local.url = "Lien requis : chaque logo mène au site de la structure.";
    if (!form.logoPath) local.logoPath = "Logo requis pour le mur de logos.";
    if (!form.onHome && !form.onProjects) local.placement = "Choisir au moins un emplacement.";
  }
  if (form.status === "PUBLISHED") {
    const gap = authorizationGap({
      authorizationAt: form.authorizationAt || null,
      authorizationScope: form.authorizationScope,
      logoPath: form.logoPath,
      testimonialText: form.testimonialText.trim() || null,
    });
    if (gap) local.authorizationScope = `${gap} : impossible de mettre la référence sur le site.`;
  }
  return local;
}

/** Témoignage de la structure : plus saisi (le site ne l'affiche pas), une valeur déjà enregistrée repart telle quelle. */
function referenceBody(form: ReferenceForm) {
  const hasTestimonial = Boolean(form.testimonialText.trim() || form.testimonialAuthor.trim());
  return {
    slug: form.slug.trim(),
    type: form.type,
    name: form.name,
    logoPath: form.logoPath,
    logoAlt: form.logoAlt.trim() || null,
    url: form.url.trim() || null,
    productSlug: form.productSlug || null,
    testimonial: hasTestimonial ? { text: form.testimonialText, author: form.testimonialAuthor, role: form.testimonialRole.trim() || null } : null,
    authorizationAt: dateToIso(form.authorizationAt),
    authorizationChannel: form.authorizationChannel.trim() || null,
    authorizationScope: form.authorizationScope || null,
    contact: form.contact.trim() || null,
    onHome: form.onHome,
    onProjects: form.onProjects,
    status: form.status,
  };
}

export function SiteReferencePage() {
  const { id = "" } = useParams();
  const creating = id === "nouvelle";
  const projects = useSiteCollection<SiteProject>("/api/site/projects");
  const [slugTouched, setSlugTouched] = useState(!creating);
  const [deleting, setDeleting] = useState(false);
  const ed = useItemEditor<SiteReference, ReferenceForm>({
    base: BASE,
    id,
    creating,
    empty: emptyForm,
    toForm: (r) => ({
      slug: r.slug,
      type: r.type,
      name: r.name,
      logoPath: r.logoPath,
      logoAlt: r.logoAlt ?? "",
      url: r.url ?? "",
      productSlug: r.productSlug ?? "",
      testimonialText: r.testimonialText ?? "",
      testimonialAuthor: r.testimonialAuthor ?? "",
      testimonialRole: r.testimonialRole ?? "",
      authorizationAt: isoToDate(r.authorizationAt),
      authorizationChannel: r.authorizationChannel ?? "",
      authorizationScope: r.authorizationScope ?? "",
      contact: r.contact ?? "",
      onHome: r.onHome,
      onProjects: r.onProjects,
      status: r.status,
    }),
    toBody: referenceBody,
    validate: referenceErrors,
    errorKey: (k) => (k.startsWith("testimonial") ? "testimonial" : k.split(".")[0]!),
    itemPath: (r) => `/site/references/${r.id}`,
    listPath: "/site/references",
    labels: { created: "Référence créée : la suite s'enregistre toute seule", deleted: "Référence supprimée", notFound: "Référence introuvable" },
  });
  const { form, set, setForm, errors, item } = ed;

  const structure = (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nom" error={errors.name}>
          <Input
            required
            autoComplete="organization"
            value={form.name}
            onChange={(e) => {
              const name = e.target.value;
              setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));
            }}
          />
        </Field>
        <Field label="Type" error={errors.type}>
          <Select value={form.type} onChange={(e) => set("type", e.target.value as SiteReferenceType)}>
            {(Object.keys(REFERENCE_TYPE_LABEL) as SiteReferenceType[])
              .filter((t) => t !== "USER" || form.type === "USER")
              .map((t) => (
                <option key={t} value={t}>
                  {REFERENCE_TYPE_LABEL[t]}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <Field label="Site de la structure" hint="Adresse https : le logo y mène." error={errors.url}>
        <Input type="url" inputMode="url" autoComplete="url" value={form.url} onChange={(e) => set("url", e.target.value)} />
      </Field>
      <Field
        label={form.type === "USER" ? "Produit utilisé" : "Réalisation liée (facultatif)"}
        hint={form.type === "USER" ? "Une des réalisations du site." : "Si vous avez fait leur site ou leur logiciel : un lien « voir le projet »."}
        error={errors.productSlug}
      >
        <Select value={form.productSlug} onChange={(e) => set("productSlug", e.target.value)}>
          <option value="">{form.type === "USER" ? "Choisir…" : "Aucune"}</option>
          {projects.rows.map((p) => (
            <option key={p.id} value={p.slug}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Identifiant" hint="Minuscules, chiffres et tirets, tiré du nom." error={errors.slug}>
        <Input
          required
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          value={form.slug}
          onChange={(e) => {
            setSlugTouched(true);
            set("slug", e.target.value);
          }}
        />
      </Field>
    </div>
  );

  const logo = (
    <div className="space-y-4">
      <ImageField label="Logo" kind="LOGO" optional={form.type === "USER"} value={form.logoPath} onChange={(p) => set("logoPath", p)} error={errors.logoPath} />
      <Field
        label="Texte alternatif du logo (facultatif)"
        hint={`Vide : le nom de la structure. Le logo est le nom du lien vers son site : jamais vide, l'écrire comme un nom (ex. « La Capsule, Morlaix »). ${form.logoAlt.length} / 120`}
        error={errors.logoAlt}
      >
        <Input maxLength={120} autoComplete="off" value={form.logoAlt} placeholder={form.name || "Nom de la structure"} onChange={(e) => set("logoAlt", e.target.value)} />
      </Field>
      <fieldset className="space-y-1 rounded-[var(--radius)] border border-[var(--border)] p-4" aria-describedby={errors.placement ? "placement-err" : undefined}>
        <legend className="px-1 text-sm font-medium">Où afficher le logo</legend>
        <p className="text-xs text-[var(--muted)]">
          Sur les pages Sites web et Logiciels, la référence apparaît d'elle-même si elle est liée à une réalisation de ce type (onglet Structure).
        </p>
        <Checkbox label="Bandeau de l'accueil" hint="« Ils m'ont fait confiance »." checked={form.onHome} onChange={(v) => set("onHome", v)} />
        <Checkbox label="Sous les réalisations, sur l'accueil" checked={form.onProjects} onChange={(v) => set("onProjects", v)} />
        {errors.placement ? (
          <p id="placement-err" className="text-sm text-[var(--danger)]">
            {errors.placement}
          </p>
        ) : null}
      </fieldset>
    </div>
  );

  const autorisation = (
    <div className="space-y-4">
      <fieldset className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-4">
        <legend className="px-1 text-sm font-medium">Autorisation écrite (jamais publiée)</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date de l'autorisation" error={errors.authorizationAt}>
            <DateInput value={form.authorizationAt} onChange={(v) => set("authorizationAt", v)} />
          </Field>
          <Field label="Canal" hint="E-mail, courrier, contrat…" error={errors.authorizationChannel}>
            <Input autoComplete="off" value={form.authorizationChannel} onChange={(e) => set("authorizationChannel", e.target.value)} />
          </Field>
        </div>
        <Field label="Ce qui est autorisé" error={errors.authorizationScope}>
          <Select value={form.authorizationScope} onChange={(e) => set("authorizationScope", e.target.value as SiteAuthorizationScope | "")}>
            <option value="">Non renseigné</option>
            {(Object.keys(SCOPE_LABEL) as SiteAuthorizationScope[]).map((s) => (
              <option key={s} value={s}>
                {SCOPE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Contact (facultatif)" hint="Personne qui a autorisé. Chiffré dans l'ERP." error={errors.contact}>
          <Textarea rows={2} autoComplete="off" value={form.contact} onChange={(e) => set("contact", e.target.value)} />
        </Field>
      </fieldset>
      {errors.testimonial ? (
        <p className="text-sm text-[var(--danger)]" role="alert">
          Témoignage enregistré auparavant : {errors.testimonial}
        </p>
      ) : null}
    </div>
  );

  const publication = (
    <div className="space-y-4">
      <Field label="Statut" hint="« Sur le site » : incluse à la prochaine publication, si l'autorisation couvre ce qui est montré." error={errors.status}>
        <Select value={form.status} onChange={(e) => set("status", e.target.value as SiteItemStatus)}>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      {item?.publishedAt ? (
        <p className="text-sm text-[var(--muted)]">Déjà publiée : pour l'enlever du site, choisir « Retiré du site » plutôt que la supprimer.</p>
      ) : item ? (
        <Button variant="danger-ghost" disabled={ed.busy} onClick={() => setDeleting(true)}>
          Supprimer la référence
        </Button>
      ) : null}
    </div>
  );

  return (
    <div>
      <PageHeader
        back={{ to: "/site/references", label: "Références" }}
        title={creating ? "Nouvelle référence" : item?.name ?? "Référence"}
        subtitle={item ? <StatusBadge row={item} /> : undefined}
      />
      <LoadState loading={ed.loading} error={ed.loadError} onRetry={() => void ed.load()}>
        <form onSubmit={ed.onSubmit} noValidate>
          <EditorLayout
            label="Sections de la référence"
            tabs={[
              { id: "structure", label: "Structure", content: structure, errors: ed.countErrors(["name", "type", "url", "productSlug", "slug"]) },
              { id: "logo", label: "Logo", content: logo, errors: ed.countErrors(["logoPath", "logoAlt", "placement"]) },
              { id: "autorisation", label: "Autorisation", content: autorisation, errors: ed.countErrors(["authorizationAt", "authorizationChannel", "authorizationScope", "contact", "testimonial"]) },
              { id: "publication", label: "Publication", content: publication, errors: ed.countErrors(["status"]) },
            ]}
            preview={() => <LogoTilePreview name={form.logoAlt.trim() || form.name} logoPath={form.logoPath} url={form.url.trim() || null} />}
            footer={<EditorFooter auto={ed.auto} creating={creating} busy={ed.busy} createLabel="Créer la référence" />}
          />
        </form>
      </LoadState>
      <ConfirmDialog
        open={deleting}
        title="Supprimer cette référence ?"
        message="Elle n'a jamais été publiée : elle disparaît de l'ERP, autorisation et contact compris."
        confirmLabel="Supprimer"
        danger
        busy={ed.busy}
        onConfirm={() => void ed.remove().catch(() => setDeleting(false))}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}
