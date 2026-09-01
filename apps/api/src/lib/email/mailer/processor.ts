import { EmailDirection } from "@prisma/client";
import { getCompanySettings } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { logClientEmailEvent } from "@/lib/email/log-event.js";
import {
  formatSmtpError,
  getSharedTransport,
  resolveFromAddress,
} from "@/lib/email/smtp.js";
import { saveEmailAttachment } from "@/lib/email/attachments.js";
import {
  buildReferences,
  extractDisplayName,
  extractEmailAddress,
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

async function sendOutboxRow(outboxId: string, rawPayload: string): Promise<void> {
  const payload = parsePayload(rawPayload);
  const messageIdHeader = generateMessageId(outboxId);
  const references = buildReferences(payload.inReplyTo, payload.references);

  const settings = await getCompanySettings().catch(() => null);
  const fromFormatted = await resolveFromAddress(settings?.smtpFromName);

  const headers: Record<string, string> = {
    ...(payload.headers ?? {}),
    "Message-ID": messageIdHeader,
  };
  if (payload.inReplyTo) headers["In-Reply-To"] = payload.inReplyTo;
  if (references) headers["References"] = references;

  let replyTo = payload.replyTo;
  if (!replyTo && settings?.smtpReplyTo) replyTo = settings.smtpReplyTo;

  const transport = await getSharedTransport();
  const mailOptions = {
    from: fromFormatted,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    replyTo,
    headers,
    attachments: decodeAttachments(payload),
  };

  let rawMessage: Buffer | null = null;
  try {
    const MailComposer = (await import("nodemailer/lib/mail-composer/index.js")).default;
    rawMessage = await new MailComposer(mailOptions).compile().build();
  } catch {
    rawMessage = null;
  }

  const info = await transport.sendMail(mailOptions);

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
      await sendOutboxRow(row.id, row.payload);
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
        const payload = parsePayload(row.payload);
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

/** Envoi immediat (tests, bypass throttle). */
export async function sendOutboxNow(outboxId: string): Promise<void> {
  const row = await prisma.emailOutbox.findUnique({ where: { id: outboxId } });
  if (!row) throw new Error("Outbox introuvable");
  await sendOutboxRow(row.id, row.payload);
}
