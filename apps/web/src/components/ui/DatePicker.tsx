import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCalendarDays } from "@fortawesome/free-solid-svg-icons";
import { useAnchoredPanel } from "@/lib/use-anchored-panel";

/** « AAAA-MM-JJ » (valeur des champs date) en date locale ; null si la valeur n'en est pas une. */
export function parseIsoDate(value: string | undefined | null): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}
export const toIsoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Saisie au clavier « JJ/MM/AAAA » (séparateurs / . - ou espace) en « AAAA-MM-JJ » ; null si incomplète ou impossible. */
export function parseTypedDate(text: string): string | null {
  const m = /^\s*(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{4})\s*$/.exec(text);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return parseIsoDate(iso) ? iso : null;
}
const display = (iso: string) => {
  const d = parseIsoDate(iso);
  return d ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : "";
};
const longDate = new Intl.DateTimeFormat("fr-FR", { dateStyle: "full" });

// Grille chargée à la demande (première ouverture), préchargée au survol ou au focus du bouton.
const loadCalendar = () => import("@/components/ui/DateCalendar");
const DateCalendar = lazy(loadCalendar);

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type DatePickerProps = {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
};

/**
 * Champ date de l'ERP dès 640 px avec une souris (décision E5, 23/10/2026) : saisie « JJ/MM/AAAA » et calendrier
 * react-day-picker (MIT, maintenu, typé ; l'accessibilité d'une grille de dates ne s'écrit pas en quelques lignes).
 * Calendrier en fenêtre de dialogue (motif APG « Date Picker Dialog ») : flèches dans la grille, Tab bouclé dans la
 * fenêtre, Échap la ferme et rend le focus au bouton. Au téléphone, Field choisit le champ date natif.
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  required,
  disabled,
  id,
  name,
  className = "",
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(display(value));
  const [typedError, setTypedError] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const errorId = useId();
  const position = useAnchoredPanel(open, wrapRef, { minWidth: 336, maxHeight: 460, flipBelow: 400 });
  const selected = parseIsoDate(value) ?? undefined;
  const minDate = parseIsoDate(min);
  const maxDate = parseIsoDate(max);
  const outOfRange = (iso: string) => Boolean((min && iso < min) || (max && iso > max));

  // Valeur changée de l'extérieur (formulaire rechargé) : la saisie suit.
  useEffect(() => {
    setDraft(display(value));
    setTypedError(false);
  }, [value]);

  // Clic hors du champ et du calendrier : fermeture, sans voler le focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !wrapRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Focus rendu avant la fermeture : jamais laissé sur la page, même un instant, quand le calendrier disparaît.
  function close() {
    buttonRef.current?.focus();
    setOpen(false);
  }

  function pick(iso: string) {
    onChange(iso);
    setDraft(display(iso));
    setTypedError(false);
    inputRef.current?.focus();
    setOpen(false);
  }

  function commitTyped() {
    if (!draft.trim()) {
      if (value) onChange("");
      setTypedError(false);
      return;
    }
    const iso = parseTypedDate(draft);
    if (iso && !outOfRange(iso)) {
      if (iso !== value) onChange(iso);
      setDraft(display(iso));
      setTypedError(false);
    } else setTypedError(true);
  }

  // Dans la fenêtre : Échap ferme, Tab boucle ; ni l'un ni l'autre ne remonte à une fenêtre modale autour.
  function onPanelKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    e.stopPropagation();
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const todayIso = toIsoDate(new Date());
  const errorShown = typedError ? errorId : undefined;

  return (
    <div ref={wrapRef} className="relative min-w-0">
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="jj/mm/aaaa"
        value={draft}
        required={required}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-describedby={[describedBy, errorShown].filter(Boolean).join(" ") || undefined}
        aria-invalid={typedError || invalid === true || invalid === "true" ? true : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          const iso = parseTypedDate(e.target.value);
          if (iso && !outOfRange(iso)) {
            setTypedError(false);
            if (iso !== value) onChange(iso);
          }
        }}
        onBlur={commitTyped}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && e.altKey) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`${className} pr-12`}
      />
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={value ? `Changer la date, ${longDate.format(parseIsoDate(value)!)}` : "Choisir une date dans le calendrier"}
        onClick={() => setOpen((o) => !o)}
        onPointerEnter={() => void loadCalendar()}
        onFocus={() => void loadCalendar()}
        className="absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center rounded-r-[var(--radius)] text-[var(--muted)] transition-colors hover:text-[var(--text)] disabled:opacity-50"
      >
        <FontAwesomeIcon icon={faCalendarDays} className="h-4 w-4" aria-hidden />
      </button>
      {typedError ? (
        <span id={errorId} className="mt-1 block text-sm text-[var(--danger)]">
          {min || max
            ? `Date attendue au format jj/mm/aaaa${min ? `, à partir du ${display(min)}` : ""}${max ? `, jusqu'au ${display(max)}` : ""}.`
            : "Date attendue au format jj/mm/aaaa."}
        </span>
      ) : null}
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={dialogId}
              role="dialog"
              aria-modal="true"
              aria-label="Choisir une date"
              style={position}
              onKeyDown={onPanelKeyDown}
              className="fixed z-[60] overflow-y-auto overscroll-contain rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] p-3 shadow-[var(--shadow)]"
            >
              <Suspense
                fallback={
                  <p className="p-4 text-sm text-[var(--muted)]" role="status">
                    Chargement du calendrier…
                  </p>
                }
              >
                <DateCalendar
                  selected={selected}
                  minDate={minDate}
                  maxDate={maxDate}
                  required={required}
                  canClear={!required && Boolean(value)}
                  todayAllowed={!outOfRange(todayIso)}
                  onPick={pick}
                />
              </Suspense>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
