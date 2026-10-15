import cron from "node-cron";
import { isImapConfigured } from "../apps/api/src/lib/email/imap-config";
import { runMailPollFallback, startIdleWorker, stopIdleWorker } from "../apps/api/src/lib/email/sync/idle-worker";
import { syncImapInbox } from "../apps/api/src/lib/email/imap-sync";
import { processEmailOutbox } from "../apps/api/src/lib/email/mailer";
import { expireQuotes, scheduleReminders } from "../apps/api/src/lib/reminders";
import { generateDueSubscriptionInvoices } from "../apps/api/src/lib/subscriptions/subscription-service";
import { sendDueRenewalReminders } from "../apps/api/src/lib/subscriptions/renewal-reminder";
import { sendDueActionReminders } from "../apps/api/src/lib/subscriptions/dunning";
import { checkExpiringCards } from "../apps/api/src/lib/subscriptions/card-expiry";
import { archivePendingIssuedPdfs } from "../apps/api/src/lib/pdf/issued-archive";
import { archivePendingReceipts } from "../apps/api/src/lib/pdf/receipt-archive";
import { sendDueReminders, sendDueDepositReminders } from "../apps/api/src/lib/reminders/send";
import { syncObligations } from "../apps/api/src/lib/obligations/obligation-service";
import { sendDueObligationEmails } from "../apps/api/src/lib/obligations/email-reminders";
import { activateDueMilestoneCheckouts } from "../apps/api/src/lib/payments/milestonePaymentService";
import { getCompanySettings } from "../apps/api/src/lib/company";
import { prisma } from "../apps/api/src/lib/prisma";
import { purgePortalData } from "../apps/api/src/lib/portal/auth";
import { purgeTestimonialProofs } from "../apps/api/src/lib/site/testimonials";
import { followSitePublications } from "../apps/api/src/lib/site/publish";
import { backfillEncryptedEmails } from "../apps/api/src/lib/privacy/at-rest";
import { purgeRetention } from "../apps/api/src/lib/privacy/retention";

async function runMaintenance() {
  try {
    const expired = await expireQuotes();
    const scheduled = await scheduleReminders();
    const subscriptions = await generateDueSubscriptionInvoices();
    const renewalReminders = await sendDueRenewalReminders();
    const actionReminders = await sendDueActionReminders();
    const cardNotices = await checkExpiringCards();
    // Factures et avoirs émis sans PDF archivé (émission sans accès, ou antérieurs à l'archivage).
    const pdfArchived = await archivePendingIssuedPdfs();
    const receiptsArchived = await archivePendingReceipts();
    const remindersSent = await sendDueReminders();
    const depositRemindersSent = await sendDueDepositReminders();
    await syncObligations();
    const obligationEmails = await sendDueObligationEmails();
    console.log(
      `[worker] maintenance: expired=${expired} remindersScheduled=${scheduled} subscriptionsInvoices=${subscriptions} renewalReminders=${renewalReminders} actionReminders=${actionReminders} cardNotices=${cardNotices} pdfArchived=${pdfArchived} receiptsArchived=${receiptsArchived} remindersSent=${remindersSent} depositReminders=${depositRemindersSent} obligationEmails=${obligationEmails}`,
    );
  } catch (err) {
    console.error(`[worker] maintenance error`, err);
  }
}

async function runPushDispatch() {
  try {
    const { dispatchPushNotifications } = await import("../apps/api/src/lib/push/dispatch");
    const sent = await dispatchPushNotifications();
    if (sent > 0) console.log(`[worker] push envoyées=${sent}`);
  } catch (err) {
    console.error("[worker] push error", err);
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
  try {
    // Témoignages retirés ou écartés depuis 3 ans : IP et navigateur retirés de la preuve d'accord.
    const proofs = await purgeTestimonialProofs();
    if (proofs > 0) console.log(`[worker] preuves de témoignage allégées=${proofs}`);
  } catch (err) {
    console.error("[worker] purge preuves de témoignage error", err);
  }
  try {
    // Lignes antérieures au chiffrement des e-mails : recopie chiffrée par lots (idempotente).
    const copied = await backfillEncryptedEmails();
    if (copied.events + copied.invitations + copied.outbox > 0) {
      console.log(`[worker] e-mails chiffrés au repos événements=${copied.events} invitations=${copied.invitations} file=${copied.outbox}`);
    }
  } catch (err) {
    console.error("[worker] chiffrement des e-mails error", err);
  }
  try {
    // Conservation des données (README, « Conservation des données ») : prospects, invitations, file, journal, sessions.
    const purged = await purgeRetention();
    if (Object.values(purged).some((n) => n > 0)) console.log("[worker] conservation des données", purged);
  } catch (err) {
    console.error("[worker] conservation des données error", err);
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
    void runPushDispatch();
  }),
  // Publication du site : suivi du déploiement jusqu'à la mise en ligne (version.json). Aucun appel sans publication suivie.
  cron.schedule("*/15 * * * * *", () => {
    followSitePublications().catch((err) => console.error("[worker] suivi de publication du site en échec", err));
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
// Une tâche planifiée qui rejette sans gestionnaire ne doit pas arrêter le worker : journal seulement.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] promesse rejetée non gérée (le worker continue)", reason);
});
