import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Combobox } from "@/components/ui/Combobox";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare, faArrowsUpDown, faCheck, faEye, faPlus } from "@fortawesome/free-solid-svg-icons";
import { Card, PageHeader } from "@/components/ui/Card";
import { Button, ButtonLink, buttonClass } from "@/components/ui/Button";
import { EditorFooter, EditorLayout, useItemEditor } from "./editor";
import { reorderVisible, saveIds, SortableList } from "./sortable";
import { applyProposals, proposePairAlt, type MediaNames } from "@/lib/site-proposals";
import { CaptureGallery, ProposedInput, captureKey, type CaptureForm } from "./captures";
import { ProjectCardPreview } from "./preview";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { DateInput, Field, Input, MonthField, Select, Textarea } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { StatStrip } from "@/components/ui/StatStrip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  dateToIso,
  ImageField,
  isoToDate,
  LoadState,
  OrderButtons,
  PROJECT_KIND_LABEL,
  saveOrder,
  SiteImage,
  STATUS_OPTIONS,
  Radio,
  StatusBadge,
  TagInput,
  useSiteCollection,
  type BeforeAfterPair,
  type FieldErrors,
  type LibraryMedia,
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
  altMode: "auto" as AltMode,
  imageAlt: "",
  status: "DRAFT" as SiteItemStatus,
  // Page projet
  description: "",
  nature: "" as "" | "refonte" | "creation",
  duree: "",
  context: "",
  need: "",
  approach: "",
  choices: "",
  result: "",
  captures: [] as CaptureForm[],
  links: [] as { label: string; url: string }[],
  avantApres: [] as PairForm[],
  // Client et accord écrit
  clientId: "",
  clientName: "",
  clientIntro: "",
  consentAt: "",
  consentNote: "",
};
type AltMode = "auto" | "custom" | "decorative";
type PairForm = {
  vue: BeforeAfterPair["vue"];
  avant: { image: string | null; alt: string; date: string; source: string; altAuto?: boolean | null };
  apres: { image: string | null; alt: string; altAuto?: boolean | null };
};
type ProjectForm = typeof emptyForm;

const VIEW_LABEL: Record<BeforeAfterPair["vue"], string> = { bureau: "Ordinateur", mobile: "Téléphone" };
const ARCHIVE_URL = /^https:\/\/web\.archive\.org\/\S+$/;
const sha12Of = (path: string | null) => /^\/media\/([a-f0-9]{12})\.webp$/.exec(path ?? "")?.[1];

/**
 * Ratios des deux captures d'une paire (dimensions 1x de la médiathèque) : le build du site échoue s'ils diffèrent,
 * même d'un pixel. null : rien à signaler (image manquante ou dimensions pas encore connues).
 */
export function pairRatioIssue(
  avant: { width: number; height: number } | undefined,
  apres: { width: number; height: number } | undefined,
): string | null {
  if (!avant || !apres || avant.width * apres.height === apres.width * avant.height) return null;
  return `Ratios différents : ${avant.width}×${avant.height} avant, ${apres.width}×${apres.height} après. Le site refuserait la publication : recadrer l'une des deux dans la médiathèque, ou choisir deux captures de même format.`;
}

/** Texte que le site calcule sans saisie (altCapture du dépôt KouziaWebsite, src/data/contenu.ts). */
export function defaultCaptureAlt(f: { kind: SiteProject["kind"]; name: string; subtitle: string }): string {
  return f.kind === "SOFTWARE" ? `Écran d’accueil du logiciel ${f.name}` : `Page d’accueil du site ${f.name}${f.subtitle.trim() ? `, ${f.subtitle.trim()}` : ""}`;
}
/** Texte alternatif publié pour la capture, tel que le site l'écrira. */
const publishedAlt = (f: ProjectForm) => (f.altMode === "auto" ? defaultCaptureAlt(f) : f.altMode === "decorative" ? "" : f.imageAlt.trim());

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
    imageAlt: form.altMode === "auto" ? null : form.altMode === "decorative" ? "" : form.imageAlt.trim(),
    status: form.status,
    description: form.description,
    nature: form.nature || null,
    duree: form.duree,
    context: form.context,
    need: form.need,
    approach: form.approach,
    choices: form.choices,
    result: form.result,
    captures: form.captures.filter((c) => c.image).map((c) => ({ image: c.image, alt: c.alt.trim(), caption: c.caption.trim() || null, vue: c.vue })),
    links: form.links.filter((l) => l.label.trim() || l.url.trim()).map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
    avantApres: form.avantApres.map((x) => ({
      vue: x.vue,
      avant: { image: x.avant.image, alt: x.avant.alt.trim(), date: x.avant.date, source: x.avant.source.trim() || null },
      apres: { image: x.apres.image, alt: x.apres.alt.trim() },
    })),
    clientId: form.clientId || null,
    clientName: form.clientName,
    clientIntro: form.clientIntro,
    consentAt: dateToIso(form.consentAt),
    consentNote: form.consentNote,
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
  if (form.altMode === "custom" && !form.imageAlt.trim()) e.imageAlt = "Texte vide : l'écrire, ou choisir le texte calculé par le site.";
  if (form.description.length > 300) e.description = "300 caractères au plus.";
  if (form.captures.some((c) => !c.image)) e.captures = "Capture sans image : en choisir une ou retirer la ligne.";
  else if (form.captures.some((c) => !c.alt.trim())) e.captures = "Chaque capture a besoin de son texte alternatif.";
  if (form.links.some((l) => !l.label.trim() || !/^https:\/\/[^\s/]+\.[^\s]+$/.test(l.url.trim()))) e.links = "Chaque lien : un libellé et une adresse https complète.";
  const pairs = form.avantApres;
  if (pairs.some((x) => !x.avant.image || !x.apres.image)) e.avantApres = "Paire incomplète : choisir les deux captures, ou retirer la paire.";
  else if (pairs.some((x) => !x.avant.alt.trim() || !x.apres.alt.trim())) e.avantApres = "Chaque capture a besoin de son texte alternatif.";
  else if (pairs.some((x) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(x.avant.date))) e.avantApres = "Date de l'archive manquante : le mois de la capture d'avant.";
  else if (pairs.some((x) => x.avant.source.trim() && !ARCHIVE_URL.test(x.avant.source.trim())))
    e.avantApres = "Source : une adresse web.archive.org complète (https://web.archive.org/…), ou rien.";
  else if (pairs.length === 2 && pairs[0]!.vue === pairs[1]!.vue) e.avantApres = "Chaque vue une fois au plus : une paire Ordinateur, une paire Téléphone.";
  if (form.clientName.trim() && !form.consentAt) e.consentAt = "Le nom du client n'est publié qu'avec son accord écrit : renseigner la date, ou vider le nom.";
  return e;
}

const TAB_FIELDS = {
  // « Carte » : contenu et lien de la carte (un onglet de moins : la barre ne défile plus à 1280 px).
  contenu: ["name", "subtitle", "mention", "kind", "text", "role", "tech", "url", "linkLabel", "slug"],
  images: ["imagePath", "imageMobilePath", "imageAlt"],
  page: ["description", "nature", "duree", "context", "need", "approach", "choices", "result", "captures", "avantApres", "links"],
  client: ["clientId", "clientName", "clientIntro", "consentAt", "consentNote"],
  publication: ["status"],
} as const;

/** Justificatif de l'accord écrit (PDF ou capture) : privé, jamais publié. */
function ConsentFile({ project, onChange }: { project: SiteProject; onChange: (p: SiteProject) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const url = `/api/site/projects/${project.id}/consent-file`;

  async function upload(file: File) {
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      onChange(await api<SiteProject>(url, { method: "POST", body }));
      toast.success("Justificatif enregistré");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Envoi impossible");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  async function remove() {
    setBusy(true);
    try {
      onChange(await api<SiteProject>(url, { method: "DELETE" }));
      setRemoving(false);
      toast.success("Justificatif retiré");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Retrait impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Justificatif de l'accord (facultatif)</p>
      <p className="text-xs text-[var(--muted)]">PDF, JPEG ou PNG, 10 Mo au plus. Gardé dans l'ERP, jamais publié.</p>
      <div className="flex flex-wrap items-center gap-2">
        {project.consentFile ? (
          <>
            <a className="link inline-flex min-h-11 items-center text-sm" href={url} download>
              Télécharger le justificatif
            </a>
            <Button variant="danger-ghost" disabled={busy} onClick={() => setRemoving(true)}>
              Retirer
            </Button>
          </>
        ) : null}
        <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
          {project.consentFile ? "Remplacer" : "Joindre un justificatif"}
        </Button>
        <input
          ref={input}
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
      <ConfirmDialog
        open={removing}
        title="Retirer le justificatif ?"
        message="Le fichier est supprimé de l'ERP. La date de l'accord reste."
        confirmLabel="Retirer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(false)}
      />
    </div>
  );
}

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
      altMode: p.imageAlt === null ? "auto" : p.imageAlt === "" ? "decorative" : "custom",
      imageAlt: p.imageAlt ?? "",
      status: p.status,
      description: p.descriptionText ?? "",
      nature: p.nature ?? "",
      duree: p.duree ?? "",
      context: p.contextText ?? "",
      need: p.needText ?? "",
      approach: p.approachText ?? "",
      choices: p.choicesText ?? "",
      result: p.resultText ?? "",
      captures: p.captures.map((c) => ({ key: captureKey(), image: c.image, alt: c.alt, caption: c.caption ?? "", vue: c.vue ?? "bureau" })),
      links: p.links,
      avantApres: (p.avantApres ?? []).map((x) => ({
        vue: x.vue,
        avant: { image: x.avant.image, alt: x.avant.alt, date: x.avant.date, source: x.avant.source ?? "" },
        apres: { image: x.apres.image, alt: x.apres.alt },
      })),
      clientId: p.clientId ?? "",
      clientName: p.clientName ?? "",
      clientIntro: p.clientIntro ?? "",
      consentAt: isoToDate(p.publicationConsentAt),
      consentNote: p.publicationConsentNote ?? "",
    }),
    toBody: projectBody,
    validate: projectErrors,
    itemPath: (p) => `/site/realisations/${p.id}`,
    listPath: "/site/realisations",
    labels: { created: "Réalisation créée : la suite s'enregistre toute seule", deleted: "Réalisation supprimée", notFound: "Réalisation introuvable" },
  });
  const { form, set, setForm, errors, busy, auto, item: project } = ed;
  const remove = () => ed.remove().catch(() => setDeleting(false));
  const [clients, setClients] = useState<{ id: string; displayName: string }[]>([]);
  useEffect(() => {
    api<{ id: string; displayName: string }[]>("/api/clients")
      .then((list) => setClients([...list].sort((a, b) => a.displayName.localeCompare(b.displayName, "fr"))))
      .catch(() => toast.error("Liste des clients indisponible"));
  }, []);
  // Médiathèque : dimensions des captures d'avant / après (contrôle du ratio dès le choix) et noms lisibles des images
  // (textes proposés). Lue à l'ouverture, relue quand une image inconnue apparaît (envoi d'une nouvelle image depuis un champ).
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [names, setNames] = useState<MediaNames | null>(null);
  const shas = [...form.captures.map((c) => c.image), ...form.avantApres.flatMap((x) => [x.avant.image, x.apres.image])]
    .map(sha12Of)
    .filter((s): s is string => Boolean(s))
    .join(",");
  useEffect(() => {
    if (names && shas.split(",").filter(Boolean).every((s) => sizes[s])) return;
    // Réponse d'une lecture dépassée (lancée avant le dernier changement d'images) : ignorée, elle écraserait la liste à jour.
    let stale = false;
    api<LibraryMedia[]>("/api/site/media")
      .then((list) => {
        if (stale) return;
        setSizes(Object.fromEntries(list.map((m) => [m.sha12, { width: m.width, height: m.height }])));
        setNames(Object.fromEntries(list.map((m) => [m.sha12, { label: m.label, originalName: m.originalName }])));
      })
      .catch(() => {
        if (stale) return;
        setNames((current) => current ?? {});
        toast.error("Médiathèque indisponible : ratio des captures d'avant / après non vérifié, textes proposés sans le nom des images");
      });
    return () => {
      stale = true;
    };
    // sizes et names exclus : relire seulement quand les images choisies changent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shas]);
  // Textes proposés (alt, légende) : appliqués une fois la médiathèque lue, puis à chaque changement de contexte.
  useEffect(() => {
    if (names) setForm((f) => applyProposals(f, names));
  }, [form, names, setForm]);
  const slugLocked = Boolean(project?.publishedAt);
  // Page projet telle que publiée : lien seulement si la dernière publication l'a mise en ligne.
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!project?.id) return;
    let stale = false;
    api<{ url: string | null }>(`${BASE}/${project.id}/page-online`)
      .then((r) => !stale && setPageUrl(r.url))
      .catch(() => !stale && setPageUrl(null));
    return () => {
      stale = true;
    };
  }, [project?.id, project?.publishedAt]);

  // Aperçu du brouillon (page /apercu du site) : onglet ouvert au clic (sinon bloqué après l'attente), puis dirigé
  // vers le lien signé une fois le brouillon enregistré ; sans lien vers cet onglet (opener coupé).
  const [previewing, setPreviewing] = useState(false);
  async function openDraftPreview() {
    if (!project) return;
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    setPreviewing(true);
    try {
      await auto.flush();
      const { url } = await api<{ url: string }>(`${BASE}/${project.id}/preview`, { method: "POST" });
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (e) {
      tab?.close();
      toast.error(e instanceof Error ? e.message : "Aperçu impossible");
    } finally {
      setPreviewing(false);
    }
  }
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
      <fieldset className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] p-4" aria-describedby="alt-aide">
        <legend className="px-1 text-sm font-medium">Texte alternatif de la capture</legend>
        <p id="alt-aide" className="text-xs text-[var(--muted)]">
          Lu à la place de l'image par un lecteur d'écran, et affiché si elle ne charge pas. L'information d'abord, sans « image de », 150 caractères
          environ.
        </p>
        <Radio name="altMode" checked={form.altMode === "auto"} onChange={() => set("altMode", "auto")} label="Calculé par le site" hint={`« ${defaultCaptureAlt(form)} »`} />
        <Radio name="altMode" checked={form.altMode === "custom"} onChange={() => set("altMode", "custom")} label="Texte saisi" />
        {form.altMode === "custom" ? (
          <Field label="Texte alternatif" hint={`${form.imageAlt.length} / 200 caractères`} error={errors.imageAlt} className="pl-8">
            <Textarea rows={2} maxLength={200} value={form.imageAlt} onChange={(e) => set("imageAlt", e.target.value)} placeholder={defaultCaptureAlt(form)} />
          </Field>
        ) : null}
        <Radio
          name="altMode"
          checked={form.altMode === "decorative"}
          onChange={() => set("altMode", "decorative")}
          label="Image décorative"
          hint="Alt vide : à choisir seulement si la capture n'apporte rien que le texte de la carte ne dise déjà."
        />
      </fieldset>
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

  const sections = [
    ["context", "Le contexte", "La situation de départ."],
    ["need", "Le besoin", "Ce que le client attendait."],
    ["approach", "La démarche", "Comment le projet s'est déroulé."],
    ["choices", "Les choix et pourquoi", "Pourquoi le site ou le logiciel est ainsi."],
    ["result", "Le résultat", "Ce qui a changé, sans chiffre invérifiable."],
  ] as const;
  const setLink = (i: number, patch: Partial<ProjectForm["links"][number]>) =>
    setForm((f) => ({ ...f, links: f.links.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const setPair = (i: number, side: "avant" | "apres" | null, patch: Record<string, unknown>) =>
    setForm((f) => ({
      ...f,
      avantApres: f.avantApres.map((x, j) => (j !== i ? x : side ? { ...x, [side]: { ...x[side], ...patch } } : { ...x, ...patch })),
    }));
  const addPair = () =>
    setForm((f) => ({
      ...f,
      avantApres: [
        ...f.avantApres,
        {
          vue: f.avantApres.some((x) => x.vue === "bureau") ? "mobile" : "bureau",
          avant: { image: null, alt: "", date: "", source: "", altAuto: true },
          apres: { image: null, alt: "", altAuto: true },
        },
      ],
    }));

  const pageProjet = (
    <div className="space-y-4">
      <p className="text-sm text-[var(--muted)]">
        Page /realisations/{form.slug || "identifiant"}/ du site, reliée à la carte. Elle part avec une description et au moins un texte détaillé ;
        une ligne vide sépare deux paragraphes.
      </p>
      {project?.detailBlocker ? (
        <p className="text-sm text-[var(--warning)]" role="status">
          Page projet non publiée : {project.detailBlocker}.
        </p>
      ) : null}
      <Field
        label="Description pour Google"
        hint={`140 à 155 caractères conseillés, unique. ${form.description.length} / 300`}
        error={errors.description}
      >
        <Textarea rows={3} maxLength={300} value={form.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
        <Field label="Nature du projet (facultatif)" hint="Affichée sur la page projet." error={errors.nature}>
          <Select value={form.nature} onChange={(e) => set("nature", e.target.value as ProjectForm["nature"])}>
            <option value="">Non précisée</option>
            <option value="refonte">Refonte</option>
            <option value="creation">Création</option>
          </Select>
        </Field>
        <Field label="Durée (facultatif)" hint={`Par exemple « 3 semaines ». ${form.duree.length} / 40`} error={errors.duree}>
          <Input maxLength={40} autoComplete="off" value={form.duree} onChange={(e) => set("duree", e.target.value)} />
        </Field>
      </div>
      {sections.map(([key, label, hint]) => (
        <Field key={key} label={`${label} (facultatif)`} hint={`${hint} ${form[key].length} / 1 500`} error={errors[key]}>
          <Textarea rows={5} maxLength={1500} value={form[key]} onChange={(e) => set(key, e.target.value)} />
        </Field>
      ))}
      <CaptureGallery
        captures={form.captures}
        setCaptures={(update) => setForm((f) => ({ ...f, captures: update(f.captures) }))}
        project={form}
        names={names}
        error={errors.captures}
      />
      <fieldset className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] p-4" aria-describedby={`avant-apres-aide${errors.avantApres ? " avant-apres-err" : ""}`}>
        <legend className="px-1 text-sm font-medium">Avant / après (facultatif)</legend>
        <p id="avant-apres-aide" className="text-xs text-[var(--muted)]">
          Comparateur de la page projet : 1 ou 2 paires, une par vue (ordinateur, téléphone). Les deux captures d'une paire doivent avoir exactement le
          même ratio. Section masquée sur le site sans paire ; ses textes se règlent dans « Tous les textes ».
        </p>
        {form.avantApres.map((x, i) => {
          const n = VIEW_LABEL[x.vue].toLowerCase();
          const ratio = pairRatioIssue(sizes[sha12Of(x.avant.image) ?? ""], sizes[sha12Of(x.apres.image) ?? ""]);
          const kind = x.vue === "mobile" ? "MOBILE" : "CAPTURE";
          return (
            <div key={i} className="space-y-4 border-t border-[var(--border)] pt-4 first-of-type:border-t-0 first-of-type:pt-0">
              <Field label={`Vue de la paire ${i + 1}`} className="max-w-xs">
                <Select value={x.vue} onChange={(e) => setPair(i, null, { vue: e.target.value })}>
                  {(["bureau", "mobile"] as const).map((v) => (
                    <option key={v} value={v} disabled={form.avantApres.some((o, j) => j !== i && o.vue === v)}>
                      {VIEW_LABEL[v]}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-6">
                <div className="min-w-0 space-y-3">
                  <ImageField label={`Capture d'avant (${n})`} kind={kind} allowRepoPath={false} value={x.avant.image} onChange={(image) => setPair(i, "avant", { image })} />
                  <ProposedInput
                    label={`Texte alternatif de la capture d'avant (${n})`}
                    hint="Ce que montre la capture d'avant."
                    max={200}
                    value={x.avant.alt}
                    auto={x.avant.altAuto}
                    proposal={proposePairAlt(form, x, "avant")}
                    onChange={(alt) => setPair(i, "avant", { alt, altAuto: false })}
                    onReset={() => setPair(i, "avant", { altAuto: true })}
                  />
                  <MonthField label={`Date de l'archive (${n})`} hint="Mois de la capture d'avant." value={x.avant.date} onChange={(date) => setPair(i, "avant", { date })} />
                  <Field label={`Source de l'archive (${n}, facultatif)`} hint="Adresse web.archive.org de la capture, affichée en petit.">
                    <Input
                      type="url"
                      inputMode="url"
                      spellCheck={false}
                      placeholder="https://web.archive.org/web/…"
                      value={x.avant.source}
                      onChange={(e) => setPair(i, "avant", { source: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="min-w-0 space-y-3">
                  <ImageField
                    label={`Capture d'après (${n})`}
                    kind={kind}
                    allowRepoPath={false}
                    value={x.apres.image}
                    onChange={(image) => setPair(i, "apres", { image })}
                    error={ratio ?? undefined}
                  />
                  <ProposedInput
                    label={`Texte alternatif de la capture d'après (${n})`}
                    hint="Ce que montre la capture d'après."
                    max={200}
                    value={x.apres.alt}
                    auto={x.apres.altAuto}
                    proposal={proposePairAlt(form, x, "apres")}
                    onChange={(alt) => setPair(i, "apres", { alt, altAuto: false })}
                    onReset={() => setPair(i, "apres", { altAuto: true })}
                  />
                </div>
              </div>
              <Button variant="danger-ghost" onClick={() => setForm((f) => ({ ...f, avantApres: f.avantApres.filter((_, j) => j !== i) }))}>
                Retirer la paire {n}
              </Button>
            </div>
          );
        })}
        {errors.avantApres ? (
          <p id="avant-apres-err" className="text-sm text-[var(--danger)]">
            {errors.avantApres}
          </p>
        ) : null}
        {form.avantApres.length < 2 ? (
          <Button variant="secondary" onClick={addPair}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Ajouter une paire
          </Button>
        ) : null}
      </fieldset>
      <fieldset className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] p-4" aria-describedby={errors.links ? "liens-err" : undefined}>
        <legend className="px-1 text-sm font-medium">Autres liens (4 au plus)</legend>
        <p className="text-xs text-[var(--muted)]">En plus du lien vers le site ou la démo ; jamais vers le code source.</p>
        {form.links.map((l, i) => (
          <div key={i} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
            <Field label={`Libellé du lien ${i + 1}`}>
              <Input maxLength={60} value={l.label} onChange={(e) => setLink(i, { label: e.target.value })} />
            </Field>
            <Field label={`Adresse du lien ${i + 1}`}>
              <Input type="url" inputMode="url" value={l.url} onChange={(e) => setLink(i, { url: e.target.value })} />
            </Field>
            <Button variant="danger-ghost" onClick={() => setForm((f) => ({ ...f, links: f.links.filter((_, j) => j !== i) }))}>
              Retirer le lien {i + 1}
            </Button>
          </div>
        ))}
        {errors.links ? (
          <p id="liens-err" className="text-sm text-[var(--danger)]">
            {errors.links}
          </p>
        ) : null}
        {form.links.length < 4 ? (
          <Button variant="secondary" onClick={() => setForm((f) => ({ ...f, links: [...f.links, { label: "", url: "https://" }] }))}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Ajouter un lien
          </Button>
        ) : null}
      </fieldset>
    </div>
  );

  const clientAccord = (
    <div className="space-y-4">
      <p className="text-sm text-[var(--muted)]">
        Zéro fiction : un projet fait pour un client ne part sur le site (nouvelle carte et page projet) qu'avec son accord écrit. Son nom n'est publié
        qu'avec cet accord.
      </p>
      <Field label="Client (facultatif)" hint="Fiche du client de ce projet. Un projet personnel n'en a pas." error={errors.clientId}>
        <Combobox
          label="Client"
          groups={[{ heading: "", options: [{ value: "", label: "Aucun (projet personnel)" }, ...clients.map((c) => ({ value: c.id, label: c.displayName }))] }]}
          value={form.clientId}
          placeholder="Choisir un client"
          searchPlaceholder="Nom du client"
          emptyText="Aucun client ne correspond."
          onChange={(clientId) => set("clientId", clientId)}
        />
      </Field>
      <Field label="Nom du client publié (facultatif)" hint={`Publié seulement avec l'accord écrit. ${form.clientName.length} / 100`} error={errors.clientName}>
        <Input maxLength={100} autoComplete="off" value={form.clientName} onChange={(e) => set("clientName", e.target.value)} />
      </Field>
      <Field label="Présentation du client (facultatif)" hint={`Sans son nom s'il n'a pas donné son accord. ${form.clientIntro.length} / 800`} error={errors.clientIntro}>
        <Textarea rows={4} maxLength={800} value={form.clientIntro} onChange={(e) => set("clientIntro", e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Accord écrit reçu le" hint="Vide : pas d'accord." error={errors.consentAt}>
          <DateInput value={form.consentAt} onChange={(v) => set("consentAt", v)} />
        </Field>
        <Field label="Forme de l'accord (facultatif)" hint="Par exemple « e-mail du 12/10/2026 »." error={errors.consentNote}>
          <Input maxLength={300} autoComplete="off" value={form.consentNote} onChange={(e) => set("consentNote", e.target.value)} />
        </Field>
      </div>
      {project ? (
        <ConsentFile project={project} onChange={ed.setItem} />
      ) : (
        <p className="text-sm text-[var(--muted)]">Le justificatif se joint une fois la réalisation créée.</p>
      )}
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
        actions={
          creating ? undefined : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" disabled={!project || previewing} onClick={openDraftPreview}>
                <FontAwesomeIcon icon={faEye} className="h-3.5 w-3.5" aria-hidden />
                {previewing ? "Préparation…" : "Aperçu du brouillon"}
                <span className="sr-only"> (nouvel onglet, lien valable 15 minutes)</span>
              </Button>
              {pageUrl ? (
                <a className={buttonClass("secondary")} href={pageUrl} target="_blank" rel="noopener noreferrer">
                  <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3.5 w-3.5" aria-hidden />
                  Voir la page sur le site<span className="sr-only"> (nouvel onglet)</span>
                </a>
              ) : (
                <>
                  <Button variant="secondary" disabled aria-describedby="page-hors-ligne">
                    <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3.5 w-3.5" aria-hidden />
                    Voir la page sur le site
                  </Button>
                  <span id="page-hors-ligne" className="text-xs text-[var(--muted)]">
                    Pas encore en ligne
                  </span>
                </>
              )}
            </div>
          )
        }
      />
      <LoadState loading={ed.loading} error={ed.loadError} onRetry={() => void ed.load()}>
        <form onSubmit={ed.onSubmit} onBlur={ed.onBlur} noValidate>
          <EditorLayout
            label="Sections de la réalisation"
            previewTitle="Carte de la liste"
            tabs={[
              {
                id: "contenu",
                label: "Carte",
                content: (
                  <div className="space-y-8">
                    {contenu}
                    <section aria-labelledby="carte-lien" className="space-y-4">
                      <h3 id="carte-lien" className="font-display text-sm font-semibold">
                        Lien de la carte
                      </h3>
                      {lien}
                    </section>
                  </div>
                ),
                errors: countErrors(TAB_FIELDS.contenu),
              },
              { id: "images", label: "Images", content: images, errors: countErrors(TAB_FIELDS.images) },
              { id: "page", label: "Page projet", content: pageProjet, errors: countErrors(TAB_FIELDS.page) },
              { id: "client", label: "Client et accord", content: clientAccord, errors: countErrors(TAB_FIELDS.client) },
              { id: "publication", label: "Publication", content: publication, errors: countErrors(TAB_FIELDS.publication) },
            ]}
            preview={(device) => (
              <div className="space-y-3">
                <ProjectCardPreview device={device} p={{ ...form, kindLabel: PROJECT_KIND_LABEL[form.kind] }} />
                <p className="text-xs text-[var(--muted)]">
                  {publishedAlt(form) ? `Texte alternatif de la capture : « ${publishedAlt(form)} »` : "Capture décorative : alt vide."}
                </p>
              </div>
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
