import cron from "node-cron";
import { syncImapInbox } from "../src/lib/email/imap-sync";

async function runSync() {
  const started = new Date().toISOString();
  console.log(`[worker] IMAP sync start ${started}`);
  try {
    const result = await syncImapInbox();
    console.log(`[worker] IMAP sync done`, result);
  } catch (err) {
    console.error(`[worker] IMAP sync error`, err);
  }
}

console.log("[worker] KouziaCRM worker démarré — IMAP toutes les heures");
void runSync();
cron.schedule("0 * * * *", () => {
  void runSync();
});
