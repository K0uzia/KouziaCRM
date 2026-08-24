import { prisma } from "@/lib/prisma";
import { decryptOptional } from "@/lib/crypto";

export async function findClientIdByEmail(address: string): Promise<string | null> {
  const needle = address.trim().toLowerCase();
  if (!needle) return null;

  const clients = await prisma.client.findMany({
    where: { emailEncrypted: { not: null } },
    select: { id: true, emailEncrypted: true },
  });

  for (const c of clients) {
    const email = decryptOptional(c.emailEncrypted)?.trim().toLowerCase();
    if (email && email === needle) return c.id;
  }
  return null;
}
