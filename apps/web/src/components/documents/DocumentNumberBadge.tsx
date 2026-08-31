type DocKind = "INVOICE" | "CREDIT_NOTE" | "QUOTE" | string;

/** Couleurs par nature de document / facture marché. */
function colorClass(documentType: DocKind, invoiceType?: string | null): string {
  if (documentType === "QUOTE") return "text-[var(--info)]";
  if (documentType === "CREDIT_NOTE") return "text-[var(--danger)]";
  if (invoiceType === "ACOMPTE") return "text-[var(--warning)]";
  if (invoiceType === "SOLDE") return "text-[var(--info)]";
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
