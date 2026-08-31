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
import {
  acceptQuoteByClient,
  rejectQuote,
  QuoteDecisionError,
} from "@/lib/invoices/transitions.js";
import { getOnboardingView, submitOnboarding } from "@/lib/clients/onboarding.js";
import { signDocumentToken } from "@/lib/documents/public-token.js";

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

const quoteDecisionSchema = trackingSchema.extend({
  decision: z.enum(["ACCEPT", "REJECT"]),
  signerName: z.string().min(2).max(120).optional(),
  reason: z.string().max(500).optional(),
});

/** Rejoue l'authentification du portail : le client n'a pas de session serveur. */
async function authenticateClient(clientNumber: string, accessCode: string) {
  const client = await prisma.client.findUnique({
    where: { clientNumber: clientNumber.trim().toUpperCase() },
  });
  if (!client?.accessCodeHash) return null;
  const ok = await verifyAccessCode(client.accessCodeHash, accessCode);
  return ok ? client : null;
}

export const publicRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/public/tracking",
    {
      config: {
        rateLimit: {
          // Le code d'accès (8 hex = 4 octets) reste impossible à brute-forcer
          // même avec une limite large ; on tolère les refreshs légitimes.
          max: 60,
          timeWindow: "15 minutes",
        },
      },
    },
    async (request, reply) => {
      const parsed = trackingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides" });
      }

      const client = await authenticateClient(
        parsed.data.clientNumber,
        parsed.data.accessCode,
      );
      if (!client) {
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
          payments: { orderBy: { paidAt: "asc" } },
        },
        take: 60,
      });

      const subscriptions = await prisma.subscription.findMany({
        where: { clientId: client.id, status: "ACTIVE" },
        orderBy: { nextInvoiceAt: "asc" },
      });

      const emailEvents = await prisma.clientEmailEvent.findMany({
        where: { clientId: client.id, success: true },
        orderBy: { sentAt: "desc" },
        take: 40,
      });

      const firstName =
        client.firstName?.trim() ||
        client.displayName.trim().split(/\s+/)[0] ||
        "Client";

      const paidCentsOf = (d: { payments: { amountCents: number }[] }) =>
        d.payments.reduce((s, p) => s + p.amountCents, 0);

      return {
        clientFirstName: firstName,
        clientNumber: client.clientNumber,
        displayName: client.displayName,
        brand: {
          tradeName: settings.tradeName ?? settings.legalName,
          accentColor: "#0f766e",
          logoUrl: null as string | null,
          contactUrl: settings.website ?? null,
        },
        company: {
          tradeName: settings.tradeName ?? settings.legalName,
          legalName: settings.legalName,
          email: settings.email ?? null,
          phone: settings.phone ?? null,
          website: settings.website ?? null,
          addressLine1: settings.addressLine1,
          addressLine2: settings.addressLine2 ?? null,
          postalCode: settings.postalCode,
          city: settings.city,
          country: settings.country,
          bankIban: settings.bankIban ?? null,
          bankBic: settings.bankBic ?? null,
          bankAccountHolder: settings.bankAccountHolder ?? null,
          bankName: settings.bankName ?? null,
        },
        documents: documents.map((d) => {
          const paid = paidCentsOf(d);
          return {
            id: d.id,
            number: d.number,
            documentType: d.documentType,
            status: d.status,
            quoteStatus: d.quoteStatus,
            quoteDecidedAt: d.quoteDecidedAt,
            quoteSignerName: d.quoteSignerName,
            quoteRejectReason: d.quoteRejectReason,
            issueDate: d.issueDate,
            validUntil: d.validUntil,
            dueDate: d.dueDate,
            downloadToken: d.number ? signDocumentToken(d.id) : null,
            ...(showAmounts
              ? {
                  totalCents: d.totalCents,
                  subtotalCents: d.subtotalCents,
                  paidCents: paid,
                  remainingCents: d.totalCents - paid,
                }
              : {}),
            payments: d.payments.map((p) => ({
              paidAt: p.paidAt,
              method: p.method,
              ...(showAmounts ? { amountCents: p.amountCents } : {}),
            })),
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
          };
        }),
        subscriptions: subscriptions.map((s) => ({
          label: s.label,
          billingDay: s.billingDay,
          nextInvoiceAt: s.nextInvoiceAt,
          ...(showAmounts ? { amountCents: s.amountCents } : {}),
        })),
        emails: emailEvents.map((e) => ({
          id: e.id,
          kind: e.kind,
          subject: e.subject,
          documentNumber: e.documentNumber,
          sentAt: e.sentAt.toISOString(),
        })),
      };
    },
  );

  // Acceptation ou refus d'un devis par le client depuis le portail de suivi.
  app.post<{ Params: { id: string } }>(
    "/api/public/quotes/:id/decision",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "15 minutes",
        },
      },
    },
    async (request, reply) => {
      const parsed = quoteDecisionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides" });
      }
      if (parsed.data.decision === "ACCEPT" && !parsed.data.signerName) {
        return reply
          .code(400)
          .send({ error: "Indiquez votre nom pour valider le devis" });
      }

      const client = await authenticateClient(
        parsed.data.clientNumber,
        parsed.data.accessCode,
      );
      if (!client) {
        return reply.code(401).send({ error: "Identifiants invalides" });
      }

      const quote = await prisma.invoice.findUnique({
        where: { id: request.params.id },
        select: { id: true, clientId: true },
      });
      // Même réponse qu'un devis inexistant : le portail ne révèle pas les documents d'autrui.
      if (!quote || quote.clientId !== client.id) {
        return reply.code(404).send({ error: "Devis introuvable" });
      }

      try {
        const updated =
          parsed.data.decision === "ACCEPT"
            ? await acceptQuoteByClient(quote.id, parsed.data.signerName as string)
            : await rejectQuote(quote.id, parsed.data.reason);
        return { quoteStatus: updated.quoteStatus };
      } catch (e) {
        if (e instanceof QuoteDecisionError) {
          return reply.code(409).send({ error: e.message, code: e.code });
        }
        return reply.code(400).send({ error: "Décision impossible" });
      }
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
