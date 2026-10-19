import { notepadTakeover, type NotepadTakeoverCounts } from "@/lib/reprises/notepad.js";

/** Reprises de données liées aux migrations du 19/10/2026, lancées par `kouziactl reprise` (après la sauvegarde). */
export type TakeoverReport = {
  at: string;
  dryRun: boolean;
  notepad: NotepadTakeoverCounts;
};

export async function runTakeovers({ dryRun }: { dryRun: boolean }): Promise<TakeoverReport> {
  const at = new Date().toISOString();
  const notepad = await notepadTakeover({ dryRun });
  return { at, dryRun, notepad };
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Lignes lisibles par Alexandre : des nombres seulement, aucune donnée personnelle. */
export function takeoverSummary(report: TakeoverReport): string[] {
  const n = report.notepad;
  return [
    report.dryRun ? "Reprise des données, comptes à blanc (rien n'est écrit) :" : "Reprise des données, comptes réels :",
    `  bloc-notes : ${plural(n.clients, "fiche remplie", "fiches remplies")}, ${plural(n.internalNotes, "« Notes internes » reprise", "« Notes internes » reprises")} en tête, ${plural(n.appointmentNotes, "note de rendez-vous reprise", "notes de rendez-vous reprises")}`,
  ];
}
