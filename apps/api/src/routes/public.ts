import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { verifyDocumentToken } from "@/lib/documents/public-token.js";
import {
  checkPortalCode,
  clearPortalCookie,
  closePortalSession,
  describeDevice,
  deviceIdOf,
  findClientByEmail,
  issuePortalCode,
  maskEmail,
  openPortalSession,
  resolvePortalClient,
  setPortalCookies,
  type CodeCheck,
} from "@/lib/portal/auth.js";
import {
  PORTAL_CODE_KINDS,
  sendLoginCodeEmail,
  sendNewDeviceAlertEmail,
  sendSignCodeEmail,
} from "@/lib/clients/access-email.js";
import { decryptOptional } from "@/lib/crypto.js";
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
  describePlans,
  parsePaymentPlan,
  parsePaymentPlanOffer,
  PaymentPlanError,
  resolveAcceptedPlan,
} from "@/lib/quotes/payment-plans.js";
import { getPublicClientPreview, submitPublicClient } from "@/lib/clients/onboarding.js";
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
import { listPortalProjects } from "@/lib/projects/service.js";

const emailSchema = z.object({ email: z.string().trim().email().max(254) });
const codeSchema = z.string().trim().regex(/^\d{6}$/);
const verifySchema = emailSchema.extend({ code: codeSchema });

/** Prénom ou nom : lettres, espaces, tiret, apostrophe. */
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^\p{L}[\p{L}\s'’-]*$/u);

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
  /** Honeypot anti-spam : doit rester vide (rempli = robot, voir POST /api/public/clients). */
  website: z.string().max(500).optional().nullable(),
  token: z.string().optional(),
});

const testimonialSubmitSchema = z.object({
  authorName: z.string().min(2).max(80),
  body: z.string().min(20).max(800),
});

/** Tracé de signature : PNG en data URL, 300 Ko au plus. */
const signatureImageSchema = z
  .string()
  .max(300_000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);

const quoteDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("ACCEPT"),
    firstName: nameSchema,
    lastName: nameSchema,
    signatureMode: z.enum(["TYPED", "DRAWN"]),
    signatureImage: signatureImageSchema.optional(),
    code: codeSchema,
    /** Formule de paiement : obligatoire quand le devis propose le choix. */
    paymentPlan: z.enum(["TWO", "THREE"]).optional(),
  }),
  z.object({
    decision: z.literal("REJECT"),
    reason: z.string().max(500).optional(),
  }),
]);

/** Libellé de l'étape cochée « déclenche le 2e acompte » dans les étapes JSON d'un projet. */
function flaggedStepLabel(steps: string | null | undefined): string | null {
  try {
    const list = JSON.parse(steps ?? "[]") as Array<{ label?: string; triggersDeposit2?: boolean }>;
    return list.find((s) => s.triggersDeposit2)?.label ?? null;
  } catch {
    return null;
  }
}

const SESSION_EXPIRED = { error: "Session expirée : reconnectez-vous." };
const CODE_ERRORS: Record<Exclude<CodeCheck, "ok">, string> = {
  invalid: "Code incorrect ou expiré.",
  locked: "Trop d'essais : demandez un nouveau code.",
};

/** « Jean DUPONT » : prénom tel que saisi, nom en capitales, espaces normalisés. */
function formatSignerName(firstName: string, lastName: string): string {
  const clean = (s: string) => s.trim().replace(/\s+/g, " ");
  return `${clean(firstName)} ${clean(lastName).toLocaleUpperCase("fr-FR")}`;
}

export const publicRoutes: FastifyPluginAsync = async (app) => {
  // fetch(…, { headers: { "Content-Type": "application/json" } }) sans corps (déconnexion) :
  // Fastify refuse un JSON vide (400) avant la route, la session resterait ouverte. Corps vide = pas de corps.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error("JSON invalide"), { statusCode: 400 }), undefined);
    }
  });

  // Connexion, étape 1 : un code part si l'adresse est celle d'un client.
  // Réponse identique dans tous les cas : on ne peut pas tester qui est client.
  app.post(
    "/api/public/auth/code",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const parsed = emailSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Adresse e-mail invalide." });

      const client = await findClientByEmail(parsed.data.email);
      if (client) {
        // Hors du temps de réponse : la durée de l'envoi ne trahit pas un client existant.
        void (async () => {
          const code = await issuePortalCode(client.id, "LOGIN");
          if (code) await sendLoginCodeEmail(client, code);
          // Réponse inchangée (anti-énumération) : le refus se voit seulement dans les journaux.
          else request.log.warn({ event: "portal_code_throttled", clientId: client.id }, "code de connexion non émis : limite horaire atteinte");
        })().catch((err) => request.log.error({ err }, "envoi du code de connexion échoué"));
      }
      return { ok: true };
    },
  );

  // Connexion, étape 2 : code valide = adresse confirmée et appareil reconnu 15 jours.
  app.post(
    "/api/public/auth/verify",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const parsed = verifySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Code à 6 chiffres attendu." });

      const client = await findClientByEmail(parsed.data.email);
      const check: CodeCheck = client
        ? await checkPortalCode(client.id, "LOGIN", parsed.data.code)
        : "invalid";
      if (!client || check !== "ok") {
        return reply.code(401).send({ error: CODE_ERRORS[check === "ok" ? "invalid" : check] });
      }

      const now = new Date();
      if (!client.emailVerifiedAt) {
        await prisma.client.update({ where: { id: client.id }, data: { emailVerifiedAt: now } });
      }
      const deviceId = deviceIdOf(request);
      const userAgent = request.headers["user-agent"] ?? null;
      const session = await openPortalSession({
        clientId: client.id,
        deviceId,
        ipAddress: request.ip,
        userAgent,
      });
      setPortalCookies(reply, session, deviceId);
      if (session.newDevice) {
        void sendNewDeviceAlertEmail(client, { device: describeDevice(userAgent), at: now }).catch(
          (err) => request.log.error({ err }, "alerte nouvel appareil échouée"),
        );
      }
      return { ok: true };
    },
  );

  app.post("/api/public/auth/logout", async (request, reply) => {
    await closePortalSession(request);
    clearPortalCookie(reply);
    return { ok: true };
  });

  app.get(
    "/api/public/tracking",
    { config: { rateLimit: { max: 120, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const client = await resolvePortalClient(request);
      if (!client) return reply.code(401).send(SESSION_EXPIRED);

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
          // 3 fois : étape du projet de CE devis qui déclenchera le 2e acompte.
          project: { select: { steps: true } },
        },
        take: 60,
      });

      const subscriptions = await prisma.subscription.findMany({
        where: { clientId: client.id, status: "ACTIVE" },
        orderBy: { nextInvoiceAt: "asc" },
      });

      const emailEvents = await prisma.clientEmailEvent.findMany({
        where: { clientId: client.id, success: true, kind: { notIn: PORTAL_CODE_KINDS } },
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
      const projects = await listPortalProjects(client.id);

      const email = decryptOptional(client.emailEncrypted);
      return {
        clientFirstName: firstName,
        clientNumber: client.clientNumber,
        displayName: client.displayName,
        emailMasked: email ? maskEmail(email) : null,
        // Pré-remplit le formulaire de signature ; le client peut corriger.
        signer: {
          firstName: client.firstName ?? "",
          lastName: client.lastName ?? "",
          companyName: client.type === "B2B" ? (client.companyName ?? client.displayName) : null,
        },
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
          const offer = parsePaymentPlanOffer(d.paymentPlanOffer);
          const awaitedStep =
            d.paymentPlan === "THREE" ? flaggedStepLabel(d.project?.steps) : null;
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
                    triggerStepLabel: m.triggerStepLabel,
                    triggeredAt: m.triggeredAt,
                    ...(m.position === 2 && m.status === "PENDING" && awaitedStep
                      ? { awaitingStepLabel: awaitedStep }
                      : {}),
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
            // Paiement en 2 ou 3 fois : formules proposées (avant signature) et formule retenue.
            ...(d.documentType === InvoiceDocumentType.QUOTE && offer
              ? {
                  paymentPlanOffer: offer,
                  paymentPlan: parsePaymentPlan(d.paymentPlan),
                  ...(quotePending
                    ? {
                        paymentPlans: describePlans(offer, d.totalCents, settings).map((p) => ({
                          plan: p.plan,
                          milestones: p.milestones.map(({ amountCents, ...m }) =>
                            showAmounts ? { ...m, amountCents } : m,
                          ),
                        })),
                      }
                    : {}),
                }
              : {}),
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
          billingInterval: s.billingInterval === "YEAR" ? "YEAR" : "MONTH",
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
        // Bloc « Avancement » de /suivi : affiché dès que la liste est présente.
        ...(projects.length > 0 ? { projects } : {}),
      };
    },
  );

  // Signature, étape 1 : code envoyé à l'adresse du client pour ce devis précis.
  app.post<{ Params: { id: string } }>(
    "/api/public/quotes/:id/sign-code",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const client = await resolvePortalClient(request);
      if (!client) return reply.code(401).send(SESSION_EXPIRED);

      const quote = await prisma.invoice.findUnique({
        where: { id: request.params.id },
        select: { id: true, clientId: true, number: true, quoteStatus: true },
      });
      // Même réponse qu'un devis inexistant : le portail ne révèle pas les documents d'autrui.
      if (!quote || quote.clientId !== client.id) {
        return reply.code(404).send({ error: "Devis introuvable" });
      }
      if (quote.quoteStatus !== "SENT") {
        return reply.code(409).send({ error: "Ce devis n'attend plus de réponse." });
      }
      const email = decryptOptional(client.emailEncrypted);
      if (!email) return reply.code(409).send({ error: "Aucune adresse e-mail sur votre fiche." });

      const code = await issuePortalCode(client.id, "SIGN", quote.id);
      if (!code) {
        return reply.code(429).send({ error: "Trop de codes demandés : réessayez dans une heure." });
      }
      await sendSignCodeEmail(client, code, quote.number);
      return { emailMasked: maskEmail(email) };
    },
  );

  // Signature, étape 2 (ou refus) : acceptation seulement avec le code de ce devis.
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
      const client = await resolvePortalClient(request);
      if (!client) return reply.code(401).send(SESSION_EXPIRED);

      const quote = await prisma.invoice.findUnique({
        where: { id: request.params.id },
        select: { id: true, clientId: true, paymentPlanOffer: true },
      });
      // Même réponse qu'un devis inexistant : le portail ne révèle pas les documents d'autrui.
      if (!quote || quote.clientId !== client.id) {
        return reply.code(404).send({ error: "Devis introuvable" });
      }

      try {
        if (parsed.data.decision === "REJECT") {
          const updated = await rejectQuote(quote.id, parsed.data.reason);
          return { quoteStatus: updated.quoteStatus };
        }

        const data = parsed.data;
        if (data.signatureMode === "DRAWN" && !data.signatureImage) {
          return reply.code(400).send({ error: "Tracez votre signature." });
        }
        // Formule vérifiée avant le code : un oubli ne consomme pas le code de signature.
        resolveAcceptedPlan(parsePaymentPlanOffer(quote.paymentPlanOffer), data.paymentPlan, { requireChoice: true });
        const check = await checkPortalCode(client.id, "SIGN", data.code, quote.id);
        if (check !== "ok") return reply.code(401).send({ error: CODE_ERRORS[check] });

        const email = decryptOptional(client.emailEncrypted);
        const updated = await acceptQuoteByClient(
          quote.id,
          formatSignerName(data.firstName, data.lastName),
          {
            context: {
              ipAddress: request.ip,
              userAgent: request.headers["user-agent"] ?? null,
            },
            signature: {
              mode: data.signatureMode,
              image: data.signatureMode === "DRAWN" ? (data.signatureImage ?? null) : null,
              company:
                client.type === "B2B" ? (client.companyName ?? client.displayName) : null,
              emailMasked: email ? maskEmail(email) : null,
              codeVerifiedAt: new Date(),
            },
            paymentPlan: data.paymentPlan,
          },
        );
        return { quoteStatus: updated.quoteStatus };
      } catch (e) {
        if (e instanceof QuoteDecisionError) {
          return reply.code(409).send({ error: e.message, code: e.code });
        }
        if (e instanceof PaymentPlanError) return reply.code(400).send({ error: e.message, code: e.code });
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
          quoteAcceptanceAudits: { orderBy: { createdAt: "desc" }, take: 1 },
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
        invoice: buildInvoicePdfPayload({ invoice, legalClauses, planSettings: await getCompanySettings() }),
      });

      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `inline; filename="${invoice.number}.pdf"`)
        .send(buffer);
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
      // Honeypot rempli = robot : fausse réussite, rien n'est enregistré.
      if (parsed.data.website?.trim()) {
        request.log.info({
          event: "public_client_submit",
          status: 201,
          ipTrunc: truncateIp(request.ip),
          reason: "honeypot",
        });
        return reply.code(201).send({ ok: true });
      }
      const token =
        parsed.data.token?.trim() ||
        (typeof (request.body as { token?: string })?.token === "string"
          ? (request.body as { token: string }).token
          : "");
      if (!token) {
        return reply.code(400).send({ error: "Token requis" });
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
      const client = await resolvePortalClient(request);
      if (!client) return reply.code(401).send(SESSION_EXPIRED);
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

  // Liens de paiement Stripe (jeton signé, lien ERP permanent). GET : page sans effet, que les
  // antivirus de messagerie peuvent précharger ; POST (bouton) : nouvelle session Checkout.
  for (const [path, kinds] of [
    ["/api/public/pay/:token", ["invoice", "milestone"]],
    ["/api/public/subscribe/:token", ["subscribe"]],
  ] as const) {
    app.get<{ Params: { token: string } }>(
      path,
      { config: { rateLimit: { max: 60, timeWindow: "15 minutes" } } },
      async (request, reply) => {
        const { resolveClientPortalUrl } = await import("@/lib/email/portal-url.js");
        const { verifyPayToken } = await import("@/lib/stripe/pay-token.js");
        const { payPageInfo, renderPayPage, PAY_PAGE_CSP } = await import("@/lib/stripe/pay-page.js");
        const parsed = verifyPayToken(request.params.token);
        const info =
          parsed && (kinds as readonly string[]).includes(parsed.kind)
            ? await payPageInfo(parsed.kind, parsed.id)
            : null;
        if (!info) return reply.redirect(await resolveClientPortalUrl());
        return reply
          .header("Content-Security-Policy", PAY_PAGE_CSP)
          .header("Cache-Control", "no-store")
          .type("text/html; charset=utf-8")
          .send(renderPayPage(info));
      },
    );

    app.post<{ Params: { token: string } }>(
      path,
      { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
      async (request, reply) => {
        const { resolveClientPortalUrl } = await import("@/lib/email/portal-url.js");
        const portal = await resolveClientPortalUrl();
        const { verifyPayToken } = await import("@/lib/stripe/pay-token.js");
        const parsed = verifyPayToken(request.params.token);
        if (!parsed || !(kinds as readonly string[]).includes(parsed.kind)) return reply.redirect(portal, 303);
        try {
          const checkout = await import("@/lib/stripe/checkout.js");
          const url =
            parsed.kind === "invoice"
              ? await checkout.createInvoiceCheckoutSession(parsed.id)
              : parsed.kind === "milestone"
                ? await checkout.createMilestoneCheckoutSession(parsed.id)
                : await checkout.createSubscriptionCheckoutSession(parsed.id);
          return reply.redirect(url, 303);
        } catch (err) {
          request.log.warn({ err: err instanceof Error ? err.message : String(err), kind: parsed.kind });
          return reply.redirect(portal, 303);
        }
      },
    );
  }
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
