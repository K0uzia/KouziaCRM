type DocKind = "INVOICE" | "CREDIT_NOTE" | "QUOTE" | string;

/** Couleurs par nature de document / facture marché. */
function colorClass(documentType: DocKind, invoiceType?: string | null): string {
  if (documentType === "QUOTE") return "text-violet-700";
  if (documentType === "CREDIT_NOTE") return "text-red-700";
  if (invoiceType === "ACOMPTE") return "text-sky-700";
  if (invoiceType === "SOLDE") return "text-indigo-700";
  return "text-teal-800"; // facture simple
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
