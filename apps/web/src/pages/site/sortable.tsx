import type { ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGripVertical } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type ScreenReaderInstructions,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "@/lib/api";
import { OrderButtons } from "./shared";

/**
 * Ordre complet après un nouvel ordre des éléments affichés (liste filtrée) : les éléments affichés gardent leurs
 * places dans l'ordre complet, dans le nouvel ordre ; les autres ne bougent pas.
 */
export function reorderVisible<T extends { id: string }>(all: T[], visible: T[], visibleIds: string[]): string[] {
  const shown = new Set(visible.map((r) => r.id));
  const queue = [...visibleIds];
  return all.map((r) => (shown.has(r.id) ? queue.shift()! : r.id));
}

/** Enregistre un ordre complet : vue mise à jour tout de suite, rétablie si l'enregistrement échoue. */
export async function saveIds<T extends { id: string }>(base: string, all: T[], ids: string[], setRows: (rows: T[]) => void): Promise<boolean> {
  const byId = new Map(all.map((r) => [r.id, r]));
  setRows(ids.map((id) => byId.get(id)!));
  try {
    await api(`${base}/reorder`, { method: "POST", body: JSON.stringify({ ids }) });
    return true;
  } catch (e) {
    setRows(all);
    toast.error(e instanceof Error ? e.message : "Ordre non enregistré");
    return false;
  }
}

const instructions: ScreenReaderInstructions = {
  draggable:
    "Pour déplacer cet élément : Espace ou Entrée pour le prendre, flèches haut et bas pour le déplacer, Espace ou Entrée pour le poser, Échap pour annuler.",
};

/**
 * Liste à réordonner : poignée à glisser (souris, doigt) ou au clavier, avec annonces au lecteur d'écran, et les
 * boutons Monter et Descendre gardés à côté (téléphone, ou clavier sans glisser).
 * Bibliothèque : @dnd-kit (MIT), validée par Alexandre pour le lot 3 ; ses capteurs clavier et ses annonces évitent
 * de réécrire un glisser-déposer accessible.
 */
export function SortableList<T extends { id: string }>({
  items,
  name,
  render,
  onReorder,
}: {
  items: T[];
  name: (item: T) => string;
  render: (item: T) => ReactNode;
  /** Nouvel ordre des éléments affichés. */
  onReorder: (ids: string[]) => void;
}) {
  const sensors = useSensors(
    // Petit seuil : un clic sur la poignée ne déclenche pas de déplacement involontaire.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const label = (id: string | number) => {
    const it = items.find((x) => x.id === id);
    return it ? name(it) : "Élément";
  };
  const position = (id: string | number) => items.findIndex((x) => x.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `${label(active.id)} pris, position ${position(active.id)} sur ${items.length}.`,
    onDragOver: ({ active, over }) => (over ? `${label(active.id)} au-dessus de la position ${position(over.id)} sur ${items.length}.` : `${label(active.id)} hors de la liste.`),
    onDragEnd: ({ active, over }) => (over ? `${label(active.id)} posé en position ${position(over.id)} sur ${items.length}.` : `${label(active.id)} reposé à sa place.`),
    onDragCancel: ({ active }) => `Déplacement annulé : ${label(active.id)} reste en position ${position(active.id)}.`,
  };

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((x) => x.id === active.id);
    const to = items.findIndex((x) => x.id === over.id);
    onReorder(arrayMove(items, from, to).map((x) => x.id));
  }

  const move = (id: string, dir: -1 | 1) => {
    const i = items.findIndex((x) => x.id === id);
    if (i + dir < 0 || i + dir >= items.length) return;
    onReorder(arrayMove(items, i, i + dir).map((x) => x.id));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements, screenReaderInstructions: instructions }}>
      <SortableContext items={items.map((x) => x.id)} strategy={verticalListSortingStrategy}>
        <ol className="divide-y divide-[var(--border)]">
          {items.map((item, i) => (
            <SortableRow key={item.id} id={item.id} name={name(item)}>
              <span className="hidden w-6 shrink-0 text-right font-mono text-sm text-[var(--muted)] sm:inline" aria-hidden>
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">{render(item)}</div>
              <OrderButtons name={name(item)} first={i === 0} last={i === items.length - 1} onMove={(d) => move(item.id, d)} />
            </SortableRow>
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ id, name, children }: { id: string; name: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative flex min-w-0 items-center gap-2 bg-[var(--surface)] px-2 py-1.5 motion-reduce:transition-none ${isDragging ? "z-10 rounded-[var(--radius-sm)] shadow-[var(--shadow)] ring-1 ring-[var(--primary)]" : ""}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Déplacer : ${name}`}
        className="inline-flex min-h-11 min-w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] active:cursor-grabbing"
      >
        <FontAwesomeIcon icon={faGripVertical} className="h-4 w-4" aria-hidden />
      </button>
      {children}
    </li>
  );
}
