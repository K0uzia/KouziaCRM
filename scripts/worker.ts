import cron from "node-cron";
import { syncImapInbox } from "../apps/api/src/lib/email/imap-sync";
import { expireQuotes, scheduleReminders } from "../apps/api/src/lib/reminders";

async function runMaintenance() {
  try {
    const expired = await expireQuotes();
    const scheduled = await scheduleReminders();
    console.log(`[worker] maintenance: expired=${expired} remindersScheduled=${scheduled}`);
  } catch (err) {
    console.error(`[worker] maintenance error`, err);
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
  await runMaintenance();
}

console.log("[worker] KouziaCRM worker démarré - IMAP toutes les heures");
void runSync();
cron.schedule("0 * * * *", () => {
  void runSync();
});
