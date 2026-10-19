import { prisma } from "@/lib/prisma.js";
import { decryptOptional } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { findClientIdByContactEmail } from "@/lib/clients/contacts.js";

export async function findClientIdByEmail(address: string): Promise<string | null> {
  const needle = address.trim().toLowerCase();
  if (!needle) return null;

  const hash = computeEmailHash(needle);
  if (hash) {
    const byHash = await prisma.client.findUnique({
      where: { emailHash: hash },
      select: { id: true },
    });
    if (byHash) return byHash.id;
    // Adresse d'un autre contact du client (Client.email reste celle du contact principal).
    const byContact = await findClientIdByContactEmail(hash);
    if (byContact) return byContact;
  }

  const clients = await prisma.client.findMany({
    where: { emailEncrypted: { not: null } },
    select: { id: true, emailEncrypted: true, emailHash: true },
  });

  for (const c of clients) {
    const email = decryptOptional(c.emailEncrypted)?.trim().toLowerCase();
    if (email && email === needle) {
      if (hash && !c.emailHash) {
        await prisma.client.update({ where: { id: c.id }, data: { emailHash: hash } }).catch(() => {});
      }
      return c.id;
    }
  }
  return null;
}
