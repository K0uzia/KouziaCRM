import fs from "node:fs/promises";
import { EmailOutboxStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { attachmentAbsPath } from "@/lib/email/attachments.js";
import { signedQuoteAbsolutePath } from "@/lib/invoices/acceptance-proof.js";
import { eraseClient } from "@/lib/clients/erasure.js";

// Durées de conservation (RGPD, documentées dans le README, section « Conservation des données ») :
// purge par le worker, chaque heure. Les pièces comptables et les clients qui en ont ne sont jamais touchés.
const DAY = 86_400_000;
export const RETENTION = {
  /** Prospect sans suite : 3 ans après le dernier contact (référentiel CNIL, gestion commerciale). */
  prospectMs: 3 * 365 * DAY,
  /** Invitation expirée ou utilisée. */
  invitationMs: 30 * DAY,
  /** Contenu d'un e-mail envoyé (la ligne reste : date, état, erreur). */
  outboxPayloadMs: 30 * DAY,
  /** Journal des e-mails envoyés à un client (suivi /suivi et fiche client). */
  emailEventMs: 365 * DAY,
  /** Messagerie : 3 ans après le dernier échange avec le contact (décision d'Alexandre du 27/10/2026). */
  mailMs: 3 * 365 * DAY,
  /** Contenu brut d'un webhook Stripe ou Revolut : 1 an (la ligne reste : identifiant, type, date). */
  webhookPayloadMs: 365 * DAY,
} as const;

/** Adresses de la boîte de l'ERP : présentes dans tous les fils, elles ne désignent jamais le contact. */
async function ownMailAddresses(): Promise<Set<string>> {
  const [accounts, settings] = await Promise.all([
    prisma.mailAccount.findMany({ select: { email: true } }),
    prisma.companySettings.findFirst({ select: { email: true, smtpUser: true, smtpFrom: true, transactionalFrom: true, imapUser: true } }),
  ]);
  const all = [...accounts.map((a) => a.email), settings?.email, settings?.smtpUser, settings?.smtpFrom, settings?.transactionalFrom, settings?.imapUser];
  return new Set(all.filter((a): a is string => Boolean(a?.trim())).map((a) => a.trim().toLowerCase()));
}

function contactsOf(participants: string, own: Set<string>): string[] {
  try {
    const list = JSON.parse(participants || "[]") as unknown;
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string").map((a) => a.trim().toLowerCase()).filter((a) => a && !own.has(a)) : [];
  } catch {
    return [];
  }
}

/**
 * Messagerie : un fil sans message depuis 3 ans est retiré de l'ERP (messages, pièces jointes et leurs fichiers), sauf
 * si son contact (fiche client, ou adresse du correspondant) a échangé depuis dans un autre fil, ou si le fil porte un
 * accord sur un devis (preuve de signature, gardée 10 ans). La boîte IMAP elle-même n'est pas touchée : la
 * synchronisation est incrémentale, un message retiré n'est pas réimporté (sauf réinitialisation du dossier).
 */
async function purgeOldMail(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION.mailMs);
  const own = await ownMailAddresses();
  const recent = await prisma.emailThread.findMany({ where: { lastMessageAt: { gte: cutoff } }, select: { clientId: true, participants: true } });
  const recentClients = new Set(recent.map((t) => t.clientId).filter(Boolean));
  const recentContacts = new Set(recent.flatMap((t) => contactsOf(t.participants, own)));
  const old = await prisma.emailThread.findMany({
    where: { lastMessageAt: { lt: cutoff }, quoteAcceptanceAudits: { none: {} } },
    select: { id: true, clientId: true, participants: true },
    orderBy: { lastMessageAt: "asc" },
    take: 200,
  });
  let purged = 0;
  for (const thread of old) {
    if (thread.clientId && recentClients.has(thread.clientId)) continue;
    if (contactsOf(thread.participants, own).some((a) => recentContacts.has(a))) continue;
    const files = await prisma.emailAttachment.findMany({ where: { message: { threadId: thread.id } }, select: { storagePath: true } });
    const { count } = await prisma.emailThread.deleteMany({ where: { id: thread.id, lastMessageAt: { lt: cutoff } } });
    if (count === 0) continue;
    for (const f of files) await fs.rm(attachmentAbsPath(f.storagePath), { force: true }).catch(() => undefined);
    purged += 1;
  }
  return purged;
}

/**
 * Pièces comptables et preuves : 10 ans à compter de la clôture de l'exercice (art. L123-22 du code de commerce), soit
 * jusqu'au 31 décembre de l'année + 10 ; purgées à partir du 1er janvier suivant. Rend le début de l'année dont les
 * documents sont encore gardés.
 */
export function accountingCutoff(now: Date): Date {
  return new Date(now.getFullYear() - 10, 0, 1);
}

/** Preuves de signature d'un devis signé il y a plus de 10 ans (exercice clos) : ligne et PDF archivés supprimés. */
async function purgeOldAcceptanceProofs(now: Date): Promise<number> {
  const old = await prisma.quoteAcceptanceAudit.findMany({
    where: { createdAt: { lt: accountingCutoff(now) } },
    select: { id: true, pdfPath: true, originalPdfPath: true },
    take: 200,
  });
  for (const proof of old) {
    for (const p of [proof.pdfPath, proof.originalPdfPath]) if (p) await fs.rm(signedQuoteAbsolutePath(p), { force: true }).catch(() => undefined);
  }
  if (old.length === 0) return 0;
  const { count } = await prisma.quoteAcceptanceAudit.deleteMany({ where: { id: { in: old.map((p) => p.id) } } });
  return count;
}

/**
 * Client dont tous les documents ont passé leurs 10 ans, sans abonnement en cours ni échange depuis 3 ans : anonymisé
 * comme un effacement demandé (lib/clients/erasure). Les lignes comptables (montants, numéros) restent.
 */
async function anonymizeExpiredClients(now: Date): Promise<number> {
  const cutoff = accountingCutoff(now);
  const quiet = new Date(now.getTime() - RETENTION.prospectMs);
  const expired = await prisma.client.findMany({
    where: {
      NOT: { displayName: { startsWith: "Client effacé" } },
      updatedAt: { lt: quiet },
      invoices: { some: {}, none: { OR: [{ issueDate: { gte: cutoff } }, { issueDate: null, createdAt: { gte: cutoff } }] } },
      subscriptions: { none: { status: { not: "ENDED" } } },
      emailThreads: { none: { lastMessageAt: { gte: quiet } } },
    },
    select: { id: true },
    take: 50,
  });
  let done = 0;
  for (const c of expired) {
    try {
      if ((await eraseClient(c.id)).mode === "ANONYMIZED") done += 1;
    } catch (err) {
      console.error(`[conservation] anonymisation du client ${c.id} impossible`, err instanceof Error ? err.message : err);
    }
  }
  return done;
}

/** Contenu brut des webhooks traités depuis plus d'un an : vidé, la ligne reste (idempotence, date, type). */
async function purgeWebhookPayloads(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION.webhookPayloadMs);
  const empty = (payload: unknown) => payload !== null && typeof payload === "object" && Object.keys(payload).length === 0;
  const stripe = (await prisma.stripeWebhookEvent.findMany({ where: { processedAt: { lt: cutoff }, status: "DONE" }, select: { id: true, payload: true }, take: 500 }))
    .filter((e) => !empty(e.payload))
    .map((e) => e.id);
  const revolut = (await prisma.revolutWebhookEvent.findMany({ where: { processedAt: { lt: cutoff } }, select: { id: true, payload: true }, take: 500 }))
    .filter((e) => !empty(e.payload))
    .map((e) => e.id);
  const a = stripe.length ? await prisma.stripeWebhookEvent.updateMany({ where: { id: { in: stripe } }, data: { payload: {} } }) : { count: 0 };
  const b = revolut.length ? await prisma.revolutWebhookEvent.updateMany({ where: { id: { in: revolut } }, data: { payload: {} } }) : { count: 0 };
  return a.count + b.count;
}

/**
 * Prospect sans suite : aucun document (même brouillon), aucun abonnement, projet, avis ni témoignage, et aucune activité
 * depuis 3 ans (fiche, e-mail envoyé, fil de messagerie). Les fils de la boîte IMAP restent (miroir) et
 * perdent seulement le lien vers la fiche.
 */
async function purgeStaleProspects(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION.prospectMs);
  const stale = await prisma.client.findMany({
    where: {
      updatedAt: { lt: cutoff },
      invoices: { none: {} },
      subscriptions: { none: {} },
      projects: { none: {} },
      // Un avis ou témoignage lié prouve la relation client (L111-7-2) : la fiche reste.
      siteReviews: { none: {} },
      testimonials: { none: {} },
      emailEvents: { none: { sentAt: { gte: cutoff } } },
      emailThreads: { none: { lastMessageAt: { gte: cutoff } } },
    },
    select: { id: true },
    take: 200,
  });
  if (stale.length === 0) return 0;
  const { count } = await prisma.client.deleteMany({ where: { id: { in: stale.map((c) => c.id) }, invoices: { none: {} }, subscriptions: { none: {} } } });
  return count;
}

export async function purgeRetention(now: Date = new Date()) {
  const before = (ms: number) => new Date(now.getTime() - ms);
  const invitations = await prisma.onboardingInvitation.deleteMany({
    where: {
      OR: [{ usedAt: { lt: before(RETENTION.invitationMs) } }, { usedAt: null, expiresAt: { lt: before(RETENTION.invitationMs) } }],
    },
  });
  const outbox = await prisma.emailOutbox.updateMany({
    where: {
      status: EmailOutboxStatus.SENT,
      sentAt: { lt: before(RETENTION.outboxPayloadMs) },
      OR: [{ payload: { not: "" } }, { payloadEncrypted: { not: null } }],
    },
    data: { payload: "", payloadEncrypted: null },
  });
  const emailEvents = await prisma.clientEmailEvent.deleteMany({ where: { sentAt: { lt: before(RETENTION.emailEventMs) } } });
  // Sessions admin expirées (7 jours au plus) ou inactives depuis 24 h.
  const sessions = await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { lastSeenAt: { lt: new Date(now.getTime() - DAY) } }] },
  });
  const prospects = await purgeStaleProspects(now);
  // Demande de logiciel (Tracebay) non convertie : comme un prospect, 3 ans après le dernier échange.
  const softwareRequests = await prisma.softwareRequest.deleteMany({
    where: { status: { not: "CONVERTED" }, updatedAt: { lt: before(RETENTION.prospectMs) } },
  });
  const mailThreads = await purgeOldMail(now);
  const webhookPayloads = await purgeWebhookPayloads(now);
  const acceptanceProofs = await purgeOldAcceptanceProofs(now);
  const expiredClients = await anonymizeExpiredClients(now);
  return {
    mailThreads,
    webhookPayloads,
    acceptanceProofs,
    expiredClients,
    invitations: invitations.count,
    outbox: outbox.count,
    emailEvents: emailEvents.count,
    sessions: sessions.count,
    prospects,
    softwareRequests: softwareRequests.count,
  };
}
