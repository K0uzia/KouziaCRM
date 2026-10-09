import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

function pad(n: number, width = 4): string {
  return String(n).padStart(width, "0");
}

/** Alloue CLI-0001 de façon atomique via NamedCounter.name=client */
export async function allocateClientNumber(
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string> {
  await db.namedCounter.upsert({
    where: { name: "client" },
    create: { name: "client", lastValue: 0 },
    update: {},
  });
  const updated = await db.namedCounter.update({
    where: { name: "client" },
    data: { lastValue: { increment: 1 } },
  });
  return `CLI-${pad(updated.lastValue)}`;
}
