import { randomBytes } from "node:crypto";
import argon2 from "argon2";
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

/** Génère un code d'accès clair (une fois) + hash argon2id */
export async function generateAccessCode(): Promise<{ code: string; hash: string }> {
  const code = randomBytes(4).toString("hex").toUpperCase();
  const hash = await argon2.hash(code, { type: argon2.argon2id });
  return { code, hash };
}

export async function verifyAccessCode(hash: string, code: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, code.trim().toUpperCase());
  } catch {
    return false;
  }
}
