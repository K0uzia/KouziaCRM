import { simpleParser } from "mailparser";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { saveEmailAttachment } from "@/lib/email/attachments.js";
import { resetRemindersForMatchedDocuments } from "@/lib/reminders.js";
import { sanitizeEmailHtml, sanitizePlainText } from "@/lib/email/sanitize-html.js";
import { withImapClient } from "@/lib/email/sync/imap-connection.js";

export async function fetchMessageBody(
  messageId: string,
  opts: { allowRemoteImages?: boolean } = {},
): Promise<{
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>;
}> {
  const message = await prisma.emailMessage.findUniqueOrThrow({
    where: { id: messageId },
    include: { folder: true, attachments: true },
  });

  if (message.bodyFetched && (message.bodyText || message.bodyHtml)) {
    return {
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml
        ? sanitizeEmailHtml(message.bodyHtml, opts)
        : null,
      attachments: message.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })),
    };
  }

  if (!message.folder || !message.imapUid) {
    return {
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml
        ? sanitizeEmailHtml(message.bodyHtml, opts)
        : null,
      attachments: message.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })),
    };
  }

  let source: Buffer | null = null;
  await withImapClient(async ({ client }) => {
    await client.mailboxOpen(message.folder!.imapPath);
    for await (const msg of client.fetch(
      String(message.imapUid),
      { uid: true, source: true },
      { uid: true },
    )) {
      if (msg.source) source = msg.source;
    }
  });

  if (!source) {
    throw new Error("Corps du message introuvable sur le serveur IMAP");
  }

  const parsed = await simpleParser(source);
  const bodyText = parsed.text ? sanitizePlainText(parsed.text) : null;
  const rawHtml = typeof parsed.html === "string" ? parsed.html : null;
  const bodyHtml = rawHtml ? sanitizeEmailHtml(rawHtml, opts) : null;
  const snippet = (bodyText || rawHtml?.replace(/<[^>]+>/g, " ") || message.subject).slice(
    0,
    160,
  );
  const parsedFromName = parsed.from?.value?.[0]?.name?.trim() || null;

  const settings = await getCompanySettings().catch(() => null);
  const maxFileBytes = (settings?.attachmentMaxFileMb ?? 50) * 1024 * 1024;
  const maxMsgBytes = (settings?.attachmentMaxMessageMb ?? 80) * 1024 * 1024;
  let msgTotalBytes = 0;
  let hasAttachments = false;
  const attachmentRows: Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }> = [];

  for (const att of parsed.attachments ?? []) {
    const content = att.content;
    if (!content || !(content instanceof Buffer) || content.length === 0) continue;
    if (content.length > maxFileBytes) continue;
    if (msgTotalBytes + content.length > maxMsgBytes) continue;
    try {
      const saved = await saveEmailAttachment({
        messageId: message.id,
        filename: att.filename ?? "piece-jointe",
        mimeType: att.contentType ?? "application/octet-stream",
        content,
      });
      const row = await prisma.emailAttachment.create({
        data: {
          messageId: message.id,
          filename: att.filename ?? "piece-jointe",
          mimeType: att.contentType ?? "application/octet-stream",
          sizeBytes: saved.sizeBytes,
          storagePath: saved.storagePath,
        },
      });
      attachmentRows.push({
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
      });
      msgTotalBytes += content.length;
      hasAttachments = true;
    } catch {
      /* skip attachment */
    }
  }

  await prisma.emailMessage.update({
    where: { id: message.id },
    data: {
      bodyText,
      bodyHtml: rawHtml,
      snippet,
      fromName: message.fromName || parsedFromName,
      bodyFetched: true,
      hasAttachments: hasAttachments || message.hasAttachments,
      rawHeaders: JSON.stringify(parsed.headers || {}),
    },
  });

  if (hasAttachments) {
    await prisma.emailThread.update({
      where: { id: message.threadId },
      data: { hasAttachments: true },
    });
  }

  await resetRemindersForMatchedDocuments(message.subject, bodyText);

  return {
    bodyText,
    bodyHtml,
    attachments: attachmentRows,
  };
}
