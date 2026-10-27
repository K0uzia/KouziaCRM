import { decryptOptional } from "@/lib/crypto.js";
import { prisma } from "@/lib/prisma.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";

/**
 * Recalcule emailHash depuis l'adresse déchiffrée (démarrage de l'API, avant d'écouter) : clients, contacts et demandes
 * de logiciel. Idempotent : un hachage déjà à jour n'est pas réécrit. Sert de migration de données au passage à la
 * sous-clé dédiée (décision du 27/10/2026).
 * @returns nombre de lignes dont le hachage a changé.
 */
export async function backfillClientEmailHashes(): Promise<number> {
  let updated = 0;
  const clients = await prisma.client.findMany({
    where: { emailEncrypted: { not: null } },
    select: { id: true, emailEncrypted: true, emailHash: true },
  });
  for (const c of clients) {
    const hash = computeEmailHash(decryptOptional(c.emailEncrypted));
    if (hash && hash !== c.emailHash) {
      await prisma.client.update({ where: { id: c.id }, data: { emailHash: hash } });
      updated += 1;
    }
  }
  const contacts = await prisma.clientContact.findMany({
    where: { emailEncrypted: { not: null } },
    select: { id: true, emailEncrypted: true, emailHash: true },
  });
  for (const c of contacts) {
    const hash = computeEmailHash(decryptOptional(c.emailEncrypted));
    if (hash && hash !== c.emailHash) {
      await prisma.clientContact.update({ where: { id: c.id }, data: { emailHash: hash } });
      updated += 1;
    }
  }
  const requests = await prisma.softwareRequest.findMany({ select: { id: true, emailEncrypted: true, emailHash: true } });
  for (const r of requests) {
    const hash = computeEmailHash(decryptOptional(r.emailEncrypted));
    if (hash && hash !== r.emailHash) {
      await prisma.softwareRequest.update({ where: { id: r.id }, data: { emailHash: hash } });
      updated += 1;
    }
  }
  return updated;
}
