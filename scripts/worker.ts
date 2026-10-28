// En premier : bornes calendaires à Paris, quel que soit le fuseau de la machine.
import "../apps/api/src/lib/business-tz.js";
import cron from "node-cron";
import { isImapConfigured } from "../apps/api/src/lib/email/imap-config.js";
import { runMailPollFallback, startIdleWorker, stopIdleWorker } from "../apps/api/src/lib/email/sync/idle-worker.js";
import { syncImapInbox } from "../apps/api/src/lib/email/imap-sync.js";
import { processEmailOutbox } from "../apps/api/src/lib/email/mailer/index.js";
import { expireQuotes, scheduleReminders } from "../apps/api/src/lib/reminders.js";
import { generateDueSubscriptionInvoices } from "../apps/api/src/lib/subscriptions/subscription-service.js";
import { sendDueFirstChargeNotices, sendDueRenewalReminders, sendDueTermEndReminders } from "../apps/api/src/lib/subscriptions/renewal-reminder.js";
import { sendDueActionReminders } from "../apps/api/src/lib/subscriptions/dunning.js";
import { checkExpiringCards } from "../apps/api/src/lib/subscriptions/card-expiry.js";
import { archivePendingIssuedPdfs } from "../apps/api/src/lib/pdf/issued-archive.js";
import { archivePendingReceipts } from "../apps/api/src/lib/pdf/receipt-archive.js";
import { sendDueReminders, sendDueDepositReminders } from "../apps/api/src/lib/reminders/send.js";
import { syncObligations } from "../apps/api/src/lib/obligations/obligation-service.js";
import { advancePastClientRenewals, sendDueClientRenewalNotices } from "../apps/api/src/lib/clients/renewals.js";
import { sendDueObligationEmails } from "../apps/api/src/lib/obligations/email-reminders.js";
import { activateDueMilestoneCheckouts } from "../apps/api/src/lib/payments/milestonePaymentService.js";
import { getCompanySettings } from "../apps/api/src/lib/company.js";
import { prisma } from "../apps/api/src/lib/prisma.js";
import { purgePortalData } from "../apps/api/src/lib/portal/auth.js";
import { purgeTestimonialProofs } from "../apps/api/src/lib/site/testimonials.js";
import { followSitePublications } from "../apps/api/src/lib/site/publish.js";
import { backfillEncryptedArchives, backfillEncryptedEmails } from "../apps/api/src/lib/privacy/at-rest.js";
import { backfillLegacyNotes } from "../apps/api/src/lib/clients/notepad.js";
import { reportForeignPaymentLinks } from "../apps/api/src/lib/invoices/foreign-payment-links.js";
import { purgeRetention } from "../apps/api/src/lib/privacy/retention.js";
import { installNoBrotliFetch } from "../apps/api/src/lib/http/no-brotli-fetch.js";
import { encryptionKey } from "../apps/api/src/lib/crypto.js";

// Réponses des services extérieurs jamais demandées en Brotli (CVE-2026-111497).
installNoBrotliFetch();
// Clé de chiffrement vérifiée au démarrage (hexadécimal strict), comme l'API : refus clair plutôt qu'une clé affaiblie.
encryptionKey();

/** Étape de maintenance isolée : une erreur est journalisée et n'empêche pas les suivantes (audit du 27/10/2026). */
async function step<T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`[worker] maintenance : étape ${name} en échec`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

async function runMaintenance() {
  const expired = await step("expireQuotes", () => expireQuotes(), 0);
  const scheduled = await step("scheduleReminders", () => scheduleReminders(), 0);
  const subscriptions = await step("generateDueSubscriptionInvoices", () => generateDueSubscriptionInvoices(), 0);
  const renewalReminders = await step("sendDueRenewalReminders", () => sendDueRenewalReminders(), 0);
  const firstChargeNotices = await step("sendDueFirstChargeNotices", () => sendDueFirstChargeNotices(), 0);
  const termEndReminders = await step("sendDueTermEndReminders", () => sendDueTermEndReminders(), 0);
  // Renouvellements chez un tiers : date passée avancée d'une période, puis e-mail au client à J-30 s'il est demandé.
  await step("advancePastClientRenewals", () => advancePastClientRenewals(), undefined);
  const clientRenewalNotices = await step("sendDueClientRenewalNotices", () => sendDueClientRenewalNotices(), 0);
  const actionReminders = await step("sendDueActionReminders", () => sendDueActionReminders(), 0);
  // Abonnement par virement impayé depuis 15 jours : alerte à l'entreprise, sans suspension (28/10/2026).
  await step(
    "alertOverdueTransferSubscriptions",
    async () => (await import("../apps/api/src/lib/subscriptions/dunning.js")).alertOverdueTransferSubscriptions(),
    0,
  );
  const cardNotices = await step("checkExpiringCards", () => checkExpiringCards(), 0);
  // Factures et avoirs émis sans PDF archivé (émission sans accès, ou antérieurs à l'archivage).
  const pdfArchived = await step("archivePendingIssuedPdfs", () => archivePendingIssuedPdfs(), 0);
  const receiptsArchived = await step("archivePendingReceipts", () => archivePendingReceipts(), 0);
  // Version accessible des documents archivés avant elle : figée seulement si son texte est celui du PDF archivé.
  const readable = await step(
    "backfillReadableSnapshots",
    async () => (await import("../apps/api/src/lib/pdf/readable-documents.js")).backfillReadableSnapshots(),
    { frozen: 0, unavailable: 0 },
  );
  // Rachat payé (décision du 28/10/2026) : fin de l'abonnement posée, au cas où le paiement n'a pas pu la poser.
  await step(
    "applyPaidBuyouts",
    async () => (await import("../apps/api/src/lib/subscriptions/buyout.js")).applyPaidBuyouts(),
    0,
  );
  // Fin programmée passée (rachat payé, non-reconduction, date de fin) : l'abonnement passe à « Clôturé ».
  const endedClosed = await step(
    "closeEndedSubscriptions",
    async () => (await import("../apps/api/src/lib/subscriptions/subscription-service.js")).closeEndedSubscriptions(),
    0,
  );
  // Prélèvement « en cours » depuis plus de 7 jours (webhook perdu) : issue relue chez Stripe.
  const stuckResolved = await step(
    "recheckStuckPaymentProcessing",
    async () => (await import("../apps/api/src/lib/stripe/webhook-handlers.js")).recheckStuckPaymentProcessing(),
    0,
  );
  const remindersSent = await step("sendDueReminders", () => sendDueReminders(), 0);
  const depositRemindersSent = await step("sendDueDepositReminders", () => sendDueDepositReminders(), 0);
  const obligationEmails = await step("sendDueObligationEmails", () => sendDueObligationEmails(), 0);
  // E-mails à valider depuis plus de 24 h : un rappel groupé, jamais la nuit.
  const reviewReminders = await step(
    "remindStaleReviews",
    async () => (await import("../apps/api/src/lib/email/review-reminder.js")).remindStaleReviews(),
    0,
  );
  console.log(
    `[worker] maintenance: expired=${expired} remindersScheduled=${scheduled} subscriptionsInvoices=${subscriptions} renewalReminders=${renewalReminders} firstChargeNotices=${firstChargeNotices} termEndReminders=${termEndReminders} clientRenewalNotices=${clientRenewalNotices} actionReminders=${actionReminders} cardNotices=${cardNotices} pdfArchived=${pdfArchived} receiptsArchived=${receiptsArchived} readableFrozen=${readable.frozen} readableUnavailable=${readable.unavailable} endedClosed=${endedClosed} stuckProcessingResolved=${stuckResolved} remindersSent=${remindersSent} depositReminders=${depositRemindersSent} obligationEmails=${obligationEmails} reviewReminders=${reviewReminders}`,
  );
}

/** Obligations et Google Calendar : hors requête de l'interface (un GET n'attend jamais Google). */
async function runObligationsSync() {
  try {
    const result = await syncObligations();
    if (!result.skipped && !result.error) console.log(`[worker] obligations : agenda aligné (${result.upserted} ouvertes, ${result.deleted} retirées)`);
  } catch (err) {
    console.error("[worker] synchro des obligations en échec", err);
  }
}

async function runPushDispatch() {
  try {
    const { dispatchPushNotifications } = await import("../apps/api/src/lib/push/dispatch.js");
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
    if (Object.values(copied).some((n) => n > 0)) {
      console.log(
        `[worker] chiffrement au repos événements=${copied.events} invitations=${copied.invitations} file=${copied.outbox} copiesClient=${copied.clientSnapshots} messages=${copied.messages} iban=${copied.ibans}`,
      );
    }
  } catch (err) {
    console.error("[worker] chiffrement des e-mails error", err);
  }
  try {
    // PDF archivés et versions lisibles d'avant leur chiffrement (27/10/2026) : recopie chiffrée par lots.
    const archives = await backfillEncryptedArchives();
    if (archives.archives + archives.readables > 0) {
      console.log(`[worker] archives chiffrées au repos pdf=${archives.archives} lisibles=${archives.readables}`);
    }
  } catch (err) {
    console.error("[worker] chiffrement des archives error", err);
  }
  try {
    // Ancien champ Client.notes en clair : recopié dans le bloc-notes chiffré puis vidé (décision du 27/10/2026).
    const notes = await backfillLegacyNotes();
    if (notes > 0) console.log(`[worker] anciennes notes reprises dans le bloc-notes=${notes}`);
  } catch (err) {
    console.error("[worker] reprise des anciennes notes error", err);
  }
  try {
    // Liens de paiement hors Stripe enregistrés avant la règle (27/10/2026) : signalés une fois, jamais modifiés.
    const foreign = await reportForeignPaymentLinks();
    if (foreign > 0) console.log(`[worker] liens de paiement hors Stripe signalés=${foreign}`);
  } catch (err) {
    console.error("[worker] contrôle des liens de paiement error", err);
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
void runObligationsSync();
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
  cron.schedule("*/15 * * * *", () => {
    void runObligationsSync();
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
