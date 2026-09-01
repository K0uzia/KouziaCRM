import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { verifyAccessCode } from "@/lib/clients/numbering.js";
import { verifyDocumentToken } from "@/lib/documents/public-token.js";
import { renderInvoicePdf } from "@/lib/pdf/render.js";
import { buildInvoicePdfPayload } from "@/lib/pdf/build-payload.js";
import { enrichCompanyForPdf } from "@/lib/pdf/brand-assets.js";
import { listActiveLegalClauses } from "@/lib/company/legal-clauses.js";
import type { ClientSnapshot } from "@/lib/invoices/transitions.js";
import {
  acceptQuoteByClient,
  rejectQuote,
  QuoteDecisionError,
} from "@/lib/invoices/transitions.js";
import {
  getOnboardingView,
  getPublicClientPreview,
  submitOnboarding,
  submitPublicClient,
} from "@/lib/clients/onboarding.js";
import { signDocumentToken } from "@/lib/documents/public-token.js";
import { replyEntrepriseLookup } from "@/lib/company/entreprise-route.js";
import {
  buildDocumentLinks,
  buildPaymentHistory,
} from "@/lib/portal/tracking-payload.js";
import { isValidSiren, isValidSiret } from "@kouzia/forms";
import {
  clientHasSubmittedTestimonial,
  listPublishedTestimonials,
  submitClientTestimonial,
  TestimonialError,
} from "@/lib/testimonials/service.js";

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
    .refine((v) => !v || isValidSiret(v.replace(/\s/g, "")), {
      message: "SIRET invalide (14 chiffres, Luhn)",
    }),
  siren: z
    .string()
    .optional()
    .nullable()
    .refine((v) => !v || isValidSiren(v.replace(/\s/g, "")), {
      message: "SIREN invalide (9 chiffres, Luhn)",
    }),
  apeCode: z.string().optional().nullable(),
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  addressCityCode: z.string().optional().nullable(),
  addressLat: z.number().optional().nullable(),
  addressLon: z.number().optional().nullable(),
  addressManualConfirmed: z.boolean().optional(),
  notes: z.string().optional().nullable(),
  /** Honeypot anti-spam : doit rester vide */
  website: z.string().max(0).optional().nullable(),
  token: z.string().optional(),
});

const testimonialSubmitSchema = trackingSchema.extend({
  authorName: z.string().min(2).max(80),
  body: z.string().min(20).max(800),
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

      const allMilestones = await prisma.paymentMilestone.findMany({
        where: { quote: { clientId: client.id } },
        include: {
          quote: { select: { number: true } },
          generatedInvoice: { select: { id: true, number: true } },
        },
        orderBy: [{ dueDate: "asc" }, { position: "asc" }],
      });

      const linkSets = buildDocumentLinks(documents);

      const paymentHistory = buildPaymentHistory({
        docs: documents,
        milestones: allMilestones,
        showAmounts,
      });

      const testimonialSubmitted = await clientHasSubmittedTestimonial(client.id);

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
        documents: documents.map((d, index) => {
          const paid = paidCentsOf(d);
          const firstMilestone =
            d.documentType === InvoiceDocumentType.QUOTE
              ? d.milestones.find((m) => m.position === 1) ?? d.milestones[0]
              : undefined;
          const requiresDeposit =
            Boolean(firstMilestone && firstMilestone.amountCents > 0);
          const depositPaid =
            !requiresDeposit || firstMilestone?.status === "PAID";
          const quotePending = d.quoteStatus === "SENT";
          return {
            id: d.id,
            number: d.number,
            documentType: d.documentType,
            invoiceType: d.invoiceType,
            status: d.status,
            quoteId: d.quoteId,
            creditedInvoiceId: d.creditedInvoiceId,
            linkedDocuments: linkSets[index],
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
              id: p.id,
              paidAt: p.paidAt,
              method: p.method,
              reference: p.reference,
              ...(showAmounts ? { amountCents: p.amountCents } : {}),
            })),
            milestones:
              d.documentType === InvoiceDocumentType.QUOTE
                ? d.milestones.map((m) => ({
                    id: m.id,
                    position: m.position,
                    label: m.label,
                    percentBps: m.percentBps,
                    status: m.status,
                    triggerText: m.triggerText,
                    dueDate: m.dueDate,
                    checkoutUrl:
                      m.checkoutUrl &&
                      m.status !== "PAID" &&
                      m.status !== "CANCELLED" &&
                      (m.status === "DUE" ||
                        m.status === "OVERDUE" ||
                        m.status === "FAILED")
                        ? m.checkoutUrl
                        : null,
                    ...(showAmounts ? { amountCents: m.amountCents } : {}),
                  }))
                : undefined,
            requiresDeposit,
            depositPaid,
            canAcceptQuote: quotePending,
            canRejectQuote: quotePending,
          };
        }),
        paymentHistory,
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
        testimonialSubmitted,
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
          payments: { orderBy: { paidAt: "asc" } },
        },
      });
      if (!invoice || invoice.status === InvoiceStatus.DRAFT || !invoice.number) {
        return reply.code(404).send({ error: "Document introuvable" });
      }

      const company = await enrichCompanyForPdf(await getCompanySettings());
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

  // Soumet le formulaire d'onboarding public legacy (validé côté serveur).
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
      const { website: _honeypot, token: _t, ...data } = parsed.data;
      const result = await submitOnboarding(request.params.token, data);
      if (!result.ok) {
        const code = result.alreadySubmitted ? 409 : 400;
        return reply.code(code).send({ error: result.error ?? "Erreur" });
      }
      return { ok: true };
    },
  );

  // Preview du formulaire client public (Kouzia) - token HMAC.
  app.get(
    "/api/public/clients/preview",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "15 minutes",
        },
      },
    },
    async (request, reply) => {
      const q = request.query as { token?: string };
      const token = (q.token ?? "").trim();
      if (!token) return reply.code(400).send({ error: "Token requis" });
      const view = await getPublicClientPreview(token);
      if (!view) return reply.code(404).send({ error: "Lien invalide ou expiré" });
      // Log technique uniquement (pas de PII)
      request.log.info({
        event: "public_client_preview",
        status: 200,
        ipTrunc: truncateIp(request.ip),
      });
      return view;
    },
  );

  // Création / mise à jour client depuis Kouzia (HMAC + honeypot + idempotence).
  app.post(
    "/api/public/clients",
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
        request.log.info({
          event: "public_client_submit",
          status: 400,
          ipTrunc: truncateIp(request.ip),
        });
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const token =
        parsed.data.token?.trim() ||
        (typeof (request.body as { token?: string })?.token === "string"
          ? (request.body as { token: string }).token
          : "");
      if (!token) {
        return reply.code(400).send({ error: "Token requis" });
      }
      // Honeypot : champ website rempli = bot
      if (parsed.data.website) {
        request.log.info({
          event: "public_client_submit",
          status: 400,
          ipTrunc: truncateIp(request.ip),
          reason: "honeypot",
        });
        return reply.code(400).send({ error: "Requête refusée" });
      }

      const { website: _h, token: _t, ...data } = parsed.data;
      const result = await submitPublicClient(token, data);
      if (!result.ok) {
        const code = result.alreadySubmitted ? 409 : 400;
        request.log.info({
          event: "public_client_submit",
          status: code,
          ipTrunc: truncateIp(request.ip),
        });
        return reply.code(code).send({ error: result.error ?? "Erreur" });
      }
      request.log.info({
        event: "public_client_submit",
        status: 201,
        ipTrunc: truncateIp(request.ip),
      });
      return reply.code(201).send({ ok: true });
    },
  );

  app.get("/api/public/testimonials", async () => {
    return { items: await listPublishedTestimonials() };
  });

  app.post(
    "/api/public/testimonials",
    {
      config: {
        rateLimit: {
          max: 8,
          timeWindow: "15 minutes",
        },
      },
    },
    async (request, reply) => {
      const parsed = testimonialSubmitSchema.safeParse(request.body);
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
      try {
        await submitClientTestimonial({
          clientId: client.id,
          authorName: parsed.data.authorName,
          body: parsed.data.body,
        });
        return reply.code(201).send({ ok: true });
      } catch (e) {
        if (e instanceof TestimonialError) {
          return reply.code(e.statusCode).send({ error: e.message });
        }
        throw e;
      }
    },
  );

  // Lookup entreprise public (rate limité) pour le formulaire Kouzia.
  // Accepte SIREN (9) ou SIRET (14) - API Recherche d'entreprises (data.gouv.fr).
  app.get<{ Params: { siren: string } }>(
    "/api/public/entreprises/:siren",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      return replyEntrepriseLookup(request.params.siren, reply);
    },
  );
};

/** Tronque une IPv4 en /24 pour les logs (privacy). */
function truncateIp(ip: string): string {
  const v4 = ip.replace(/^::ffff:/, "");
  const parts = v4.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  // IPv6 : garder le préfixe /48 approximatif
  const v6 = v4.split(":");
  if (v6.length >= 3) return `${v6.slice(0, 3).join(":")}::`;
  return "unknown";
}
