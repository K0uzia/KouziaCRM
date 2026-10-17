import { OUTBOUND_HEADER } from "@/lib/email/own-messages.js";
import { EmailDirection, EmailOutboxStatus } from "@prisma/client";
import { getCompanySettings } from "@/lib/company.js";
import { prisma } from "@/lib/prisma.js";
import { logClientEmailEvent } from "@/lib/email/log-event.js";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import {
  formatSmtpError,
  getSharedTransport,
  resolveFromAddress,
} from "@/lib/email/smtp.js";
import { saveEmailAttachment } from "@/lib/email/attachments.js";
import { renderEmailHtml, renderEmailTextFooter, type EmailLayoutBrand } from "@/lib/email/layout.js";
import {
  buildReferences,
  extractDisplayName,
  extractEmailAddress,
  formatFrom,
  generateMessageId,
} from "./headers.js";
import {
  claimPendingOutbox,
  countSentSince,
  markOutboxFailed,
  markOutboxSent,
  parsePayload,
} from "./outbox.js";

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

function decodeAttachments(payload: ReturnType<typeof parsePayload>) {
  return (payload.attachments ?? []).map((a) => ({
    filename: a.filename,
    content: Buffer.from(a.contentBase64, "base64"),
    contentType: a.contentType,
  }));
}

async function recordOutboundMessage(opts: {
  outboxId: string;
  payload: ReturnType<typeof parsePayload>;
  smtpMessageId: string | undefined;
  fromFormatted: string;
}) {
  const { payload, outboxId, smtpMessageId, fromFormatted } = opts;
  if (!payload.threadId) return;

  const messageId = smtpMessageId || generateMessageId(outboxId);
  const existing = await prisma.emailMessage.findUnique({ where: { messageId } });
  if (existing) return;

  const toList = Array.isArray(payload.to) ? payload.to : [payload.to];

  await prisma.emailMessage.create({
    data: {
      threadId: payload.threadId,
      direction: EmailDirection.OUTBOUND,
      messageId,
      inReplyTo: payload.inReplyTo ?? null,
      fromAddress: extractEmailAddress(fromFormatted),
      fromName: extractDisplayName(fromFormatted),
      toAddresses: JSON.stringify(toList.map((t) => t.toLowerCase())),
      subject: payload.subject,
      bodyText: payload.bodyTextForMessage ?? payload.text ?? null,
      bodyHtml: payload.html ?? null,
      receivedAt: new Date(),
      isRead: true,
    },
  });

  await prisma.emailThread.update({
    where: { id: payload.threadId },
    data: { lastMessageAt: new Date() },
  });
}

async function persistOutboundAttachments(
  outboxId: string,
  payload: ReturnType<typeof parsePayload>,
): Promise<void> {
  const attachments = payload.attachments ?? [];
  if (attachments.length === 0 || !payload.threadId) return;

  const messageIdHeader = generateMessageId(outboxId);
  const smtpId = payload.headers?.["Message-ID"];
  const lookupId = smtpId ?? messageIdHeader;
  let message = await prisma.emailMessage.findFirst({
    where: {
      OR: [{ messageId: lookupId }, { threadId: payload.threadId, direction: EmailDirection.OUTBOUND }],
    },
    orderBy: { receivedAt: "desc" },
  });
  if (!message) return;

  let totalBytes = 0;
  for (const att of attachments) {
    const content = Buffer.from(att.contentBase64, "base64");
    if (content.length === 0) continue;
    totalBytes += content.length;
    try {
      const saved = await saveEmailAttachment({
        messageId: message.id,
        filename: att.filename,
        mimeType: att.contentType ?? "application/octet-stream",
        content,
      });
      await prisma.emailAttachment.create({
        data: {
          messageId: message.id,
          filename: att.filename,
          mimeType: att.contentType ?? "application/octet-stream",
          sizeBytes: saved.sizeBytes,
          storagePath: saved.storagePath,
        },
      });
    } catch {
      /* best-effort */
    }
  }
  if (totalBytes > 0) {
    await prisma.emailThread.update({
      where: { id: payload.threadId },
      data: { hasAttachments: true },
    });
  }
}

async function recordClientEvent(opts: {
  outboxId: string;
  payload: ReturnType<typeof parsePayload>;
  success: boolean;
  errorMessage?: string;
}) {
  const { payload, outboxId, success, errorMessage } = opts;
  if (!payload.clientId) return;
  const to = Array.isArray(payload.to) ? payload.to[0] : payload.to;
  await logClientEmailEvent({
    clientId: payload.clientId,
    kind: payload.kind ?? "custom",
    subject: payload.subject,
    toAddress: to,
    documentId: payload.documentId ?? null,
    documentNumber: payload.documentNumber ?? null,
    success,
    errorMessage: errorMessage ?? null,
    outboxId,
    threadId: payload.threadId ?? null,
  });
}

type Settings = Awaited<ReturnType<typeof getCompanySettings>>;

function layoutBrand(settings: Settings): EmailLayoutBrand {
  return {
    tradeName: settings.tradeName ?? settings.legalName,
    legalName: settings.legalName,
    siret: settings.siret,
    addressLine1: settings.addressLine1,
    postalCode: settings.postalCode,
    city: settings.city,
    website: settings.website,
  };
}

/** E-mail automatique (pied de mentions légales) ; les messages rédigés à la main (« custom ») restent tels quels. */
function isAutomatic(payload: ReturnType<typeof parsePayload>, settings: Settings | null): settings is Settings {
  return Boolean(payload.text && settings && payload.kind && payload.kind !== "custom");
}

/** Emails automatiques envoyés en texte seul : version HTML aux couleurs de la charte. */
function brandedHtml(payload: ReturnType<typeof parsePayload>, settings: Settings | null): string | undefined {
  if (!isAutomatic(payload, settings)) return undefined;
  return renderEmailHtml({ text: payload.text!, brand: layoutBrand(settings), colors: settings });
}

/** Partie text/plain : mêmes mentions légales que le pied HTML, ajoutées une seule fois à l'envoi. */
function textWithFooter(payload: ReturnType<typeof parsePayload>, settings: Settings | null): string | undefined {
  if (!isAutomatic(payload, settings)) return payload.text;
  return `${payload.text!.trimEnd()}\n\n${renderEmailTextFooter(layoutBrand(settings))}`;
}

/** E-mails automatiques : partent de l'expéditeur transactionnel (noreply@) s'il est réglé. */
const TRANSACTIONAL_KINDS = new Set(["portal_code", "portal_alert", "onboarding", "access", "admin_alert", "review_invite"]);

/** Refus de l'adresse d'expédition par le serveur SMTP (alias non autorisé à l'envoi, etc.). */
function isSenderRejected(err: unknown): boolean {
  const e = err as { responseCode?: number; response?: string; message?: string };
  const text = `${e.response ?? ""} ${e.message ?? ""}`;
  return [550, 553, 554].includes(e.responseCode ?? 0) && /sender|from|owned|authori[sz]|not allowed|mismatch/i.test(text);
}

async function sendOutboxRow(outboxId: string, rawPayload: string): Promise<void> {
  const payload = parsePayload(rawPayload);
  const messageIdHeader = generateMessageId(outboxId);
  const references = buildReferences(payload.inReplyTo, payload.references);

  const settings = await getCompanySettings().catch(() => null);
  const defaultFrom = await resolveFromAddress(settings?.smtpFromName);
  const transactional = Boolean(payload.kind && TRANSACTIONAL_KINDS.has(payload.kind) && settings?.transactionalFrom);
  let fromFormatted = transactional ? formatFrom(settings!.transactionalFrom!, settings?.smtpFromName) : defaultFrom;

  const headers: Record<string, string> = {
    ...(payload.headers ?? {}),
    "Message-ID": messageIdHeader,
    // Reconnu par la synchro IMAP : un envoi de l'ERP n'est jamais un « nouveau message ».
    [OUTBOUND_HEADER]: "1",
  };
  if (payload.inReplyTo) headers["In-Reply-To"] = payload.inReplyTo;
  if (references) headers["References"] = references;

  let replyTo = payload.replyTo;
  if (!replyTo && settings?.smtpReplyTo) replyTo = settings.smtpReplyTo;
  // noreply@ : les réponses du client arrivent quand même dans la boîte habituelle.
  if (!replyTo && transactional) replyTo = extractEmailAddress(defaultFrom);

  const transport = await getSharedTransport();
  const mailOptions = {
    from: fromFormatted,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    text: textWithFooter(payload, settings),
    html: payload.html ?? brandedHtml(payload, settings),
    replyTo,
    headers,
    attachments: decodeAttachments(payload),
  };

  let rawMessage: Buffer | null = null;
  try {
    const MailComposer = (await import("nodemailer/lib/mail-composer")).default;
    rawMessage = await new MailComposer(mailOptions).compile().build();
  } catch {
    rawMessage = null;
  }

  let info: { messageId?: string };
  try {
    info = await transport.sendMail(mailOptions);
  } catch (err) {
    if (!transactional || !isSenderRejected(err)) throw err;
    // Expéditeur transactionnel refusé : l'e-mail part quand même, depuis l'adresse habituelle.
    console.warn(`[mail] expéditeur transactionnel refusé, envoi depuis l'adresse habituelle (${outboxId})`);
    fromFormatted = defaultFrom;
    mailOptions.from = defaultFrom;
    info = await transport.sendMail(mailOptions);
  }

  if (rawMessage) {
    try {
      const { appendMessageToSentFolder } = await import("@/lib/email/sync/append-sent.js");
      await appendMessageToSentFolder(rawMessage);
    } catch {
      /* append Sent best-effort */
    }
  }

  await markOutboxSent(outboxId);
  await recordOutboundMessage({
    outboxId,
    payload,
    smtpMessageId: info.messageId,
    fromFormatted,
  });
  await recordClientEvent({ outboxId, payload, success: true });

  if (payload.reminderInvoiceId) {
    const { markReminderSent } = await import("@/lib/reminders.js");
    await markReminderSent(payload.reminderInvoiceId, new Date());
  }
  await persistOutboundAttachments(outboxId, payload);
  if (payload.markAccessEmailSent && payload.clientId) {
    await prisma.client.update({
      where: { id: payload.clientId },
      data: { accessEmailSentAt: new Date() },
    });
  }
}

export async function processEmailOutbox(): Promise<{ processed: number; failed: number }> {
  const settings = await getCompanySettings().catch(() => null);
  const throttle = Math.max(1, settings?.emailThrottlePerMinute ?? 30);
  const since = new Date(Date.now() - 60_000);
  const sentLastMinute = await countSentSince(since);
  const capacity = Math.max(0, throttle - sentLastMinute);
  if (capacity === 0) return { processed: 0, failed: 0 };

  const rows = await claimPendingOutbox(capacity);
  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await sendOutboxRow(row.id, outboxPayloadRaw(row));
      processed += 1;
    } catch (e) {
      failed += 1;
      const error = formatSmtpError(e);
      const attempts = row.attempts + 1;
      const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
      const retryAt =
        attempts < row.maxAttempts ? new Date(Date.now() + delay) : undefined;
      await markOutboxFailed(row.id, error, retryAt);

      if (!retryAt) {
        const payload = parsePayload(outboxPayloadRaw(row));
        await recordClientEvent({
          outboxId: row.id,
          payload,
          success: false,
          errorMessage: error,
        });
      }
    }
  }

  return { processed, failed };
}

/**
 * Envoi immédiat d'un message urgent (code de connexion) sans attendre le passage du worker.
 * La ligne est réservée comme dans le worker : jamais d'envoi en double. En cas d'échec,
 * elle repasse en attente et le worker réessaie.
 */
export async function sendOutboxImmediately(outboxId: string): Promise<boolean> {
  const claimed = await prisma.emailOutbox.updateMany({
    where: { id: outboxId, status: EmailOutboxStatus.PENDING },
    data: { status: EmailOutboxStatus.SENDING },
  });
  if (claimed.count !== 1) return false;
  const row = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outboxId } });
  try {
    await sendOutboxRow(row.id, outboxPayloadRaw(row));
    return true;
  } catch (e) {
    await markOutboxFailed(row.id, formatSmtpError(e), new Date(Date.now() + RETRY_DELAYS_MS[0]));
    return false;
  }
}

/** Envoi immediat (tests, bypass throttle). */
export async function sendOutboxNow(outboxId: string): Promise<void> {
  const row = await prisma.emailOutbox.findUnique({ where: { id: outboxId } });
  if (!row) throw new Error("Outbox introuvable");
  await sendOutboxRow(row.id, outboxPayloadRaw(row));
}
