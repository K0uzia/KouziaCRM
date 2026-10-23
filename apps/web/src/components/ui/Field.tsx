import { Children, cloneElement, isValidElement, useId } from "react";
import type { ComponentPropsWithRef, SelectHTMLAttributes, ReactNode } from "react";

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
  const noteId = hint || error ? `${id}-note` : undefined;
  // Aide et erreur : description du contrôle (aria-describedby), pas une partie de son nom.
  // aria-hidden les retire du nom calculé depuis le label ; la référence par id reste lue.
  const describedChild =
    noteId && Children.count(children) === 1 && isValidElement<Record<string, unknown>>(children)
      ? cloneElement(children, {
          "aria-describedby": children.props["aria-describedby"] ?? noteId,
          ...(error ? { "aria-invalid": true } : {}),
        })
      : children;
  const linked = describedChild !== children;
  return (
    <label className={`block min-w-0 space-y-1.5 ${className}`}>
      <span className="block text-sm font-medium text-[var(--text)]">{label}</span>
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

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${control} ${singleLine} ui-select ${className}`} {...props} />;
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
