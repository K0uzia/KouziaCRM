import { useEffect, useRef } from "react";
import { DayPicker, type Matcher } from "react-day-picker";
import { fr } from "react-day-picker/locale/fr";
import "./date-calendar.css";

/**
 * Grille du DatePicker (react-day-picker), dans son propre fichier : chargée à la première ouverture d'un calendrier,
 * elle ne pèse pas sur le chargement des écrans (≈ 25 Ko compressés avec date-fns et sa feuille).
 */
export default function DateCalendar({
  selected,
  minDate,
  maxDate,
  required,
  canClear,
  todayAllowed,
  onPick,
}: {
  selected: Date | undefined;
  minDate: Date | null;
  maxDate: Date | null;
  required?: boolean;
  canClear: boolean;
  todayAllowed: boolean;
  /** Date choisie (« AAAA-MM-JJ »), ou "" pour effacer. */
  onPick: (iso: string) => void;
}) {
  const today = new Date();
  const thisYear = today.getFullYear();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const disabled: Matcher[] = [...(minDate ? [{ before: minDate }] : []), ...(maxDate ? [{ after: maxDate }] : [])];
  const gridRef = useRef<HTMLDivElement>(null);
  // Ouverture : focus sur le jour actif de la grille (date choisie, sinon aujourd'hui), sans attendre autoFocus.
  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>(".rdp-day button[tabindex=\"0\"]")?.focus();
  }, []);
  return (
    <div ref={gridRef}>
      <DayPicker
        mode="single"
        locale={fr}
        weekStartsOn={1}
        autoFocus
        captionLayout="dropdown"
        startMonth={minDate ?? new Date(thisYear - 30, 0)}
        endMonth={maxDate ?? new Date(thisYear + 10, 11)}
        defaultMonth={selected ?? (maxDate && maxDate < today ? maxDate : minDate && minDate > today ? minDate : today)}
        selected={selected}
        disabled={disabled}
        onSelect={(d) => (d ? onPick(iso(d)) : !required && onPick(""))}
      />
      <div className="mt-2 flex flex-wrap justify-between gap-2 border-t border-[var(--border)] pt-2">
        {todayAllowed ? (
          <button type="button" className="min-h-11 rounded-[var(--radius-sm)] px-3 text-sm font-medium text-[var(--primary)] hover:bg-[var(--surface-hover)]" onClick={() => onPick(iso(today))}>
            Aujourd'hui
          </button>
        ) : (
          <span />
        )}
        {canClear ? (
          <button type="button" className="min-h-11 rounded-[var(--radius-sm)] px-3 text-sm text-[var(--muted)] hover:bg-[var(--surface-hover)]" onClick={() => onPick("")}>
            Effacer
          </button>
        ) : null}
      </div>
    </div>
  );
}
