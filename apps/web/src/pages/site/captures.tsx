import { useRef, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDesktop, faGripVertical, faMobileScreen, faPhotoFilm, faUpload } from "@fortawesome/free-solid-svg-icons";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { guessVueOfFile, proposeCaptionText, proposeCaptureAlt, type MediaNames } from "@/lib/site-proposals";
import { ImageField, OrderButtons, SiteImage } from "./shared";

export const MAX_CAPTURES = 6;

/** Capture de la page projet dans le formulaire ; key, altAuto et captionAuto sont propres à l'écran, jamais envoyés. */
export type CaptureForm = {
  key: string;
  image: string | null;
  alt: string;
  caption: string;
  vue: "bureau" | "mobile";
  altAuto?: boolean | null;
  captionAuto?: boolean | null;
};

let seq = 0;
/** Identifiant de ligne pour le glisser-déposer (les captures n'en ont pas côté API). */
export const captureKey = () => `capture-${++seq}`;

const VUE_LABEL = { bureau: "Ordinateur", mobile: "Téléphone" } as const;

/**
 * Champ d'un texte proposé d'après le contexte (alt, légende) : signalé « proposé » tant qu'il n'est pas retouché ;
 * retouché, il ne bouge plus et la proposition peut être reprise.
 */
export function ProposedInput({
  label,
  hint,
  max,
  value,
  auto,
  proposal,
  onChange,
  onReset,
}: {
  label: string;
  hint?: string;
  max: number;
  value: string;
  auto: boolean | null | undefined;
  proposal: string;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const proposed = Boolean(auto && value);
  const lead = proposed ? "Proposé d'après le projet, la vue et l'image : à corriger s'il ne décrit pas ce qu'on voit." : (hint ?? "");
  return (
    <div className="space-y-1">
      <Field label={label} hint={`${lead ? `${lead} ` : ""}${value.length} / ${max}`}>
        <Input maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
      {!auto && proposal && value !== proposal ? (
        <Button variant="ghost" onClick={onReset}>
          Reprendre la proposition<span className="sr-only"> : {label}</span>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Captures de la page projet : vignettes compactes (2 par ligne au téléphone, 3 ou 4 au-delà) à réordonner en les
 * glissant (souris, doigt, clavier) ou par Monter / Descendre, panneau d'édition de la capture choisie, envoi de
 * plusieurs fichiers d'un coup avec la vue devinée d'après le format.
 */
export function CaptureGallery({
  captures,
  setCaptures,
  project,
  names,
  error,
}: {
  captures: CaptureForm[];
  setCaptures: (update: (list: CaptureForm[]) => CaptureForm[]) => void;
  project: { kind: string; name: string; nature: string };
  names: MediaNames | null;
  error?: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Rien de choisi (ouverture, capture retirée) : la première capture.
  const found = captures.findIndex((c) => c.key === selected);
  const current = found >= 0 ? found : captures.length ? 0 : -1;
  const capture = current >= 0 ? captures[current]! : null;
  const nameAt = (i: number) => `Capture ${i + 1}`;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const position = (id: string | number) => captures.findIndex((c) => c.key === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Capture ${position(active.id)} prise, position ${position(active.id)} sur ${captures.length}.`,
    onDragOver: ({ over }) => (over ? `Au-dessus de la position ${position(over.id)} sur ${captures.length}.` : "Hors de la grille."),
    onDragEnd: ({ over }) => (over ? `Posée en position ${position(over.id)} sur ${captures.length}.` : "Reposée à sa place."),
    onDragCancel: () => "Déplacement annulé.",
  };
  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    setCaptures((list) => arrayMove(list, list.findIndex((c) => c.key === active.id), list.findIndex((c) => c.key === over.id)));
  }

  const patch = (key: string, p: Partial<CaptureForm>) => setCaptures((list) => list.map((c) => (c.key === key ? { ...c, ...p } : c)));
  const move = (key: string, dir: -1 | 1) =>
    setCaptures((list) => {
      const i = list.findIndex((c) => c.key === key);
      return i + dir < 0 || i + dir >= list.length ? list : arrayMove(list, i, i + dir);
    });
  function remove(key: string) {
    const i = captures.findIndex((c) => c.key === key);
    const next = captures[i + 1] ?? captures[i - 1] ?? null;
    setCaptures((list) => list.filter((c) => c.key !== key));
    setSelected(next?.key ?? null);
  }
  function addEmpty() {
    const key = captureKey();
    setCaptures((list) => [...list, { key, image: null, alt: "", caption: "", vue: "bureau", altAuto: true, captionAuto: true }]);
    setSelected(key);
  }

  // Envoi l'un après l'autre : le serveur traite une image à la fois (sharp, mémoire bornée).
  async function uploadMany(files: File[]) {
    const room = MAX_CAPTURES - captures.length;
    const chosen = files.slice(0, Math.max(0, room));
    if (files.length > chosen.length) {
      const extra = files.length - chosen.length;
      toast.warning(`${MAX_CAPTURES} captures au plus : ${extra} fichier${extra > 1 ? "s" : ""} non envoyé${extra > 1 ? "s" : ""}.`);
    }
    if (!chosen.length) return;
    setBusy(true);
    const id = toast.loading(chosen.length > 1 ? `Envoi de ${chosen.length} captures…` : "Envoi de la capture…");
    const added: CaptureForm[] = [];
    const refused: string[] = [];
    for (const file of chosen) {
      const vue = await guessVueOfFile(file);
      try {
        const body = new FormData();
        body.append("file", file);
        const media = await api<{ path: string }>(`/api/site/media?kind=${vue === "mobile" ? "MOBILE" : "CAPTURE"}`, { method: "POST", body });
        added.push({ key: captureKey(), image: media.path, alt: "", caption: "", vue, altAuto: true, captionAuto: true });
      } catch (e) {
        refused.push(`${file.name} : ${e instanceof Error ? e.message : "envoi impossible"}`);
      }
    }
    if (added.length) {
      setCaptures((list) => [...list, ...added].slice(0, MAX_CAPTURES));
      setSelected(added[0]!.key);
    }
    const phones = added.filter((c) => c.vue === "mobile").length;
    const summary = `${added.length} capture${added.length > 1 ? "s" : ""} ajoutée${added.length > 1 ? "s" : ""}${phones ? ` (dont ${phones} en téléphone, d'après le format)` : ""}`;
    if (refused.length) toast.error(`${added.length ? `${summary}. ` : ""}Refusée${refused.length > 1 ? "s" : ""} : ${refused.join(" ; ")}`, { id });
    else toast.success(summary, { id });
    setBusy(false);
    if (input.current) input.current.value = "";
  }

  return (
    <fieldset className="@container min-w-0 space-y-3 rounded-[var(--radius)] border border-[var(--border)] p-4" aria-describedby={`captures-aide${error ? " captures-err" : ""}`}>
      <legend className="px-1 text-sm font-medium">Captures ({MAX_CAPTURES} au plus)</legend>
      <p id="captures-aide" className="text-xs text-[var(--muted)]">
        Glisser une vignette par sa poignée pour changer l'ordre, ou Monter et Descendre dans le panneau. Envoyées à plusieurs, une image en hauteur de 1 290 px de large au plus part en téléphone, les autres en ordinateur.
      </p>
      <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]">
        <div className="min-w-0 space-y-3">
          {captures.length ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
              accessibility={{
                announcements,
                screenReaderInstructions: {
                  draggable: "Pour déplacer la capture : Espace ou Entrée pour la prendre, flèches pour la déplacer, Espace ou Entrée pour la poser, Échap pour annuler.",
                },
              }}
            >
              <SortableContext items={captures.map((c) => c.key)} strategy={rectSortingStrategy}>
                <ol className="grid grid-cols-2 gap-2 @md:grid-cols-3 @2xl:grid-cols-4" aria-label="Ordre des captures">
                  {captures.map((c, i) => (
                    <CaptureTile key={c.key} capture={c} name={nameAt(i)} selected={i === current} onSelect={() => setSelected(c.key)} />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
          ) : (
            <p className="text-sm text-[var(--muted)]">Aucune capture : la page projet n'affiche que la carte.</p>
          )}
          {captures.length < MAX_CAPTURES ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
                <FontAwesomeIcon icon={faUpload} className="h-3.5 w-3.5" aria-hidden />
                {busy ? "Envoi…" : "Envoyer des captures"}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={addEmpty}>
                <FontAwesomeIcon icon={faPhotoFilm} className="h-3.5 w-3.5" aria-hidden />
                Ajouter depuis la médiathèque
              </Button>
              <input
                ref={input}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/avif"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => void uploadMany([...(e.target.files ?? [])])}
              />
            </div>
          ) : null}
        </div>
        {capture ? (
          <section aria-labelledby="capture-panneau" className="min-w-0 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p id="capture-panneau" className="text-sm font-semibold">
                {nameAt(current)}
              </p>
              <OrderButtons name={nameAt(current)} first={current === 0} last={current === captures.length - 1} onMove={(dir) => move(capture.key, dir)} />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Vue</p>
              {/* Changer de vue retire l'image : une capture d'ordinateur et une de téléphone ne sont pas du même type. */}
              <Segmented
                label={`Vue de la ${nameAt(current).toLowerCase()}`}
                options={[
                  { id: "bureau", label: "Ordinateur", icon: faDesktop },
                  { id: "mobile", label: "Téléphone", icon: faMobileScreen },
                ]}
                value={capture.vue}
                onChange={(vue) => patch(capture.key, vue === capture.vue ? {} : { vue, image: null })}
              />
            </div>
            <ImageField
              label={`Image de la capture ${current + 1}`}
              kind={capture.vue === "mobile" ? "MOBILE" : "CAPTURE"}
              allowRepoPath={false}
              value={capture.image}
              onChange={(image) => patch(capture.key, { image })}
            />
            <ProposedInput
              label={`Texte alternatif de la capture ${current + 1}`}
              hint="Ce que montre la capture."
              max={200}
              value={capture.alt}
              auto={capture.altAuto}
              proposal={names ? proposeCaptureAlt(project, captures, current, names) : ""}
              onChange={(alt) => patch(capture.key, { alt, altAuto: false })}
              onReset={() => patch(capture.key, { altAuto: true })}
            />
            <ProposedInput
              label={`Légende de la capture ${current + 1} (facultatif)`}
              max={150}
              value={capture.caption}
              auto={capture.captionAuto}
              proposal={names ? proposeCaptionText(capture, names) : ""}
              onChange={(caption) => patch(capture.key, { caption, captionAuto: false })}
              onReset={() => patch(capture.key, { captionAuto: true })}
            />
            <Button variant="danger-ghost" onClick={() => remove(capture.key)}>
              Retirer la capture {current + 1}
            </Button>
          </section>
        ) : null}
      </div>
      {error ? (
        <p id="captures-err" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Vignette : choisir la capture (bouton) et la déplacer (poignée). */
function CaptureTile({ capture, name, selected, onSelect }: { capture: CaptureForm; name: string; selected: boolean; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: capture.key });
  const missing = !capture.image || !capture.alt.trim();
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative min-w-0 rounded-[var(--radius-sm)] border bg-[var(--surface)] motion-reduce:transition-none ${
        selected ? "border-[var(--primary)]" : "border-[var(--border)]"
      } ${isDragging ? "z-10 shadow-[var(--shadow)]" : ""}`}
    >
      <button type="button" aria-pressed={selected} onClick={onSelect} className="block w-full min-w-0 rounded-[var(--radius-sm)] text-left hover:bg-[var(--surface-hover)]">
        <span aria-hidden className="block">
          <SiteImage path={capture.image} alt="" className="aspect-[4/3] w-full rounded-t-[var(--radius-sm)] object-contain" />
        </span>
        <span className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-1.5 px-2 py-1 text-xs">
          <span className="font-medium">{name}</span>
          <span className="text-[var(--muted)]">{VUE_LABEL[capture.vue]}</span>
          {missing ? <span className="text-[var(--warning)]">{capture.image ? "alt manquant" : "sans image"}</span> : null}
        </span>
      </button>
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Déplacer : ${name}`}
        className="absolute right-1 top-1 inline-flex min-h-11 min-w-11 cursor-grab touch-none items-center justify-center rounded-[var(--radius-sm)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)] active:cursor-grabbing"
      >
        <FontAwesomeIcon icon={faGripVertical} className="h-4 w-4" aria-hidden />
      </button>
    </li>
  );
}
