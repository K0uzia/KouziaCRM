import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

const PAD = 3;

export function formatInvoiceNumber(year: number, seq: number): string {
  return `${year}-${String(seq).padStart(PAD, "0")}`;
}

export type AllocatedNumber = {
  number: string;
  sequenceYear: number;
  sequenceNumber: number;
};

/**
 * Alloue le prochain numéro de façon atomique (increment SQLite).
 * À appeler UNIQUEMENT lors du passage DRAFT → ISSUED ou création d'avoir.
 */
export async function allocateInvoiceNumber(
  issueDate: Date = new Date(),
  tx?: Prisma.TransactionClient,
): Promise<AllocatedNumber> {
  const sequenceYear = issueDate.getFullYear();

  const run = async (client: Prisma.TransactionClient) => {
    await client.invoiceSequence.upsert({
      where: { year: sequenceYear },
      create: { year: sequenceYear, lastNumber: 0 },
      update: {},
    });

    const seq = await client.invoiceSequence.update({
      where: { year: sequenceYear },
      data: { lastNumber: { increment: 1 } },
    });

    return {
      number: formatInvoiceNumber(sequenceYear, seq.lastNumber),
      sequenceYear,
      sequenceNumber: seq.lastNumber,
    };
  };

  if (tx) {
    return run(tx);
  }

  return prisma.$transaction(async (inner) => run(inner));
}
