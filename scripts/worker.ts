import cron from "node-cron";
import { isImapConfigured } from "../apps/api/src/lib/email/imap-config";
import { runMailPollFallback, startIdleWorker } from "../apps/api/src/lib/email/sync/idle-worker";
import { syncImapInbox } from "../apps/api/src/lib/email/imap-sync";
import { processEmailOutbox } from "../apps/api/src/lib/email/mailer";
import { expireQuotes, scheduleReminders } from "../apps/api/src/lib/reminders";
import { generateDueSubscriptionInvoices } from "../apps/api/src/lib/subscriptions/subscription-service";
import { sendDueReminders, sendDueDepositReminders } from "../apps/api/src/lib/reminders/send";
import { importTransactions } from "../apps/api/src/lib/revolut/importTransactions";
import { activateDueMilestoneCheckouts } from "../apps/api/src/lib/payments/milestonePaymentService";
import { getCompanySettings } from "../apps/api/src/lib/company";
import { prisma } from "../apps/api/src/lib/prisma";

async function runMaintenance() {
  try {
    const expired = await expireQuotes();
    const scheduled = await scheduleReminders();
    const subscriptions = await generateDueSubscriptionInvoices();
    const remindersSent = await sendDueReminders();
    const depositRemindersSent = await sendDueDepositReminders();
    console.log(
      `[worker] maintenance: expired=${expired} remindersScheduled=${scheduled} subscriptionsInvoices=${subscriptions} remindersSent=${remindersSent} depositReminders=${depositRemindersSent}`,
    );
  } catch (err) {
    console.error(`[worker] maintenance error`, err);
  }
}

async function runBankSync() {
  try {
    const result = await importTransactions({ force: false });
    console.log(`[worker] bank sync`, result);
  } catch (err) {
    console.error(`[worker] bank sync error`, err);
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
    if (!(await isImapConfigured())) return;
    const settings = await getCompanySettings();
    const intervalMin = Math.min(60, Math.max(1, settings.imapPollIntervalMinutes || 15));
    const state = await prisma.mailSyncStatus.findUnique({ where: { id: "default" } });
    if (
      state?.lastSyncAt &&
      Date.now() - state.lastSyncAt.getTime() < intervalMin * 60 * 1000
    ) {
      return;
    }
    console.log(`[worker] IMAP sync start ${new Date().toISOString()}`);
    const result = await syncImapInbox();
    console.log(`[worker] IMAP sync done`, result);
  } catch (err) {
    console.error(`[worker] IMAP sync error`, err);
  }
}

async function runHourly() {
  await runBankSync();
  await runMaintenance();
  try {
    const activated = await activateDueMilestoneCheckouts();
    if (activated > 0) {
      console.log(`[worker] milestone checkouts activated=${activated}`);
    }
  } catch (err) {
    console.error("[worker] milestone checkout error", err);
  }
}

console.log(
  "[worker] KouziaCRM worker démarré - outbox 30s + IMAP IDLE/poll 60s + banque/maintenance horaire",
);
void runOutbox();
void runImapIfDue();
void runHourly();

if (process.env.MAIL_IDLE !== "false") {
  void startIdleWorker();
}

cron.schedule("*/30 * * * * *", () => {
  void runOutbox();
});
cron.schedule("* * * * *", () => {
  void runMailPollFallback();
});
cron.schedule("*/5 * * * *", () => {
  void runImapIfDue();
});
cron.schedule("0 * * * *", () => {
  void runHourly();
});
