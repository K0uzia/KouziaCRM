import { EmailOutboxStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
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
  const { needsReview } = await import("@/lib/email/review.js");
  const awaitingReview = opts.review ? await needsReview(opts.review) : false;
  const row = await prisma.emailOutbox.create({
    data: {
      status: awaitingReview ? EmailOutboxStatus.REVIEW : EmailOutboxStatus.PENDING,
      origin: opts.review?.origin ?? null,
      reviewFamily: opts.review?.family ?? null,
      reviewKind: payload.kind ?? null,
      documentId: payload.documentId ?? null,
      clientWaiting: opts.review?.clientWaiting ?? false,
      maxAttempts: opts.maxAttempts ?? 3,
      scheduledAt: opts.scheduledAt ?? new Date(),
      // Contenu chiffré au repos ; l'ancienne colonne en clair reste vide.
      payload: "",
      payloadEncrypted: encrypt(serializePayload(payload)),
    },
  });
  return { outboxId: row.id, messageId: generateMessageId(row.id), awaitingReview };
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

/**
 * Lignes restées « en cours d'envoi » plus de 15 minutes (service arrêté entre la réservation et l'envoi) : passées en
 * échec, visibles, jamais renvoyées d'office puisque l'e-mail a pu partir (audit du 27/10/2026 : elles restaient en
 * SENDING pour toujours, l'e-mail ne partait jamais et bloquait les rappels d'acompte suivants du même jalon).
 */
export async function failStaleSending(now = new Date(), staleMs = 15 * 60_000): Promise<number> {
  const res = await prisma.emailOutbox.updateMany({
    where: { status: EmailOutboxStatus.SENDING, updatedAt: { lt: new Date(now.getTime() - staleMs) } },
    data: { status: EmailOutboxStatus.FAILED, lastError: "Interrompu pendant l'envoi (arrêt du service) : vérifier s'il est parti avant de le renvoyer." },
  });
  return res.count;
}

export async function markOutboxSent(id: string) {
  const sentAt = new Date();
  const row = await prisma.emailOutbox.update({
    where: { id },
    data: {
      status: EmailOutboxStatus.SENT,
      sentAt,
      lastError: null,
    },
    select: { documentId: true, reviewKind: true },
  });
  // Information de reconduction (L215-1) : son envoi effectif, et lui seul, la compte comme faite (28/10/2026).
  if (row.documentId && row.reviewKind) {
    const { RENEWAL_NOTICE_KINDS, recordRenewalNoticeSent } = await import("@/lib/subscriptions/renewal-reminder.js");
    if ((RENEWAL_NOTICE_KINDS as readonly string[]).includes(row.reviewKind)) await recordRenewalNoticeSent(row.documentId, sentAt);
  }
}

export async function markOutboxFailed(id: string, error: string, retryAt?: Date) {
  const row = await prisma.emailOutbox.findUnique({ where: { id } });
  // Déjà parti : jamais remis en file (un renvoi au client), quelle que soit l'erreur survenue après l'envoi.
  if (!row || row.status === EmailOutboxStatus.SENT) return;
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
