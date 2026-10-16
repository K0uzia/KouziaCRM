import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCloudArrowUp, faCrop, faTrash, faUpload } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { FilterChips } from "@/components/ui/FilterChips";
import { Segmented } from "@/components/ui/Segmented";
import { StatStrip } from "@/components/ui/StatStrip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { KIND_HINT, LoadState, MEDIA_KIND_LABEL, mediaName, SiteImage, useSiteCollection, type LibraryMedia, type MediaKind } from "./shared";

type Filter = "all" | MediaKind | "unused" | "previous";
type Upload = { key: string; name: string; state: "pending" | "done" | "error"; message?: string };

const KIND_OPTIONS: ReadonlyArray<{ id: MediaKind; label: string }> = [
  { id: "CAPTURE", label: "Capture" },
  { id: "MOBILE", label: "Téléphone" },
  { id: "LOGO", label: "Logo" },
  { id: "PARTAGE", label: "Partage" },
];
const ACCEPT: Record<MediaKind, string> = {
  CAPTURE: "image/jpeg,image/png,image/webp,image/avif",
  MOBILE: "image/jpeg,image/png,image/webp,image/avif",
  LOGO: "image/svg+xml,image/png,image/webp,image/jpeg,image/avif",
  PARTAGE: "image/jpeg,image/png,image/webp,image/avif",
};
/** Proportions des cadres recadrés (largeur / hauteur), comme l'API. */
const FRAME_RATIO: Partial<Record<MediaKind, number>> = { CAPTURE: 16 / 9, MOBILE: 390 / 844, PARTAGE: 1200 / 630 };
const kb = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const size = (bytes: number) => `${kb.format(bytes / 1000)} Ko`;

/** Zone gardée, en fractions de l'original : même calcul que focalCrop côté API. */
function cropBox(w: number, h: number, ratio: number, focal: { x: number; y: number }) {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  if (w / h > ratio) {
    const width = Math.min(w, Math.round(h * ratio));
    return { left: clamp(Math.round(focal.x * w - width / 2), w - width) / w, top: 0, width: width / w, height: 1 };
  }
  const height = Math.min(h, Math.round(w / ratio));
  return { left: 0, top: clamp(Math.round(focal.y * h - height / 2), h - height) / h, width: 1, height: height / h };
}

/** Raison qui empêche de supprimer une image (même règle que l'API), null si la suppression est possible. */
function deletionBlocker(m: LibraryMedia): string | null {
  if (m.usages.length) return "Utilisée par une fiche : la retirer de ces fiches d'abord.";
  if (m.online === null) return "Le site a été publié avant le suivi des images : publier une fois, puis supprimer.";
  if (m.online) return "Encore en ligne sur kouzia.com : supprimable après la prochaine publication.";
  return null;
}

/**
 * Médiathèque de l'espace Site : toutes les images envoyées (captures, téléphone, logos), où elles servent, envoi
 * groupé par glisser-déposer, nom lisible, recadrage depuis l'original et suppression des images inutilisées.
 */
export function SiteMediaPage() {
  const { rows, loading, error, reload } = useSiteCollection<LibraryMedia>("/api/site/media");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MediaKind>("CAPTURE");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const kindLabelId = useId();

  // Anciennes versions d'images recadrées : hors de la grille par défaut, gardées tant qu'elles sont en ligne.
  const current = rows.filter((m) => !m.previousVersion);
  const previous = rows.filter((m) => m.previousVersion);
  const q = query.trim().toLowerCase();
  const visible = (filter === "previous" ? previous : current).filter(
    (m) =>
      (filter === "all" || filter === "previous" || (filter === "unused" ? !m.usages.length : m.kind === filter)) &&
      (!q || mediaName(m).toLowerCase().includes(q) || (m.originalName ?? "").toLowerCase().includes(q) || m.usages.some((u) => u.label.toLowerCase().includes(q))),
  );
  const unused = current.filter((m) => !m.usages.length).length;
  const unknownOnline = rows.some((m) => m.online === null);
  // Filtre « Anciennes versions » vidé (publication passée) : retour à toutes les images.
  useEffect(() => {
    if (filter === "previous" && !previous.length) setFilter("all");
  }, [filter, previous.length]);
  const opened = rows.find((m) => m.id === openId) ?? null;
  const busy = uploads.some((u) => u.state === "pending");

  // Envoi l'un après l'autre : le serveur traite une image à la fois (sharp, mémoire bornée).
  async function send(files: File[]) {
    if (!files.length) return;
    const batch = files.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, state: "pending" as const }));
    setUploads(batch);
    let ok = 0;
    for (const [i, file] of files.entries()) {
      const body = new FormData();
      body.append("file", file);
      try {
        await api(`/api/site/media?kind=${kind}`, { method: "POST", body });
        ok++;
        setUploads((list) => list.map((u) => (u.key === batch[i]!.key ? { ...u, state: "done" } : u)));
      } catch (e) {
        const message = e instanceof Error ? e.message : "Envoi impossible";
        setUploads((list) => list.map((u) => (u.key === batch[i]!.key ? { ...u, state: "error", message } : u)));
      }
    }
    if (input.current) input.current.value = "";
    await reload();
    if (ok === files.length) toast.success(ok > 1 ? `${ok} images enregistrées` : "Image enregistrée");
    else toast.error(`${files.length - ok} image${files.length - ok > 1 ? "s" : ""} refusée${files.length - ok > 1 ? "s" : ""} : voir le détail`);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (!busy) void send([...e.dataTransfer.files]);
  }

  return (
    <div>
      <PageHeader
        title="Images"
        subtitle="Captures et logos du site : envoyés une fois, puis choisis dans les fiches. Chaque image est publiée en WebP sans métadonnées ; l'original, nettoyé lui aussi, reste dans l'ERP pour recadrer."
      />
      <LoadState loading={loading} error={error} onRetry={() => void reload()}>
        <StatStrip
          className="mb-4"
          items={[
            { label: "Images", value: current.length, hint: previous.length ? `et ${previous.length} ancienne${previous.length > 1 ? "s" : ""} version${previous.length > 1 ? "s" : ""}` : undefined },
            { label: "Utilisées", value: current.length - unused },
            { label: "Non utilisées", value: unused, hint: unused ? "Supprimables si elles ne sont plus en ligne" : undefined },
            { label: "En ligne", value: unknownOnline ? "?" : rows.filter((m) => m.online).length, hint: unknownOnline ? "Connu après la prochaine publication" : "Dernière publication" },
          ]}
        />

        <Card className="mb-4 space-y-3 p-4">
          <div className="space-y-1.5">
            <p id={kindLabelId} className="text-sm font-medium">
              Type des images à envoyer
            </p>
            <Segmented label="Type des images à envoyer" options={KIND_OPTIONS} value={kind} onChange={setKind} />
          </div>
          {/* Zone de dépôt : le bouton « Choisir des fichiers » reste le chemin principal (clavier, téléphone). */}
          <div
            className={`flex flex-col items-center justify-center gap-2 rounded-[var(--radius)] border-2 border-dashed px-4 py-8 text-center transition-colors ${
              dragging ? "border-[var(--primary)] bg-[var(--primary-soft)]" : "border-[var(--border-strong)] bg-[var(--bg-subtle)]"
            }`}
            onDragEnter={(e: DragEvent) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragOver={(e: DragEvent) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDragging(true);
            }}
            onDragLeave={(e: DragEvent) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={onDrop}
          >
            <FontAwesomeIcon icon={dragging ? faCloudArrowUp : faUpload} className={`h-6 w-6 ${dragging ? "text-[var(--primary)]" : "text-[var(--muted)]"}`} aria-hidden />
            <p className="text-sm">
              {dragging ? (
                <span className="font-medium">Déposer pour envoyer en « {MEDIA_KIND_LABEL[kind]} »</span>
              ) : (
                <>
                  <span className="pointer-coarse:hidden">Glisser-déposer vos images ici ou </span>
                  <Button variant="secondary" className="mt-1" onClick={() => input.current?.click()} disabled={busy} aria-describedby={`${kindLabelId} ${hintId}`}>
                    {busy ? "Envoi…" : "Choisir des fichiers"}
                  </Button>
                </>
              )}
            </p>
          </div>
          <p id={hintId} className="text-xs text-[var(--muted)]">
            {KIND_HINT[kind]} 15 Mo au plus par fichier.
          </p>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT[kind]}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => void send([...(e.target.files ?? [])])}
          />
          {uploads.length ? (
            <ul className="mt-3 space-y-1 text-sm" aria-live="polite">
              {uploads.map((u) => (
                <li key={u.key} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <Badge tone={u.state === "done" ? "green" : u.state === "error" ? "red" : "neutral"}>
                    {u.state === "done" ? "Enregistrée" : u.state === "error" ? "Refusée" : "En cours"}
                  </Badge>
                  <span className="min-w-0 break-all">{u.name}</span>
                  {u.message ? <span className="w-full text-[var(--danger)]">{u.message}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card className="p-4">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <label className="block min-w-0 space-y-1.5 md:w-72">
              <span className="block text-sm font-medium">Rechercher</span>
              <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nom, fichier ou fiche" autoComplete="off" />
            </label>
            <FilterChips
              label="Filtrer les images"
              value={filter}
              onChange={setFilter}
              wrap
              options={[
                { id: "all", label: "Toutes", count: current.length },
                { id: "CAPTURE", label: "Captures", count: current.filter((m) => m.kind === "CAPTURE").length },
                { id: "MOBILE", label: "Téléphone", count: current.filter((m) => m.kind === "MOBILE").length },
                { id: "LOGO", label: "Logos", count: current.filter((m) => m.kind === "LOGO").length },
                { id: "unused", label: "Non utilisées", count: unused },
                ...(previous.length ? [{ id: "previous" as const, label: "Anciennes versions", count: previous.length }] : []),
              ]}
            />
          </div>
          {visible.length ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
              {visible.map((m) => (
                <li key={m.id} className="min-w-0">
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    data-media-id={m.id}
                    onClick={() => setOpenId(m.id)}
                    className="flex h-full min-h-11 w-full flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2 text-left transition-colors hover:border-[var(--primary)]"
                  >
                    <SiteImage path={m.path} alt="" className={`aspect-video w-full rounded-[var(--radius-sm)] ${m.kind === "CAPTURE" ? "" : "object-contain"}`} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium" title={mediaName(m)}>
                        {mediaName(m)}
                      </span>
                      <span className="block text-xs text-[var(--muted)]">
                        {MEDIA_KIND_LABEL[m.kind]}, {m.width}×{m.height} px, {size(m.bytes)}
                      </span>
                    </span>
                    <span className="mt-auto flex flex-wrap gap-1">
                      {m.previousVersion ? (
                        <Badge tone="amber">{m.online ? "Ancienne version, encore en ligne" : "Ancienne version"}</Badge>
                      ) : m.usages.length ? (
                        <Badge tone="green">{`Utilisée par ${m.usages.length} fiche${m.usages.length > 1 ? "s" : ""}`}</Badge>
                      ) : (
                        <Badge tone="neutral">Non utilisée</Badge>
                      )}
                      {m.online && !m.previousVersion ? <Badge tone="blue">En ligne</Badge> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-8 text-center">
              <p className="font-medium">{current.length ? "Aucune image ne correspond" : "Aucune image pour l'instant"}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {current.length ? "Changer le filtre ou la recherche." : "Envoyez des captures ou des logos : ils se choisissent ensuite dans les réalisations et les références."}
              </p>
            </div>
          )}
        </Card>
      </LoadState>

      {opened ? (
        <MediaDetail
          key={opened.id}
          media={opened}
          onClose={() => {
            const id = opened.id;
            setOpenId(null);
            // Après un recadrage, la carte qui a ouvert le panneau n'existe plus : le focus va à la nouvelle version.
            requestAnimationFrame(() => {
              if (document.activeElement === document.body) document.querySelector<HTMLElement>(`[data-media-id="${id}"]`)?.focus();
            });
          }}
          onChanged={async (nextId) => {
            await reload();
            setOpenId(nextId);
          }}
        />
      ) : null}
    </div>
  );
}

function MediaDetail({ media, onClose, onChanged }: { media: LibraryMedia; onClose: () => void; onChanged: (nextId: string | null) => Promise<void> }) {
  const [label, setLabel] = useState(media.label ?? "");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const blocker = deletionBlocker(media);
  const blockerId = useId();
  const labelHintId = useId();

  async function saveLabel(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api(`/api/site/media/${media.id}`, { method: "PATCH", body: JSON.stringify({ label: label.trim() || null }) });
      toast.success("Nom enregistré");
      await onChanged(media.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Enregistrement impossible");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await api(`/api/site/media/${media.id}`, { method: "DELETE" });
      toast.success("Image supprimée");
      setConfirming(false);
      await onChanged(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      open
      side
      onClose={onClose}
      title={mediaName(media)}
      description={`${MEDIA_KIND_LABEL[media.kind]}, ${media.width}×${media.height} px`}
      footer={
        <div className="flex w-full flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          {blocker ? (
            <p id={blockerId} className="text-sm text-[var(--muted)]">
              {blocker}
            </p>
          ) : (
            <span />
          )}
          <Button variant="danger" disabled={Boolean(blocker)} aria-describedby={blocker ? blockerId : undefined} onClick={() => setConfirming(true)} className="shrink-0">
            <FontAwesomeIcon icon={faTrash} className="h-3.5 w-3.5" aria-hidden />
            Supprimer
          </Button>
        </div>
      }
    >
      <div className="space-y-6 text-sm">
        <SiteImage
          path={media.path}
          alt={`Version publiée de ${mediaName(media)}`}
          className={`rounded-[var(--radius-sm)] border border-[var(--border)] ${media.kind === "MOBILE" ? "mx-auto aspect-[9/19.5] w-40" : media.kind === "LOGO" ? "h-24 w-full object-contain" : "aspect-video w-full"}`}
        />

        <form onSubmit={saveLabel} className="space-y-1.5">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Nom dans la médiathèque" className="min-w-0 flex-[1_1_12rem]">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} autoComplete="off" aria-describedby={labelHintId} />
            </Field>
            <Button type="submit" variant="secondary" disabled={saving || label.trim() === (media.label ?? "")}>
              {saving ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </div>
          <p id={labelHintId} className="text-xs text-[var(--muted)]">
            Pour la retrouver : n'est jamais publié.
          </p>
        </form>

        <section aria-labelledby="media-usages">
          <h3 id="media-usages" className="font-semibold">
            Utilisée par
          </h3>
          {media.usages.length ? (
            <ul className="mt-1">
              {media.usages.map((u) => (
                <li key={`${u.to}:${u.label}`}>
                  <Link to={u.to} className="link inline-flex min-h-11 items-center" onClick={onClose}>
                    {u.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[var(--muted)]">
              {media.previousVersion ? "Ancienne version d'une image recadrée : retirée après la prochaine publication." : "Aucune fiche."}
            </p>
          )}
        </section>

        <Recrop media={media} onDone={(id) => onChanged(id)} />

        <section aria-labelledby="media-infos">
          <h3 id="media-infos" className="font-semibold">
            Fichiers
          </h3>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-[var(--muted)]">Publiée</dt>
            <dd className="min-w-0">
              {media.width}×{media.height} px, {size(media.bytes)}
              {media.width2x ? ` ; haute densité ${media.width2x}×${media.height2x} px, ${size(media.bytes2x ?? 0)}` : " ; sans version haute densité"}
            </dd>
            <dt className="text-[var(--muted)]">Sur le site</dt>
            <dd className="min-w-0">{media.online === null ? "Inconnu avant la prochaine publication" : media.online ? "En ligne" : "Pas en ligne"}</dd>
            <dt className="text-[var(--muted)]">Adresse</dt>
            <dd className="min-w-0 break-all font-mono text-xs">{media.path}</dd>
            <dt className="text-[var(--muted)]">Original</dt>
            <dd className="min-w-0 break-words">
              {media.originalPath
                ? `${media.originalName ?? "conservé"}${media.originalBytes ? `, ${size(media.originalBytes)}` : ""}, sans métadonnées`
                : "Non conservé (envoyée avant la médiathèque ou reprise du site)"}
            </dd>
          </dl>
        </section>
      </div>
      <ConfirmDialog
        open={confirming}
        danger
        busy={deleting}
        title="Supprimer cette image ?"
        message="La version publiée, sa version haute densité et l'original sont supprimés de l'ERP. Aucune fiche ne l'utilise et elle n'est plus en ligne."
        confirmLabel="Supprimer"
        onConfirm={() => void remove()}
        onClose={() => setConfirming(false)}
      />
    </Modal>
  );
}

/** Recadrage d'une capture autour d'un point d'intérêt, choisi sur l'original (clic ou curseurs au clavier). */
function Recrop({ media, onDone }: { media: LibraryMedia; onDone: (id: string) => Promise<void> }) {
  const ratio = FRAME_RATIO[media.kind];
  const saved = useMemo(() => ({ x: media.focalX ?? 0.5, y: media.focalY ?? (media.kind === "MOBILE" ? 0 : 0.5) }), [media]);
  const [focal, setFocal] = useState(saved);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const xId = useId();
  const yId = useId();
  useEffect(() => setFocal(saved), [saved]);

  if (!ratio) {
    return (
      <section aria-labelledby="media-recrop">
        <h3 id="media-recrop" className="font-semibold">
          Recadrage
        </h3>
        <p className="mt-1 text-[var(--muted)]">Un logo garde ses proportions : pas de recadrage.</p>
      </section>
    );
  }
  if (!media.originalPath || failed) {
    return (
      <section aria-labelledby="media-recrop">
        <h3 id="media-recrop" className="font-semibold">
          Recadrage
        </h3>
        <p className="mt-1 text-[var(--muted)]">
          {failed ? "Original illisible sur le disque" : "Original non conservé (image envoyée avant la médiathèque ou reprise du site)"} : pour recadrer, renvoyer l'image depuis
          la fiche.
        </p>
      </section>
    );
  }

  const box = natural ? cropBox(natural.w, natural.h, ratio, focal) : null;
  const changed = Math.abs(focal.x - saved.x) > 0.005 || Math.abs(focal.y - saved.y) > 0.005 || media.focalX === null;
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

  async function apply() {
    setBusy(true);
    try {
      const next = await api<{ id: string }>(`/api/site/media/${media.id}/recadrage`, { method: "POST", body: JSON.stringify(focal) });
      toast.success(
        media.usages.length
          ? "Image recadrée : les fiches qui l'utilisent passent en « Modifié », à publier"
          : "Image recadrée",
      );
      await onDone(next.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Recadrage impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="media-recrop" className="space-y-3">
      <div>
        <h3 id="media-recrop" className="font-semibold">
          Recadrage
        </h3>
        <p className="mt-1 text-[var(--muted)]">
          Cliquer sur l'original pour placer le point d'intérêt : la zone claire est celle publiée. Recadrer crée une nouvelle version ; l'ancienne reste en
          ligne jusqu'à la prochaine publication.
        </p>
      </div>
      {/* Clic : raccourci souris ; les curseurs ci-dessous donnent le même réglage au clavier. */}
      <div
        className="relative mx-auto w-fit max-w-full cursor-crosshair overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)]"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setFocal({ x: Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), y: Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1) });
        }}
      >
        <img
          src={`/api/site/media/${media.id}/original`}
          alt={`Original de ${mediaName(media)}`}
          className="block h-auto max-h-[60vh] w-auto max-w-full"
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
        />
        {box ? (
          <span
            aria-hidden
            className="pointer-events-none absolute border-2 border-[var(--primary)] shadow-[var(--crop-mask)]"
            style={{ left: pct(box.left), top: pct(box.top), width: pct(box.width), height: pct(box.height) }}
          />
        ) : null}
        <span
          aria-hidden
          className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--primary-fg)] bg-[var(--primary)]"
          style={{ left: pct(focal.x), top: pct(focal.y) }}
        />
      </div>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-medium">Point d'intérêt</legend>
        <label htmlFor={xId} className="block space-y-1">
          <span className="block">Horizontal : {Math.round(focal.x * 100)} %</span>
          <input id={xId} type="range" min={0} max={100} step={1} value={Math.round(focal.x * 100)} onChange={(e) => setFocal((f) => ({ ...f, x: Number(e.target.value) / 100 }))} className="h-11 w-full accent-[var(--primary)]" />
        </label>
        <label htmlFor={yId} className="block space-y-1">
          <span className="block">Vertical : {Math.round(focal.y * 100)} %</span>
          <input id={yId} type="range" min={0} max={100} step={1} value={Math.round(focal.y * 100)} onChange={(e) => setFocal((f) => ({ ...f, y: Number(e.target.value) / 100 }))} className="h-11 w-full accent-[var(--primary)]" />
        </label>
      </fieldset>
      <Button variant="secondary" onClick={() => void apply()} disabled={busy || !changed}>
        <FontAwesomeIcon icon={faCrop} className="h-3.5 w-3.5" aria-hidden />
        {busy ? "Recadrage…" : "Appliquer le recadrage"}
      </Button>
    </section>
  );
}
