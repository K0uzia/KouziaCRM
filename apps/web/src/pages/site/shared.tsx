import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowDown, faArrowUp, faChevronRight, faImage, faUpload } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Badge, Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";

export type SiteItemStatus = "DRAFT" | "PUBLISHED" | "WITHDRAWN";

type SiteItem = {
  id: string;
  position: number;
  status: SiteItemStatus;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export type SiteProject = SiteItem & {
  slug: string;
  name: string;
  subtitle: string | null;
  kind: "WEBSITE" | "SOFTWARE";
  text: string;
  role: string | null;
  tech: string[];
  url: string;
  linkLabel: string;
  imagePath: string;
  imageMobilePath: string | null;
};

export type SiteReview = SiteItem & {
  author: string;
  reviewedOn: string;
  text: string;
  rating: number | null;
  googleUrl: string | null;
  consentAt: string | null;
  consentChannel: string | null;
  consentProof: string | null;
  withdrawalRequestedAt: string | null;
};

export type SiteReferenceType = "CLIENT" | "PARTNER" | "USER";
export type SiteAuthorizationScope = "NAME" | "NAME_LOGO" | "TESTIMONIAL";

export type SiteReference = SiteItem & {
  slug: string;
  type: SiteReferenceType;
  name: string;
  logoPath: string | null;
  url: string | null;
  productSlug: string | null;
  testimonialText: string | null;
  testimonialAuthor: string | null;
  testimonialRole: string | null;
  authorizationAt: string | null;
  authorizationChannel: string | null;
  authorizationScope: SiteAuthorizationScope | null;
  contact: string | null;
};

export type SiteFaqPage = "HOME" | "WEBSITES" | "SOFTWARE";
export type SiteFaq = SiteItem & { page: SiteFaqPage; question: string; answer: string };

export type SiteIssue = { file: string; path: string; message: string };
export type SiteState = {
  imagesAvailable: boolean;
  github: {
    repo: string;
    branch: string;
    token: { set: boolean; hint: string | null };
    expiresAt: string | null;
  };
  empty: boolean;
  digest: string;
  issues: SiteIssue[];
};

export const PROJECT_KIND_LABEL: Record<SiteProject["kind"], string> = { WEBSITE: "Site web", SOFTWARE: "Logiciel" };
export const REFERENCE_TYPE_LABEL: Record<SiteReferenceType, string> = {
  CLIENT: "Client",
  PARTNER: "Partenaire",
  USER: "Utilisateur",
};
export const SCOPE_LABEL: Record<SiteAuthorizationScope, string> = {
  NAME: "Nom seulement",
  NAME_LOGO: "Nom et logo",
  TESTIMONIAL: "Nom, logo et témoignage",
};
export const FAQ_PAGE_LABEL: Record<SiteFaqPage, string> = {
  HOME: "Accueil",
  WEBSITES: "Sites web",
  SOFTWARE: "Logiciels",
};

/** Choix du statut dans les formulaires : « Sur le site » veut dire « inclus à la prochaine publication ». */
export const STATUS_OPTIONS: ReadonlyArray<{ id: SiteItemStatus; label: string }> = [
  { id: "DRAFT", label: "Brouillon (pas sur le site)" },
  { id: "PUBLISHED", label: "Sur le site" },
  { id: "WITHDRAWN", label: "Retiré du site" },
];

export function statusView(row: Pick<SiteItem, "status" | "publishedAt">): { label: string; tone: "neutral" | "green" | "blue" | "amber" } {
  if (row.status === "DRAFT") return { label: "Brouillon", tone: "neutral" };
  if (row.status === "WITHDRAWN") return { label: "Retiré", tone: "amber" };
  return row.publishedAt ? { label: "Publié", tone: "green" } : { label: "Prêt à publier", tone: "blue" };
}

export function StatusBadge({ row }: { row: Pick<SiteItem, "status" | "publishedAt"> }) {
  const v = statusView(row);
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

/** Liste d'une collection du Site : chargement, erreur, rechargement. */
export function useSiteCollection<T>(path: string) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setRows(await api<T[]>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { rows, setRows, loading, error, reload };
}

/** États communs d'un écran : chargement, erreur avec nouvel essai, puis le contenu. */
export function LoadState({
  loading,
  error,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <Card className="p-6 text-sm text-[var(--muted)]" role="status">
        Chargement…
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="flex flex-col items-start gap-3 p-6" role="alert">
        <p className="text-sm text-[var(--danger)]">{error}</p>
        <Button variant="secondary" onClick={onRetry}>
          Réessayer
        </Button>
      </Card>
    );
  }
  return <>{children}</>;
}

/**
 * Nouvel ordre après avoir monté ou descendu un élément parmi ceux affichés (liste filtrée) :
 * il échange sa place avec son voisin affiché, le reste de l'ordre ne bouge pas.
 */
export function movedOrder<T extends { id: string }>(all: T[], visible: T[], id: string, dir: -1 | 1): string[] | null {
  const i = visible.findIndex((r) => r.id === id);
  const neighbour = visible[i + dir];
  if (i < 0 || !neighbour) return null;
  const ids = all.map((r) => r.id);
  const a = ids.indexOf(id);
  const b = ids.indexOf(neighbour.id);
  [ids[a], ids[b]] = [ids[b]!, ids[a]!];
  return ids;
}

/** Région status unique (hors de React : elle survit aux changements d'écran), vidée puis remplie pour être relue. */
function announce(text: string) {
  let region = document.getElementById("site-annonce");
  if (!region) {
    region = document.createElement("div");
    region.id = "site-annonce";
    region.setAttribute("role", "status");
    region.className = "sr-only";
    document.body.append(region);
  }
  region.textContent = "";
  const target = region;
  window.setTimeout(() => (target.textContent = text), 50);
}

export async function saveOrder<T extends { id: string }>(
  base: string,
  all: T[],
  visible: T[],
  id: string,
  dir: -1 | 1,
  setRows: (rows: T[]) => void,
  name: (row: T) => string,
) {
  const ids = movedOrder(all, visible, id, dir);
  if (!ids) return;
  const row = all.find((r) => r.id === id)!;
  const visibleIds = new Set(visible.map((r) => r.id));
  const position = ids.filter((x) => visibleIds.has(x)).indexOf(id) + 1;
  const previous = all;
  const byId = new Map(all.map((r) => [r.id, r]));
  // Vue mise à jour tout de suite, rétablie si l'enregistrement échoue.
  setRows(ids.map((x) => byId.get(x)!));
  try {
    await api(`${base}/reorder`, { method: "POST", body: JSON.stringify({ ids }) });
    announce(`${name(row)}, position ${position} sur ${visible.length}`);
  } catch (e) {
    setRows(previous);
    toast.error(e instanceof Error ? e.message : "Ordre non enregistré");
  }
}

/** Boutons « Monter » et « Descendre » (le glisser-déposer n'est pas utilisable au clavier ni au téléphone). */
export function OrderButtons({
  name,
  first,
  last,
  onMove,
}: {
  name: string;
  first: boolean;
  last: boolean;
  onMove: (dir: -1 | 1) => void;
}) {
  const cls =
    "inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="flex shrink-0 items-center">
      <button type="button" className={cls} disabled={first} aria-label={`Monter « ${name} »`} onClick={() => onMove(-1)}>
        <FontAwesomeIcon icon={faArrowUp} className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button type="button" className={cls} disabled={last} aria-label={`Descendre « ${name} »`} onClick={() => onMove(1)}>
        <FontAwesomeIcon icon={faArrowDown} className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Adresse d'aperçu d'une image publiée : les images de l'ERP passent par l'API (session admin),
 * celles reprises du site (/projets/…) sont lues sur kouzia.com.
 */
export function siteImageSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  const media = /^\/media\/([a-f0-9]{12})\.webp$/.exec(path);
  if (media) return `/api/site/media/${media[1]}.webp`;
  if (/^\/(projets|media)\/[a-z0-9-]+\.(webp|svg)$/.test(path)) return `https://kouzia.com${path}`;
  return null;
}

export function SiteImage({ path, alt, className = "" }: { path: string | null | undefined; alt: string; className?: string }) {
  const src = siteImageSrc(path);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <div
        className={`flex items-center justify-center bg-[var(--surface-raised)] text-[var(--muted)] ${className}`}
        role="img"
        aria-label={src ? `${alt} : aperçu indisponible` : `${alt} : aucune image`}
      >
        <FontAwesomeIcon icon={faImage} className="h-5 w-5" aria-hidden />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`bg-[var(--surface-raised)] object-cover ${className}`}
    />
  );
}

export type MediaKind = "CAPTURE" | "MOBILE" | "LOGO";
type UploadedMedia = { path: string; width: number; height: number; width2x: number | null };

const KIND_HINT: Record<MediaKind, string> = {
  CAPTURE: "Capture d'écran d'ordinateur : recadrée en 16:9, 960×540 px au moins (1920×1080 pour les écrans haute densité).",
  MOBILE: "Capture de téléphone : 390×844 px au moins (780×1688 conseillé), recadrée par le haut.",
  LOGO: "Logo : 200 px de large au moins, PNG transparent de préférence.",
};
const KIND_FRAME: Record<MediaKind, string> = {
  CAPTURE: "aspect-video w-full max-w-xs",
  MOBILE: "aspect-[9/19.5] w-28",
  LOGO: "h-16 w-40 object-contain",
};

/**
 * Champ image : aperçu, envoi (normalisé en WebP sans métadonnées par l'API) et retrait si facultatif.
 * Le fichier choisi n'est envoyé qu'à l'API de l'ERP ; l'original n'est pas conservé.
 */
export function ImageField({
  label,
  kind,
  value,
  onChange,
  optional = false,
  error,
}: {
  label: string;
  kind: MediaKind;
  value: string | null;
  onChange: (path: string | null) => void;
  optional?: boolean;
  error?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const pathId = useId();
  const [existing, setExisting] = useState("");
  const [existingError, setExistingError] = useState<string | null>(null);

  // Image déjà dans le dépôt du site (public/projets/) : référencée par son chemin, sans envoi.
  function applyExisting() {
    const path = existing.trim();
    if (!/^\/projets\/[a-z0-9-]+\.webp$/.test(path)) {
      setExistingError("Chemin attendu : /projets/nom-de-l-image.webp");
      return;
    }
    setExistingError(null);
    setExisting("");
    onChange(path);
  }

  async function upload(file: File) {
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const media = await api<UploadedMedia>(`/api/site/media?kind=${kind}`, { method: "POST", body });
      onChange(media.path);
      toast.success(
        media.width2x
          ? "Image enregistrée (deux tailles, sans métadonnées)"
          : "Image enregistrée sans version haute densité : la source était trop petite",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Envoi impossible");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <fieldset className="min-w-0 space-y-2" aria-describedby={hintId}>
      <legend className="text-sm font-medium text-[var(--text)]">
        {label}
        {optional ? <span className="font-normal text-[var(--muted)]"> (facultatif)</span> : null}
      </legend>
      <div className="flex flex-wrap items-end gap-3">
        <SiteImage
          path={value}
          alt={label}
          className={`rounded-[var(--radius-sm)] border border-[var(--border)] ${KIND_FRAME[kind]}`}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => input.current?.click()}
            aria-label={`${value ? "Remplacer" : "Choisir une image"} : ${label}`}
          >
            <FontAwesomeIcon icon={faUpload} className="h-3.5 w-3.5" aria-hidden />
            {busy ? "Envoi…" : value ? "Remplacer" : "Choisir une image"}
          </Button>
          {optional && value ? (
            <Button variant="ghost" disabled={busy} onClick={() => onChange(null)} aria-label={`Retirer : ${label}`}>
              Retirer
            </Button>
          ) : null}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
      <p id={hintId} className="text-xs text-[var(--muted)]">
        {KIND_HINT[kind]}
        {value ? <span className="block font-mono">{value}</span> : null}
      </p>
      {kind !== "LOGO" ? (
        <details className="group text-sm">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-[var(--muted)] hover:text-[var(--text)] [&::-webkit-details-marker]:hidden">
            <FontAwesomeIcon icon={faChevronRight} className="h-3 w-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
            Utiliser une image déjà sur le site
          </summary>
          <div className="mt-1 space-y-1.5">
            <label htmlFor={pathId} className="block text-xs text-[var(--muted)]">
              Chemin dans le dépôt du site (dossier public/projets)
              <span className="sr-only"> : {label}</span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Input
                id={pathId}
                className="min-w-0 flex-[1_1_14rem] font-mono"
                placeholder={kind === "MOBILE" ? "/projets/nom-mobile.webp" : "/projets/nom.webp"}
                spellCheck={false}
                value={existing}
                aria-invalid={existingError ? true : undefined}
                aria-describedby={existingError ? `${pathId}-err` : undefined}
                onChange={(e) => setExisting(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyExisting();
                  }
                }}
              />
              <Button variant="secondary" onClick={applyExisting} aria-label={`Utiliser ce chemin : ${label}`}>
                Utiliser
              </Button>
            </div>
            {existingError ? (
              <p id={`${pathId}-err`} className="text-sm text-[var(--danger)]">
                {existingError}
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
      {error ? (
        <p className="text-sm text-[var(--danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Date du jour au format AAAA-MM-JJ (champ date), heure locale. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Champ date (AAAA-MM-JJ) vers l'instant ISO attendu par l'API, à midi pour éviter un décalage de jour. */
export function dateToIso(date: string): string | null {
  return date ? new Date(`${date}T12:00:00`).toISOString() : null;
}

export function isoToDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Message d'erreur API par champ (zod côté serveur). */
export type FieldErrors = Record<string, string>;
export function fieldErrorsOf(e: unknown): FieldErrors {
  return (e as { fieldErrors?: FieldErrors }).fieldErrors ?? {};
}
