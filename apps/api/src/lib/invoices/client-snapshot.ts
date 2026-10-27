import { Prisma } from "@prisma/client";
import { decrypt, encrypt } from "@/lib/crypto.js";
import type { ClientSnapshot } from "@/lib/invoices/documentFlowService.js";

// Copie du client figée dans un document émis (e-mail, téléphone, SIRET, adresse), chiffrée au repos (décision
// d'Alexandre du 27/10/2026, migration 20261221090000) : écrite dans clientSnapshotEncrypted, l'ancienne colonne JSON
// reste vide. Lecture : colonne chiffrée, à défaut l'ancienne (documents pas encore recopiés par le worker).

/** Champs à écrire pour figer la copie du client d'un document. */
export function clientSnapshotData(snapshot: ClientSnapshot): { clientSnapshotEncrypted: string; clientSnapshot: typeof Prisma.DbNull } {
  return { clientSnapshotEncrypted: encrypt(JSON.stringify(snapshot)), clientSnapshot: Prisma.DbNull };
}

/** Copie du client d'un document, ou null si le document n'en a pas (brouillon). */
export function readClientSnapshot(doc: { clientSnapshotEncrypted?: string | null; clientSnapshot?: unknown }): ClientSnapshot | null {
  if (doc.clientSnapshotEncrypted) return JSON.parse(decrypt(doc.clientSnapshotEncrypted)) as ClientSnapshot;
  return (doc.clientSnapshot as ClientSnapshot | null | undefined) ?? null;
}
