import { prisma } from "@/lib/prisma.js";
import { decrypt, encrypt } from "@/lib/crypto.js";
import { takeoverText } from "@/lib/clients/notepad.js";

/** Comptes de la reprise du bloc-notes : des nombres seulement, jamais de texte ni d'identifiant. */
export type NotepadTakeoverCounts = {
  /** Fiches dont le bloc-notes est rempli par la reprise. */
  clients: number;
  /** Dont « Notes internes » reprises en tête. */
  internalNotes: number;
  /** Notes de rendez-vous reprises. */
  appointmentNotes: number;
};

/**
 * Reprise des « Notes internes » (Client.notes) et des notes de rendez-vous (ClientNote) dans le bloc-notes.
 * Idempotente : seules les fiches jamais écrites ni reprises (version 0) sont traitées, et l'écriture est
 * conditionnée à cette version (une saisie concurrente l'emporte). Rien n'est effacé : les anciennes données
 * restent en place, en lecture seule. À blanc (dryRun), mêmes comptes, rien n'est écrit.
 */
export async function notepadTakeover({ dryRun }: { dryRun: boolean }): Promise<NotepadTakeoverCounts> {
  const candidates = await prisma.client.findMany({
    where: { notepadVersion: 0 },
    select: { id: true, notes: true, updatedAt: true, appointmentNotes: { select: { preparedAt: true, bodyEncrypted: true } } },
  });
  const counts: NotepadTakeoverCounts = { clients: 0, internalNotes: 0, appointmentNotes: 0 };
  const now = new Date();
  for (const c of candidates) {
    const text = takeoverText(
      c.notes,
      c.appointmentNotes.map((n) => ({ preparedAt: n.preparedAt, body: decrypt(n.bodyEncrypted) })),
    );
    if (!text) continue;
    if (!dryRun) {
      const { count } = await prisma.client.updateMany({
        where: { id: c.id, notepadVersion: 0 },
        data: { notepadEncrypted: encrypt(text), notepadVersion: 1, notepadUpdatedAt: now, updatedAt: c.updatedAt },
      });
      if (count === 0) continue;
    }
    counts.clients++;
    if (c.notes?.trim()) counts.internalNotes++;
    counts.appointmentNotes += c.appointmentNotes.length;
  }
  return counts;
}
