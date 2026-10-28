import { readArchiveFile } from "@/lib/pdf/archive-file.js";
import { primaryMethod } from "@/lib/stripe/payment-methods.js";
import { nextPeriodAmountCents, recurringDiscountSummary } from "@/lib/quotes/recurring-discount-calc.js";
import { balanceFields } from "@/lib/invoices/balance.js";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { rateLimitKey } from "@/lib/client-ip.js";
import { z } from "zod";
import { InvoiceDocumentType, InvoiceStatus, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { loadDocumentForPdf, pdfDataOfLoaded } from "@/lib/pdf/document-pdf.js";
import { optionalChoicesError, optionalLinesSchema, proposalLetter, quoteFieldsOfOption } from "@/lib/quotes/quote-options.js";
import { getCompanySettings } from "@/lib/company.js";
import { buildPayUrl } from "@/lib/stripe/pay-urls.js";
import { billedWithDocument, depositBaseOf, isCommittedLine } from "@/lib/invoices/totals.js";
import { readScope } from "@/lib/quotes/scope.js";

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
  lines: Array<{ unitPriceCents: number; subscriptionStart: string | null; isOptional: boolean; optionalAccepted: boolean | null }>;
}): number {
  if (d.documentType === "QUOTE" && d.depositBaseCents !== null) {
    // Option en attente ou non retenue : hors du sous-total, donc hors du calcul (28/10/2026).
    const billedSubs = d.lines
      .filter((l) => isCommittedLine(l) && billedWithDocument({ isSubscription: true, subscriptionStart: l.subscriptionStart }))
      .reduce((s, l) => s + l.unitPriceCents, 0);
    return Math.max(0, d.subtotalCents - billedSubs - d.depositBaseCents);
  }
  return Math.max(0, d.subtotalCents - d.totalCents);
}
import { verifyDocumentToken } from "@/lib/documents/public-token.js";
import {
  VERIFY_FAILURE_FLOOR_MS,
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
  resolvePortalSession,
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
import { resolveBrandColors } from "@/lib/brand.js";
import { CLIENT_TYPES, isOrganization } from "@/lib/clients/client-type.js";
import {
  CancelRequestError,
  isStripeManaged,
  portalSubscriptionFields,
  requestSubscriptionCancellation,
} from "@/lib/subscriptions/self-service.js";
import {
  acceptQuoteByClient,
  deferredStartOf,
  rejectQuote,
  QuoteDecisionError,
} from "@/lib/invoices/transitions.js";
import {
  describePlans,
  planSettingsOf,
  parsePaymentPlan,
  parseBillingMode,
  parsePaymentPlanOffer,
  PaymentPlanError,
  resolveAcceptedPlan,
} from "@/lib/quotes/payment-plans.js";
import { getPublicClientPreview, submitPublicClient } from "@/lib/clients/onboarding.js";
import { signDocumentToken } from "@/lib/documents/public-token.js";
import { parseReadable, readableInvoice, readableLinkAvailable, snapshotFor } from "@/lib/pdf/readable-documents.js";
import type { InvoicePdfData } from "@/lib/pdf/invoice-document.js";
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
import { publicStart, type StartLine } from "@/lib/subscriptions/start.js";
import { normalizeInterval, periodMonths } from "@/lib/subscriptions/subscription-service.js";
import {
  PORTAL_SECTIONS,
  changedAfter,
  isNewDocument,
  isNewMilestone,
  isNewProject,
  loadPortalSeen,
  markPortalSeen,
  newPaymentEntryIds,
} from "@/lib/portal/unseen.js";
import {
  CONSENT_TEXT,
  CONSENT_VERSION,
  nameOptions,
  portalTestimonials,
  TESTIMONIAL_MAX_LENGTH,
  TESTIMONIAL_SOURCE,
} from "@/lib/site/testimonials.js";

const emailSchema = z.object({ email: z.string().trim().email().max(254) });
const codeSchema = z.string().trim().regex(/^\d{6}$/);
const seenSchema = z.object({ section: z.enum(PORTAL_SECTIONS) });
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

/** Choix d'option manquant ou étranger à la formule signée (28/10/2026) : codes du contrat /suivi. */
const OPTIONAL_CHOICE_ERRORS = {
  REQUIRED: { error: "Indiquez si l'option proposée est retenue ou non.", code: "optional_choice_required" },
  INVALID: { error: "Ce choix d'option ne correspond pas à la formule signée.", code: "optional_choice_invalid" },
} as const;

const quoteDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("ACCEPT"),
    firstName: nameSchema,
    lastName: nameSchema,
    signatureMode: z.enum(["TYPED", "DRAWN"]),
    signatureImage: signatureImageSchema.optional(),
    /** Facultatif : la session /suivi (ouverte par le code de connexion) suffit. Envoyé quand même, il est vérifié. */
    code: codeSchema.optional(),
    /** Formule de paiement : obligatoire quand le devis propose le choix. */
    paymentPlan: z.enum(["TWO", "THREE"]).optional(),
    /** Devis à propositions : la proposition retenue (obligatoire). */
    optionId: z.string().min(1).max(64).optional(),
    /** Lignes en option de la formule signée : un choix explicite pour chacune (obligatoire s'il y en a). */
    optionalLines: optionalLinesSchema,
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
/** Date « AAAA-MM-JJ » à l'heure locale. */
const ymdOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Devis en mode récurrent (contrat F5, 24/10/2026) : un abonnement, lignes d'abonnement additionnées, mêmes période,
 * engagement, départ et jour sur chaque ligne ; aucune ligne ponctuelle (décision du 23/10/2026).
 * null pour tout autre devis.
 */
function recurringOf(d: {
  billingMode: string | null;
  depositBaseCents: number | null;
  recurringDiscountKind: string | null;
  recurringDiscountValue: number | null;
  recurringDiscountMonths: number | null;
  openingDiscount: boolean;
  promoCode?: { code: string; conditionText: string | null } | null;
  lines: Array<
    StartLine & {
      billingInterval: string | null;
      unitPriceCents: number;
      commitmentMonths: number | null;
      billingDay: number | null;
      subscription: { nextInvoiceAt: Date; invoices: Array<{ issueDate: Date | null }> } | null;
    }
  >;
}) {
  const first = d.lines[0];
  if (parseBillingMode(d.billingMode) !== "RECURRING" || !first) return null;
  const period = normalizeInterval(first.billingInterval);
  const start = publicStart(first, first.subscriptionStart === "DELIVERY");
  const sub = first.subscription;
  const firstInvoice = sub ? (sub.invoices[0]?.issueDate ?? sub.nextInvoiceAt) : null;
  const amountCents = d.lines.reduce((sum, l) => sum + l.unitPriceCents, 0);
  return {
    period,
    amountCents,
    commitmentMonths: first.commitmentMonths ?? null,
    // Remise du devis (R1, contrat R4) : même calcul que le PDF.
    discount: recurringDiscountSummary(d, amountCents, period, first.commitmentMonths ?? null),
    periods: first.commitmentMonths ? Math.ceil(first.commitmentMonths / periodMonths(period)) : null,
    ...start,
    billingDay: first.billingDay ?? 1,
    firstInvoiceOn: firstInvoice ? ymdOf(firstInvoice) : null,
  };
}

function flaggedStepLabel(steps: string | null | undefined): string | null {
  try {
    const list = JSON.parse(steps ?? "[]") as Array<{ label?: string; triggersDeposit2?: boolean }>;
    return list.find((s) => s.triggersDeposit2)?.label ?? null;
  } catch {
    return null;
  }
}

const SESSION_EXPIRED = { error: "Session expirée : reconnectez-vous." };

/**
 * Lien de paiement d'une facture montré dans /suivi : https seulement (lien collé à la main compris) ; en dev, l'API
 * locale sert ses liens en http sur localhost, acceptés hors production pour pouvoir tester.
 */
function safePayUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return url;
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.protocol === "http:" && local && process.env.NODE_ENV !== "production" ? url : null;
  } catch {
    return null;
  }
}

/** IBAN groupé par 4, comme sur le PDF de la facture. */
const formatIban = (iban: string) => iban.replace(/\s+/g, "").toUpperCase().replace(/(.{4})/g, "$1 ").trim();
// Message unique : « verrouillé » distinct d'« incorrect » révélait qu'une adresse est celle d'un client.
const CODE_ERROR = "Code incorrect ou expiré. Après plusieurs essais, demandez un nouveau code.";
const CODE_ERRORS: Record<Exclude<CodeCheck, "ok">, string> = {
  invalid: CODE_ERROR,
  locked: CODE_ERROR,
};

/** Limites de débit des codes : une IPv6 compte pour son bloc /64 entier. */
const byIpBlock = (request: FastifyRequest) => rateLimitKey(request.ip);

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
 * Document d'un lien public (PDF et version lisible) : null si inconnu, brouillon ou sans numéro. Même chargement que le
 * PDF admin et l'archive (loadDocumentForPdf) : propositions, code promo et récapitulatif du solde compris.
 */
async function loadPublicDocument(invoiceId: string) {
  const doc = await loadDocumentForPdf(invoiceId, { maskContacts: true });
  return doc && doc.invoice.status !== InvoiceStatus.DRAFT ? doc : null;
}
type PublicDocument = NonNullable<Awaited<ReturnType<typeof loadPublicDocument>>>;

/**
 * Devis signé : le PDF archivé dans la preuve de signature (décision du 25/10/2026), jamais un nouveau rendu ; null pour
 * un devis non signé ou une archive illisible (rendu du jour).
 */
async function signedQuotePdf(invoice: PublicDocument["invoice"]): Promise<Buffer | null> {
  const proof = invoice.quoteAcceptanceAudits[0];
  if (invoice.documentType !== InvoiceDocumentType.QUOTE || invoice.quoteStatus !== "ACCEPTED" || !proof?.pdfPath) return null;
  try {
    const { signedQuoteAbsolutePath } = await import("@/lib/invoices/acceptance-proof.js");
    const fs = await import("node:fs/promises");
    return await readArchiveFile(signedQuoteAbsolutePath(proof.pdfPath));
  } catch (err) {
    console.error(`[public] devis signé illisible pour ${invoice.id}`, err);
    return null;
  }
}

/** Données du PDF rendu à la demande (devis, facture sans archive) : celles du PDF admin (pdfDataOfLoaded). */
async function liveDocumentPdfData(doc: PublicDocument): Promise<InvoicePdfData> {
  return pdfDataOfLoaded(doc);
}


/** En-têtes des routes lisibles (contrat B), réponse d'erreur comprise ; X-Robots-Tag noindex, nofollow posé pour toute l'API. */
function readableHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("Content-Language", "fr")
    .header("Cache-Control", "private, no-store")
    .header("Referrer-Policy", "no-referrer");
}

/** 404 identique dans tous les cas : jeton invalide ou expiré, document inconnu, version lisible indisponible. */
const readableNotFound = (reply: FastifyReply) => readableHeaders(reply).code(404).send({ error: "Document introuvable" });

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
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes", keyGenerator: byIpBlock } } },
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
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes", keyGenerator: byIpBlock } } },
    async (request, reply) => {
      const startedAt = Date.now();
      const parsed = verifySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Code à 6 chiffres attendu." });

      const client = await findClientByEmail(parsed.data.email);
      const check: CodeCheck = client
        ? await checkPortalCode(client.id, "LOGIN", parsed.data.code)
        : "invalid";
      if (!client || check !== "ok") {
        // Même durée minimale pour tout refus : le temps de réponse ne dit pas si l'adresse est celle d'un client.
        const wait = VERIFY_FAILURE_FLOOR_MS - (Date.now() - startedAt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
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
      const session = await resolvePortalSession(request);
      if (!session) return reply.code(401).send(SESSION_EXPIRED);
      const client = session.client;

      const settings = await getCompanySettings();
      const showAmounts = settings.publicTrackingShowAmounts;
      // Pastilles « non vu » (contrat du 19/10/2026) : dernière ouverture de chaque rubrique.
      const seen = await loadPortalSeen(client.id);

      const documents = await prisma.invoice.findMany({
        where: {
          clientId: client.id,
          status: { not: InvoiceStatus.DRAFT },
          // Devis retiré par Kouzia avant signature (28/10/2026) : masqué, ce n'est ni un refus ni une offre en cours.
          OR: [{ quoteStatus: null }, { quoteStatus: { not: QuoteStatus.WITHDRAWN } }],
        },
        orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
        include: {
          promoCode: { select: { code: true, conditionText: true } },
          options: { orderBy: { position: "asc" }, include: { promoCode: { select: { code: true, conditionText: true } } } },
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
              id: true,
              optionId: true,
              // Option au choix du client (28/10/2026) : à part des abonnements engagés (optionalLines).
              isOptional: true,
              optionalAccepted: true,
              description: true,
              billingInterval: true,
              unitPriceCents: true,
              subscriptionStart: true,
              subscriptionStartDate: true,
              subscriptionFreeMonths: true,
              // Mode récurrent (contrat F5, 24/10/2026) : engagement, jour et 1re facture de l'abonnement créé.
              commitmentMonths: true,
              billingDay: true,
              subscription: { select: { nextInvoiceAt: true, invoices: { orderBy: { issueDate: "asc" }, take: 1, select: { issueDate: true } } } },
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

      const built = buildPaymentHistory({
        docs: documents,
        milestones: allMilestones,
        showAmounts,
        projectByQuote,
      });
      const newPaymentIds = newPaymentEntryIds(documents, allMilestones, seen.payments);
      const history = {
        ...built,
        items: built.items.map((i) => (newPaymentIds.has(i.id) ? { ...i, isNew: true as const } : i)),
      };
      // Ajout du 19/10/2026 (contrat /suivi) : « Reste à régler » avoirs compris, somme des dueCents des factures
      // émises. Seul total dû du contrat (totalDueCents, faux dès deux projets, retiré le 28/10/2026).
      const paymentHistory = showAmounts
        ? {
            ...history,
            totalNetDueCents: documents
              .filter((d) => d.documentType === InvoiceDocumentType.INVOICE && d.status === InvoiceStatus.ISSUED)
              .reduce((sum, d) => sum + (balanceFields(d)?.dueCents ?? 0), 0),
          }
        : history;

      const testimonials = await portalTestimonials(client.id);
      const [projectDates, testimonialDates] = await Promise.all([
        prisma.clientProject.findMany({ where: { clientId: client.id, visibleOnPortal: true }, select: { id: true, updatedAt: true } }),
        prisma.siteReview.findMany({
          where: { clientId: client.id, source: TESTIMONIAL_SOURCE, projectId: { not: null } },
          select: { projectId: true, publishedAt: true, rejectedAt: true },
        }),
      ]);
      const updatedAtOf = new Map(projectDates.map((p) => [p.id, p.updatedAt]));
      const testimonialOf = new Map(testimonialDates.map((t) => [t.projectId!, t]));
      // Projet terminé : état de son témoignage (« none » tant qu'aucun n'a été déposé).
      const projects = portalProjects.map((p) => {
        const updatedAt = updatedAtOf.get(p.id);
        const isNew = Boolean(updatedAt && isNewProject({ updatedAt }, testimonialOf.get(p.id), seen.projects));
        const base = p.status === "DONE" ? { ...p, testimonial: testimonials.get(p.id) ?? { status: "NONE" as const } } : p;
        return isNew ? { ...base, isNew: true as const } : base;
      });

      // Compteurs des pastilles : toujours présents (0 si rien de nouveau).
      const quoteMilestones = documents.filter((d) => d.documentType === InvoiceDocumentType.QUOTE).flatMap((d) => d.milestones);
      const now = new Date();
      const unseen = {
        projects: projects.filter((p) => "isNew" in p).length,
        documents: documents.filter((d) => isNewDocument(d, seen.documents)).length,
        payments:
          newPaymentIds.size +
          quoteMilestones.filter((m) => isNewMilestone(m, seen.payments)).length +
          documents.filter(
            (d) =>
              d.documentType === InvoiceDocumentType.INVOICE &&
              d.status === InvoiceStatus.ISSUED &&
              (balanceFields(d)?.dueCents ?? 0) > 0 &&
              isNewDocument(d, seen.payments),
          ).length +
          subscriptions.filter(
            (s) =>
              settings.moduleStripeEnabled &&
              !s.stripeSubscriptionId &&
              !s.cancellationRequestedAt &&
              !(s.endDate && s.endDate > now) &&
              changedAfter(s.setupLinkSentAt, seen.payments),
          ).length,
      };
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
          // Signable : envoyé et encore valable (audit du 28/10/2026), même règle que la signature (refuseExpired).
          const quoteSignable = quotePending && (!d.validUntil || d.validUntil.getTime() >= Date.now());
          // Montant du devis dans /suivi (fil « Devis envoyé ») : le projet (partie ponctuelle figée) d'un devis mixte,
          // rien pour un devis à propositions non signé (aucun montant commun, audit du 28/10/2026).
          const shownTotalCents =
            d.documentType !== InvoiceDocumentType.QUOTE
              ? d.totalCents
              : d.options.length && !d.selectedOptionId
                ? null
                : d.depositBaseCents != null && d.depositBaseCents > 0
                  ? d.depositBaseCents
                  : d.totalCents;
          const offer = parsePaymentPlanOffer(d.paymentPlanOffer);
          const awaitedStep =
            d.paymentPlan === "THREE" && !d.billingMode ? flaggedStepLabel(d.project?.steps) : null;
          // Facture à régler (ajout du 19/10/2026) : bouton « Payer » si un lien existe, sinon virement, comme le PDF.
          const isInvoice = d.documentType === InvoiceDocumentType.INVOICE;
          const dueNow = isInvoice && d.status === InvoiceStatus.ISSUED ? (balanceFields(d)?.dueCents ?? 0) : 0;
          // Prélèvement en cours (SEPA, environ 6 jours ouvrés) : pas de bouton « Payer », l'état est affiché à la place.
          const processing = dueNow > 0 && d.paymentProcessingAt ? { since: d.paymentProcessingAt.toISOString(), method: d.paymentProcessingMethod ?? "sepa_debit" } : null;
          const payUrl = dueNow > 0 && !processing ? safePayUrl(d.checkoutUrl) : null;
          const proposals = d.documentType === InvoiceDocumentType.QUOTE && d.options.length ? d.options : null;
          /** Mode, abonnement, offre et échéanciers d'un devis ; aussi d'une proposition, construite comme un devis. */
          const quoteBilling = (all: typeof d) => {
            const offer = parsePaymentPlanOffer(all.paymentPlanOffer);
            // Abonnements engagés seulement : une option en attente ou non retenue est décrite dans optionalLines.
            const q = { ...all, lines: all.lines.filter(isCommittedLine) };
            const optional = all.lines.filter((l) => l.isOptional);
            const scope = all.documentType === InvoiceDocumentType.QUOTE ? readScope(all.scopeSnapshot) : null;
            return {
              ...(scope ? { scope } : {}),
              ...(optional.length
                ? {
                    optionalLines: optional.map((l) => {
                      const months = l.commitmentMonths ?? 12;
                      return {
                        id: l.id,
                        label: l.description,
                        interval: normalizeInterval(l.billingInterval),
                        // totalCommitmentCents : l'option seule sur l'engagement ; totalWithOptionCents (ajout du 28/10/2026) :
                        // total du projet sans l'option, plus l'option sur toute la durée d'engagement.
                        ...(showAmounts
                          ? (() => {
                              const commitmentCents = Math.round((l.unitPriceCents * months) / 12);
                              return { amountCents: l.unitPriceCents, totalCommitmentCents: commitmentCents, totalWithOptionCents: all.totalCents + commitmentCents };
                            })()
                          : {}),
                        commitmentMonths: months,
                        startsAt: "DELIVERY" as const,
                        accepted: l.optionalAccepted,
                      };
                    }),
                  }
                : {}),
              // Mode de facturation (contrat F5) : null pour un devis antérieur ; récurrent : l'abonnement du devis.
              ...(q.documentType === InvoiceDocumentType.QUOTE ? { billingMode: parseBillingMode(q.billingMode) } : {}),
              ...(q.documentType === InvoiceDocumentType.QUOTE && recurringOf(q)
                ? {
                    recurring: (() => {
                      const r = recurringOf(q)!;
                      return {
                        period: r.period,
                        ...(showAmounts ? { amountCents: r.amountCents } : {}),
                        commitmentMonths: r.commitmentMonths,
                        periods: r.periods,
                        // Avec remise : total remisé, le même que le PDF (contrat R4).
                        ...(showAmounts && r.periods ? { totalCommitmentCents: r.discount?.totalCommitmentCents ?? r.amountCents * r.periods } : {}),
                        ...(r.discount
                          ? {
                              discount: {
                                kind: r.discount.kind,
                                ...(r.discount.kind === "PERCENT" ? { percentBps: r.discount.value } : showAmounts ? { amountCents: r.discount.value } : {}),
                                months: r.discount.months,
                                periods: r.discount.periods,
                                opening: r.discount.opening,
                                // Code promo (R3) : « Code promo X » comme le PDF ; condition imprimée sur le devis.
                                ...(r.discount.promoCode ? { promoCode: r.discount.promoCode } : {}),
                                ...(r.discount.promoCode && r.discount.condition ? { condition: r.discount.condition } : {}),
                                ...(showAmounts ? { discountedAmountCents: r.discount.discountedAmountCents } : {}),
                              },
                            }
                          : {}),
                        startsAt: r.startsAt,
                        ...(r.startsOn ? { startsOn: r.startsOn } : {}),
                        ...(r.freeMonths ? { freeMonths: r.freeMonths } : {}),
                        billingDay: r.billingDay,
                        ...(r.firstInvoiceOn ? { firstInvoiceOn: r.firstInvoiceOn } : {}),
                      };
                    })(),
                  }
                : {}),
              // Paiement en 2 ou 3 fois : formules proposées (avant signature) et formule retenue.
              ...(q.documentType === InvoiceDocumentType.QUOTE && offer
                ? {
                    paymentPlanOffer: offer,
                    paymentPlan: parsePaymentPlan(q.paymentPlan),
                    // Abonnement du devis : seul (NONE, qémarre à la signature) ou avec une partie ponctuelle
                    // (qémarre à la livraison). L'échéancier ne porte que sur la partie ponctuelle.
                    ...(q.lines.length > 0 && (offer === "NONE" || q.depositBaseCents !== null)
                      ? {
                          subscriptionBilling: {
                            interval: recurringOf(q)?.period ?? (q.lines.some((l) => l.billingInterval === "YEAR") ? "YEAR" : "MONTH"),
                            startsAt: recurringOf(q)?.startsAt ?? (offer === "NONE" ? "SIGNATURE" : "DELIVERY"),
                            // Prélèvement Stripe : la 1re échéance est prélevée à sa mise en place. Sinon, facture.
                            directDebit: settings.moduleStripeEnabled,
                            ...(showAmounts ? { amountCents: q.lines.reduce((s, l) => s + l.unitPriceCents, 0) } : {}),
                          },
                          // Une entrée par ligne q'abonnement, dans l'ordre du devis (contrat KouziaWebsite, README
                          // « Espace client ») : qépart de la facturation et mois offerts comptés depuis ce qépart.
                          subscriptionLines: q.lines.map((l) => ({
                            label: l.description,
                            interval: normalizeInterval(l.billingInterval),
                            ...(showAmounts ? { amountCents: l.unitPriceCents } : {}),
                            // Mode récurrent : le qépart choisi fait foi (pas de projet hors « à la livraison »).
                            ...publicStart(l, recurringOf(q) ? l.subscriptionStart === "DELIVERY" : offer !== "NONE"),
                          })),
                          ...(offer !== "NONE" && showAmounts ? { oneOffTotalCents: depositBaseOf(q) } : {}),
                        }
                      : {}),
                    ...(quotePending && offer !== "NONE"
                      ? {
                          paymentPlans: describePlans(offer, depositBaseOf(q), planSettingsOf(q, settings), parseBillingMode(q.billingMode)).map((p) => ({
                            plan: p.plan,
                            milestones: p.milestones.map(({ amountCents, ...m }) =>
                              showAmounts ? { ...m, amountCents } : m,
                            ),
                          })),
                        }
                      : {}),
                  }
                : {})
            };
          };
          return {
            id: d.id,
            ...(isNewDocument(d, seen.documents) ? { isNew: true as const } : {}),
            number: d.number,
            documentType: d.documentType,
            invoiceType: d.invoiceType,
            status: d.status,
            quoteId: d.quoteId,
            creditedInvoiceId: d.creditedInvoiceId,
            projectId: projectOfDocument(projectByQuote, d),
            linkedDocuments: linkSets[index],
            quoteStatus: d.quoteStatus,
            // Session valide : signature sans code (décision du 19/10/2026). Champ gardé pour la compatibilité du site.
            ...(d.documentType === InvoiceDocumentType.QUOTE && quotePending ? { signCodeRequired: false } : {}),
            quoteDecidedAt: d.quoteDecidedAt,
            quoteSignerName: d.quoteSignerName,
            // Motif d'une commande annulée par Kouzia : interne, jamais envoyé ; seul le refus du client l'est.
            quoteRejectReason: d.quoteStatus === QuoteStatus.REJECTED ? d.quoteRejectReason : null,
            issueDate: d.issueDate,
            validUntil: d.validUntil,
            dueDate: d.dueDate,
            downloadToken: d.number ? signDocumentToken(d.id) : null,
            // Contrat B (version accessible) : devis rendu à la demande (signé : figé avec son PDF signé, masqué si indisponible),
            // facture et avoir figés avec leur PDF archivé.
            ...(readableLinkAvailable(d)
              ? { readableAvailable: true as const }
              : {}),
            ...(isInvoice ? { milestoneId: d.milestoneId } : {}),
            ...(payUrl
              ? { checkoutUrl: payUrl, ...(payUrl.includes("/api/public/pay/") ? { paymentMethodHint: primaryMethod(dueNow, settings) } : {}) }
              : {}),
            ...(processing ? { paymentProcessing: processing } : {}),
            ...(dueNow > 0 && settings.bankIban && d.number
              ? {
                  bankTransfer: {
                    reference: d.number,
                    iban: formatIban(settings.bankIban),
                    bic: settings.bankBic ?? null,
                    accountHolder: settings.bankAccountHolder ?? null,
                  },
                }
              : {}),
            ...(showAmounts
              ? {
                  ...(shownTotalCents !== null
                    ? { totalCents: shownTotalCents, subtotalCents: d.subtotalCents, remainingCents: shownTotalCents - paid }
                    : {}),
                  paidCents: paid,
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
                    ...(isNewMilestone(m, seen.payments) ? { isNew: true as const } : {}),
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
                    // Prélèvement en cours (ajout du 20/10/2026) : pas de lien, pour éviter un second paiement.
                    ...(m.paymentProcessingAt && m.status !== "PAID" && m.status !== "CANCELLED"
                      ? { paymentProcessing: { since: m.paymentProcessingAt.toISOString(), method: m.paymentProcessingMethod ?? "sepa_debit" } }
                      : {}),
                    checkoutUrl:
                      m.checkoutUrl &&
                      !m.paymentProcessingAt &&
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
            // Devis à propositions (contrat P4) : avant signature, rien de facturable au niveau du devis (son total est celui
            // de la proposition la moins chère) ; après, la proposition retenue, recopiée, et ses seules lignes.
            ...(d.documentType === InvoiceDocumentType.QUOTE
              ? proposals && !d.selectedOptionId
                ? { billingMode: null, totalIsCheapestOption: true as const }
                : quoteBilling(proposals ? { ...d, lines: d.lines.filter((l) => !l.optionId || l.optionId === d.selectedOptionId) } : d)
              : {}),
            ...(proposals
              ? {
                  selectedOptionId: d.selectedOptionId,
                  options: proposals.map((o) => ({
                    id: o.id,
                    position: o.position,
                    letter: proposalLetter(o),
                    label: o.label,
                    ...quoteBilling({
                      ...d,
                      ...quoteFieldsOfOption(o),
                      paymentPlanOffer: o.paymentPlanOffer,
                      promoCode: o.promoCode,
                      scopeSnapshot: o.scopeSnapshot,
                      paymentPlan: d.selectedOptionId === o.id ? d.paymentPlan : null,
                      lines: d.lines.filter((l) => l.optionId === o.id),
                    }),
                    ...(showAmounts ? { totalCents: o.totalCents, subtotalCents: o.subtotalCents } : {}),
                  })),
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
            canAcceptQuote: quoteSignable,
            canRejectQuote: quotePending,
          };
        }),
        paymentHistory,
        unseen,
        subscriptions: subscriptions.map((s) => ({
          label: s.label,
          billingDay: s.billingDay,
          billingInterval: normalizeInterval(s.billingInterval),
          // Contrat F5 : durée d'engagement (null = sans engagement).
          commitmentMonths: s.commitmentMonths ?? null,
          nextInvoiceAt: s.nextInvoiceAt,
          ...(showAmounts ? { amountCents: s.amountCents } : {}),
          // Remise (contrat R4) : tant qu'il reste des échéances remisées ; nextAmountCents = prochaine échéance, remise déduite.
          ...(s.discountKind && s.discountValue && s.discountPeriods && s.discountPeriods > s.discountPeriodsBilled
            ? {
                discount: {
                  kind: s.discountKind,
                  ...(s.discountKind === "PERCENT" ? { percentBps: s.discountValue } : showAmounts ? { amountCents: s.discountValue } : {}),
                  remainingPeriods: s.discountPeriods - s.discountPeriodsBilled,
                  ...(showAmounts ? { nextAmountCents: nextPeriodAmountCents(s) } : {}),
                },
              }
            : {}),
          // Moyen enregistré dans Stripe (ajout du 19/10/2026) : type et 4 derniers chiffres seulement.
          ...(s.paymentMethodType ? { paymentMethod: { type: s.paymentMethodType, last4: s.paymentMethodLast4 ?? null } } : {}),
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
      // Abonnement engagé : portail sans résiliation (createSubscriptionPortalUrl), la non-reconduction se demande ici.
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

  // Pastilles « non vu » : rubrique ouverte par le client, ses éléments ne sont plus nouveaux. Idempotent.
  app.post(
    "/api/public/seen",
    { config: { rateLimit: { max: 60, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const client = await resolvePortalClient(request);
      if (!client) return reply.code(401).send(SESSION_EXPIRED);
      const parsed = seenSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ code: "unknown_section", error: "Rubrique inconnue." });
      await markPortalSeen(client.id, parsed.data.section);
      return reply.code(204).send();
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
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes", keyGenerator: byIpBlock } } },
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
          keyGenerator: byIpBlock,
        },
      },
    },
    async (request, reply) => {
      const parsed = quoteDecisionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides" });
      }
      const session = await resolvePortalSession(request);
      if (!session) return reply.code(401).send(SESSION_EXPIRED);
      const client = session.client;

      const quote = await prisma.invoice.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          clientId: true,
          paymentPlanOffer: true,
          options: { select: { id: true, paymentPlanOffer: true } },
          lines: { where: { isOptional: true }, select: { id: true, optionId: true } },
        },
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
        // Devis à propositions : la proposition retenue, de ce devis ; sa formule fait foi.
        const option = quote.options.find((o) => o.id === data.optionId) ?? null;
        if (quote.options.length && !data.optionId) {
          return reply.code(400).send({ error: "Choisissez l'une des propositions du devis.", code: "option_required" });
        }
        if ((quote.options.length && !option) || (!quote.options.length && data.optionId)) {
          return reply.code(400).send({ error: "Cette proposition n'existe pas sur ce devis.", code: "option_invalid" });
        }
        // Option au choix (28/10/2026) : une réponse pour chaque ligne en option de la formule signée, avant le code.
        const optionalIds = quote.lines.filter((l) => (option ? l.optionId === option.id : !l.optionId)).map((l) => l.id);
        const choiceError = optionalChoicesError(optionalIds, data.optionalLines);
        if (choiceError) return reply.code(400).send(OPTIONAL_CHOICE_ERRORS[choiceError]);
        // Formule, CGV et case vérifiées avant le code : un oubli ne consomme pas le code de signature.
        resolveAcceptedPlan(parsePaymentPlanOffer(option ? option.paymentPlanOffer : quote.paymentPlanOffer), data.paymentPlan, { requireChoice: true });
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
        // Code envoyé (ancien site) : vérifié comme avant. Sans code : la session valide suffit, la preuve garde
        // l'heure de connexion (vérification du code de connexion).
        let auth: { method: "SIGN_CODE" | "PORTAL_SESSION"; verifiedAt: Date };
        if (data.code) {
          const check = await checkPortalCode(client.id, "SIGN", data.code, quote.id);
          if (check !== "ok") return reply.code(401).send({ error: CODE_ERRORS[check] });
          auth = { method: "SIGN_CODE", verifiedAt: new Date() };
        } else {
          auth = { method: "PORTAL_SESSION", verifiedAt: session.authenticatedAt };
        }

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
              authMethod: auth.method,
              codeVerifiedAt: auth.verifiedAt,
            },
            paymentPlan: data.paymentPlan,
            optionId: option?.id ?? null,
            optionalLines: data.optionalLines,
            cgvAccepted: settings.cgvPublished && data.acceptCgv === true,
            expressExecution: data.expressExecution === true,
          },
        );
        return { quoteStatus: updated.quoteStatus, ...(await subscriptionSetupUrlOf(quote.id)) };
      } catch (e) {
        if (e instanceof QuoteDecisionError) {
          if (e.code === "OPTIONAL_CHOICE_REQUIRED") return reply.code(400).send(OPTIONAL_CHOICE_ERRORS.REQUIRED);
          if (e.code === "OPTIONAL_CHOICE_INVALID") return reply.code(400).send(OPTIONAL_CHOICE_ERRORS.INVALID);
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

  // Version lisible d'un reçu (contrat B, RGAA 13.3) : JSON figé avec le PDF archivé ; 404 identique sinon.
  app.get<{ Params: { token: string } }>(
    "/api/public/receipts/:token/lisible",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const { verifyReceiptToken } = await import("@/lib/documents/public-token.js");
      const paymentId = verifyReceiptToken(request.params.token);
      if (!paymentId) return readableNotFound(reply);
      const select = { receiptPdfPath: true, receiptReadableSnapshot: true, invoice: { select: { number: true } } } as const;
      let row = await prisma.payment.findUnique({ where: { id: paymentId }, select });
      if (!row?.invoice?.number) return readableNotFound(reply);
      if (!row.receiptPdfPath) {
        // Reçu jamais archivé : archivé maintenant, sa version lisible avec.
        const { paymentReceiptPdf } = await import("@/lib/pdf/receipt-archive.js");
        await paymentReceiptPdf(paymentId);
        row = await prisma.payment.findUnique({ where: { id: paymentId }, select });
      }
      const doc = parseReadable(row?.receiptReadableSnapshot);
      return doc ? readableHeaders(reply).send(doc) : readableNotFound(reply);
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

      const doc = await loadPublicDocument(invoiceId);
      if (!doc) {
        return reply.code(404).send({ error: "Document introuvable" });
      }
      const invoice = doc.invoice;
      // Facture ou avoir émis : PDF archivé, servi tel quel.
      const { issuedDocumentPdf } = await import("@/lib/pdf/issued-archive.js");
      const archived = await issuedDocumentPdf(invoice.id);
      if (archived) {
        return reply
          .header("Content-Type", "application/pdf")
          .header("Content-Disposition", `inline; filename="${invoice.number}.pdf"`)
          .send(archived);
      }
      const signed = await signedQuotePdf(invoice);
      if (signed) {
        return reply
          .header("Content-Type", "application/pdf")
          .header("Content-Disposition", `inline; filename="${invoice.number}.pdf"`)
          .send(signed);
      }

      const buffer = await renderInvoicePdf(await liveDocumentPdfData(doc));

      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `inline; filename="${invoice.number}.pdf"`)
        .send(buffer);
    },
  );

  // Version lisible d'un devis, d'une facture ou d'un avoir (contrat B, RGAA 13.3) ; 404 identique sinon.
  app.get<{ Params: { token: string } }>(
    "/api/public/documents/:token/lisible",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const invoiceId = verifyDocumentToken(request.params.token);
      const doc = invoiceId ? await loadPublicDocument(invoiceId) : null;
      if (!doc) return readableNotFound(reply);
      const invoice = doc.invoice;
      const { isArchivableDocument, issuedDocumentPdf } = await import("@/lib/pdf/issued-archive.js");
      // Devis non signé : version lisible rendue à la demande (source LIVE, convenu avec le site le 27/10/2026), même
      // si son PDF est figé à l'émission.
      if (!isArchivableDocument(invoice)) {
        // Devis signé : version lisible figée au 1er accès, seulement si son texte est celui du PDF signé archivé.
        const signed = await signedQuotePdf(invoice);
        if (signed) {
          let frozen = invoice.readableSnapshot;
          if (!frozen) {
            frozen = (await snapshotFor(signed, readableInvoice(await liveDocumentPdfData(doc), "ARCHIVE"))).snapshot;
            await prisma.invoice.updateMany({ where: { id: invoice.id, readableSnapshot: null }, data: { readableSnapshot: frozen } });
          }
          const readable = parseReadable(frozen);
          return readable ? readableHeaders(reply).send(readable) : readableNotFound(reply);
        }
        // Devis : rendu à la demande, depuis les mêmes données que son PDF.
        return readableHeaders(reply).send(readableInvoice(await liveDocumentPdfData(doc), "LIVE").doc);
      }
      let snapshot = invoice.readableSnapshot;
      if (!invoice.pdfPath) {
        // Facture ou avoir jamais archivé : archivé maintenant, sa version lisible avec.
        await issuedDocumentPdf(invoice.id);
        snapshot = (await prisma.invoice.findUnique({ where: { id: invoice.id }, select: { readableSnapshot: true } }))?.readableSnapshot ?? null;
      }
      const readable = parseReadable(snapshot);
      return readable ? readableHeaders(reply).send(readable) : readableNotFound(reply);
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
        // code "validation" (ajout du 19/10/2026) : erreurs rattachées aux champs dans error.fieldErrors.
        return reply.code(400).send({ error: parsed.error.flatten(), code: "validation" });
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
      // Kouzia ne travaille qu'avec des professionnels et des associations (décision du 27/10/2026) : un particulier
      // est refusé avant tout enregistrement. Les clients particuliers déjà en base restent tels quels.
      if (parsed.data.type === "B2C") {
        request.log.info({ event: "public_client_submit", status: 422, ipTrunc: truncateIp(request.ip), reason: "particulier" });
        return reply.code(422).send({
          error: "Kouzia travaille uniquement avec les professionnels et les associations : ce formulaire n'accepte pas les particuliers.",
          code: "particulier_refuse",
        });
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
    // Lien de paiement, de mandat ou de gestion (décision du 19/10/2026) : redirection 303 immédiate vers Stripe, sans
    // page. La session est créée de façon idempotente sur la journée (lib/stripe/idempotency.ts) : un lien ouvert par
    // une analyse de messagerie ne crée pas de session de plus. Page affichée seulement en cas d'erreur ; le POST
    // (anciens e-mails, page déjà ouverte) fait la même chose.
    const openLink = async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
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
    };

    app.get<{ Params: { token: string } }>(
      path,
      { config: { rateLimit: { max: 60, timeWindow: "15 minutes" } } },
      openLink,
    );

    app.post<{ Params: { token: string } }>(
      path,
      { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
      openLink,
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
