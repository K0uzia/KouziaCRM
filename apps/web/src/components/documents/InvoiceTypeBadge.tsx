import { Badge } from "@/components/ui/Card";

const tones: Record<string, "blue" | "violet" | "teal" | "red" | "neutral"> = {
  ACOMPTE: "blue",
  SOLDE: "violet",
  SIMPLE: "teal",
  CREDIT_NOTE: "red",
  QUOTE: "violet",
};

const labels: Record<string, string> = {
  ACOMPTE: "Acompte",
  SOLDE: "Solde",
  SIMPLE: "Facture",
  CREDIT_NOTE: "Avoir",
  QUOTE: "Devis",
};

/** Badge type : ACOMPTE / SOLDE toujours ; SIMPLE optionnel via showSimple. */
export function InvoiceTypeBadge({
  type,
  showSimple = false,
  compact = false,
}: {
  type?: string | null;
  showSimple?: boolean;
  /** Dans une liste : badge resserré, sur la même ligne que le numéro. */
  compact?: boolean;
}) {
  if (!type) return null;
  if (type === "SIMPLE" && !showSimple) return null;
  const tone = tones[type] ?? "neutral";
  return (
    <Badge tone={tone} className={compact ? "shrink-0 px-1.5 py-0.5 leading-tight" : ""}>
      {labels[type] ?? type}
    </Badge>
  );
}
