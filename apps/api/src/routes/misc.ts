import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { EmailDirection, UrssafPeriodicity } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { getDashboardSnapshot } from "@/lib/finance/dashboard-service.js";
import { isCashflowScope } from "@/lib/finance/cashflow-service.js";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";
import { applyInpiImport } from "@/lib/company/inpi.js";
import { markUrssafPaid } from "@/lib/finance/dashboard-service.js";
import { isSmtpConfigured, sendEmail } from "@/lib/email/smtp.js";
import { findClientIdByEmail } from "@/lib/email/match-client.js";
import { isImapConfigured, syncImapInbox } from "@/lib/email/imap-sync.js";

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

  app.get("/api/settings", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return getCompanySettings();
  });

  app.patch("/api/settings", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const patchSchema = z.object({
      legalName: z.string().min(1).optional(),
      tradeName: z.string().optional().nullable(),
      siren: z.string().regex(/^\d{9}$/).optional(),
      siret: z.string().regex(/^\d{14}$/).optional(),
      apeCode: z.string().min(1).optional(),
      addressLine1: z.string().min(1).optional(),
      addressLine2: z.string().optional().nullable(),
      postalCode: z.string().min(1).optional(),
      city: z.string().min(1).optional(),
      country: z.string().optional(),
      urssafPeriodicity: z.nativeEnum(UrssafPeriodicity).optional(),
      // Forcé à 15 côté métier AE ; accepté pour compat mais écrasé
      urssafDeadlineDay: z.number().int().min(1).max(28).optional(),
      treasuryRateBps: z.number().int().min(0).max(5000).optional(),
      placementRateBps: z.number().int().min(0).max(5000).optional(),
      reminderQuoteDays: z.number().int().min(1).max(90).optional(),
      reminderInvoiceDays: z.number().int().min(1).max(90).optional(),
      publicTrackingShowAmounts: z.boolean().optional(),
      email: z.string().email().optional().nullable().or(z.literal("")),
      phone: z.string().optional().nullable(),
      website: z.string().optional().nullable(),
      businessStartDate: z.string().optional().nullable(),
      cfeAmountCents: z.number().int().min(0).optional(),
      cfeAmountEuros: z.coerce.number().min(0).optional(),
      b2cActivity: z.boolean().optional(),
      incomeTaxReminderMonth: z.number().int().min(1).max(12).optional(),
      incomeTaxReminderDay: z.number().int().min(1).max(28).optional(),
      inpiUrl: z.string().optional().nullable(),
      invoiceNumberTemplate: z.string().min(3).max(64).optional(),
      quoteNumberTemplate: z.string().min(3).max(64).optional(),
      creditNoteNumberTemplate: z.string().min(3).max(64).optional(),
      numberCounterWidth: z.number().int().min(1).max(8).optional(),
      numberingLegacyStarts: z.record(z.string(), z.number().int().min(0)).optional().nullable(),
      officialLinks: z
        .object({
          urssafDeclaration: z.string().url().optional(),
          impotsPro: z.string().url().optional(),
          impotsParticulier: z.string().url().optional(),
        })
        .optional(),
    });
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const current = await getCompanySettings();
    const {
      businessStartDate,
      cfeAmountEuros,
      cfeAmountCents,
      officialLinks,
      urssafDeadlineDay: _ignored,
      ...rest
    } = parsed.data;
    const data: Record<string, unknown> = {
      ...rest,
      urssafDeadlineDay: 15,
    };
    if (businessStartDate !== undefined) {
      data.businessStartDate = businessStartDate ? new Date(businessStartDate) : null;
    }
    if (cfeAmountCents !== undefined) data.cfeAmountCents = cfeAmountCents;
    else if (cfeAmountEuros !== undefined) {
      data.cfeAmountCents = Math.round(cfeAmountEuros * 100);
    }
    if (officialLinks !== undefined) {
      data.officialLinks = officialLinks;
    }
    const updated = await prisma.companySettings.update({
      where: { id: current.id },
      data,
    });
    invalidateCompanySettingsCache();
    return updated;
  });

  app.post("/api/settings/import-inpi", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      query: z.string().min(3),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Fournissez un SIREN ou une URL data.inpi.fr" });
    }
    try {
      return await applyInpiImport(parsed.data.query);
    } catch (e) {
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Import INPI impossible" });
    }
  });

  app.get("/api/payments", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return prisma.payment.findMany({
      orderBy: { paidAt: "desc" },
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

  app.get("/api/emails", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const threads = await prisma.emailThread.findMany({
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
      client: t.client,
      preview: t.messages[0]?.bodyText?.slice(0, 140) ?? "",
      lastFrom: t.messages[0]?.fromAddress ?? "",
      direction: t.messages[0]?.direction ?? null,
    }));
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
          messages: { orderBy: { receivedAt: "asc" } },
        },
      });
      if (!thread) return reply.code(404).send({ error: "Not found" });
      return {
        ...thread,
        participants: JSON.parse(thread.participants || "[]"),
        messages: thread.messages.map((m) => ({
          ...m,
          toAddresses: JSON.parse(m.toAddresses || "[]"),
        })),
      };
    },
  );

  app.post("/api/emails/send", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (!isSmtpConfigured()) {
      return reply
        .code(400)
        .send({ error: "SMTP non configuré (SMTP_HOST / SMTP_USER / SMTP_FROM)" });
    }
    const schema = z.object({
      to: z.string().email(),
      subject: z.string().min(1),
      body: z.string().min(1),
      threadId: z.string().optional(),
      inReplyTo: z.string().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { to, subject, body, threadId, inReplyTo } = parsed.data;
    const clientId = await findClientIdByEmail(to);
    let resolvedThreadId = threadId;
    if (!resolvedThreadId) {
      const thread = await prisma.emailThread.create({
        data: {
          subject,
          participants: JSON.stringify([to, process.env.SMTP_FROM || ""]),
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

    const sent = await sendEmail({
      to,
      subject,
      text: body,
      headers: inReplyTo ? { "In-Reply-To": inReplyTo, References: inReplyTo } : undefined,
    });

    const message = await prisma.emailMessage.create({
      data: {
        threadId: resolvedThreadId,
        direction: EmailDirection.OUTBOUND,
        messageId: sent.messageId || `outbound-${Date.now()}@kouzia.local`,
        inReplyTo: inReplyTo || null,
        fromAddress: (process.env.SMTP_FROM || "").toLowerCase(),
        toAddresses: JSON.stringify([to.toLowerCase()]),
        subject,
        bodyText: body,
        receivedAt: new Date(),
      },
    });

    return reply.code(201).send({ threadId: resolvedThreadId, message });
  });

  app.post("/api/emails/sync", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (!isImapConfigured()) {
      return reply.code(400).send({ error: "IMAP non configuré" });
    }
    return syncImapInbox();
  });
};
