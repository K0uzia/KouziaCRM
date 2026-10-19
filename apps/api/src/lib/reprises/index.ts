import { notepadTakeover, type NotepadTakeoverCounts } from "@/lib/reprises/notepad.js";
import { contactsTakeover, type ContactsTakeoverCounts } from "@/lib/reprises/contacts.js";

/** Reprises de données liées aux migrations du 19/10/2026, lancées par `kouziactl reprise` (après la sauvegarde). */
export type TakeoverReport = {
  at: string;
  dryRun: boolean;
  notepad: NotepadTakeoverCounts;
  contacts: ContactsTakeoverCounts;
};

export async function runTakeovers({ dryRun }: { dryRun: boolean }): Promise<TakeoverReport> {
  const at = new Date().toISOString();
  const notepad = await notepadTakeover({ dryRun });
  const contacts = await contactsTakeover({ dryRun });
  return { at, dryRun, notepad, contacts };
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Lignes lisibles par Alexandre : des nombres seulement, aucune donnée personnelle. */
export function takeoverSummary(report: TakeoverReport): string[] {
  const n = report.notepad;
  const c = report.contacts;
  return [
    report.dryRun ? "Reprise des données, comptes à blanc (rien n'est écrit) :" : "Reprise des données, comptes réels :",
    `  bloc-notes : ${plural(n.clients, "fiche remplie", "fiches remplies")}, ${plural(n.internalNotes, "« Notes internes » reprise", "« Notes internes » reprises")} en tête, ${plural(n.appointmentNotes, "note de rendez-vous reprise", "notes de rendez-vous reprises")}`,
    `  contacts : ${plural(c.contacts, "contact principal créé", "contacts principaux créés")} (${c.withEmail} avec e-mail, ${c.withPhone} avec téléphone, ${c.unnamed} sans nom « Contact principal »), ${plural(c.skipped, "fiche sans nom, e-mail ni téléphone", "fiches sans nom, e-mail ni téléphone")} laissée${c.skipped > 1 ? "s" : ""} sans contact`,
  ];
}
