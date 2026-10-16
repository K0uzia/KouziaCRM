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
import { listDueClientRenewals } from "@/lib/clients/renewals.js";
import { listRevisionsToAttach } from "@/lib/subscriptions/activate-from-document.js";

/** Temps maximal d'un bloc secondaire : au-delà, le tableau de bord part sans lui (il ne l'attend jamais). */
const BLOC_BUDGET_MS = 4000;

/**
 * Bloc secondaire en échec ou trop lent : null, le reste du tableau de bord s'affiche (journal sur une ligne)
 * et le bloc est nommé dans `indisponibles` pour que l'écran le signale (avec Réessayer) au lieu de le croire vide.
 */
async function optional<T>(label: string, run: () => Promise<T>, indisponibles: string[]): Promise<T | null> {
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<"delai">((resolve) => {
    minuteur = setTimeout(() => resolve("delai"), BLOC_BUDGET_MS);
  });
  try {
    const r = await Promise.race([run(), delai]);
    if (r === "delai") {
      console.error(`[dashboard] bloc ${label} : plus de ${BLOC_BUDGET_MS} ms, affiché sans lui`);
      indisponibles.push(label);
      return null;
    }
    return r as T;
  } catch (err) {
    console.error(`[dashboard] bloc ${label} en échec :`, err instanceof Error ? err.message : String(err));
    indisponibles.push(label);
    return null;
  } finally {
    clearTimeout(minuteur);
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
  const indisponibles: string[] = [];
  const [snapshot, reminders, mrr, obligations, threads, mailSync, ownerPay, pendingStarts, renewals, revisionsToAttach] = await Promise.all([
    getDashboardSnapshot(scope),
    optional("relances", listPendingReminders, indisponibles),
    optional("abonnements", () => computeMrrCents(), indisponibles),
    optional("obligations", () => listObligationsDashboard(), indisponibles),
    optional("messagerie", () => latestThreads(5), indisponibles),
    optional(
      "synchro mail",
      async () => {
        if (!(await isImapConfigured())) return { imapConfigured: false, lastSyncAt: null };
        const status = await getMailSyncStatus();
        return { imapConfigured: true, lastSyncAt: status?.lastSyncAt ?? null };
      },
      indisponibles,
    ),
    optional("salaire", () => getOwnerPaySummary(), indisponibles),
    optional("délais de rétractation", () => listPendingStarts(), indisponibles),
    optional("renouvellements chez l'hébergeur", () => listDueClientRenewals(), indisponibles),
    optional("avenants à rattacher", () => listRevisionsToAttach(), indisponibles),
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
    renewals: renewals ?? [],
    revisionsToAttach: (revisionsToAttach ?? []).map((r) => ({ lineId: r.lineId, quoteId: r.quoteId, quoteNumber: r.quoteNumber, displayName: r.displayName, description: r.description })),
    indisponibles,
  };
}
