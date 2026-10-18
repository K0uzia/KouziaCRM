import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Ligne d'une liste au téléphone (clients, devis, factures, encaissements, livre de recettes) : un seul gabarit.
 * Ligne 1 : le titre (qui) et le montant à droite en chiffres tabulaires ; ligne 2 : le détail (numéro, date,
 * ville) et les statuts à droite. Toute la carte est le lien (cible de 44 px au moins) ; sans `to`, simple bloc.
 */
export function ListRow({
  to,
  title,
  amount,
  meta,
  badges,
  leading,
}: {
  /** Fiche à ouvrir ; sans lien (encaissement sans facture), la ligne est un simple bloc. */
  to?: string;
  title: ReactNode;
  /** Montant déjà formaté (formatEUR). */
  amount?: string | null;
  meta?: ReactNode;
  badges?: ReactNode;
  /** Avatar ou icône à gauche. */
  leading?: ReactNode;
}) {
  const box =
    "flex min-h-11 min-w-0 items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5";
  const content = (
    <>
      {leading}
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="line-clamp-2 min-w-0 break-words text-sm font-medium text-[var(--text)]">{title}</span>
          {amount != null ? <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--text)]">{amount}</span> : null}
        </span>
        {meta || badges ? (
          // Numéro et date jamais coupés par les statuts : ceux-ci passent à la ligne s'il le faut, à droite.
          <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="max-w-full shrink-0 truncate text-xs text-[var(--muted)]">{meta}</span>
            {badges ? <span className="ml-auto flex flex-wrap justify-end gap-1">{badges}</span> : null}
          </span>
        ) : null}
      </span>
    </>
  );
  if (!to) return <div className={box}>{content}</div>;
  return (
    <Link to={to} className={`${box} transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-raised)]`}>
      {content}
    </Link>
  );
}
