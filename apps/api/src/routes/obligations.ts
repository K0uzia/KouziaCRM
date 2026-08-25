import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "@/lib/auth.js";
import {
  confirmObligation,
  listObligationsDashboard,
  patchObligationAmount,
  updateChecklist,
} from "@/lib/obligations/obligation-service.js";
import { prisma } from "@/lib/prisma.js";
import {
  paymentMethodLabel,
  receiptsPeriod,
  receiptsToCsv,
} from "@/lib/obligations/receipts.js";
import { getCompanySettings } from "@/lib/company.js";
import { renderReceiptsPdf } from "@/lib/pdf/render.js";

const uploadsRoot = path.resolve(
  process.env.UPLOADS_DIR ?? path.join(process.cwd(), "data", "uploads", "obligations"),
);

export const obligationsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/obligations", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return listObligationsDashboard();
  });

  app.get("/api/obligations/summary", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const dash = await listObligationsDashboard();
    return {
      summary: dash.summary,
      alerts: dash.alerts,
      nextDue: dash.summary.nextDue,
    };
  });

  app.post<{ Params: { id: string } }>(
    "/api/obligations/:id/confirm",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      try {
        const result = await confirmObligation(request.params.id);
        return result;
      } catch (e) {
        return reply
          .code(400)
          .send({ error: e instanceof Error ? e.message : "Confirmation impossible" });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/obligations/:id/attachment",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;

      const data = await request.file();
      if (!data) return reply.code(400).send({ error: "Fichier manquant" });
      if (data.mimetype !== "application/pdf") {
        return reply.code(400).send({ error: "Seuls les PDF sont acceptés" });
      }

      await fs.mkdir(uploadsRoot, { recursive: true });
      const safeName = `${request.params.id}-${Date.now()}.pdf`;
      const dest = path.join(uploadsRoot, safeName);
      await pipeline(data.file, createWriteStream(dest));

      const updated = await prisma.obligation.update({
        where: { id: request.params.id },
        data: {
          attachmentPath: path.join("obligations", safeName),
          attachmentName: data.filename || safeName,
          attachmentMime: "application/pdf",
        },
      });
      return updated;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/obligations/:id/attachment",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const obl = await prisma.obligation.findUnique({ where: { id: request.params.id } });
      if (!obl?.attachmentPath) return reply.code(404).send({ error: "Aucun justificatif" });
      const full = path.resolve(
        process.env.UPLOADS_DIR
          ? path.dirname(uploadsRoot)
          : path.join(process.cwd(), "data", "uploads"),
        obl.attachmentPath,
      );
      const buf = await fs.readFile(full);
      return reply
        .header("Content-Type", obl.attachmentMime ?? "application/pdf")
        .header(
          "Content-Disposition",
          `inline; filename="${obl.attachmentName ?? "justificatif.pdf"}"`,
        )
        .send(buf);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/obligations/:id",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const schema = z.object({
        amountCents: z.number().int().min(0).optional(),
        amountEuros: z.coerce.number().min(0).optional(),
        notes: z.string().optional().nullable(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides" });
      }
      const amountCents =
        parsed.data.amountCents ??
        (parsed.data.amountEuros !== undefined
          ? Math.round(parsed.data.amountEuros * 100)
          : undefined);
      if (amountCents === undefined && parsed.data.notes === undefined) {
        return reply.code(400).send({ error: "Rien à mettre à jour" });
      }
      if (amountCents !== undefined) {
        await patchObligationAmount(request.params.id, amountCents);
      }
      if (parsed.data.notes !== undefined) {
        await prisma.obligation.update({
          where: { id: request.params.id },
          data: { notes: parsed.data.notes },
        });
      }
      return prisma.obligation.findUniqueOrThrow({ where: { id: request.params.id } });
    },
  );

  app.get("/api/checklist", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const dash = await listObligationsDashboard();
    return dash.checklist;
  });

  app.patch("/api/checklist", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      urssafAccount: z.boolean().optional(),
      impotsProAccount: z.boolean().optional(),
      activityQuestionnaire: z.boolean().optional(),
      cfeInitialDeclaration: z.boolean().optional(),
      rcpInsurance: z.boolean().optional(),
      mediationChecked: z.boolean().optional(),
      dedicatedBankAccount: z.boolean().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides" });
    }
    return updateChecklist(parsed.data);
  });

  app.get("/api/receipts", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { year?: string; quarter?: string; month?: string };
    const { year, start, end } = receiptsPeriod(q);

    const payments = await prisma.payment.findMany({
      where: { paidAt: { gte: start, lte: end } },
      orderBy: { paidAt: "asc" },
      include: {
        invoice: {
          include: {
            client: { select: { displayName: true, clientNumber: true } },
            lines: { orderBy: { position: "asc" }, take: 3 },
          },
        },
      },
    });

    return {
      period: { start: start.toISOString(), end: end.toISOString(), year },
      rows: payments.map((p) => {
        const nature =
          p.invoice.lines.map((l) => l.description).join(" · ") ||
          p.invoice.notes ||
          "Prestation de services";
        return {
          id: p.id,
          paidAt: p.paidAt.toISOString(),
          invoiceNumber: p.invoice.number,
          invoiceId: p.invoice.id,
          invoiceType: p.invoice.invoiceType,
          documentType: p.invoice.documentType,
          amountCents: p.amountCents,
          clientName: p.invoice.client.displayName,
          clientNumber: p.invoice.client.clientNumber,
          nature,
          paymentMethod: p.method,
          paymentMethodLabel: paymentMethodLabel(p.method),
          reference: p.reference,
        };
      }),
      totalCents: payments.reduce((s, p) => s + p.amountCents, 0),
    };
  });

  app.get("/api/receipts/csv", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { year?: string; quarter?: string; month?: string };
    const { year, start, end } = receiptsPeriod(q);

    const payments = await prisma.payment.findMany({
      where: { paidAt: { gte: start, lte: end } },
      orderBy: { paidAt: "asc" },
      include: {
        invoice: {
          include: {
            client: { select: { displayName: true, clientNumber: true } },
            lines: { orderBy: { position: "asc" }, take: 3 },
          },
        },
      },
    });

    const csv = receiptsToCsv(
      payments.map((p) => ({
        paidAt: p.paidAt.toISOString(),
        invoiceNumber: p.invoice.number,
        amountCents: p.amountCents,
        clientName: p.invoice.client.displayName,
        clientNumber: p.invoice.client.clientNumber,
        nature:
          p.invoice.lines.map((l) => l.description).join(" · ") ||
          p.invoice.notes ||
          "Prestation de services",
        paymentMethodLabel: paymentMethodLabel(p.method),
      })),
    );

    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="livre-recettes-${year}.csv"`,
      )
      .send(csv);
  });

  app.get("/api/receipts/pdf", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { year?: string; quarter?: string; month?: string };
    const { year, start, end } = receiptsPeriod(q);

    const [company, payments] = await Promise.all([
      getCompanySettings(),
      prisma.payment.findMany({
        where: { paidAt: { gte: start, lte: end } },
        orderBy: { paidAt: "asc" },
        include: {
          invoice: {
            include: {
              client: { select: { displayName: true, clientNumber: true } },
              lines: { orderBy: { position: "asc" }, take: 3 },
            },
          },
        },
      }),
    ]);

    const rows = payments.map((p) => ({
      paidAt: p.paidAt.toISOString(),
      invoiceNumber: p.invoice.number,
      clientNumber: p.invoice.client.clientNumber,
      clientName: p.invoice.client.displayName,
      nature:
        p.invoice.lines.map((l) => l.description).join(" · ") ||
        p.invoice.notes ||
        "Prestation de services",
      paymentMethodLabel: paymentMethodLabel(p.method),
      amountCents: p.amountCents,
    }));

    const pdf = await renderReceiptsPdf({
      year,
      editedAt: new Date(),
      company: {
        legalName: company.legalName,
        tradeName: company.tradeName,
        siret: company.siret,
        addressLine1: company.addressLine1,
        postalCode: company.postalCode,
        city: company.city,
      },
      rows,
      totalCents: rows.reduce((s, r) => s + r.amountCents, 0),
    });

    return reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `inline; filename="livre-recettes-${year}.pdf"`,
      )
      .send(pdf);
  });
};
