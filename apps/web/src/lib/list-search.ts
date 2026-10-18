function readPath(row: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, row);
}

/** Ligne retenue par la recherche du tableau (même règle pour les nombres affichés dans les filtres de la page). */
export function matchesSearch(row: unknown, searchable: boolean | string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (Array.isArray(searchable)) return searchable.some((f) => String(readPath(row, f) ?? "").toLowerCase().includes(q));
  return Object.values(row as Record<string, unknown>).some((v) => {
    if (v != null && typeof v === "object") {
      return Object.values(v as Record<string, unknown>).some((nested) => String(nested ?? "").toLowerCase().includes(q));
    }
    return String(v ?? "").toLowerCase().includes(q);
  });
}
