import { Prisma } from "@prisma/client";
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
export async function backfillEncryptedEmails(
  batch = 200,
): Promise<{ events: number; invitations: number; outbox: number; clientSnapshots: number; messages: number; ibans: number }> {
  const done = { events: 0, invitations: 0, outbox: 0, clientSnapshots: 0, messages: 0, ibans: 0 };
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
  // Copie du client des documents émis (migration 20261221090000) : même contenu, chiffré ; le PDF ne change pas.
  for (const row of await prisma.invoice.findMany({
    where: { clientSnapshotEncrypted: null, NOT: { clientSnapshot: { equals: Prisma.DbNull } } },
    select: { id: true, clientSnapshot: true },
    take: batch,
  })) {
    if (row.clientSnapshot === null) continue;
    await prisma.invoice.update({
      where: { id: row.id },
      data: { clientSnapshotEncrypted: sealed(JSON.stringify(row.clientSnapshot)), clientSnapshot: Prisma.DbNull },
    });
    done.clientSnapshots += 1;
  }
  // Corps des e-mails de la messagerie (même migration) : chaque corps présent est chiffré, l'ancien vidé.
  for (const row of await prisma.emailMessage.findMany({
    where: { OR: [{ bodyText: { not: null } }, { bodyHtml: { not: null } }] },
    select: { id: true, bodyText: true, bodyHtml: true, bodyTextEncrypted: true, bodyHtmlEncrypted: true },
    take: batch,
  })) {
    await prisma.emailMessage.update({
      where: { id: row.id },
      data: {
        bodyText: null,
        bodyHtml: null,
        bodyTextEncrypted: row.bodyText != null ? sealed(row.bodyText) : row.bodyTextEncrypted,
        bodyHtmlEncrypted: row.bodyHtml != null ? sealed(row.bodyHtml) : row.bodyHtmlEncrypted,
      },
    });
    done.messages += 1;
  }
  // IBAN de la contrepartie des opérations bancaires (même migration).
  for (const row of await prisma.bankTransaction.findMany({ where: { counterpartyIban: { not: null } }, select: { id: true, counterpartyIban: true }, take: batch })) {
    await prisma.bankTransaction.update({ where: { id: row.id }, data: { counterpartyIbanEncrypted: sealed(row.counterpartyIban!), counterpartyIban: null } });
    done.ibans += 1;
  }
  return done;
}
