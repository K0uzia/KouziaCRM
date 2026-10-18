/**
 * Nature d'un encaissement à l'écran, sans répéter le type affiché dans sa colonne : « Acompte de 30 % sur devis
 * D-2026-0002 : Acompte - À la validation du devis » devient « Acompte de 30 % sur devis D-2026-0002 ». Lecture
 * seule : la nature légale (CSV, PDF, title de la cellule) reste le texte complet.
 */
export function shortNature(nature: string, typeLabel: string): string {
  const type = typeLabel.trim().toLowerCase();
  let text = nature.trim();
  // « Avoir · … » : le type le dit déjà.
  if (type === "avoir") text = text.replace(/^avoir\s*·\s*/i, "");
  const parts = text.split(/\s+:\s+/);
  const kept = parts.filter((part, i) => i === 0 || !new RegExp(`^${escapeRegExp(type)}(\\s*[-·:]|$)`, "i").test(part.trim()));
  return kept.join(" : ") || nature;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
