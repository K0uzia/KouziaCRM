import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "@/lib/auth.js";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";
import { prisma } from "@/lib/prisma.js";
import {
  auditNumberingIntegrity,
  previewNextNumbers,
  reseedCountersFromDatabase,
} from "@/lib/invoices/numberingService.js";

export const numberingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/numbering/preview", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const settings = await getCompanySettings();
    return {
      templates: {
        invoice: settings.invoiceNumberTemplate,
        quote: settings.quoteNumberTemplate,
        creditNote: settings.creditNoteNumberTemplate,
        counterWidth: settings.numberCounterWidth,
      },
      previews: await previewNextNumbers(settings),
    };
  });

  app.get("/api/numbering/audit", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return auditNumberingIntegrity();
  });

  app.post("/api/settings/numbering/reseed", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const result = await reseedCountersFromDatabase();
    return { ok: true, ...result };
  });

  app.patch("/api/settings/numbering", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      invoiceNumberTemplate: z.string().min(3).max(64).optional(),
      quoteNumberTemplate: z.string().min(3).max(64).optional(),
      creditNoteNumberTemplate: z.string().min(3).max(64).optional(),
      numberCounterWidth: z.number().int().min(1).max(8).optional(),
      numberingLegacyStarts: z.record(z.string(), z.number().int().min(0)).optional().nullable(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
    }

    const tplOk = (t: string | undefined) =>
      !t || (t.includes("{year}") && t.includes("{counter}"));
    if (
      !tplOk(parsed.data.invoiceNumberTemplate) ||
      !tplOk(parsed.data.quoteNumberTemplate) ||
      !tplOk(parsed.data.creditNoteNumberTemplate)
    ) {
      return reply
        .code(400)
        .send({ error: "Chaque template doit contenir {year} et {counter}" });
    }

    const current = await getCompanySettings();
    const updated = await prisma.companySettings.update({
      where: { id: current.id },
      data: {
        ...(parsed.data.invoiceNumberTemplate !== undefined
          ? { invoiceNumberTemplate: parsed.data.invoiceNumberTemplate }
          : {}),
        ...(parsed.data.quoteNumberTemplate !== undefined
          ? { quoteNumberTemplate: parsed.data.quoteNumberTemplate }
          : {}),
        ...(parsed.data.creditNoteNumberTemplate !== undefined
          ? { creditNoteNumberTemplate: parsed.data.creditNoteNumberTemplate }
          : {}),
        ...(parsed.data.numberCounterWidth !== undefined
          ? { numberCounterWidth: parsed.data.numberCounterWidth }
          : {}),
        ...(parsed.data.numberingLegacyStarts !== undefined
          ? { numberingLegacyStarts: parsed.data.numberingLegacyStarts }
          : {}),
      },
    });
    invalidateCompanySettingsCache();
    const previews = await previewNextNumbers(updated);
    return { settings: updated, previews };
  });
};
