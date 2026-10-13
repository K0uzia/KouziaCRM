type DocKind = "INVOICE" | "CREDIT_NOTE" | "QUOTE" | string;

/**
 * Une seule couleur pour tous les numéros : le type (acompte, solde, avoir) est porté par le
 * badge à côté (InvoiceTypeBadge), pas par la couleur seule.
 */
function colorClass(_documentType: DocKind, _invoiceType?: string | null): string {
  return "text-[var(--primary)]";
}

/** Numéro compact coloré selon le type. */
export function DocumentNumberBadge({
  number,
  documentType,
  invoiceType,
  className = "",
}: {
  number: string | null | undefined;
  documentType: DocKind;
  invoiceType?: string | null;
  className?: string;
}) {
  if (!number) {
    return (
      <span className={`text-xs italic text-[var(--muted)] ${className}`}>
        Brouillon
      </span>
    );
  }

  return (
    <span
      className={`font-mono text-sm font-semibold tabular-nums tracking-tight ${colorClass(documentType, invoiceType)} ${className}`}
    >
      {number}
    </span>
  );
}
