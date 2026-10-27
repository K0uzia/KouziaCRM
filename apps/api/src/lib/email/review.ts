import { EmailOutboxStatus, InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { decrypt, encrypt } from "@/lib/crypto.js";
import { getCompanySettings } from "@/lib/company.js";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { parsePayload, serializePayload } from "@/lib/email/mailer/outbox.js";
import { templateKeyFor } from "@/lib/email/template-registry.js";

/**
 * File « E-mails à valider » (décision d'Alexandre, 23/10/2026) : tout e-mail automatique destiné à un client attend sa
 * validation, sauf les codes de connexion /suivi et les alertes de sécurité (envoyés aussitôt), et sauf les familles
 * qu'il a choisies de valider d'office dans les Réglages. La mise en demeure est toujours validée à la main.
 */
export const REVIEW_FAMILIES = {
  payment_receipt: "Reçu de paiement",
  subscription_invoice: "Facture d'abonnement",
  payment_link: "Lien de paiement ou de prélèvement",
  reminder: "Relance",
  formal_notice: "Mise en demeure",
  deposit_reminder: "Rappel d'échéance d'acompte",
  subscription_notice: "Rappel d'abonnement ou de renouvellement",
  payment_issue: "Échec ou régularisation de paiement",
  signature_confirmation: "Confirmation de signature",
  portal_access: "Accès à l'espace client",
  review_invite: "Invitation à témoigner",
  cancellation_ack: "Résiliation (accusé, programmation)",
  document: "Document envoyé d'office",
} as const;
export type ReviewFamily = keyof typeof REVIEW_FAMILIES;
export const REVIEW_FAMILY_IDS = Object.keys(REVIEW_FAMILIES) as ReviewFamily[];
/** Jamais validée d'office : ni proposée dans les Réglages, ni acceptée par l'API. */
export const ALWAYS_REVIEWED: ReadonlySet<ReviewFamily> = new Set(["formal_notice"]);

export const EMAIL_ORIGINS = {
  WORKER: "Automatique (tâche planifiée)",
  WEBHOOK: "Paiement Stripe",
  CLIENT_ACTION: "Action du client sur /suivi",
  ADMIN_ACTION: "Suite à votre action",
  CLICK: "Envoi sur clic",
} as const;
export type EmailOrigin = keyof typeof EMAIL_ORIGINS;

/** À fournir à mailEnqueue pour tout e-mail automatique destiné à un client. */
export type ReviewOptions = { family: ReviewFamily; origin: EmailOrigin; clientWaiting?: boolean };

/** Familles validées d'office (réglage JSON) ; une valeur inconnue ou la mise en demeure est ignorée. */
export function parseAutoApprove(json: string | null | undefined): ReviewFamily[] {
  try {
    const list = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((f): f is ReviewFamily => REVIEW_FAMILY_IDS.includes(f) && !ALWAYS_REVIEWED.has(f)) : [];
  } catch {
    return [];
  }
}

/** Cet e-mail attend-il la validation ? Non si sa famille est validée d'office (jamais pour la mise en demeure). */
export async function needsReview(review: ReviewOptions): Promise<boolean> {
  if (ALWAYS_REVIEWED.has(review.family)) return true;
  const settings = await getCompanySettings();
  return !parseAutoApprove(settings.emailAutoApproveKinds).includes(review.family);
}

const DAY_MS = 86_400_000;
const REJECTED_WINDOW_MS = 30 * DAY_MS;

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

type Row = Awaited<ReturnType<typeof prisma.emailOutbox.findMany>>[number];

/** Vue d'une ligne pour l'écran (contenu déchiffré : réservé à l'admin, jamais journalisé). */
async function view(row: Row, clients: Map<string, string>) {
  const p = parsePayload(outboxPayloadRaw(row));
  return {
    id: row.id,
    status: row.status,
    to: Array.isArray(p.to) ? p.to.join(", ") : p.to,
    subject: p.subject,
    clientId: p.clientId ?? null,
    clientName: p.clientId ? (clients.get(p.clientId) ?? null) : null,
    documentId: row.documentId,
    documentNumber: p.documentNumber ?? null,
    family: row.reviewFamily,
    familyLabel: row.reviewFamily ? (REVIEW_FAMILIES[row.reviewFamily as ReviewFamily] ?? row.reviewFamily) : null,
    // « Modifier le modèle » : modèle qui donne le texte de cet e-mail (null : texte du code seul).
    templateKey: templateKeyFor(p.kind ?? row.reviewKind, row.reviewFamily),
    origin: row.origin,
    originLabel: row.origin ? (EMAIL_ORIGINS[row.origin as EmailOrigin] ?? row.origin) : null,
    clientWaiting: row.clientWaiting,
    attachments: (p.attachments ?? []).map((a) => ({ filename: a.filename, bytes: Math.floor((a.contentBase64.length * 3) / 4) })),
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    rejectReason: row.rejectReason ? decrypt(row.rejectReason) : null,
  };
}

async function clientNames(rows: Row[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => parsePayload(outboxPayloadRaw(r)).clientId).filter((x): x is string => Boolean(x)))];
  const list = ids.length ? await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }) : [];
  return new Map(list.map((c) => [c.id, c.displayName]));
}

/** E-mails en attente (les plus urgents puis les plus anciens d'abord) et refus des 30 derniers jours. */
export async function listReviewQueue(now = new Date()) {
  const [pending, rejected] = await Promise.all([
    prisma.emailOutbox.findMany({ where: { status: EmailOutboxStatus.REVIEW }, orderBy: [{ clientWaiting: "desc" }, { createdAt: "asc" }] }),
    prisma.emailOutbox.findMany({
      where: { status: EmailOutboxStatus.REJECTED, reviewedAt: { gte: new Date(now.getTime() - REJECTED_WINDOW_MS) } },
      orderBy: { reviewedAt: "desc" },
    }),
  ]);
  const names = await clientNames([...pending, ...rejected]);
  return {
    pending: await Promise.all(pending.map((r) => view(r, names))),
    rejected: await Promise.all(rejected.map((r) => view(r, names))),
  };
}

/** Un e-mail à valider, avec son texte (pour « Vérifier l'e-mail »). */
export async function getReviewEmail(id: string) {
  const row = await prisma.emailOutbox.findUnique({ where: { id } });
  if (!row || (row.status !== EmailOutboxStatus.REVIEW && row.status !== EmailOutboxStatus.REJECTED)) throw new ReviewError("E-mail introuvable", 404);
  const p = parsePayload(outboxPayloadRaw(row));
  return { ...(await view(row, await clientNames([row]))), text: p.text ?? "", hasCustomLayout: Boolean(p.html) };
}

/** Échecs de paiement : à revalider avant l'envoi (le paiement a pu être régularisé depuis). */
const PAYMENT_FAILURE_KINDS: ReadonlySet<string> = new Set(["payment_failed", "subscription_payment_failed"]);
const REMINDER_REVIEW_KINDS: ReadonlySet<string> = new Set(["reminder_soft", "reminder_firm", "reminder_formal"]);

/** Avis d'abonnement devenus sans objet quand la fin est actée (rachat signé, fin programmée ou clôture). */
export const SUBSCRIPTION_NOTICE_KINDS = ["subscription_renewal", "subscription_term_end", "subscription_term_end_buyout", "subscription_first_charge"] as const;

/** Motif pour lequel un e-mail en attente ne doit plus partir ; null s'il reste valable. */
async function obsoleteReason(row: { reviewKind: string | null; documentId: string | null }): Promise<string | null> {
  if (!row.documentId || !row.reviewKind) return null;
  // Relance validée après le règlement, l'annulation ou la réponse au devis (audit du 27/10/2026) : jamais envoyée.
  if (REMINDER_REVIEW_KINDS.has(row.reviewKind)) {
    const doc = await prisma.invoice.findUnique({ where: { id: row.documentId }, select: { documentType: true, status: true, quoteStatus: true } });
    if (!doc) return null;
    if (doc.documentType === "QUOTE") return doc.quoteStatus === "SENT" ? null : "Devis accepté, refusé ou expiré depuis : relance retirée.";
    return doc.status === InvoiceStatus.ISSUED ? null : "Facture réglée ou annulée depuis : relance retirée.";
  }
  if (row.reviewKind.startsWith("deposit_reminder")) {
    const milestone = await prisma.paymentMilestone.findUnique({ where: { id: row.documentId }, select: { status: true } });
    return milestone && (milestone.status === "PAID" || milestone.status === "CANCELLED") ? "Acompte réglé ou annulé depuis : rappel retiré." : null;
  }
  if (!PAYMENT_FAILURE_KINDS.has(row.reviewKind)) return null;
  const [invoice, milestone] = await Promise.all([
    prisma.invoice.findUnique({ where: { id: row.documentId }, select: { status: true } }),
    prisma.paymentMilestone.findUnique({ where: { id: row.documentId }, select: { status: true } }),
  ]);
  return invoice?.status === InvoiceStatus.PAID || milestone?.status === "PAID" ? "Paiement régularisé depuis : e-mail d'échec retiré." : null;
}

/** E-mails en attente d'un document devenus sans objet : refusés avec leur motif (jamais envoyés). */
export async function rejectObsoleteReviewEmails(documentId: string, kinds: readonly string[], reason: string, now = new Date()): Promise<number> {
  const res = await prisma.emailOutbox.updateMany({
    where: { documentId, reviewKind: { in: [...kinds] }, status: EmailOutboxStatus.REVIEW },
    data: { status: EmailOutboxStatus.REJECTED, reviewedAt: now, rejectReason: encrypt(reason) },
  });
  return res.count;
}

async function rejectAsObsolete(id: string, reason: string, now: Date): Promise<void> {
  await prisma.emailOutbox.updateMany({
    where: { id, status: EmailOutboxStatus.REVIEW },
    data: { status: EmailOutboxStatus.REJECTED, reviewedAt: now, rejectReason: encrypt(reason) },
  });
}

/**
 * Valide un e-mail : il rejoint la file d'envoi normale. Objet ou texte modifié : contenu rechiffré, et la mise en page
 * HTML est refaite à l'envoi depuis le texte (les liens y restent en clair), pour que les deux versions disent la même chose.
 */
export async function approveReviewEmail(id: string, edits: { subject?: string; text?: string } = {}, now = new Date()) {
  const row = await prisma.emailOutbox.findUnique({ where: { id } });
  if (!row) throw new ReviewError("E-mail introuvable", 404);
  if (row.status !== EmailOutboxStatus.REVIEW) throw new ReviewError("Cet e-mail n'est plus en attente de validation.", 409);
  const obsolete = await obsoleteReason(row);
  if (obsolete) {
    await rejectAsObsolete(id, obsolete, now);
    throw new ReviewError(obsolete, 409);
  }
  const p = parsePayload(outboxPayloadRaw(row));
  const subject = edits.subject?.trim();
  const text = edits.text?.trim();
  if (subject) p.subject = subject;
  if (text && text !== (p.text ?? "").trim()) {
    p.text = text;
    p.bodyTextForMessage = text;
    delete p.html;
  }
  const claimed = await prisma.emailOutbox.updateMany({
    where: { id, status: EmailOutboxStatus.REVIEW },
    data: { status: EmailOutboxStatus.PENDING, scheduledAt: now, reviewedAt: now, payloadEncrypted: encrypt(serializePayload(p)) },
  });
  if (claimed.count === 0) throw new ReviewError("Cet e-mail n'est plus en attente de validation.", 409);
  await resumeReminder(p.reminderInvoiceId, now);
}

/**
 * Relance validée : même état qu'une relance mise en file sans validation (délai d'une heure, puis l'envoi programme la
 * suivante). Sans cela, nextReminderAt resterait nul (posé à la mise en attente) et plus aucune relance ne partirait.
 */
async function resumeReminder(invoiceId: string | undefined, now: Date) {
  if (!invoiceId) return;
  const { markReminderQueued } = await import("@/lib/reminders.js");
  await markReminderQueued(invoiceId, now);
}

/** Valide plusieurs e-mails tels quels ; renvoie le nombre réellement validés (ceux déjà traités sont ignorés). */
export async function approveReviewEmails(ids: string[], now = new Date()): Promise<number> {
  const rows = await prisma.emailOutbox.findMany({ where: { id: { in: ids }, status: EmailOutboxStatus.REVIEW } });
  let approved = 0;
  for (const row of rows) {
    const obsolete = await obsoleteReason(row);
    if (obsolete) {
      await rejectAsObsolete(row.id, obsolete, now);
      continue;
    }
    const claimed = await prisma.emailOutbox.updateMany({
      where: { id: row.id, status: EmailOutboxStatus.REVIEW },
      data: { status: EmailOutboxStatus.PENDING, scheduledAt: now, reviewedAt: now },
    });
    if (claimed.count === 0) continue;
    approved += 1;
    await resumeReminder(parsePayload(outboxPayloadRaw(row)).reminderInvoiceId, now);
  }
  return approved;
}

/**
 * Refuse un e-mail : jamais envoyé, motif gardé (chiffré, jamais transmis au client). Pour que le générateur ne le
 * reproduise pas aussitôt : une relance repart au cycle suivant (délai des réglages, compteur inchangé) ; un rappel
 * d'acompte est noté refusé dans l'historique e-mail du client (il n'est pas reproposé le même jour).
 */
export async function rejectReviewEmail(id: string, reason: string, now = new Date()) {
  const row = await prisma.emailOutbox.findUnique({ where: { id } });
  if (!row) throw new ReviewError("E-mail introuvable", 404);
  const claimed = await prisma.emailOutbox.updateMany({
    where: { id, status: EmailOutboxStatus.REVIEW },
    data: { status: EmailOutboxStatus.REJECTED, reviewedAt: now, rejectReason: encrypt(reason.trim()) },
  });
  if (claimed.count === 0) throw new ReviewError("Cet e-mail n'est plus en attente de validation.", 409);
  const p = parsePayload(outboxPayloadRaw(row));
  if (p.reminderInvoiceId) {
    const settings = await getCompanySettings();
    const inv = await prisma.invoice.findUnique({ where: { id: p.reminderInvoiceId }, select: { documentType: true } });
    if (inv) {
      const days = inv.documentType === InvoiceDocumentType.QUOTE ? settings.reminderQuoteDays : settings.reminderInvoiceDays;
      await prisma.invoice.update({ where: { id: p.reminderInvoiceId }, data: { nextReminderAt: new Date(now.getTime() + days * DAY_MS) } });
    }
  }
  if (row.reviewFamily === "deposit_reminder" && p.clientId) {
    const to = Array.isArray(p.to) ? p.to.join(", ") : p.to;
    await prisma.clientEmailEvent.create({
      data: {
        clientId: p.clientId,
        kind: row.reviewKind ?? p.kind ?? "deposit_reminder",
        subject: p.subject,
        toAddress: "",
        toAddressEncrypted: encrypt(to),
        documentId: p.documentId ?? null,
        documentNumber: p.documentNumber ?? null,
        success: false,
        errorMessage: `Refusé à la validation : ${reason.trim()}`,
        sentAt: now,
      },
    });
  }
}

/** Une ligne ouverte (à valider, à envoyer ou en cours) existe-t-elle déjà pour ce document et ce kind ? */
export async function hasOpenEmail(documentId: string, kind: string): Promise<boolean> {
  const n = await prisma.emailOutbox.count({
    where: {
      documentId,
      reviewKind: kind,
      status: { in: [EmailOutboxStatus.REVIEW, EmailOutboxStatus.PENDING, EmailOutboxStatus.SENDING] },
    },
  });
  return n > 0;
}

/** Nombre d'e-mails en attente (pastille du menu). */
export const countReviewQueue = () => prisma.emailOutbox.count({ where: { status: EmailOutboxStatus.REVIEW } });
