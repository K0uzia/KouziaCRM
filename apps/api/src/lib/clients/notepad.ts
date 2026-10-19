import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { decrypt, decryptOptional, encrypt } from "@/lib/crypto.js";
import { formatDateTimeShortFr } from "@/lib/format-fr.js";

/** Bloc-notes unique de la fiche : texte chiffré au repos, versionné (enregistrement concurrent détecté). */
export const NOTEPAD_MAX = 50_000;

export const notepadInputSchema = z.object({
  text: z.string().max(NOTEPAD_MAX, "Bloc-notes trop long (50 000 caractères au plus)"),
  /** Version lue par l'appareil avant la saisie. */
  baseVersion: z.number().int().min(0),
});

export type NotepadInput = z.infer<typeof notepadInputSchema>;

export type NotepadView = {
  text: string;
  version: number;
  updatedAt: Date | null;
  /** Enregistrement concurrent : les deux textes sont gardés, à relire. */
  conflictAt: Date | null;
};

const NOTEPAD_SELECT = {
  id: true,
  notes: true,
  notepadEncrypted: true,
  notepadVersion: true,
  notepadUpdatedAt: true,
  notepadConflictAt: true,
  updatedAt: true,
} satisfies Prisma.ClientSelect;

type NotepadRow = Prisma.ClientGetPayload<{ select: typeof NOTEPAD_SELECT }>;

/**
 * Texte repris des anciennes données : « Notes internes » en tête, puis chaque note de rendez-vous datée, dans
 * l'ordre chronologique, une ligne vide entre deux. Vide s'il n'y a rien à reprendre.
 */
export function takeoverText(internalNotes: string | null, appointmentNotes: Array<{ preparedAt: Date; body: string }>): string {
  const parts: string[] = [];
  if (internalNotes?.trim()) parts.push(`Notes internes :\n${internalNotes.trim()}`);
  for (const note of [...appointmentNotes].sort((a, b) => a.preparedAt.getTime() - b.preparedAt.getTime())) {
    parts.push(`${formatDateTimeShortFr(note.preparedAt)} : ${note.body}`);
  }
  return parts.join("\n\n");
}

async function legacyText(row: NotepadRow): Promise<string> {
  const notes = await prisma.clientNote.findMany({ where: { clientId: row.id }, select: { preparedAt: true, bodyEncrypted: true } });
  return takeoverText(
    row.notes,
    notes.map((n) => ({ preparedAt: n.preparedAt, body: decrypt(n.bodyEncrypted) })),
  );
}

/**
 * Texte en vigueur. Fiche jamais écrite ni reprise (version 0) : contenu des anciennes notes, calculé sans rien
 * écrire, pour qu'un enregistrement fait avant la reprise parte de ce que l'écran a montré.
 */
async function currentText(row: NotepadRow): Promise<string> {
  return row.notepadVersion === 0 ? legacyText(row) : (decryptOptional(row.notepadEncrypted) ?? "");
}

function viewOf(row: NotepadRow, text: string): NotepadView {
  return { text, version: row.notepadVersion, updatedAt: row.notepadUpdatedAt, conflictAt: row.notepadConflictAt };
}

export async function readNotepad(clientId: string): Promise<NotepadView | null> {
  const row = await prisma.client.findUnique({ where: { id: clientId }, select: NOTEPAD_SELECT });
  return row ? viewOf(row, await currentText(row)) : null;
}

/**
 * Écriture conditionnée à la version lue (updateMany sur id + version) : une écriture concurrente fait échouer la
 * condition et la lecture est refaite. `next` calcule le texte à partir de l'état relu.
 */
async function writeNotepad(
  clientId: string,
  next: (current: string, row: NotepadRow) => { text: string; conflict: boolean } | null,
): Promise<{ notepad: NotepadView; conflict: boolean } | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await prisma.client.findUnique({ where: { id: clientId }, select: NOTEPAD_SELECT });
    if (!row) return null;
    const current = await currentText(row);
    const change = next(current, row);
    if (!change) return { notepad: viewOf(row, current), conflict: false };
    const now = new Date();
    const data = {
      notepadEncrypted: change.text.trim() ? encrypt(change.text) : null,
      notepadVersion: row.notepadVersion + 1,
      notepadUpdatedAt: now,
      notepadConflictAt: change.conflict ? now : null,
      // Date de la fiche gardée : un devis préparé hors ligne n'est pas signalé « client modifié » pour une note.
      updatedAt: row.updatedAt,
    };
    const { count } = await prisma.client.updateMany({ where: { id: clientId, notepadVersion: row.notepadVersion }, data });
    if (count === 1) {
      return {
        notepad: { text: change.text.trim() ? change.text : "", version: data.notepadVersion, updatedAt: now, conflictAt: data.notepadConflictAt },
        conflict: change.conflict,
      };
    }
  }
  throw new Error("Bloc-notes modifié en continu : enregistrement abandonné, réessayer.");
}

/**
 * Enregistrement depuis l'écran ou la file hors ligne.
 * - Même texte que celui en base : rien n'est réécrit (renvoi après une réponse perdue, double envoi).
 * - Version lue = version en base : le texte reçu remplace l'ancien ; un texte vide vide le bloc-notes.
 * - Version dépassée (modifié ailleurs entre-temps) : rien n'est perdu, le texte en base vient d'abord, puis la
 *   version de l'appareil, datée et marquée « à relire » ; le bandeau reste jusqu'au prochain enregistrement.
 */
export async function saveNotepad(clientId: string, input: NotepadInput) {
  return writeNotepad(clientId, (current, row) => {
    if (input.text === current) return null;
    if (input.baseVersion === row.notepadVersion || !current.trim()) return { text: input.text, conflict: false };
    if (!input.text.trim()) return { text: current, conflict: true };
    return {
      text: `${current}\n\nVersion de l'appareil du ${formatDateTimeShortFr(new Date())}, à relire :\n${input.text}`,
      conflict: true,
    };
  });
}

/**
 * Ajout en fin de bloc-notes (note de rendez-vous envoyée par un appareil pas encore mis à jour). Fiche jamais
 * reprise : le texte repris contient déjà cette note, enregistrée avant l'appel ; il est seulement matérialisé.
 */
export async function appendToNotepad(clientId: string, block: string) {
  return writeNotepad(clientId, (current, row) => {
    if (row.notepadVersion === 0) return { text: current, conflict: false };
    return { text: current.trim() ? `${current}\n\n${block}` : block, conflict: false };
  });
}

export function serializeNotepad(view: NotepadView) {
  return {
    text: view.text,
    version: view.version,
    updatedAt: view.updatedAt?.toISOString() ?? null,
    conflictAt: view.conflictAt?.toISOString() ?? null,
  };
}
