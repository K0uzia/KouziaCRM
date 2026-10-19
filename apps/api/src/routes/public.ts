import { balanceFields } from "@/lib/invoices/balance.js";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { buildPayUrl } from "@/lib/stripe/pay-urls.js";
import { billedWithDocument, depositBaseOf } from "@/lib/invoices/totals.js";

/**
 * Remise appliquée à la partie ponctuelle d'un document (contrat KouziaWebsite, README « Espace client »).
 * Devis émis : partie ponctuelle facturée avec le devis moins sa base figée (oneOffTotalCents), devis antérieurs
 * compris ; autre document : sous-total moins total. 0 sans remise.
 */
function oneOffDiscountOf(d: {
  documentType: string;
  subtotalCents: number;
  totalCents: number;
  depositBaseCents: number | null;
  lines: Array<{ unitPriceCents: number; subscriptionStart: string | null }>;
}): number {
  if (d.documentType === "QUOTE" && d.depositBaseCents !== null) {
    const billedSubs = d.lines
      .filter((l) => billedWithDocument({ isSubscription: true, subscriptionStart: l.subscriptionStart }))
      .reduce((s, l) => s + l.unitPriceCents, 0);
    return Math.max(0, d.subtotalCents - billedSubs - d.depositBaseCents);
  }
  return Math.max(0, d.subtotalCents - d.totalCents);
}
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
import { buildInvoicePdfPayload, pdfSettingsOf } from "@/lib/pdf/build-payload.js";
import { enrichCompanyForPdf } from "@/lib/pdf/brand-assets.js";
import { resolveBrandColors } from "@/lib/brand.js";
import { listActiveLegalClauses } from "@/lib/company/legal-clauses.js";
import { CLIENT_TYPES, isOrganization } from "@/lib/clients/client-type.js";
import {
  CancelRequestError,
  isStripeManaged,
  portalSubscriptionFields,
  requestSubscriptionCancellation,
} from "@/lib/subscriptions/self-service.js";
import type { ClientSnapshot } from "@/lib/invoices/transitions.js";
import {
  acceptQuoteByClient,
  deferredStartOf,
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
  projectOfDocument,
  type ProjectByQuote,
} from "@/lib/portal/tracking-payload.js";
import { isValidSiren, isValidSiret } from "@kouzia/forms";
import { listPortalProjects } from "@/lib/projects/service.js";
import { reviewInviteEligible } from "@/lib/projects/review-invite.js";
import { publicStart } from "@/lib/subscriptions/start.js";
import {
  CONSENT_TEXT,
  CONSENT_VERSION,
  nameOptions,
  portalTestimonials,
  TESTIMONIAL_MAX_LENGTH,
} from "@/lib/site/testimonials.js";

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
  type: z.enum(CLIENT_TYPES),
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
    /** CGV publiées : case cochée (true) et version lue, égale à la version en vigueur. */
    acceptCgv: z.literal(true).optional(),
    cgvVersion: z.string().trim().min(1).max(40).optional(),
    /** Particulier : exécution demandée avant la fin du délai de rétractation (case facultative). */
    expressExecution: z.boolean().optional(),
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

/**
 * Après la signature d'un devis d'abonnement : lien de mise en place du prélèvement Stripe,
 * affiché tout de suite dans l'espace client (l'e-mail part aussi, une seule fois).
 */
async function subscriptionSetupUrlOf(quoteId: string): Promise<{ subscriptionSetupUrl?: string }> {
  const settings = await getCompanySettings();
  if (!settings.moduleStripeEnabled) return {};
  const line = await prisma.invoiceLine.findFirst({
    where: { invoiceId: quoteId, isSubscription: true, subscriptionId: { not: null } },
    select: { subscription: { select: { id: true, status: true, stripeSubscriptionId: true } } },
  });
  const sub = line?.subscription;
  if (!sub || sub.stripeSubscriptionId || sub.status !== "ACTIVE") return {};
  return { subscriptionSetupUrl: buildPayUrl("subscribe", sub.id) };
}

/**
 * Délai minimal de saisie du formulaire /nouveau-client (anti-robot, côté serveur) : premier affichage
 * du lien noté en mémoire ; un envoi moins de 3 s après est traité comme le honeypot (fausse réussite).
 * Sans affichage noté (redémarrage), l'envoi passe.
 */
export const FORM_MIN_FILL_MS = 3_000;
const formShownAt = new Map<string, number>();
function noteFormShown(token: string, now = Date.now()) {
  if (formShownAt.size > 5_000) formShownAt.clear();
  if (!formShownAt.has(token)) formShownAt.set(token, now);
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

  // Formulaire HTML de la page de paiement (bouton « Payer ») : le navigateur envoie
  // application/x-www-form-urlencoded. Aucun champ n'est lu : corps ignoré, taille plafonnée.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 1024 },
    (_request, _body, done) => done(null, {}),
  );

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

  // Connexion, étape 2 : code valide = adresse confirmée et appareil reconnu 7 jours.
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
          // Avoir : devis de la facture créditée (documents[].projectId).
          creditedInvoice: { select: { quoteId: true } },
          // Facture : ses avoirs et leurs remboursements (solde, reste dû).
          creditNotes: { select: { totalCents: true, payments: { select: { amountCents: true } } } },
          lines: {
            where: { isSubscription: true },
            orderBy: { position: "asc" },
            select: {
              description: true,
              billingInterval: true,
              unitPriceCents: true,
              subscriptionStart: true,
              subscriptionStartDate: true,
              subscriptionFreeMonths: true,
            },
          },
          quoteAcceptanceAudits: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { consumer: true, expressExecution: true, withdrawalEndsAt: true },
          },
        },
        take: 60,
      });

      // Clôturé : jamais affiché. Suspendu (impayé ou suspension manuelle) : affiché avec son état.
      const subscriptions = await prisma.subscription.findMany({
        where: { clientId: client.id, status: { in: ["ACTIVE", "PAUSED"] } },
        orderBy: { nextInvoiceAt: "asc" },
        // Lignes de devis (ou de facture) d'origine : subscriptions[].projectId, en une passe.
        include: {
          sourceLines: { select: { invoice: { select: { id: true, documentType: true, quoteId: true } } } },
          _count: { select: { invoices: true } },
        },
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
      // Rattachement aux projets : seuls les projets visibles de CE client (jamais un identifiant masqué).
      const portalProjects = await listPortalProjects(client.id);
      const projectByQuote: ProjectByQuote = new Map(portalProjects.flatMap((p) => (p.quoteId ? [[p.quoteId, p.id] as const] : [])));

      const history = buildPaymentHistory({
        docs: documents,
        milestones: allMilestones,
        showAmounts,
        projectByQuote,
      });
      // Ajout du 19/10/2026 (contrat /suivi) : « Reste à régler » avoirs compris, somme des dueCents des factures
      // émises. totalDueCents (au niveau du marché, sans les avoirs) reste inchangé.
      const paymentHistory = showAmounts
        ? {
            ...history,
            totalNetDueCents: documents
              .filter((d) => d.documentType === InvoiceDocumentType.INVOICE && d.status === InvoiceStatus.ISSUED)
              .reduce((sum, d) => sum + (balanceFields(d)?.dueCents ?? 0), 0),
          }
        : history;

      const testimonials = await portalTestimonials(client.id);
      // Projet terminé : état de son témoignage (« none » tant qu'aucun n'a été déposé).
      const projects = portalProjects.map((p) =>
        p.status === "DONE" ? { ...p, testimonial: testimonials.get(p.id) ?? { status: "NONE" as const } } : p,
      );
      const reviewEligible = await reviewInviteEligible(client.id);

      const email = decryptOptional(client.emailEncrypted);
      return {
        clientFirstName: firstName,
        clientNumber: client.clientNumber,
        displayName: client.displayName,
        emailMasked: email ? maskEmail(email) : null,
        // Particulier : droit de rétractation de 14 jours, case de demande d'exécution anticipée.
        consumer: client.type === "B2C",
        // Formulaire de signature : CGV à accepter (null tant qu'elles ne sont pas publiées) et
        // libellé légal de la case d'exécution anticipée (particuliers seulement).
        signatureTerms: {
          cgv: settings.cgvPublished && settings.cgvUrl && settings.cgvVersion
            ? { url: settings.cgvUrl, version: settings.cgvVersion }
            : null,
          expressExecutionText: client.type === "B2C" ? settings.withdrawalExpressRequestText : null,
        },
        // Pré-remplit le formulaire de signature ; le client peut corriger.
        signer: {
          firstName: client.firstName ?? "",
          lastName: client.lastName ?? "",
          companyName: isOrganization(client.type) ? (client.companyName ?? client.displayName) : null,
        },
        brand: {
          tradeName: settings.tradeName ?? settings.legalName,
          accentColor: resolveBrandColors(settings).primary,
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
            projectId: projectOfDocument(projectByQuote, d),
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
                  ...(oneOffDiscountOf(d) > 0 ? { oneOffDiscountCents: oneOffDiscountOf(d) } : {}),
                  // Ajout du 19/10/2026 (contrat /suivi) : solde avoirs compris, factures seulement. Les champs
                  // ci-dessus ne changent pas ; dueCents est le reste à payer à afficher.
                  ...(balanceFields(d) ?? {}),
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
                  // Abonnement du devis : seul (NONE, démarre à la signature) ou avec une partie ponctuelle
                  // (démarre à la livraison). L'échéancier ne porte que sur la partie ponctuelle.
                  ...(d.lines.length > 0 && (offer === "NONE" || d.depositBaseCents !== null)
                    ? {
                        subscriptionBilling: {
                          interval: d.lines.some((l) => l.billingInterval === "YEAR") ? "YEAR" : "MONTH",
                          startsAt: offer === "NONE" ? "SIGNATURE" : "DELIVERY",
                          // Prélèvement Stripe : la 1re échéance est prélevée à sa mise en place. Sinon, facture.
                          directDebit: settings.moduleStripeEnabled,
                          ...(showAmounts ? { amountCents: d.lines.reduce((s, l) => s + l.unitPriceCents, 0) } : {}),
                        },
                        // Une entrée par ligne d'abonnement, dans l'ordre du devis (contrat KouziaWebsite, README
                        // « Espace client ») : départ de la facturation et mois offerts comptés depuis ce départ.
                        subscriptionLines: d.lines.map((l) => ({
                          label: l.description,
                          interval: l.billingInterval === "YEAR" ? "YEAR" : "MONTH",
                          ...(showAmounts ? { amountCents: l.unitPriceCents } : {}),
                          ...publicStart(l, offer !== "NONE"),
                        })),
                        ...(offer !== "NONE" && showAmounts ? { oneOffTotalCents: depositBaseOf(d) } : {}),
                      }
                    : {}),
                  ...(quotePending && offer !== "NONE"
                    ? {
                        paymentPlans: describePlans(offer, depositBaseOf(d), settings).map((p) => ({
                          plan: p.plan,
                          milestones: p.milestones.map(({ amountCents, ...m }) =>
                            showAmounts ? { ...m, amountCents } : m,
                          ),
                        })),
                      }
                    : {}),
                }
              : {}),
            // Devis signé par un particulier : fin du délai de rétractation et, sans demande
            // d'exécution anticipée, date de démarrage au plus tôt (lendemain).
            ...(() => {
              const proof = d.quoteAcceptanceAudits[0];
              if (d.documentType !== InvoiceDocumentType.QUOTE || !proof?.consumer || !proof.withdrawalEndsAt) return {};
              const start = deferredStartOf({ ...proof, consumer: true });
              return {
                withdrawal: {
                  endsAt: proof.withdrawalEndsAt,
                  expressExecution: proof.expressExecution === true,
                  startsNotBefore: start,
                },
              };
            })(),
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
          // Prélèvement Stripe pas encore en place : lien pour le mettre en place (SEPA ou carte).
          // Pas de mise en place du prélèvement sur un abonnement en cours de résiliation.
          ...(settings.moduleStripeEnabled && !s.stripeSubscriptionId && !s.cancellationRequestedAt && !(s.endDate && s.endDate > new Date())
            ? { setupUrl: buildPayUrl("subscribe", s.id) }
            : {}),
          id: s.id,
          projectId:
            s.sourceLines.map((l) => projectOfDocument(projectByQuote, l.invoice)).find((p) => p !== null) ?? null,
          ...portalSubscriptionFields(
            s,
            settings.nonRenewalNoticeDays,
            new Date(),
            Boolean(s.lastInvoiceId) || s._count.invoices > 0 || s.sourceLines.some((l) => l.invoice.documentType === "INVOICE"),
          ),
        })),
        emails: emailEvents.map((e) => ({
          id: e.id,
          kind: e.kind,
          subject: e.subject,
          documentNumber: e.documentNumber,
          sentAt: e.sentAt.toISOString(),
        })),
        // Projet livré : « À faire » propose de laisser un avis Google (lien porté par le site).
        reviewInvite: { eligible: reviewEligible },
        // Bloc « Avancement » de /suivi : affiché dès que la liste est présente.
        ...(projects.length > 0 ? { projects } : {}),
        // Formulaire de témoignage (projet terminé) : formes du nom calculées depuis la fiche, texte d'accord versionné.
        ...(projects.some((p) => p.status === "DONE")
          ? {
              testimonialForm: {
                nameOptions: nameOptions(client),
                maxLength: TESTIMONIAL_MAX_LENGTH,
                // Texte d'accord EXACT, affiché tel quel par le site ; sa version accompagne l'envoi.
                consent: { version: CONSENT_VERSION, text: CONSENT_TEXT },
              },
            }
          : {}),
      };
    },
  );

  // Gestion d'un abonnement prélevé par Stripe : session du portail client, pour le client connecté.
  app.post<{ Params: { id: string } }>(
    "/api/public/subscriptions/:id/portal",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const client = await resolvePortalClient(request);
      if (!client) return reply.code(401).send(SESSION_EXPIRED);
      const sub = await prisma.subscription.findUnique({ where: { id: request.params.id } });
      // Même réponse qu'un abonnement inexistant : le portail ne révèle pas les données d'autrui.
      if (!sub || sub.clientId !== client.id || sub.status === "ENDED") {
        return reply.code(404).send({ error: "Abonnement introuvable" });
      }
      if (!isStripeManaged(sub)) {
        return reply.code(409).send({ error: "Cet abonnement n'est pas prélevé en ligne : utilisez « Demander la résiliation »." });
      }
      try {
        const { createSubscriptionPortalUrl } = await import("@/lib/stripe/portal.js");
        return { url: await createSubscriptionPortalUrl(sub.id) };
      } catch (err) {
        request.log.warn({ err: err instanceof Error ? err.message : String(err) }, "portail Stripe indisponible");
        return reply
          .code(502)
          .send({ error: "La gestion en ligne est indisponible pour le moment. Réessayez plus tard ou répondez à l'un de nos e-mails." });
      }
    },
  );

  // Abonnement par virement : demande de résiliation (accusé par e-mail, l'admin clôture à la main).
  app.post<{ Params: { id: string } }>(
    "/api/public/subscriptions/:id/cancel-request",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const client = await resolvePortalClient(request);
      if (!client) return reply.code(401).send(SESSION_EXPIRED);
      const sub = await prisma.subscription.findUnique({ where: { id: request.params.id }, select: { clientId: true, status: true } });
      if (!sub || sub.clientId !== client.id || sub.status === "ENDED") {
        return reply.code(404).send({ error: "Abonnement introuvable" });
      }
      try {
        const at = await requestSubscriptionCancellation(request.params.id);
        return { cancellationRequestedAt: at.toISOString() };
      } catch (err) {
        if (err instanceof CancelRequestError) return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
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
        // Formule, CGV et case vérifiées avant le code : un oubli ne consomme pas le code de signature.
        resolveAcceptedPlan(parsePaymentPlanOffer(quote.paymentPlanOffer), data.paymentPlan, { requireChoice: true });
        const settings = await getCompanySettings();
        if (settings.cgvPublished) {
          if (data.acceptCgv !== true) {
            return reply.code(400).send({ error: "Acceptez les conditions générales de vente.", code: "CGV_REQUIRED" });
          }
          if (data.cgvVersion !== settings.cgvVersion) {
            return reply.code(409).send({
              error: "Les conditions générales de vente ont changé : relisez la nouvelle version.",
              code: "CGV_VERSION_CHANGED",
            });
          }
        }
        if (data.expressExecution && client.type !== "B2C") {
          return reply.code(400).send({ error: "Demande réservée aux particuliers.", code: "EXPRESS_EXECUTION_CONSUMER_ONLY" });
        }
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
                isOrganization(client.type) ? (client.companyName ?? client.displayName) : null,
              emailMasked: email ? maskEmail(email) : null,
              codeVerifiedAt: new Date(),
            },
            paymentPlan: data.paymentPlan,
            cgvAccepted: settings.cgvPublished && data.acceptCgv === true,
            expressExecution: data.expressExecution === true,
          },
        );
        return { quoteStatus: updated.quoteStatus, ...(await subscriptionSetupUrlOf(quote.id)) };
      } catch (e) {
        if (e instanceof QuoteDecisionError) {
          return reply.code(409).send({ error: e.message, code: e.code });
        }
        if (e instanceof PaymentPlanError) return reply.code(400).send({ error: e.message, code: e.code });
        return reply.code(400).send({ error: "Décision impossible" });
      }
    },
  );

  // Reçu d'un règlement (lien receiptPdfToken de /suivi) : PDF archivé, servi tel quel.
  app.get<{ Params: { token: string } }>(
    "/api/public/receipts/:token",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const { verifyReceiptToken } = await import("@/lib/documents/public-token.js");
      const paymentId = verifyReceiptToken(request.params.token);
      if (!paymentId) return reply.code(404).send({ error: "Lien invalide" });
      const { paymentReceiptPdf, receiptFileName } = await import("@/lib/pdf/receipt-archive.js");
      const pdf = await paymentReceiptPdf(paymentId);
      const payment = pdf
        ? await prisma.payment.findUnique({
            where: { id: paymentId },
            select: { paidAt: true, invoice: { select: { number: true } } },
          })
        : null;
      if (!pdf || !payment?.invoice?.number) return reply.code(404).send({ error: "Document introuvable" });
      const filename = receiptFileName(payment.invoice.number, payment.paidAt, paymentId);
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `inline; filename="${filename}"`)
        .header("Cache-Control", "private, no-store")
        .send(pdf);
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
      // Facture ou avoir émis : PDF archivé, servi tel quel.
      const { issuedDocumentPdf } = await import("@/lib/pdf/issued-archive.js");
      const archived = await issuedDocumentPdf(invoice.id);
      if (archived) {
        return reply
          .header("Content-Type", "application/pdf")
          .header("Content-Disposition", `inline; filename="${invoice.number}.pdf"`)
          .send(archived);
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
        invoice: buildInvoicePdfPayload({
          invoice,
          legalClauses,
          clientType: snapshot.type,
          ...(await pdfSettingsOf()),
        }),
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
      const q = z.object({ token: z.string().trim().max(512).default("") }).safeParse(request.query);
      const token = q.success ? q.data.token : "";
      if (!token) return reply.code(400).send({ error: "Token requis" });
      const view = await getPublicClientPreview(token);
      if (!view) return reply.code(404).send({ error: "Lien invalide ou expiré" });
      noteFormShown(token);
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
      const token = parsed.data.token?.trim() ?? "";
      if (!token) {
        return reply.code(400).send({ error: "Token requis" });
      }
      const shownAt = formShownAt.get(token);
      if (shownAt !== undefined && Date.now() - shownAt < FORM_MIN_FILL_MS) {
        request.log.info({ event: "public_client_submit", status: 201, ipTrunc: truncateIp(request.ip), reason: "trop_rapide" });
        return reply.code(201).send({ ok: true });
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
        return reply.code(code).send({
          error: result.error ?? "Erreur",
          ...(result.code ? { code: result.code } : {}),
          ...(result.suggestion ? { suggestion: result.suggestion } : {}),
        });
      }
      request.log.info({
        event: "public_client_submit",
        status: 201,
        ipTrunc: truncateIp(request.ip),
      });
      return reply.code(201).send({ ok: true });
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
  // Jeton signé (lien long), ou jeton court d'abonnement pour /manage et /card (le chemin donne le type).
  const resolveLink = async (token: string, kinds: readonly string[], shortKind: "manage" | "card" | null) => {
    const { verifyPayToken } = await import("@/lib/stripe/pay-token.js");
    const signed = verifyPayToken(token);
    if (signed) return kinds.includes(signed.kind) ? signed : null;
    if (!shortKind) return null;
    const { subscriptionIdFromShortToken } = await import("@/lib/stripe/portal.js");
    const id = await subscriptionIdFromShortToken(token);
    return id ? { kind: shortKind, id } : null;
  };

  for (const [path, kinds, shortKind] of [
    ["/api/public/pay/:token", ["invoice", "milestone"], null],
    ["/api/public/subscribe/:token", ["subscribe"], null],
    ["/api/public/manage/:token", ["manage", "card"], "manage"],
    ["/api/public/card/:token", ["card"], "card"],
  ] as const) {
    app.get<{ Params: { token: string } }>(
      path,
      { config: { rateLimit: { max: 60, timeWindow: "15 minutes" } } },
      async (request, reply) => {
        const { resolveClientPortalUrl } = await import("@/lib/email/portal-url.js");
        const { payPageInfo, renderPayPage, PAY_PAGE_CSP } = await import("@/lib/stripe/pay-page.js");
        const parsed = await resolveLink(request.params.token, kinds, shortKind);
        const info = parsed ? await payPageInfo(parsed.kind, parsed.id) : null;
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
        const parsed = await resolveLink(request.params.token, kinds, shortKind);
        if (!parsed) return reply.redirect(portal, 303);
        const { payPageInfo, renderPayPage, PAY_PAGE_CSP } = await import("@/lib/stripe/pay-page.js");
        const info = await payPageInfo(parsed.kind, parsed.id);
        if (!info) return reply.redirect(portal, 303);
        // Page réaffichée avec un message (montant sous le minimum, Checkout indisponible) plutôt
        // qu'une redirection muette : le client sait quoi faire.
        const page = (notice: string) =>
          reply
            .header("Content-Security-Policy", PAY_PAGE_CSP)
            .header("Cache-Control", "no-store")
            .type("text/html; charset=utf-8")
            .send(renderPayPage({ ...info, notice }));
        if (!info.button) return page(info.notice ?? "Paiement en ligne indisponible.");
        try {
          const checkout = await import("@/lib/stripe/checkout.js");
          const url =
            parsed.kind === "invoice"
              ? await checkout.createInvoiceCheckoutSession(parsed.id)
              : parsed.kind === "milestone"
                ? await checkout.createMilestoneCheckoutSession(parsed.id)
                : parsed.kind === "manage" || parsed.kind === "card"
                  ? await (await import("@/lib/stripe/portal.js")).createSubscriptionPortalUrl(parsed.id, {
                      updateCard: parsed.kind === "card",
                    })
                  : await checkout.createSubscriptionCheckoutSession(parsed.id);
          return reply.redirect(url, 303);
        } catch (err) {
          request.log.warn({ err: err instanceof Error ? err.message : String(err), kind: parsed.kind });
          const { getCompanySettings } = await import("@/lib/company.js");
          const email = (await getCompanySettings()).email?.trim();
          return page(
            `Le paiement en ligne n'a pas pu démarrer. Réessayez dans quelques minutes, ou réglez par virement${email ? ` et écrivez-nous à ${email}` : ""}.`,
          );
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
