import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { verifyAccessCode } from "@/lib/clients/numbering.js";
import { verifyDocumentToken } from "@/lib/documents/public-token.js";
import { renderInvoicePdf } from "@/lib/pdf/render.js";
import type { ClientSnapshot } from "@/lib/invoices/transitions.js";

const trackingSchema = z.object({
  clientNumber: z.string().min(3),
  accessCode: z.string().min(4),
});

export const publicRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/public/tracking",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "15 minutes",
        },
      },
    },
    async (request, reply) => {
      const parsed = trackingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides" });
      }

      const clientNumber = parsed.data.clientNumber.trim().toUpperCase();
      const client = await prisma.client.findUnique({
        where: { clientNumber },
      });
      if (!client?.accessCodeHash) {
        return reply.code(401).send({ error: "Identifiants invalides" });
      }

      const ok = await verifyAccessCode(client.accessCodeHash, parsed.data.accessCode);
      if (!ok) {
        return reply.code(401).send({ error: "Identifiants invalides" });
      }

      const settings = await getCompanySettings();
      const showAmounts = settings.publicTrackingShowAmounts;

      const documents = await prisma.invoice.findMany({
        where: {
          clientId: client.id,
          status: { not: InvoiceStatus.DRAFT },
        },
        orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
        include: {
          milestones: { orderBy: { position: "asc" } },
        },
        take: 40,
      });

      return {
        clientNumber: client.clientNumber,
        displayName: client.displayName,
        documents: documents.map((d) => ({
          id: d.id,
          number: d.number,
          documentType: d.documentType,
          status: d.status,
          quoteStatus: d.quoteStatus,
          issueDate: d.issueDate,
          validUntil: d.validUntil,
          dueDate: d.dueDate,
          ...(showAmounts
            ? { totalCents: d.totalCents, subtotalCents: d.subtotalCents }
            : {}),
          milestones:
            d.documentType === InvoiceDocumentType.QUOTE
              ? d.milestones.map((m) => ({
                  label: m.label,
                  percentBps: m.percentBps,
                  status: m.status,
                  triggerText: m.triggerText,
                  ...(showAmounts ? { amountCents: m.amountCents } : {}),
                }))
              : undefined,
        })),
      };
    },
  );

  app.get<{ Params: { token: string } }>(
    "/api/public/documents/:token",
    async (request, reply) => {
      const invoiceId = verifyDocumentToken(request.params.token);
      if (!invoiceId) return reply.code(404).send({ error: "Lien invalide" });

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          lines: { orderBy: { position: "asc" } },
          client: true,
          creditedInvoice: true,
          milestones: { orderBy: { position: "asc" } },
        },
      });
      if (!invoice || invoice.status === InvoiceStatus.DRAFT || !invoice.number) {
        return reply.code(404).send({ error: "Document introuvable" });
      }

      const company = await getCompanySettings();
      const snapshot = (invoice.clientSnapshot as ClientSnapshot | null) ?? {
        displayName: invoice.client.displayName,
        type: invoice.client.type,
        email: null,
        phone: null,
        siret: null,
        addressLine1: invoice.client.addressLine1,
        addressLine2: invoice.client.addressLine2,
        postalCode: invoice.client.postalCode,
        city: invoice.client.city,
        country: invoice.client.country,
      };

      const buffer = await renderInvoicePdf({
        company,
        client: snapshot,
        invoice: {
          number: invoice.number,
          documentType: invoice.documentType as "INVOICE" | "CREDIT_NOTE" | "QUOTE",
          issueDate: invoice.issueDate!,
          dueDate: invoice.dueDate,
          validUntil: invoice.validUntil,
          paymentTerms: invoice.paymentTerms,
          notes: invoice.notes,
          totalCents: invoice.totalCents,
          subtotalCents: invoice.subtotalCents,
          creditedInvoiceNumber: invoice.creditedInvoice?.number ?? null,
          milestones: invoice.milestones.map((m) => ({
            label: m.label,
            percentBps: m.percentBps,
            amountCents: m.amountCents,
            triggerText: m.triggerText,
          })),
          lines: invoice.lines.map((l) => ({
            description: l.description,
            quantity: Number(l.quantity),
            unitPriceCents: l.unitPriceCents,
            lineTotalCents: l.lineTotalCents,
          })),
        },
      });

      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `inline; filename="${invoice.number}.pdf"`)
        .send(buffer);
    },
  );
};
