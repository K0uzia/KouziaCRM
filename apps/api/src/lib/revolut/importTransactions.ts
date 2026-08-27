import { BankTxStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import {
  bookedAtOf,
  canPollNow,
  counterpartyIbanOf,
  counterpartyNameOf,
  creditAmountOf,
  fetchTransactions,
  isRevolutConfigured,
  markPolled,
  referenceOf,
  RevolutApiError,
  type RevolutTransaction,
} from "@/lib/revolut/revolutService.js";
import { reconcileUnmatched } from "@/lib/revolut/reconciliationService.js";

const WINDOW_DAYS = 7;

export type ImportTransactionsResult = {
  skipped: boolean;
  reason?: string;
  imported: number;
  updated: number;
  matchedAuto: number;
  unmatched: number;
  logId: string | null;
};

function mapStatus(tx: RevolutTransaction, amountCents: number): BankTxStatus {
  if (amountCents <= 0) return BankTxStatus.IGNORED;
  if (tx.state && /pending/i.test(tx.state)) return BankTxStatus.PENDING;
  return BankTxStatus.UNMATCHED;
}

/**
 * Import idempotent des crédits Revolut (fenêtre glissante 7 jours).
 * Met à jour l'état Revolut des lignes existantes, puis lance le rapprochement auto.
 */
export async function importTransactions(opts?: {
  force?: boolean;
  now?: Date;
}): Promise<ImportTransactionsResult> {
  const now = opts?.now ?? new Date();
  const force = opts?.force ?? false;

  if (!isRevolutConfigured()) {
    return {
      skipped: true,
      reason: "Revolut non configuré (clés / refresh token)",
      imported: 0,
      updated: 0,
      matchedAuto: 0,
      unmatched: 0,
      logId: null,
    };
  }

  if (!canPollNow(force, now.getTime())) {
    return {
      skipped: true,
      reason: "Rate limit : sync max 1×/heure (utiliser force pour forcer)",
      imported: 0,
      updated: 0,
      matchedAuto: 0,
      unmatched: 0,
      logId: null,
    };
  }

  const log = await prisma.bankSyncLog.create({
    data: { startedAt: now },
  });

  let imported = 0;
  let updated = 0;
  let matchedAuto = 0;
  let unmatched = 0;

  try {
    const from = new Date(now);
    from.setDate(from.getDate() - WINDOW_DAYS);
    from.setHours(0, 0, 0, 0);

    const txs = await fetchTransactions({ from, to: now });
    markPolled(now.getTime());

    for (const raw of txs) {
      const amountCents = creditAmountOf(raw);
      if (amountCents <= 0) continue;

      const bookedAt = bookedAtOf(raw);
      const counterpartyName = counterpartyNameOf(raw);
      const counterpartyIban = counterpartyIbanOf(raw);
      const reference = referenceOf(raw);
      const revolutState = raw.state ?? null;
      const nextStatus = mapStatus(raw, amountCents);

      const existing = await prisma.bankTransaction.findUnique({
        where: { revolutId: raw.id },
      });

      if (!existing) {
        await prisma.bankTransaction.create({
          data: {
            revolutId: raw.id,
            bookedAt,
            amountCents,
            currency: raw.legs?.[0]?.currency ?? "EUR",
            counterpartyName,
            counterpartyIban,
            reference,
            revolutState,
            status: nextStatus,
          },
        });
        imported++;
        continue;
      }

      // Mise à jour état / métadonnées ; ne pas écraser un MATCHED / IGNORED métier
      const data: {
        bookedAt: Date;
        amountCents: number;
        counterpartyName: string | null;
        counterpartyIban: string | null;
        reference: string | null;
        revolutState: string | null;
        status?: BankTxStatus;
      } = {
        bookedAt,
        amountCents,
        counterpartyName,
        counterpartyIban,
        reference,
        revolutState,
      };

      if (
        existing.status === BankTxStatus.PENDING ||
        existing.status === BankTxStatus.UNMATCHED
      ) {
        if (nextStatus === BankTxStatus.PENDING) {
          data.status = BankTxStatus.PENDING;
        } else if (existing.status === BankTxStatus.PENDING) {
          data.status = BankTxStatus.UNMATCHED;
        }
      }

      await prisma.bankTransaction.update({
        where: { id: existing.id },
        data,
      });
      updated++;
    }

    const recon = await reconcileUnmatched();
    matchedAuto = recon.matchedAuto;
    unmatched = recon.unmatched;

    await prisma.bankSyncLog.update({
      where: { id: log.id },
      data: {
        finishedAt: new Date(),
        imported,
        updated,
        matchedAuto,
        unmatched,
      },
    });

    return {
      skipped: false,
      imported,
      updated,
      matchedAuto,
      unmatched,
      logId: log.id,
    };
  } catch (err) {
    const message =
      err instanceof RevolutApiError
        ? `${err.message}${err.body ? ` : ${err.body.slice(0, 300)}` : ""}`
        : err instanceof Error
          ? err.message
          : "Erreur sync Revolut";
    await prisma.bankSyncLog.update({
      where: { id: log.id },
      data: {
        finishedAt: new Date(),
        imported,
        updated,
        matchedAuto,
        unmatched,
        errorMessage: message,
      },
    });
    throw err;
  }
}
