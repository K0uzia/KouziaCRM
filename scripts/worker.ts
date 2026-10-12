import cron from "node-cron";
import { isImapConfigured } from "../apps/api/src/lib/email/imap-config";
import { runMailPollFallback, startIdleWorker, stopIdleWorker } from "../apps/api/src/lib/email/sync/idle-worker";
import { syncImapInbox } from "../apps/api/src/lib/email/imap-sync";
import { processEmailOutbox } from "../apps/api/src/lib/email/mailer";
import { expireQuotes, scheduleReminders } from "../apps/api/src/lib/reminders";
import { generateDueSubscriptionInvoices } from "../apps/api/src/lib/subscriptions/subscription-service";
import { sendDueRenewalReminders } from "../apps/api/src/lib/subscriptions/renewal-reminder";
import { sendDueReminders, sendDueDepositReminders } from "../apps/api/src/lib/reminders/send";
import { syncObligations } from "../apps/api/src/lib/obligations/obligation-service";
import { sendDueObligationEmails } from "../apps/api/src/lib/obligations/email-reminders";
import { activateDueMilestoneCheckouts } from "../apps/api/src/lib/payments/milestonePaymentService";
import { getCompanySettings } from "../apps/api/src/lib/company";
import { prisma } from "../apps/api/src/lib/prisma";
import { purgePortalData } from "../apps/api/src/lib/portal/auth";

async function runMaintenance() {
  try {
    const expired = await expireQuotes();
    const scheduled = await scheduleReminders();
    const subscriptions = await generateDueSubscriptionInvoices();
    const renewalReminders = await sendDueRenewalReminders();
    const remindersSent = await sendDueReminders();
    const depositRemindersSent = await sendDueDepositReminders();
    await syncObligations();
    const obligationEmails = await sendDueObligationEmails();
    console.log(
      `[worker] maintenance: expired=${expired} remindersScheduled=${scheduled} subscriptionsInvoices=${subscriptions} renewalReminders=${renewalReminders} remindersSent=${remindersSent} depositReminders=${depositRemindersSent} obligationEmails=${obligationEmails}`,
    );
  } catch (err) {
    console.error(`[worker] maintenance error`, err);
  }
}

async function runOutbox() {
  try {
    const result = await processEmailOutbox();
    if (result.processed > 0 || result.failed > 0) {
      console.log(`[worker] outbox processed=${result.processed} failed=${result.failed}`);
    }
  } catch (err) {
    console.error(`[worker] outbox error`, err);
  }
}

async function runImapIfDue() {
  try {
    if (!(await isImapConfigured())) {
      console.log("[worker] IMAP sync skip : IMAP non configuré");
      return;
    }
    const settings = await getCompanySettings();
    const intervalMin = Math.min(60, Math.max(1, settings.imapPollIntervalMinutes || 2));
    const state = await prisma.mailSyncStatus.findUnique({ where: { id: "default" } });
    if (
      state?.lastSyncAt &&
      Date.now() - state.lastSyncAt.getTime() < intervalMin * 60 * 1000
    ) {
      const ago = Math.round((Date.now() - state.lastSyncAt.getTime()) / 60_000);
      console.log(`[worker] IMAP sync skip : dernière synchro il y a ${ago} min (intervalle ${intervalMin} min)`);
      return;
    }
    console.log(`[worker] IMAP sync start ${new Date().toISOString()}`);
    const result = await syncImapInbox();
    console.log(`[worker] IMAP sync done`, result);
  } catch (err) {
    console.error(`[worker] IMAP sync error`, err);
  }
}

async function runStripeCatalogSync() {
  try {
    const settings = await getCompanySettings();
    if (!settings.moduleStripeEnabled || !settings.stripeSecretKeyEncrypted) return;
    // Mode des identifiants enregistrés complété avant toute synchro (garde-fou live/test).
    const { backfillStripeModes } = await import("../apps/api/src/lib/stripe/mode.js");
    await backfillStripeModes();
    const { syncCatalogFromStripe } = await import(
      "../apps/api/src/lib/stripe/catalog.js"
    );
    const actions = await syncCatalogFromStripe();
    if (actions.length > 0) {
      console.log(`[worker] stripe catalog sync actions=${actions.length}`);
    }
  } catch (err) {
    console.error("[worker] stripe catalog sync error", err);
  }
}

async function runHourly() {
  await runMaintenance();
  await runStripeCatalogSync();
  try {
    const activated = await activateDueMilestoneCheckouts();
    if (activated > 0) {
      console.log(`[worker] milestone checkouts activated=${activated}`);
    }
  } catch (err) {
    console.error("[worker] milestone checkout error", err);
  }
  try {
    const purged = await purgePortalData();
    if (purged.codes + purged.sessions > 0) {
      console.log(`[worker] espace client purgé codes=${purged.codes} sessions=${purged.sessions}`);
    }
  } catch (err) {
    console.error("[worker] purge espace client error", err);
  }
}

console.log(
  "[worker] Kouzia ERP worker démarré - outbox 30s + IMAP IDLE/poll 60s + Stripe et maintenance horaires",
);
void runOutbox();
void runImapIfDue();
void runHourly();

if (process.env.MAIL_IDLE !== "false") {
  void startIdleWorker();
}

const tasks = [
  cron.schedule("*/30 * * * * *", () => {
    void runOutbox();
  }),
  cron.schedule("* * * * *", () => {
    runMailPollFallback()
      .then((r) => {
        if (r === "skipped") console.log("[worker] repli IMAP : skip (IDLE actif et synchro récente, ou IMAP non configuré)");
      })
      .catch((err) => console.error("[worker] repli IMAP en échec", err));
  }),
  cron.schedule("*/5 * * * *", () => {
    void runImapIfDue();
  }),
  cron.schedule("0 * * * *", () => {
    void runHourly();
  }),
];

// Arrêt propre (Ctrl+C, redémarrage de tsx watch, OpenRC) : plus de tâche, IMAP et base fermés.
let closing = false;
function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[worker] arrêt (${signal})`);
  setTimeout(() => process.exit(0), 3000).unref();
  for (const task of tasks) void task.stop();
  stopIdleWorker();
  void prisma
    .$disconnect()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => shutdown(signal));
