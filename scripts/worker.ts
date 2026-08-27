import cron from "node-cron";
import { syncImapInbox } from "../apps/api/src/lib/email/imap-sync";
import { expireQuotes, scheduleReminders } from "../apps/api/src/lib/reminders";
import { generateDueSubscriptionInvoices } from "../apps/api/src/lib/subscriptions/subscription-service";
import { sendDueReminders } from "../apps/api/src/lib/reminders/send";
import { importTransactions } from "../apps/api/src/lib/revolut/importTransactions";

async function runMaintenance() {
  try {
    const expired = await expireQuotes();
    const scheduled = await scheduleReminders();
    const subscriptions = await generateDueSubscriptionInvoices();
    const remindersSent = await sendDueReminders();
    console.log(
      `[worker] maintenance: expired=${expired} remindersScheduled=${scheduled} subscriptionsInvoices=${subscriptions} remindersSent=${remindersSent}`,
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

async function runSync() {
  const started = new Date().toISOString();
  console.log(`[worker] IMAP sync start ${started}`);
  try {
    const result = await syncImapInbox();
    console.log(`[worker] IMAP sync done`, result);
  } catch (err) {
    console.error(`[worker] IMAP sync error`, err);
  }
  await runBankSync();
  await runMaintenance();
}

console.log("[worker] KouziaCRM worker démarré - IMAP + banque toutes les heures");
void runSync();
cron.schedule("0 * * * *", () => {
  void runSync();
});
