import { decrypt, encrypt } from "@/lib/crypto.js";
import { prisma } from "@/lib/prisma.js";

// Adresses et contenus d'e-mails chiffrés au repos (migration 20261109090000) : les écritures passent par
// la colonne *Encrypted et laissent "" dans l'ancienne colonne, qui n'est jamais supprimée. Lecture : colonne
// chiffrée, à défaut l'ancienne (lignes écrites avant la migration et pas encore recopiées).

const readAtRest = (encrypted: string | null | undefined, legacy: string): string => (encrypted ? decrypt(encrypted) : legacy);

export const clientEmailEventTo = (e: { toAddressEncrypted: string | null; toAddress: string }) => readAtRest(e.toAddressEncrypted, e.toAddress);
export const invitationEmail = (i: { emailEncrypted: string | null; email: string }) => readAtRest(i.emailEncrypted, i.email);
export const outboxPayloadRaw = (o: { payloadEncrypted: string | null; payload: string }) => readAtRest(o.payloadEncrypted, o.payload);

/** Chiffre puis vérifie la relecture : une valeur qui ne se relit pas n'est jamais écrite. */
function sealed(plain: string): string {
  const enc = encrypt(plain);
  if (decrypt(enc) !== plain) throw new Error("relecture du chiffrement différente");
  return enc;
}

/**
 * Clé utilisable : chiffrement possible ET déchiffrement d'une donnée déjà chiffrée en base (une clé
 * différente de celle des données ferait des colonnes illisibles). Lève sinon.
 */
async function assertKeyMatchesData() {
  sealed("controle");
  const sample =
    (await prisma.client.findFirst({ where: { emailEncrypted: { not: null } }, select: { emailEncrypted: true } }))?.emailEncrypted ??
    (await prisma.clientEmailEvent.findFirst({ where: { toAddressEncrypted: { not: null } }, select: { toAddressEncrypted: true } }))?.toAddressEncrypted ??
    null;
  if (sample) decrypt(sample);
}

/**
 * Recopie chiffrée des lignes antérieures à la migration, par lots ; ancienne colonne vidée seulement
 * après relecture. Clé absente ou différente de celle des données : rien n'est touché, erreur journalisée.
 */
export async function backfillEncryptedEmails(batch = 200): Promise<{ events: number; invitations: number; outbox: number }> {
  const done = { events: 0, invitations: 0, outbox: 0 };
  try {
    await assertKeyMatchesData();
  } catch (err) {
    console.error(`[chiffrement] recopie suspendue, aucune colonne vidée : clé de chiffrement absente ou différente (${err instanceof Error ? err.message : String(err)})`);
    return done;
  }
  for (const row of await prisma.clientEmailEvent.findMany({ where: { toAddressEncrypted: null, toAddress: { not: "" } }, select: { id: true, toAddress: true }, take: batch })) {
    await prisma.clientEmailEvent.update({ where: { id: row.id }, data: { toAddressEncrypted: sealed(row.toAddress), toAddress: "" } });
    done.events += 1;
  }
  for (const row of await prisma.onboardingInvitation.findMany({ where: { emailEncrypted: null, email: { not: "" } }, select: { id: true, email: true }, take: batch })) {
    await prisma.onboardingInvitation.update({ where: { id: row.id }, data: { emailEncrypted: sealed(row.email), email: "" } });
    done.invitations += 1;
  }
  for (const row of await prisma.emailOutbox.findMany({ where: { payloadEncrypted: null, payload: { not: "" } }, select: { id: true, payload: true }, take: batch })) {
    await prisma.emailOutbox.update({ where: { id: row.id }, data: { payloadEncrypted: sealed(row.payload), payload: "" } });
    done.outbox += 1;
  }
  return done;
}
