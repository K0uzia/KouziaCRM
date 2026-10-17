import { z } from "zod";
import type { ClientNote } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { decrypt, encrypt } from "@/lib/crypto.js";

/** Note de rendez-vous : texte (chiffré au repos), UUID de l'appareil, date de saisie. */
export const noteInputSchema = z.object({
  body: z.string().trim().min(1, "Note vide").max(5000, "Note trop longue (5 000 caractères au plus)"),
  clientRequestId: z.string().uuid(),
  /** Hors ligne : date de préparation sur l'appareil. Absente : maintenant. */
  preparedAt: z.iso.datetime({ offset: true }).optional(),
});

export type NoteInput = z.infer<typeof noteInputSchema>;

export function serializeNote(note: ClientNote) {
  return {
    id: note.id,
    clientId: note.clientId,
    body: decrypt(note.bodyEncrypted),
    preparedAt: note.preparedAt,
    createdAt: note.createdAt,
  };
}

export async function listClientNotes(clientId: string) {
  const notes = await prisma.clientNote.findMany({
    where: { clientId },
    orderBy: [{ preparedAt: "desc" }, { createdAt: "desc" }],
  });
  return notes.map(serializeNote);
}

/**
 * Ajoute la note, une seule fois par clientRequestId : un renvoi (réponse perdue, double envoi) rend la note déjà
 * créée. Date de préparation dans le futur (horloge de l'appareil en avance) : ramenée à maintenant.
 */
export async function createClientNote(
  clientId: string,
  input: NoteInput,
): Promise<{ note: ReturnType<typeof serializeNote>; replayed: boolean }> {
  const existing = await prisma.clientNote.findUnique({ where: { clientRequestId: input.clientRequestId } });
  if (existing) return { note: serializeNote(existing), replayed: true };
  const now = new Date();
  const prepared = input.preparedAt ? new Date(input.preparedAt) : now;
  try {
    const note = await prisma.clientNote.create({
      data: {
        clientId,
        bodyEncrypted: encrypt(input.body),
        clientRequestId: input.clientRequestId,
        preparedAt: prepared > now ? now : prepared,
      },
    });
    return { note: serializeNote(note), replayed: false };
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    const raced = await prisma.clientNote.findUniqueOrThrow({ where: { clientRequestId: input.clientRequestId } });
    return { note: serializeNote(raced), replayed: true };
  }
}
