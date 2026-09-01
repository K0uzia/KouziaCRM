import { EmailOutboxStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateMessageId } from "./headers.js";
import type { EnqueueOptions, EnqueueResult, OutboxPayload } from "./types.js";

export function serializePayload(payload: OutboxPayload): string {
  return JSON.stringify(payload);
}

export function parsePayload(raw: string): OutboxPayload {
  return JSON.parse(raw) as OutboxPayload;
}

export async function enqueueEmail(
  payload: OutboxPayload,
  opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const row = await prisma.emailOutbox.create({
    data: {
      status: EmailOutboxStatus.PENDING,
      maxAttempts: opts.maxAttempts ?? 3,
      scheduledAt: opts.scheduledAt ?? new Date(),
      payload: serializePayload(payload),
    },
  });
  return { outboxId: row.id, messageId: generateMessageId(row.id) };
}

export async function claimPendingOutbox(limit: number) {
  const now = new Date();
  const rows = await prisma.emailOutbox.findMany({
    where: {
      status: EmailOutboxStatus.PENDING,
      scheduledAt: { lte: now },
    },
    orderBy: { scheduledAt: "asc" },
    take: limit,
  });
  const claimed: typeof rows = [];
  for (const row of rows) {
    const updated = await prisma.emailOutbox.updateMany({
      where: { id: row.id, status: EmailOutboxStatus.PENDING },
      data: { status: EmailOutboxStatus.SENDING },
    });
    if (updated.count === 1) claimed.push(row);
  }
  return claimed;
}

export async function markOutboxSent(id: string) {
  await prisma.emailOutbox.update({
    where: { id },
    data: {
      status: EmailOutboxStatus.SENT,
      sentAt: new Date(),
      lastError: null,
    },
  });
}

export async function markOutboxFailed(id: string, error: string, retryAt?: Date) {
  const row = await prisma.emailOutbox.findUnique({ where: { id } });
  if (!row) return;
  const attempts = row.attempts + 1;
  if (attempts >= row.maxAttempts || !retryAt) {
    await prisma.emailOutbox.update({
      where: { id },
      data: {
        status: EmailOutboxStatus.FAILED,
        attempts,
        lastError: error,
      },
    });
    return;
  }
  await prisma.emailOutbox.update({
    where: { id },
    data: {
      status: EmailOutboxStatus.PENDING,
      attempts,
      lastError: error,
      scheduledAt: retryAt,
    },
  });
}

export async function countSentSince(since: Date): Promise<number> {
  return prisma.emailOutbox.count({
    where: { status: EmailOutboxStatus.SENT, sentAt: { gte: since } },
  });
}
