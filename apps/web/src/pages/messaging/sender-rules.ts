export type SenderRule = {
  id: string;
  kind: "ADDRESS" | "DOMAIN";
  value: string;
  action: "BLOCK" | "TRUST";
  source: string;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
};

/** Ligne de suivi d'une règle : nombre de messages écartés et dernière fois (blocage), date d'ajout sinon. */
export function ruleCounter(
  rule: Pick<SenderRule, "action" | "hitCount" | "lastHitAt" | "createdAt" | "source">,
  formatDate: (d: string) => string,
): string {
  const added = `Ajouté le ${formatDate(rule.createdAt)}${rule.source === "REPORT" ? " en signalant un indésirable" : ""}`;
  if (rule.action !== "BLOCK") return added;
  if (rule.hitCount === 0) return `${added}. Aucun message bloqué pour l'instant.`;
  const n = rule.hitCount === 1 ? "1 message bloqué" : `${rule.hitCount} messages bloqués`;
  return rule.lastHitAt ? `${n}, le dernier le ${formatDate(rule.lastHitAt)}` : n;
}
