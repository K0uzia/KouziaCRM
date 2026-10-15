import { getDashboardSnapshot } from "@/lib/finance/dashboard-service.js";
import type { CashflowScope } from "@/lib/finance/cashflow-service.js";
import { getOwnerPaySummary } from "@/lib/finance/owner-pay.js";
import { isImapConfigured } from "@/lib/email/imap-config.js";
import { getMailSyncStatus } from "@/lib/email/sync/sync-status.js";
import { serializeInvoice } from "@/lib/invoices/serialize.js";
import { listObligationsDashboard } from "@/lib/obligations/obligation-service.js";
import { prisma } from "@/lib/prisma.js";
import { listPendingReminders } from "@/lib/reminders.js";
import { computeMrrCents } from "@/lib/subscriptions/subscription-service.js";
import { listPendingStarts } from "@/lib/quotes/withdrawal-pending.js";

/** Bloc secondaire en échec : null, le reste du tableau de bord s'affiche (journal sur une ligne). */
async function optional<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    console.error(`[dashboard] bloc ${label} en échec :`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Derniers fils de la messagerie, sans corps de message (seul l'expéditeur du dernier sert). */
async function latestThreads(take: number) {
  const threads = await prisma.emailThread.findMany({
    orderBy: { lastMessageAt: "desc" },
    take,
    select: {
      id: true,
      subject: true,
      lastMessageAt: true,
      unreadCount: true,
      client: { select: { id: true, displayName: true } },
      messages: { orderBy: { receivedAt: "desc" }, take: 1, select: { fromAddress: true } },
    },
  });
  return threads.map(({ messages, ...t }) => ({ ...t, lastFrom: messages[0]?.fromAddress ?? "" }));
}

/**
 * Tout le tableau de bord en un appel : une requête au lieu de huit, calculs en parallèle côté
 * serveur, obligations calculées une seule fois. Les routes unitaires restent pour les autres écrans.
 */
export async function getDashboardOverview(scope: CashflowScope) {
  const [snapshot, reminders, mrr, obligations, threads, mailSync, ownerPay, pendingStarts] = await Promise.all([
    getDashboardSnapshot(scope),
    optional("relances", listPendingReminders),
    optional("abonnements", () => computeMrrCents()),
    optional("obligations", () => listObligationsDashboard()),
    optional("messagerie", () => latestThreads(5)),
    optional("synchro mail", async () => {
      if (!(await isImapConfigured())) return { imapConfigured: false, lastSyncAt: null };
      const status = await getMailSyncStatus();
      return { imapConfigured: true, lastSyncAt: status?.lastSyncAt ?? null };
    }),
    optional("salaire", () => getOwnerPaySummary()),
    optional("délais de rétractation", () => listPendingStarts()),
  ]);

  const cfe = obligations?.items
    .filter((i) => i.type === "CFE_PAYMENT" && i.displayStatus !== "DONE")
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];

  return {
    ...snapshot,
    reminders: reminders?.map(serializeInvoice) ?? null,
    mrr,
    obligations: obligations
      ? { summary: obligations.summary, alerts: obligations.alerts, nextDue: obligations.summary.nextDue }
      : null,
    cfeObligation: cfe ? { label: cfe.label, dueDate: cfe.dueDate, amountCents: cfe.amountCents } : null,
    threads,
    mailSync,
    ownerPay,
    pendingStarts: pendingStarts ?? [],
  };
}
