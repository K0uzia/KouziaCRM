import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { verifyAccessCode } from "@/lib/clients/numbering.js";
import { verifyDocumentToken } from "@/lib/documents/public-token.js";
import { renderInvoicePdf } from "@/lib/pdf/render.js";
import { buildInvoicePdfPayload } from "@/lib/pdf/build-payload.js";
import { listActiveLegalClauses } from "@/lib/company/legal-clauses.js";
import type { ClientSnapshot } from "@/lib/invoices/transitions.js";
import { getOnboardingView, submitOnboarding } from "@/lib/clients/onboarding.js";

const trackingSchema = z.object({
  clientNumber: z.string().min(3),
  accessCode: z.string().min(4),
});

const onboardingSubmitSchema = z.object({
  type: z.enum(["B2B", "B2C"]),
  firstName: z.string().optional().nullable(),
  lastName: z.string().optional().nullable(),
  companyName: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal("")),
  phone: z.string().optional().nullable(),
  siret: z
    .string()
    .optional()
    .nullable()
    .refine((v) => !v || /^\d{14}$/.test(v.replace(/\s/g, "")), {
      message: "SIRET invalide (14 chiffres)",
    }),
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
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
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "15 minutes",
        },
      },
    },
    async (request, reply) => {
      const invoiceId = verifyDocumentToken(request.params.token);
      if (!invoiceId) return reply.code(404).send({ error: "Lien invalide" });

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          lines: { orderBy: { position: "asc" } },
          client: true,
          creditedInvoice: true,
          quote: true,
          sourceMilestone: true,
          milestones: { orderBy: { position: "asc" } },
        },
      });
      if (!invoice || invoice.status === InvoiceStatus.DRAFT || !invoice.number) {
        return reply.code(404).send({ error: "Document introuvable" });
      }

      const company = await getCompanySettings();
      const legalClauses = await listActiveLegalClauses();
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
        invoice: buildInvoicePdfPayload({ invoice, legalClauses }),
      });

      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `inline; filename="${invoice.number}.pdf"`)
        .send(buffer);
    },
  );

  app.get<{ Params: { token: string } }>(
    "/api/public/onboarding/:token",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "15 minutes",
        },
      },
    },
    async (request, reply) => {
      const view = await getOnboardingView(request.params.token);
      if (!view) return reply.code(404).send({ error: "Lien invalide ou expiré" });
      return view;
    },
  );

  // Soumet le formulaire d'onboarding public (validé côté serveur).
  app.post<{ Params: { token: string } }>(
    "/api/public/onboarding/:token",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "15 minutes",
        },
      },
    },
    async (request, reply) => {
      const parsed = onboardingSubmitSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const result = await submitOnboarding(request.params.token, parsed.data);
      if (!result.ok) {
        return reply.code(400).send({ error: result.error ?? "Erreur" });
      }
      return { ok: true };
    },
  );
};
