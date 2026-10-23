import { Children, cloneElement, isValidElement, useEffect, useId, useState } from "react";
import type { ComponentPropsWithRef, SelectHTMLAttributes, ReactNode } from "react";
import { useMediaQuery } from "@/lib/use-media-query";
import { Listbox } from "@/components/ui/Listbox";
import { DatePicker, type DatePickerProps } from "@/components/ui/DatePicker";

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const noteId = hint || error ? `${id}-note` : undefined;
  const single = Children.count(children) === 1 && isValidElement<Record<string, unknown>>(children) ? children : null;
  // Champ date : son bouton de calendrier est dans le label ; nommé par le seul libellé, sinon le nom du bouton
  // s'ajouterait au sien (« Date Changer la date, … »).
  const labelled = single?.type === DateInput;
  // Aide et erreur : description du contrôle (aria-describedby), pas une partie de son nom.
  // aria-hidden les retire du nom calculé depuis le label ; la référence par id reste lue.
  const describedChild =
    single && (noteId || labelled)
      ? cloneElement(single, {
          ...(labelled ? { "aria-labelledby": single.props["aria-labelledby"] ?? labelId } : {}),
          ...(noteId ? { "aria-describedby": single.props["aria-describedby"] ?? noteId } : {}),
          ...(error ? { "aria-invalid": true } : {}),
        })
      : children;
  const linked = describedChild !== children;
  return (
    <label className={`block min-w-0 space-y-1.5 ${className}`}>
      <span id={labelId} className="block text-sm font-medium text-[var(--text)]">
        {label}
      </span>
      {describedChild}
      {hint && !error ? (
        <span id={noteId} aria-hidden={linked || undefined} className="block text-xs text-[var(--muted)]">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={noteId} aria-hidden={linked || undefined} className="block text-sm text-[var(--danger)]">
          {error}
        </span>
      ) : null}
    </label>
  );
}

const control =
  "w-full rounded-[var(--radius)] border border-[var(--border-input)] bg-[var(--surface-raised)] px-3 text-sm text-[var(--text)] placeholder:text-[var(--muted)] ui-field transition disabled:bg-[var(--bg-subtle)] disabled:opacity-70";
/** Hauteur fixe (--field-h) : un champ d'une ligne ne s'étire plus dans une grille à côté d'une zone de texte. */
const singleLine = "h-[var(--field-h)]";

// React 19 : ref est une prop ordinaire, transmise avec le reste (focus programmatique).
export function Input({ className = "", ...props }: ComponentPropsWithRef<"input">) {
  return <input className={`${control} ${singleLine} ${className}`} {...props} />;
}

/**
 * Liste de choix : panneau au design de l'ERP dès 640 px avec une souris (Listbox) ; liste native au téléphone ou au
 * doigt, plus grande sous le pouce, avec l'accessibilité du système (décision E4, 23/10/2026).
 */
export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const native = useMediaQuery("(max-width: 639.98px), (pointer: coarse)");
  const classes = `${control} ${singleLine} ui-select ${className}`;
  return native ? <select className={classes} {...props} /> : <Listbox className={classes} {...props} />;
}

/**
 * Champ date (valeur « AAAA-MM-JJ ») : saisie et calendrier de l'ERP dès 640 px avec une souris (DatePicker) ; champ
 * date natif au téléphone ou au doigt, avec le sélecteur du système (décision E5, 23/10/2026).
 */
export function DateInput({ value, onChange, className = "", ...props }: DatePickerProps) {
  const native = useMediaQuery("(max-width: 639.98px), (pointer: coarse)");
  const classes = `${control} ${singleLine} ${className}`;
  return native ? (
    <input type="date" className={classes} value={value} onChange={(e) => onChange(e.target.value)} {...props} />
  ) : (
    <DatePicker className={classes} value={value} onChange={onChange} {...props} />
  );
}

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/**
 * Mois et année (valeur « AAAA-MM ») : deux listes, mois puis année, au design de l'ERP (Select : Listbox à la souris,
 * liste native au téléphone). Remplace le champ mois natif, réduit à un champ texte par Firefox et Safari de bureau.
 * La valeur n'est émise qu'une fois les deux choisis ; « » tant qu'il en manque un.
 */
export function MonthField({
  label,
  hint,
  error,
  value,
  onChange,
  minYear = 1996,
  maxYear = new Date().getFullYear(),
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  minYear?: number;
  maxYear?: number;
  className?: string;
}) {
  const id = useId();
  const noteId = hint || error ? `${id}-note` : undefined;
  const parsed = /^(d{4})-(d{2})$/.exec(value);
  const [year, setYear] = useState(parsed?.[1] ?? "");
  const [month, setMonth] = useState(parsed?.[2] ?? "");
  // Valeur changée de l'extérieur (fiche rechargée) : les deux listes suivent.
  useEffect(() => {
    const m = /^(d{4})-(d{2})$/.exec(value);
    if (m) {
      setYear(m[1]!);
      setMonth(m[2]!);
    }
  }, [value]);
  const emit = (y: string, m: string) => onChange(y && m ? `${y}-${m}` : "");
  const years = Array.from({ length: Math.max(0, maxYear - minYear + 1) }, (_, i) => String(maxYear - i));
  const describe = { "aria-describedby": noteId, ...(error ? { "aria-invalid": true } : {}) };
  return (
    <fieldset className={`min-w-0 space-y-1.5 ${className}`}>
      <legend className="mb-1.5 text-sm font-medium text-[var(--text)]">{label}</legend>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-2">
        <label className="block min-w-0">
          <span className="sr-only">{`Mois (${label})`}</span>
          <Select
            value={month}
            {...describe}
            onChange={(e) => {
              setMonth(e.target.value);
              emit(year, e.target.value);
            }}
          >
            <option value="">Mois</option>
            {MONTHS.map((name, i) => (
              <option key={name} value={String(i + 1).padStart(2, "0")}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block min-w-0">
          <span className="sr-only">{`Année (${label})`}</span>
          <Select
            value={year}
            {...describe}
            onChange={(e) => {
              setYear(e.target.value);
              emit(e.target.value, month);
            }}
          >
            <option value="">Année</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {hint && !error ? (
        <span id={noteId} className="block text-xs text-[var(--muted)]">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={noteId} className="block text-sm text-[var(--danger)]">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

export function Textarea({ className = "", ...props }: ComponentPropsWithRef<"textarea">) {
  return <textarea className={`${control} min-h-24 resize-y py-2.5 ${className}`} {...props} />;
}

/** Case à cocher avec son libellé : toute la ligne est cliquable (44 px), la case suit --check-size. */
export function Checkbox({
  label,
  hint,
  className = "",
  ...props
}: Omit<ComponentPropsWithRef<"input">, "type"> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className={`flex min-h-11 cursor-pointer items-start gap-3 py-2.5 text-sm ${className}`}>
      <input type="checkbox" className="mt-px" {...props} />
      <span className="min-w-0">
        <span className="block text-[var(--text)]">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-[var(--muted)]">{hint}</span> : null}
      </span>
    </label>
  );
}
