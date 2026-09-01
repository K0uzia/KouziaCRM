import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { EmailDirection, InvoiceDocumentType, QuoteStatus } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { getDashboardSnapshot } from "@/lib/finance/dashboard-service.js";
import { isCashflowScope } from "@/lib/finance/cashflow-service.js";
import { markUrssafPaid } from "@/lib/finance/dashboard-service.js";
import { isSmtpConfigured, resolveFromAddress } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { extractDisplayName, extractEmailAddress } from "@/lib/email/mailer/headers.js";
import { findClientIdByEmail } from "@/lib/email/match-client.js";
import { isImapConfigured, syncImapInbox } from "@/lib/email/imap-sync.js";
import {
  buildMessageListWhere,
  countMessagesByAudience,
  deleteMessage,
  deleteMessages,
  getMailFoldersWithCounts,
  getMailSyncStatus,
  moveMessageToFolder,
  runMailSync,
} from "@/lib/email/sync/index.js";
import { fetchMessageBody } from "@/lib/email/sync/body-fetch.js";
import { setBulkMessageFlags, setMessageFlags } from "@/lib/email/sync/flag-sync.js";
import { withImapClient } from "@/lib/email/sync/imap-connection.js";
import { toImapInt } from "@/lib/email/sync/imap-int.js";
import { decryptOptional } from "@/lib/crypto.js";
import { getCompanySettings } from "@/lib/company.js";
import { detectQuoteConfirmationIntent } from "@/lib/email/quote-confirmation-intent.js";
import {
  composeAttachmentsToOutbox,
  deleteComposeAttachments,
  saveComposeDraftAttachment,
} from "@/lib/email/compose-attachments.js";
import { ATTACHMENT_DEFAULTS } from "@/lib/settings/defaults.js";

export const miscRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/dashboard", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { scope?: string; invoiceId?: string };
    const rawScope = q.scope ?? "month";
    const scope = isCashflowScope(rawScope) ? rawScope : "month";
    const invoiceId = q.invoiceId && q.invoiceId.length > 0 ? q.invoiceId : null;
    return getDashboardSnapshot(scope, invoiceId);
  });

  /** Recherche globale : clients, devis, factures, avoirs, tarifs. */
  app.get("/api/search", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = String((request.query as { q?: string }).q ?? "").trim();
    if (q.length < 1) {
      return { clients: [], documents: [], services: [] };
    }

    const [clients, documents, services] = await Promise.all([
      prisma.client.findMany({
        where: {
          OR: [
            { displayName: { contains: q } },
            { clientNumber: { contains: q } },
            { companyName: { contains: q } },
            { firstName: { contains: q } },
            { lastName: { contains: q } },
            { city: { contains: q } },
          ],
        },
        select: {
          id: true,
          displayName: true,
          clientNumber: true,
          city: true,
          type: true,
        },
        orderBy: { displayName: "asc" },
        take: 8,
      }),
      prisma.invoice.findMany({
        where: {
          OR: [
            { number: { contains: q } },
            { notes: { contains: q } },
            { purchaseOrderRef: { contains: q } },
            { client: { displayName: { contains: q } } },
            { client: { clientNumber: { contains: q } } },
          ],
        },
        select: {
          id: true,
          number: true,
          documentType: true,
          status: true,
          quoteStatus: true,
          totalCents: true,
          client: { select: { displayName: true } },
        },
        orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
        take: 10,
      }),
      prisma.service.findMany({
        where: {
          OR: [{ name: { contains: q } }, { description: { contains: q } }],
        },
        select: {
          id: true,
          name: true,
          unitPriceCents: true,
          active: true,
          isSubscription: true,
        },
        orderBy: { name: "asc" },
        take: 6,
      }),
    ]);

    return {
      clients,
      documents: documents.map((d) => ({
        id: d.id,
        number: d.number,
        documentType: d.documentType,
        status: d.status,
        quoteStatus: d.quoteStatus,
        totalCents: d.totalCents,
        clientName: d.client.displayName,
      })),
      services,
    };
  });

  app.get("/api/payments", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { page?: string; pageSize?: string };
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 50));
    return prisma.payment.findMany({
      orderBy: { paidAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        invoice: {
          select: { id: true, number: true, client: { select: { displayName: true } } },
        },
      },
    });
  });

  app.get("/api/urssaf/declarations", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return prisma.urssafDeclaration.findMany({
      orderBy: { periodStart: "desc" },
      take: 50,
    });
  });

  app.post("/api/urssaf/mark-paid", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      periodKey: z.string().optional(),
      paymentRef: z.string().optional(),
    });
    const body = schema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    return markUrssafPaid(body.data);
  });

  app.get("/api/emails/folders", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      return await getMailFoldersWithCounts();
    } catch (e) {
      return reply.code(400).send({
        error: e instanceof Error ? e.message : "Impossible de lister les dossiers",
      });
    }
  });

  app.get("/api/emails/sync-status", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return (await getMailSyncStatus()) ?? { connected: false, idleActive: false };
  });

  app.get("/api/emails/messages", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as {
      folderId?: string;
      virtual?: string;
      audience?: string;
      clientId?: string;
      search?: string;
      q?: string;
      unread?: string;
      starred?: string;
      hasAttachments?: string;
      skip?: string;
      take?: string;
    };
    const search = (q.search ?? q.q ?? "").trim();
    const virtual =
      q.virtual === "unread" || q.virtual === "starred" || q.virtual === "attachments"
        ? q.virtual
        : undefined;
    const audience =
      q.audience === "clients" || q.audience === "external" ? q.audience : undefined;
    const listFilter = {
      folderId: q.folderId,
      virtual,
      audience,
      clientId: q.clientId,
      search,
      unread: q.unread === "true",
      starred: q.starred === "true",
      hasAttachments: q.hasAttachments === "true",
    };
    const where = buildMessageListWhere(listFilter);
    const skip = Math.max(0, Number(q.skip ?? 0));
    const take = Math.min(100, Math.max(1, Number(q.take ?? 50)));

    const [total, messages, audienceCounts] = await Promise.all([
      prisma.emailMessage.count({ where }),
      prisma.emailMessage.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        skip,
        take,
        include: {
          thread: {
            select: {
              id: true,
              subject: true,
              clientId: true,
              unreadCount: true,
              client: { select: { id: true, displayName: true } },
            },
          },
          folder: { select: { id: true, displayName: true, role: true } },
        },
      }),
      countMessagesByAudience({
        folderId: q.folderId,
        virtual,
        clientId: q.clientId,
        search,
        unread: q.unread === "true",
        starred: q.starred === "true",
        hasAttachments: q.hasAttachments === "true",
      }),
    ]);

    return {
      total,
      audienceCounts,
      skip,
      take,
      messages: messages.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        folderId: m.folderId,
        subject: m.subject,
        snippet: m.snippet ?? m.subject.slice(0, 120),
        fromAddress: m.fromAddress,
        fromName: m.fromName,
        receivedAt: m.receivedAt,
        isRead: m.isRead,
        isStarred: m.isStarred,
        hasAttachments: m.hasAttachments,
        direction: m.direction,
        thread: m.thread,
        folder: m.folder,
      })),
    };
  });

  app.get("/api/emails", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as {
      clientId?: string;
      search?: string;
      q?: string;
      hasAttachments?: string;
    };
    const search = (q.search ?? q.q ?? "").trim();
    const where: {
      clientId?: string;
      hasAttachments?: boolean;
      OR?: Array<{ subject?: { contains: string }; messages?: { some: { fromAddress: { contains: string } } } }>;
    } = {};
    if (q.clientId) where.clientId = q.clientId;
    if (q.hasAttachments === "true") where.hasAttachments = true;
    if (search) {
      where.OR = [
        { subject: { contains: search } },
        { messages: { some: { fromAddress: { contains: search } } } },
      ];
    }
    const threads = await prisma.emailThread.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      take: 100,
      include: {
        client: { select: { id: true, displayName: true } },
        messages: {
          orderBy: { receivedAt: "desc" },
          take: 1,
          select: {
            id: true,
            fromAddress: true,
            subject: true,
            bodyText: true,
            receivedAt: true,
            direction: true,
          },
        },
      },
    });
    return threads.map((t) => ({
      id: t.id,
      subject: t.subject,
      lastMessageAt: t.lastMessageAt,
      hasAttachments: t.hasAttachments,
      client: t.client,
      preview: t.messages[0]?.bodyText?.slice(0, 140) ?? "",
      lastFrom: t.messages[0]?.fromAddress ?? "",
      direction: t.messages[0]?.direction ?? null,
    }));
  });

  app.get<{ Params: { attachmentId: string } }>(
    "/api/emails/attachments/:attachmentId",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const att = await prisma.emailAttachment.findUnique({
        where: { id: request.params.attachmentId },
      });
      if (!att) return reply.code(404).send({ error: "Pièce jointe introuvable" });
      const { openAttachmentStream } = await import("@/lib/email/attachments.js");
      const stream = openAttachmentStream(att.storagePath);
      if (!stream) return reply.code(404).send({ error: "Fichier absent" });
      return reply
        .header("Content-Type", att.mimeType)
        .header("Content-Disposition", `attachment; filename="${att.filename.replace(/"/g, "")}"`)
        .send(stream);
    },
  );

  app.patch<{ Params: { messageId: string } }>(
    "/api/emails/messages/:messageId/read",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      await setMessageFlags(request.params.messageId, { read: true });
      return { ok: true };
    },
  );

  app.patch<{ Params: { messageId: string } }>(
    "/api/emails/messages/:messageId/flags",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const schema = z.object({
        read: z.boolean().optional(),
        starred: z.boolean().optional(),
      });
      const parsed = schema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      await setMessageFlags(request.params.messageId, parsed.data);
      return { ok: true };
    },
  );

  app.post("/api/emails/messages/bulk-flags", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      messageIds: z.array(z.string()).min(1),
      read: z.boolean().optional(),
      starred: z.boolean().optional(),
    });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const count = await setBulkMessageFlags(parsed.data.messageIds, parsed.data);
    return { ok: true, count };
  });

  app.post("/api/emails/messages/bulk-delete", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      messageIds: z.array(z.string()).min(1),
      permanent: z.boolean().optional(),
    });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const result = await deleteMessages(parsed.data.messageIds, parsed.data.permanent === true);
    return { ok: true, deleted: result.deleted };
  });

  app.get<{ Params: { messageId: string } }>(
    "/api/emails/messages/:messageId",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const message = await prisma.emailMessage.findUnique({
        where: { id: request.params.messageId },
        include: {
          thread: {
            select: {
              id: true,
              subject: true,
              client: { select: { id: true, displayName: true } },
            },
          },
          folder: { select: { id: true, displayName: true, role: true } },
          attachments: {
            select: { id: true, filename: true, mimeType: true, sizeBytes: true },
          },
        },
      });
      if (!message) return reply.code(404).send({ error: "Message introuvable" });
      return {
        ...message,
        toAddresses: JSON.parse(message.toAddresses || "[]"),
        ccAddresses: message.ccAddresses ? JSON.parse(message.ccAddresses) : [],
      };
    },
  );

  app.get<{ Params: { messageId: string } }>(
    "/api/emails/messages/:messageId/body",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const q = request.query as { allowRemoteImages?: string };
      try {
        return await fetchMessageBody(request.params.messageId, {
          allowRemoteImages: q.allowRemoteImages !== "false",
        });
      } catch (e) {
        return reply.code(400).send({
          error: e instanceof Error ? e.message : "Corps introuvable",
        });
      }
    },
  );

  app.post<{ Params: { messageId: string } }>(
    "/api/emails/messages/:messageId/move",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const schema = z.object({ folderId: z.string() });
      const parsed = schema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      try {
        await moveMessageToFolder(request.params.messageId, parsed.data.folderId);
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({
          error: e instanceof Error ? e.message : "Déplacement impossible",
        });
      }
    },
  );

  app.delete<{ Params: { messageId: string } }>(
    "/api/emails/messages/:messageId",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const q = request.query as { permanent?: string };
      try {
        const result = await deleteMessage(request.params.messageId, q.permanent === "true");
        return { ok: true, deleted: result.deleted };
      } catch (e) {
        return reply.code(400).send({
          error: e instanceof Error ? e.message : "Suppression impossible",
        });
      }
    },
  );

  app.post("/api/emails/search", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      query: z.string().min(1),
      folderId: z.string().optional(),
    });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (!(await isImapConfigured())) {
      return reply.code(400).send({ error: "IMAP non configuré" });
    }
    try {
      const folder = parsed.data.folderId
        ? await prisma.mailFolder.findUnique({ where: { id: parsed.data.folderId } })
        : await prisma.mailFolder.findFirst({ where: { role: "INBOX" } });
      if (!folder) return reply.code(404).send({ error: "Dossier introuvable" });

      const uids: number[] = [];
      await withImapClient(async ({ client }) => {
        await client.mailboxOpen(folder.imapPath);
        const result = await client.search({
          or: [
            { subject: parsed.data.query },
            { from: parsed.data.query },
            { to: parsed.data.query },
            { body: parsed.data.query },
          ],
        });
        if (Array.isArray(result)) {
          uids.push(...result.map((uid) => toImapInt(uid)).filter((uid) => uid > 0));
        }
      });

      const messages = await prisma.emailMessage.findMany({
        where: { folderId: folder.id, imapUid: { in: uids } },
        orderBy: { receivedAt: "desc" },
        take: 100,
        include: {
          thread: { select: { id: true, client: { select: { id: true, displayName: true } } } },
        },
      });
      return { total: messages.length, messages };
    } catch (e) {
      return reply.code(400).send({
        error: e instanceof Error ? e.message : "Recherche IMAP impossible",
      });
    }
  });

  app.get<{ Params: { threadId: string } }>(
    "/api/emails/:threadId",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const thread = await prisma.emailThread.findUnique({
        where: { id: request.params.threadId },
        include: {
          client: { select: { id: true, displayName: true } },
          messages: {
            where: { orphaned: false },
            orderBy: { receivedAt: "asc" },
            include: {
              attachments: {
                select: {
                  id: true,
                  filename: true,
                  mimeType: true,
                  sizeBytes: true,
                },
              },
            },
          },
        },
      });
      if (!thread) return reply.code(404).send({ error: "Not found" });

      let pendingQuotes: Array<{
        id: string;
        number: string | null;
        totalCents: number;
        issueDate: Date | null;
      }> = [];
      if (thread.clientId) {
        pendingQuotes = await prisma.invoice.findMany({
          where: {
            clientId: thread.clientId,
            documentType: InvoiceDocumentType.QUOTE,
            quoteStatus: QuoteStatus.SENT,
          },
          orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
          select: {
            id: true,
            number: true,
            totalCents: true,
            issueDate: true,
          },
          take: 10,
        });
      }

      const acceptanceAudits = await prisma.quoteAcceptanceAudit.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          quoteId: true,
          signerName: true,
          source: true,
          createdAt: true,
          quote: { select: { number: true } },
        },
      });

      const latestInbound = [...thread.messages]
        .reverse()
        .find((m) => m.direction === EmailDirection.INBOUND);
      const quoteConfirmationHint =
        pendingQuotes.length > 0 &&
        Boolean(
          latestInbound &&
            detectQuoteConfirmationIntent(
              latestInbound.bodyText ?? latestInbound.snippet,
            ),
        );

      return {
        ...thread,
        participants: JSON.parse(thread.participants || "[]"),
        pendingQuotes,
        acceptanceAudits,
        quoteConfirmationHint,
        messages: thread.messages.map((m) => ({
          ...m,
          toAddresses: JSON.parse(m.toAddresses || "[]"),
        })),
      };
    },
  );

  app.patch<{ Params: { threadId: string } }>(
    "/api/emails/:threadId",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const schema = z.object({ clientId: z.string().nullable() });
      const parsed = schema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const thread = await prisma.emailThread.update({
        where: { id: request.params.threadId },
        data: { clientId: parsed.data.clientId },
        include: { client: { select: { id: true, displayName: true } } },
      });
      return {
        ...thread,
        participants: JSON.parse(thread.participants || "[]"),
      };
    },
  );

  app.post("/api/emails/draft-attachments", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: "Fichier manquant" });

    const settings = await getCompanySettings().catch(() => null);
    const maxMb = settings?.attachmentMaxFileMb ?? ATTACHMENT_DEFAULTS.maxFileMb;
    const maxBytes = Math.min(maxMb, ATTACHMENT_DEFAULTS.maxFileMbCap) * 1024 * 1024;

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    if (content.length === 0) {
      return reply.code(400).send({ error: "Fichier vide" });
    }

    try {
      const saved = await saveComposeDraftAttachment({
        filename: data.filename,
        mimeType: data.mimetype,
        content,
        maxBytes,
      });
      return reply.code(201).send({
        id: saved.id,
        filename: saved.filename,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
      });
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Upload impossible" });
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/emails/draft-attachments/:id",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      await deleteComposeAttachments([request.params.id]);
      return reply.code(204).send();
    },
  );

  app.post("/api/emails/send", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (!(await isSmtpConfigured())) {
      return reply
        .code(400)
        .send({ error: "SMTP non configuré (paramètres ou SMTP_HOST / SMTP_USER / SMTP_FROM)" });
    }
    const schema = z.object({
      to: z.string().email().optional(),
      clientId: z.string().optional(),
      subject: z.string().min(1),
      body: z.string().min(1),
      html: z.string().optional(),
      cc: z.string().email().optional(),
      bcc: z.string().email().optional(),
      threadId: z.string().optional(),
      inReplyTo: z.string().optional(),
      documentId: z.string().optional(),
      attachmentIds: z.array(z.string()).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { subject, body, threadId, inReplyTo, documentId, html, cc, bcc, attachmentIds } =
      parsed.data;
    let to = parsed.data.to?.trim().toLowerCase();
    let clientId = parsed.data.clientId ?? null;

    if (clientId) {
      const client = await prisma.client.findUnique({ where: { id: clientId } });
      if (!client) {
        return reply.code(404).send({ error: "Client introuvable" });
      }
      if (!to) {
        to = decryptOptional(client.emailEncrypted)?.trim().toLowerCase() || undefined;
        if (!to) {
          return reply.code(400).send({ error: "Ce client n'a pas d'adresse email" });
        }
      }
    } else if (to) {
      clientId = await findClientIdByEmail(to);
    } else {
      return reply.code(400).send({ error: "Destinataire (to) ou clientId requis" });
    }

    const fromFormatted = await resolveFromAddress();
    const fromAddress = extractEmailAddress(fromFormatted);

    let resolvedThreadId = threadId;
    if (!resolvedThreadId) {
      const thread = await prisma.emailThread.create({
        data: {
          subject,
          participants: JSON.stringify([to, fromAddress]),
          clientId,
          lastMessageAt: new Date(),
        },
      });
      resolvedThreadId = thread.id;
    } else {
      await prisma.emailThread.update({
        where: { id: resolvedThreadId },
        data: { lastMessageAt: new Date(), clientId: clientId ?? undefined },
      });
    }

    if (documentId) {
      const { sendDocumentPdf } = await import("@/lib/email/send-document-pdf.js");
      const extraAttachments =
        attachmentIds && attachmentIds.length > 0
          ? await composeAttachmentsToOutbox(attachmentIds)
          : undefined;
      const mail = await sendDocumentPdf(documentId, {
        subject,
        text: body,
        threadId: resolvedThreadId,
        extraAttachments,
      });
      if (attachmentIds?.length) {
        await deleteComposeAttachments(attachmentIds);
      }
      return reply.code(201).send({
        threadId: resolvedThreadId,
        queued: mail.queued ?? false,
        outboxId: mail.outboxId ?? null,
        emailed: mail.sent,
      });
    }

    const fileAttachments =
      attachmentIds && attachmentIds.length > 0
        ? await composeAttachmentsToOutbox(attachmentIds)
        : undefined;

    const settings = await getCompanySettings();
    const signature = settings.emailSignatureHtml?.trim();
    const bodyWithSignature =
      signature && !threadId
        ? `${body}\n\n-- \n${signature.replace(/<[^>]+>/g, "")}`
        : body;

    const { outboxId, messageId } = await mailEnqueue({
      to,
      subject,
      text: bodyWithSignature,
      html: html ?? (signature ? `<p>${body.replace(/\n/g, "<br>")}</p><hr><div>${signature}</div>` : undefined),
      cc: cc ? [cc] : undefined,
      bcc: bcc ? [bcc] : undefined,
      threadId: resolvedThreadId,
      clientId: clientId ?? undefined,
      kind: "custom",
      inReplyTo,
      references: inReplyTo,
      bodyTextForMessage: bodyWithSignature,
      attachments: fileAttachments,
    });

    if (attachmentIds?.length) {
      await deleteComposeAttachments(attachmentIds);
    }

    const message = await prisma.emailMessage.create({
      data: {
        threadId: resolvedThreadId,
        direction: EmailDirection.OUTBOUND,
        messageId,
        inReplyTo: inReplyTo || null,
        fromAddress,
        fromName: extractDisplayName(fromFormatted),
        toAddresses: JSON.stringify([to]),
        subject,
        bodyText: body,
        receivedAt: new Date(),
        isRead: true,
      },
    });

    return reply.code(201).send({ threadId: resolvedThreadId, message, outboxId, queued: true });
  });

  app.post("/api/emails/sync", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (!(await isImapConfigured())) {
      return reply.code(400).send({ error: "IMAP non configuré (hôte, utilisateur et mot de passe)" });
    }
    try {
      return await runMailSync();
    } catch (e) {
      return reply.code(400).send({
        error: e instanceof Error ? e.message : "Synchronisation IMAP impossible",
      });
    }
  });
};
