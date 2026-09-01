import { decryptOptional } from "@/lib/crypto.js";
import { prisma } from "@/lib/prisma.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";

/** Recalcule emailHash pour les clients existants (boot / migration). */
export async function backfillClientEmailHashes(): Promise<number> {
  const clients = await prisma.client.findMany({
    where: { emailEncrypted: { not: null } },
    select: { id: true, emailEncrypted: true, emailHash: true },
  });
  let updated = 0;
  for (const c of clients) {
    const email = decryptOptional(c.emailEncrypted);
    const hash = computeEmailHash(email);
    if (hash && hash !== c.emailHash) {
      await prisma.client.update({ where: { id: c.id }, data: { emailHash: hash } });
      updated += 1;
    }
  }
  return updated;
}
