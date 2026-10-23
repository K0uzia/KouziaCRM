import { Children, Fragment, isValidElement, type ReactNode } from "react";

/** Option d'une liste de choix, lue dans les enfants `<option>` et `<optgroup>` d'un Select. */
export type ListOption = { value: string; label: string; disabled: boolean; group: string | null };

function text(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return "";
}

/** Options dans l'ordre d'affichage ; un groupe désactivé désactive ses options, comme en HTML. */
export function readOptions(children: ReactNode, group: string | null = null, groupDisabled = false): ListOption[] {
  const out: ListOption[] = [];
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ children?: ReactNode; value?: unknown; label?: string; disabled?: boolean }>(child)) continue;
    if (child.type === "option") {
      const label = text(child.props.children).replace(/\s+/g, " ").trim();
      out.push({
        value: child.props.value === undefined ? label : String(child.props.value),
        label,
        disabled: groupDisabled || Boolean(child.props.disabled),
        group,
      });
    } else if (child.type === "optgroup") {
      out.push(...readOptions(child.props.children, child.props.label ?? null, Boolean(child.props.disabled)));
    } else if (child.type === Fragment) {
      out.push(...readOptions(child.props.children, group, groupDisabled));
    }
  }
  return out;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Recherche par frappe (APG) : première option activable après `from` dont le libellé commence par la saisie, en
 * bouclant ; une même lettre répétée passe d'une option à la suivante qui commence par elle. -1 sans résultat.
 */
export function typeahead(options: ListOption[], typed: string, from: number): number {
  const query = fold(typed);
  if (!query) return -1;
  const repeated = query.length > 1 && [...query].every((c) => c === query[0]);
  const needle = repeated ? query[0]! : query;
  const n = options.length;
  // Saisie qui s'allonge : l'option actuelle peut encore convenir ; lettre répétée : on passe à la suivante.
  const start = repeated || query.length === 1 ? from + 1 : from;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    const o = options[i]!;
    if (!o.disabled && fold(o.label).startsWith(needle)) return i;
  }
  return -1;
}

/** Option activable suivante (pas > 0) ou précédente (pas < 0), sans boucler ; reste en place au bord. */
export function step(options: ListOption[], from: number, delta: number): number {
  const dir = delta > 0 ? 1 : -1;
  let target = from;
  let moved = 0;
  for (let i = from + dir; i >= 0 && i < options.length && moved < Math.abs(delta); i += dir) {
    if (!options[i]!.disabled) {
      target = i;
      moved++;
    }
  }
  return target;
}

export const firstEnabled = (options: ListOption[]) => options.findIndex((o) => !o.disabled);
export const lastEnabled = (options: ListOption[]) => {
  for (let i = options.length - 1; i >= 0; i--) if (!options[i]!.disabled) return i;
  return -1;
};
