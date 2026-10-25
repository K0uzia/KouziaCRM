import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { assertIssueDateAllowed, IssueDateError } from "@/lib/invoices/numberingService.js";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  PaymentMethod,
  QuoteStatus,
} from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { computeLineTotals, assertSubscriptionLinesValid } from "@/lib/invoices/totals.js";
import { BILLING_MODES, parseBillingMode, type PaymentPlanOffer } from "@/lib/quotes/payment-plans.js";
import { assertBillingModeLines } from "@/lib/quotes/billing-mode.js";
import { NO_RECURRING_DISCOUNT, resolveRecurringDiscount, storedRecurringDiscount, type RecurringDiscountFields } from "@/lib/quotes/recurring-discount.js";
import { promoAsDiscountInput, resolvePromoForQuote } from "@/lib/quotes/promo-codes.js";
import { eurosToCents, formatEUR } from "@/lib/money.js";
import {
  issueInvoice,
  issueQuote,
  convertQuoteToInvoice,
  cancelInvoiceWithCreditNote,
  assessCreditNoteEligibility,
  createCreditNote,
  CreditNoteError,
  DocumentFlowError,
  assertQuoteEditable,
  syncMilestoneOnInvoicePaid,
  rejectQuote,
  QuoteDecisionError,
} from "@/lib/invoices/transitions.js";
import { CreditNoteReason, RefundMethod } from "@prisma/client";
import { getCompanySettings } from "@/lib/company.js";
import { loadDocumentForPdf, renderLoadedDocumentPdf } from "@/lib/pdf/document-pdf.js";
import { decryptOptional } from "@/lib/crypto.js";
import type { ClientSnapshot } from "@/lib/invoices/transitions.js";
import { serializeInvoice } from "@/lib/invoices/serialize.js";
import { invoiceListSummary } from "@/lib/invoices/list-summary.js";
import { adminBalanceFields, BALANCE_INCLUDE, invoiceBalance, overpaidCents } from "@/lib/invoices/balance.js";
import { applySettledStatus, lockInvoice } from "@/lib/invoices/balance-status.js";
import { WorkflowError } from "@/lib/invoices/workflow.js";
import {
  applyPaymentLinkChoice,
  assertQuoteLinkable,
  setInvoicePaymentLink,
} from "@/lib/invoices/payment-link.js";
import { serializeClient } from "@/lib/clients.js";
import { ensureQuoteMilestones } from "@/lib/quotes/milestones.js";
import {
  listPendingReminders,
  markReminderSent,
  scheduleReminders,
} from "@/lib/reminders.js";
import { sendDueReminders, sendDueDepositReminders } from "@/lib/reminders/send.js";
import { processEmailOutbox } from "@/lib/email/mailer/index.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { sendDocumentPdf } from "@/lib/email/send-document-pdf.js";
import { brandFromSettings } from "@/lib/email/templates.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { renderEmailTextFooter } from "@/lib/email/layout.js";
import { signDocumentToken } from "@/lib/documents/public-token.js";
import { subscriptionDateNoticeOf } from "@/lib/company/legal-clauses.js";
import { FREE_MONTHS_MAX, SUBSCRIPTION_STARTS } from "@/lib/subscriptions/start.js";
import { offlineConflicts, offlineQuoteFields, offlineReviewReason } from "@/lib/invoices/offline-review.js";
import { renderCreditNotePreviewPdf, renderDraftPreviewPdf } from "@/lib/pdf/draft-preview.js";

const lineSchema = z.object({
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPriceEuros: z.coerce.number(),
  isSubscription: z.boolean().optional().default(false),
  billingDay: z.coerce.number().int().min(1).max(28).optional().nullable(),
  billingInterval: z.enum(["MONTH", "QUARTER", "YEAR"]).optional().nullable(),
  serviceId: z.string().optional().nullable(),
  // Départ de la facturation d'une ligne d'abonnement de devis (lib/subscriptions/start.ts).
  subscriptionStart: z.enum(SUBSCRIPTION_STARTS).optional().nullable(),
  subscriptionStartDate: z.iso.date().optional().nullable(),
  subscriptionFreeMonths: z.coerce.number().int().min(1).max(FREE_MONTHS_MAX).optional().nullable(),
  /** Abonnement : durée d'engagement en mois (offre tout compris) ; absent ou null = sans engagement. */
  commitmentMonths: z.union([z.literal(12), z.literal(24), z.literal(36)]).optional().nullable(),
  /** Pack : titre sous lequel la ligne est groupée, et ligne de remise du pack (montant négatif ou nul). */
  groupTitle: z.string().trim().max(200).optional().nullable(),
  isPackDiscount: z.boolean().optional().default(false),
}).superRefine((l, ctx) => {
  if (l.isPackDiscount && (l.isSubscription || l.unitPriceEuros > 0)) {
    ctx.addIssue({ code: "custom", path: ["unitPriceEuros"], message: "La remise d'un pack est un montant négatif, hors abonnement" });
  }
  if (l.subscriptionStart === "DATE" && !l.subscriptionStartDate) {
    ctx.addIssue({ code: "custom", path: ["subscriptionStartDate"], message: "Date de la 1re facture requise" });
  }
  if (l.subscriptionStart === "FREE_MONTHS" && !l.subscriptionFreeMonths) {
    ctx.addIssue({ code: "custom", path: ["subscriptionFreeMonths"], message: "Nombre de mois offerts requis" });
  }
});

/** Champs de départ d'une ligne saisie : date du champ à minuit, heure locale. */
const lineStartFields = (l: z.output<typeof lineSchema>) => ({
  subscriptionStart: l.subscriptionStart ?? null,
  subscriptionStartDate: l.subscriptionStartDate ? new Date(`${l.subscriptionStartDate}T00:00:00`) : null,
  subscriptionFreeMonths: l.subscriptionFreeMonths ?? null,
  commitmentMonths: l.isSubscription ? (l.commitmentMonths ?? null) : null,
});

/** Lignes saisies : centimes et champs de départ, telles qu'enregistrées à la création. */
const lineInputsOf = (lines: z.output<typeof lineSchema>[]) =>
  lines.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unitPriceCents: eurosToCents(l.unitPriceEuros),
    isSubscription: l.isSubscription,
    billingDay: l.billingDay,
    billingInterval: l.billingInterval,
    serviceId: l.serviceId,
    groupTitle: l.groupTitle ?? null,
    isPackDiscount: l.isPackDiscount,
    ...lineStartFields(l),
  }));

/** Devis récurrent (R1) : remise sur les premières échéances ; months absent ou null = toute la durée de l'engagement. */
const recurringDiscountSchema = z
  .object({
    kind: z.enum(["PERCENT", "FIXED"]),
    percent: z.coerce.number().min(0).max(100).optional(),
    euros: z.coerce.number().min(0).optional(),
    months: z.number().int().positive().max(36).nullable().optional(),
  })
  .nullable()
  .optional();

/** Devis à propositions (P1) : chaque proposition est complète (mode, offre de paiement, remise, lignes). */
export const MAX_QUOTE_OPTIONS = 2;
const optionSchema = z.object({
  label: z.string().trim().min(1).max(120),
  billingMode: z.enum(BILLING_MODES),
  lines: z.array(lineSchema).min(1),
  paymentPlanOffer: z.enum(["ONE", "TWO", "THREE", "CHOICE"]).optional(),
  discountType: z.enum(["NONE", "PERCENT", "FIXED"]).optional().default("NONE"),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  discountEuros: z.coerce.number().min(0).optional(),
  recurringDiscount: recurringDiscountSchema,
  openingDiscount: z.boolean().optional(),
  promoCode: z.string().trim().max(32).nullable().optional(),
});
const optionsSchema = z.array(optionSchema).length(MAX_QUOTE_OPTIONS);

const createSchema = z.object({
  clientId: z.string().min(1),
  documentType: z.enum(["INVOICE", "QUOTE"]).default("INVOICE"),
  notes: z.string().optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  serviceDate: z.string().optional().nullable(),
  purchaseOrderRef: z.string().max(80).optional().nullable(),
  validUntil: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1).optional(),
  /** Facture libre rattachée à un devis signé du même client (facultatif). */
  sourceQuoteId: z.string().min(1).optional().nullable(),
  discountType: z.enum(["NONE", "PERCENT", "FIXED"]).optional().default("NONE"),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  discountEuros: z.coerce.number().min(0).optional(),
  /** Devis : paiement en 2 fois, en 3 fois ou au choix du client (défaut : réglages). */
  paymentPlanOffer: z.enum(["ONE", "TWO", "THREE", "CHOICE"]).optional(),
  /** Devis : mode de facturation de tout le document (null = règles par ligne, devis antérieurs). */
  billingMode: z.enum(BILLING_MODES).optional().nullable(),
  recurringDiscount: recurringDiscountSchema,
  openingDiscount: z.boolean().optional(),
  /** Devis récurrent : code promo (R3), exclusif des deux autres remises ; null le retire. */
  promoCode: z.string().trim().max(32).nullable().optional(),
  /** Devis à 2 propositions : à la place des lignes et des réglages de facturation du devis. */
  options: optionsSchema.optional(),
  ...offlineQuoteFields,
}).superRefine((d, ctx) => {
  if (d.options && d.documentType !== "QUOTE") ctx.addIssue({ code: "custom", path: ["options"], message: "Propositions : réservées au devis" });
  if (d.options && d.lines) ctx.addIssue({ code: "custom", path: ["lines"], message: "Devis à propositions : les lignes vont dans chaque proposition" });
  if (!d.options && !d.lines) ctx.addIssue({ code: "custom", path: ["lines"], message: "Lignes requises" });
});

/** Aperçu d'un avoir : les champs de POST /api/invoices/:id/credit-note, avec la facture d'origine. */
const creditNotePreviewSchema = z.object({
  documentType: z.literal("CREDIT_NOTE"),
  invoiceId: z.string().min(1),
  amountEuros: z.coerce.number().positive(),
  reason: z.nativeEnum(CreditNoteReason),
  reasonDetail: z.string().max(2000).optional().nullable(),
  refundMethod: z.nativeEnum(RefundMethod),
  issueDate: z.iso.date().optional(),
});

const updateSchema = z.object({
  clientId: z.string().min(1).optional(),
  notes: z.string().optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  serviceDate: z.string().optional().nullable(),
  purchaseOrderRef: z.string().max(80).optional().nullable(),
  validUntil: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1).optional(),
  sourceQuoteId: z.string().min(1).optional().nullable(),
  discountType: z.enum(["NONE", "PERCENT", "FIXED"]).optional(),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  discountEuros: z.coerce.number().min(0).optional(),
  paymentPlanOffer: z.enum(["ONE", "TWO", "THREE", "CHOICE"]).optional(),
  /** Devis : mode de facturation de tout le document (null = règles par ligne, devis antérieurs). */
  billingMode: z.enum(BILLING_MODES).optional().nullable(),
  recurringDiscount: recurringDiscountSchema,
  openingDiscount: z.boolean().optional(),
  /** Devis récurrent : code promo (R3), exclusif des deux autres remises ; null le retire. */
  promoCode: z.string().trim().max(32).nullable().optional(),
  /** Devis à 2 propositions : remplace les propositions ; null revient au devis simple (lignes requises). */
  options: optionsSchema.nullable().optional(),
}).superRefine((d, ctx) => {
  if (d.options && d.lines) ctx.addIssue({ code: "custom", path: ["lines"], message: "Devis à propositions : les lignes vont dans chaque proposition" });
  if (d.options === null && !d.lines) ctx.addIssue({ code: "custom", path: ["lines"], message: "Lignes requises pour revenir à une seule proposition" });
});

function discountFromBody(data: {
  discountType?: "NONE" | "PERCENT" | "FIXED";
  discountPercent?: number;
  discountEuros?: number;
}): { discountType: "NONE" | "PERCENT" | "FIXED"; discountValue: number } {
  const type = data.discountType ?? "NONE";
  if (type === "PERCENT") {
    const pct = data.discountPercent ?? 0;
    return { discountType: "PERCENT", discountValue: Math.round(pct * 100) };
  }
  if (type === "FIXED") {
    return {
      discountType: "FIXED",
      discountValue: eurosToCents(data.discountEuros ?? 0),
    };
  }
  return { discountType: "NONE", discountValue: 0 };
}

/**
 * Propositions d'un devis, vérifiées comme un devis simple (lignes, mode, code promo, remise) et totalisées.
 * BillingModeError ou Error avec un message pour l'écran.
 */
async function prepareQuoteOptions(options: z.output<typeof optionsSchema>, quote: { id?: string; clientId: string }) {
  const defaultOffer = (await getCompanySettings()).paymentChoiceDefault ? "CHOICE" : "TWO";
  const prepared = [];
  for (const [position, o] of options.entries()) {
    const lineInputs = lineInputsOf(o.lines);
    assertSubscriptionLinesValid(lineInputs);
    assertBillingModeLines(o.billingMode, lineInputs);
    const promo = o.billingMode === "RECURRING" ? await resolvePromoForQuote(o, { ...quote, lines: lineInputs }, null) : null;
    const recurringDiscount = resolveRecurringDiscount(o.billingMode, lineInputs, promo ? { recurringDiscount: promoAsDiscountInput(promo) } : o);
    const totals = computeLineTotals(lineInputs, discountFromBody(o));
    prepared.push({
      option: {
        position,
        label: o.label,
        billingMode: o.billingMode,
        paymentPlanOffer: o.billingMode === "RECURRING" ? "NONE" : (o.paymentPlanOffer ?? defaultOffer),
        discountType: totals.discountType,
        discountValue: totals.discountValue,
        ...recurringDiscount,
        promoCodeId: promo?.id ?? null,
        subtotalCents: totals.subtotalCents,
        totalCents: totals.totalCents,
      },
      lines: totals.lines,
      // Aperçu : totaux complets, remise et code tels que vérifiés.
      totals,
      recurringDiscount,
      promo,
    });
  }
  return prepared;
}

/**
 * Champs du devis lui-même quand il a des propositions : facturation neutre (recopiée de la proposition retenue à la
 * signature) et totaux de la moins chère, comptés dans les listes et le tableau de bord (décision du 25/10/2026).
 */
function quoteFieldsOfOptions(prepared: Awaited<ReturnType<typeof prepareQuoteOptions>>) {
  const cheapest = prepared.reduce((min, p) => (p.option.totalCents < min.option.totalCents ? p : min));
  return {
    billingMode: null,
    paymentPlanOffer: null,
    discountType: "NONE",
    discountValue: 0,
    ...NO_RECURRING_DISCOUNT,
    promoCodeId: null,
    subtotalCents: cheapest.option.subtotalCents,
    totalCents: cheapest.option.totalCents,
  };
}

type OptionsTx = Pick<typeof prisma, "quoteOption" | "invoiceLine">;

/** Remplace les propositions et toutes les lignes du devis ; lignes numérotées à la suite, A puis B. */
async function writeQuoteOptions(tx: OptionsTx, quoteId: string, prepared: Awaited<ReturnType<typeof prepareQuoteOptions>>) {
  await tx.quoteOption.deleteMany({ where: { quoteId } });
  await tx.invoiceLine.deleteMany({ where: { invoiceId: quoteId } });
  let position = 0;
  for (const p of prepared) {
    const option = await tx.quoteOption.create({ data: { ...p.option, quoteId } });
    await tx.invoiceLine.createMany({ data: p.lines.map((l) => ({ ...l, position: ++position, invoiceId: quoteId, optionId: option.id })) });
  }
}

/** Propositions renvoyées avec un devis : dans l'ordre, avec le code promo lisible. */
const OPTIONS_INCLUDE = { orderBy: { position: "asc" }, include: { promoCode: { select: { code: true } } } } as const;

/** Date saisie (« 2026-10-25 » ou ISO complète) : refusée si illisible, au lieu d'une Invalid Date en base. */
const dateString = z.string().trim().min(1).refine((s) => !Number.isNaN(new Date(s).getTime()), { message: "Date invalide." });

const issueBodySchema = z.object({
  issueDate: dateString.optional(),
  dueDate: dateString.optional(),
  validUntil: dateString.optional(),
  email: z.object({ send: z.boolean().optional(), subject: z.string().max(300).optional(), body: z.string().max(20_000).optional() }).optional(),
  payment: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("none") }),
      z.object({ mode: z.literal("manual"), url: z.string().max(2048) }),
      z.object({ mode: z.literal("auto") }),
    ])
    .optional(),
});

/** Avoir daté à la main : pas avant la facture créditée, ni avant le dernier avoir, ni dans le futur. null si valable. */
async function creditNoteDateError(invoiceId: string, issueDate: Date): Promise<string | null> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { issueDate: true } });
  try {
    await assertIssueDateAllowed(InvoiceDocumentType.CREDIT_NOTE, issueDate, {
      ...(invoice?.issueDate ? { notBefore: { date: invoice.issueDate, label: "de la facture créditée" } } : {}),
    });
    return null;
  } catch (e) {
    if (e instanceof IssueDateError) return e.message;
    throw e;
  }
}

/** Montant saisi en euros : au moins un centime une fois arrondi (0,001 € donnait un règlement de 0). */
const centsAmount = z.coerce.number().positive().refine((v) => eurosToCents(v) >= 1, { message: "Montant minimal : 0,01 €." });

const paySchema = z.object({
  amountEuros: centsAmount,
  paidAt: dateString.optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  /** E-mail au client : reçu du règlement et facture (telle qu'émise). Par défaut : oui. */
  notifyClient: z.boolean().optional(),
});

const refundSchema = z.object({
  amountEuros: centsAmount,
  paidAt: z.iso.date().optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
  reference: z.string().max(200).optional().nullable(),
});

function defaultQuoteValidUntil(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d;
}

/** Paramètres de la liste ; un paramètre répété (?clientId=a&clientId=b) arrive en tableau et répond 400. */
const LIST_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const LIST_INT = z.string().regex(/^\d{1,6}$/).transform(Number);
const listQuerySchema = z.strictObject({
  type: z.enum(["QUOTE", "INVOICE", "ALL"]).optional(),
  market: LIST_ID.optional(),
  clientId: LIST_ID.optional(),
  page: LIST_INT.optional(),
  pageSize: LIST_INT.optional(),
});
/** Plafond de sécurité d'une liste complète ; au-delà, la réponse le signale (X-Liste-Tronquee, X-Total-Count). */
export const INVOICE_LIST_CAP = 5_000;

/** Montant d'un paiement au-delà du reste dû relu dans la transaction (avoir ou paiement concurrent). */
class PaymentAmountError extends Error {
  constructor(public dueCents: number) {
    super("Montant supérieur au reste dû");
  }
}

/** Objet et texte relus dans « Vérifier l'e-mail » (envois sur clic). Absents : texte de l'ERP. */
const emailEditsSchema = z.object({ subject: z.string().trim().max(300).optional(), text: z.string().trim().max(20000).optional() });

export const invoicesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/invoices", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsedQuery = listQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) return reply.code(400).send({ error: "Paramètres de liste invalides" });
    const q = parsedQuery.data;
    const where: Record<string, unknown> =
      q.type === "QUOTE"
        ? { documentType: InvoiceDocumentType.QUOTE }
        : q.type === "ALL"
          ? {}
          : {
              documentType: {
                in: [InvoiceDocumentType.INVOICE, InvoiceDocumentType.CREDIT_NOTE],
              },
            };
    if (q.market) {
      where.quoteId = q.market;
    }
    if (q.clientId) {
      where.clientId = q.clientId;
    }

    // Liste complète par défaut : les listes, leurs filtres et la copie hors ligne portent sur toutes les pièces.
    // Pagination seulement sur demande (page ou pageSize), 100 au plus par page.
    const paged = q.page !== undefined || q.pageSize !== undefined;
    const page = Math.max(1, q.page || 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize || 50));

    const rows = await prisma.invoice.findMany({
      where,
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      ...(paged ? { skip: (page - 1) * pageSize, take: pageSize } : { take: INVOICE_LIST_CAP + 1 }),
      include: {
        client: { select: { id: true, displayName: true, clientNumber: true } },
        payments: { select: { id: true, amountCents: true, paidAt: true, method: true } },
        quote: { select: { id: true, number: true } },
        creditNotes: { select: { totalCents: true, payments: { select: { amountCents: true } } } },
        // Devis à propositions : montant de la moins chère tant qu'aucune n'est retenue (annoncé dans la liste).
        _count: { select: { options: true } },
      },
    });
    // Solde de chaque facture (avoirs compris) : reste dû, net, encaissé net ; les avoirs eux-mêmes ne sont pas renvoyés.
    const withBalance = (list: typeof rows) =>
      list.map(({ creditNotes, ...r }) => ({ ...serializeInvoice(r), balance: adminBalanceFields({ ...r, creditNotes }) }));
    if (!paged && rows.length > INVOICE_LIST_CAP) {
      const total = await prisma.invoice.count({ where });
      request.log.warn({ event: "invoice_list_capped", total, cap: INVOICE_LIST_CAP }, "liste des pièces tronquée");
      reply.header("X-Liste-Tronquee", String(INVOICE_LIST_CAP)).header("X-Total-Count", String(total));
      return withBalance(rows.slice(0, INVOICE_LIST_CAP));
    }
    return withBalance(rows);
  });

  app.post("/api/invoices", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
      }
      const { clientRequestId } = parsed.data;
      const createdInclude = {
        lines: true,
        client: { select: { id: true, displayName: true, clientNumber: true } },
      } as const;
      // Renvoi d'un brouillon préparé hors ligne (réponse perdue, double envoi) : le brouillon déjà créé.
      const replay = async () => {
        const already = clientRequestId
          ? await prisma.invoice.findUnique({ where: { clientRequestId }, include: createdInclude })
          : null;
        if (!already) return null;
        const owner = await prisma.client.findUnique({ where: { id: already.clientId }, select: { updatedAt: true } });
        const conflicts = owner ? await offlineConflicts(owner, parsed.data) : [];
        return reply.code(200).send({ ...serializeInvoice(already), offline: { replayed: true, conflicts } });
      };
      const sent = await replay();
      if (sent) return sent;
      const client = await prisma.client.findUnique({ where: { id: parsed.data.clientId } });
      if (!client) return reply.code(404).send({ error: "Client introuvable", code: "client_not_found" });

      if (parsed.data.options) {
        let prepared: Awaited<ReturnType<typeof prepareQuoteOptions>>;
        try {
          prepared = await prepareQuoteOptions(parsed.data.options, { clientId: parsed.data.clientId });
        } catch (e) {
          return reply.code(400).send({ error: e instanceof Error ? e.message : "Propositions invalides" });
        }
        const conflicts = clientRequestId ? await offlineConflicts(client, parsed.data) : [];
        const created = await prisma
          .$transaction(async (tx) => {
            const quote = await tx.invoice.create({
              data: {
                documentType: InvoiceDocumentType.QUOTE,
                ...quoteFieldsOfOptions(prepared),
                ...(clientRequestId ? { clientRequestId, offlineReviewReason: offlineReviewReason(conflicts) } : {}),
                quoteStatus: QuoteStatus.DRAFT,
                clientId: parsed.data.clientId,
                notes: parsed.data.notes ?? null,
                paymentTerms: parsed.data.paymentTerms ?? "Devis valable 30 jours",
                serviceDate: parsed.data.serviceDate ? new Date(parsed.data.serviceDate) : null,
                purchaseOrderRef: parsed.data.purchaseOrderRef ?? null,
                validUntil: parsed.data.validUntil ? new Date(parsed.data.validUntil) : defaultQuoteValidUntil(),
              },
            });
            await writeQuoteOptions(tx, quote.id, prepared);
            return tx.invoice.findUniqueOrThrow({ where: { id: quote.id }, include: { ...createdInclude, lines: { orderBy: { position: "asc" } }, options: OPTIONS_INCLUDE } });
          })
          .catch((e: unknown) => {
            if ((e as { code?: string }).code === "P2002" && clientRequestId) return null;
            throw e;
          });
        if (!created) return (await replay()) ?? reply.code(409).send({ error: "Brouillon déjà en cours de création" });
        return reply
          .code(201)
          .send(clientRequestId ? { ...serializeInvoice(created), offline: { replayed: false, conflicts } } : serializeInvoice(created));
      }

      const discount = discountFromBody(parsed.data);
      const lineInputs = lineInputsOf(parsed.data.lines!);
      const billingMode = parsed.data.documentType === "QUOTE" ? (parsed.data.billingMode ?? null) : null;
      let recurringDiscount: RecurringDiscountFields;
      let promo: Awaited<ReturnType<typeof resolvePromoForQuote>> = null;
      try {
        assertSubscriptionLinesValid(lineInputs);
        assertBillingModeLines(billingMode, lineInputs);
        promo = billingMode ? await resolvePromoForQuote(parsed.data, { clientId: parsed.data.clientId, lines: lineInputs }, null) : null;
        recurringDiscount = resolveRecurringDiscount(billingMode, lineInputs, promo ? { recurringDiscount: promoAsDiscountInput(promo) } : parsed.data);
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : "Lignes invalides" });
      }
      const { lines, subtotalCents, totalCents, discountType, discountValue } = computeLineTotals(
        lineInputs,
        discount,
      );

      const documentType =
        parsed.data.documentType === "QUOTE"
          ? InvoiceDocumentType.QUOTE
          : InvoiceDocumentType.INVOICE;

      const linkedQuoteId =
        documentType === InvoiceDocumentType.INVOICE ? parsed.data.sourceQuoteId ?? null : null;
      if (linkedQuoteId) {
        try {
          await assertQuoteLinkable(linkedQuoteId, parsed.data.clientId);
        } catch (e) {
          if (e instanceof WorkflowError) return reply.code(e.statusCode).send({ error: e.message });
          throw e;
        }
      }

      const validUntil =
        documentType === InvoiceDocumentType.QUOTE
          ? parsed.data.validUntil
            ? new Date(parsed.data.validUntil)
            : defaultQuoteValidUntil()
          : parsed.data.validUntil
            ? new Date(parsed.data.validUntil)
            : null;

      // Mode récurrent : rien à régler au titre du devis, l'abonnement facture chaque période.
      const paymentPlanOffer =
        documentType !== InvoiceDocumentType.QUOTE
          ? null
          : billingMode === "RECURRING"
            ? "NONE"
            : (parsed.data.paymentPlanOffer ?? ((await getCompanySettings()).paymentChoiceDefault ? "CHOICE" : "TWO"));

      const conflicts = clientRequestId ? await offlineConflicts(client, parsed.data) : [];
      const invoice = await prisma.invoice.create({
        data: {
          documentType,
          paymentPlanOffer,
          billingMode,
          ...(clientRequestId ? { clientRequestId, offlineReviewReason: offlineReviewReason(conflicts) } : {}),
          quoteStatus: documentType === InvoiceDocumentType.QUOTE ? QuoteStatus.DRAFT : null,
          clientId: parsed.data.clientId,
          notes: parsed.data.notes ?? null,
          paymentTerms:
            parsed.data.paymentTerms ??
            (documentType === InvoiceDocumentType.QUOTE
              ? "Devis valable 30 jours"
              : "Paiement à réception"),
          serviceDate: parsed.data.serviceDate ? new Date(parsed.data.serviceDate) : null,
          purchaseOrderRef: parsed.data.purchaseOrderRef ?? null,
          validUntil,
          subtotalCents,
          totalCents,
          discountType,
          discountValue,
          ...(documentType === InvoiceDocumentType.QUOTE ? { ...recurringDiscount, promoCodeId: promo?.id ?? null } : {}),
          ...(linkedQuoteId ? { quoteId: linkedQuoteId, sourceQuoteId: linkedQuoteId } : {}),
          lines: { create: lines },
        },
        include: createdInclude,
      }).catch(async (e: unknown) => {
        // Deux envois simultanés du même brouillon : le premier fait foi.
        if ((e as { code?: string }).code === "P2002" && clientRequestId) return null;
        throw e;
      });
      if (!invoice) return (await replay()) ?? reply.code(409).send({ error: "Brouillon déjà en cours de création" });
      return reply
        .code(201)
        .send(clientRequestId ? { ...serializeInvoice(invoice), offline: { replayed: false, conflicts } } : serializeInvoice(invoice));
    } catch (e) {
      request.log.error({ err: e }, "POST /api/invoices");
      throw e;
    }
  });

  // Aperçu avant création : le brouillon du formulaire (même schéma que la création), rendu par le
  // gabarit réel. Rien n'est enregistré et aucun numéro n'est consommé.
  const pdfReply = (reply: FastifyReply, pdf: Buffer) =>
    reply
      .header("Content-Type", "application/pdf")
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", 'inline; filename="apercu.pdf"')
      .send(pdf);

  app.post("/api/invoices/preview.pdf", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    // Avoir : les champs de l'assistant d'avoir, contrôlés comme à l'émission.
    if ((request.body as { documentType?: unknown } | null)?.documentType === "CREDIT_NOTE") {
      const credit = creditNotePreviewSchema.safeParse(request.body);
      if (!credit.success) {
        return reply.code(400).send({ error: "Données invalides", details: credit.error.flatten() });
      }
      try {
        const pdf = await renderCreditNotePreviewPdf({
          invoiceId: credit.data.invoiceId,
          amountCents: eurosToCents(credit.data.amountEuros),
          reason: credit.data.reason,
          reasonDetail: credit.data.reasonDetail ?? null,
          refundMethod: credit.data.refundMethod,
          issueDate: credit.data.issueDate ? new Date(credit.data.issueDate) : new Date(),
        });
        return pdfReply(reply, pdf);
      } catch (e) {
        if (e instanceof CreditNoteError) {
          return reply.code(e.code === "NOT_FOUND" ? 404 : 400).send({ error: e.message, code: e.code });
        }
        throw e;
      }
    }
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
    }
    if (parsed.data.options) {
      // Devis à propositions : chacune vérifiée comme à l'enregistrement, rendue dans le même gabarit que le devis émis.
      let prepared: Awaited<ReturnType<typeof prepareQuoteOptions>>;
      try {
        prepared = await prepareQuoteOptions(parsed.data.options, { clientId: parsed.data.clientId });
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : "Propositions invalides" });
      }
      const d = parsed.data;
      const pdf = await renderDraftPreviewPdf({
        documentType: "QUOTE",
        clientId: d.clientId,
        notes: d.notes ?? null,
        paymentTerms: d.paymentTerms ?? null,
        serviceDate: null,
        purchaseOrderRef: d.purchaseOrderRef ?? null,
        validUntil: d.validUntil ? new Date(d.validUntil) : null,
        sourceQuoteId: null,
        paymentPlanOffer: null,
        billingMode: null,
        totals: computeLineTotals([], discountFromBody({})),
        options: prepared.map((p) => ({
          label: p.option.label,
          billingMode: p.option.billingMode,
          paymentPlanOffer: p.option.paymentPlanOffer as PaymentPlanOffer,
          totals: p.totals,
          recurringDiscount: p.recurringDiscount,
          promoCode: p.promo ? { id: p.promo.id, code: p.promo.code, conditionText: p.promo.conditionText } : null,
        })),
      });
      if (!pdf) return reply.code(404).send({ error: "Client introuvable" });
      return pdfReply(reply, pdf);
    }
    const lineInputs = lineInputsOf(parsed.data.lines!);
    let recurringDiscount: RecurringDiscountFields;
    let previewPromo: Awaited<ReturnType<typeof resolvePromoForQuote>> = null;
    try {
      assertSubscriptionLinesValid(lineInputs);
      const promo = parsed.data.documentType === "QUOTE" && parsed.data.billingMode ? await resolvePromoForQuote(parsed.data, { clientId: parsed.data.clientId, lines: lineInputs }, null) : null;
      recurringDiscount =
        parsed.data.documentType === "QUOTE"
          ? resolveRecurringDiscount(parsed.data.billingMode ?? null, lineInputs, promo ? { recurringDiscount: promoAsDiscountInput(promo) } : parsed.data)
          : NO_RECURRING_DISCOUNT;
      previewPromo = promo;
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Lignes invalides" });
    }
    const d = parsed.data;
    const pdf = await renderDraftPreviewPdf({
      documentType: d.documentType,
      clientId: d.clientId,
      notes: d.notes ?? null,
      paymentTerms: d.paymentTerms ?? null,
      serviceDate: d.serviceDate ? new Date(d.serviceDate) : null,
      purchaseOrderRef: d.purchaseOrderRef ?? null,
      validUntil: d.validUntil ? new Date(d.validUntil) : null,
      sourceQuoteId: d.documentType === "INVOICE" ? (d.sourceQuoteId ?? null) : null,
      paymentPlanOffer: d.paymentPlanOffer ?? null,
      billingMode: d.documentType === "QUOTE" ? (d.billingMode ?? null) : null,
      totals: computeLineTotals(lineInputs, discountFromBody(d)),
      recurringDiscount,
      promoCode: previewPromo,
    });
    if (!pdf) return reply.code(404).send({ error: "Client introuvable" });
    return pdfReply(reply, pdf);
  });

  // Nombres de la liste des devis ou des factures (statuts, types, à relire, échéance dépassée), sur toute la base.
  app.get("/api/invoices/summary", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = z.object({ type: z.enum(["QUOTE", "INVOICE"]) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Type de document attendu : QUOTE ou INVOICE" });
    return invoiceListSummary(parsed.data.type);
  });

  app.get("/api/invoices/search", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = String((request.query as { q?: string }).q ?? "").trim();
    if (q.length < 1) return [];

    const invoices = await prisma.invoice.findMany({
      where: {
        documentType: "INVOICE",
        payments: { some: {} },
        OR: [
          { number: { contains: q } },
          { client: { displayName: { contains: q } } },
        ],
      },
      include: {
        payments: { select: { amountCents: true } },
        client: { select: { displayName: true } },
      },
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
      take: 12,
    });

    return invoices.map((inv) => ({
      id: inv.id,
      number: inv.number,
      displayName: inv.client.displayName,
      paidCents: inv.payments.reduce((s, p) => s + p.amountCents, 0),
    }));
  });

  app.get("/api/reminders/pending", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const rows = await listPendingReminders();
    return rows.map(serializeInvoice);
  });

  app.post("/api/reminders/run", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const errors: string[] = [];
    let scheduled = 0;
    let enqueued = 0;
    let sent = 0;

    try {
      scheduled = await scheduleReminders();
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Planification impossible");
    }

    try {
      // Clic « Relancer maintenant » : les relances automatiques gardent la validation (aucune n'a été relue).
      enqueued = (await sendDueReminders(new Date(), "ADMIN_ACTION")) + (await sendDueDepositReminders(new Date(), "ADMIN_ACTION"));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Enqueue relances impossible");
    }

    try {
      const result = await processEmailOutbox();
      sent = result.processed;
      if (result.failed > 0) {
        errors.push(`${result.failed} envoi(s) outbox en échec`);
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Traitement outbox impossible");
    }

    return { scheduled, enqueued, sent, errors };
  });

  app.get<{ Params: { id: string } }>("/api/invoices/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const invoice = await prisma.invoice.findUnique({
      where: { id: request.params.id },
      include: {
        lines: { orderBy: { position: "asc" } },
        client: true,
        payments: { orderBy: { paidAt: "desc" } },
        bankTransactions: {
          orderBy: { bookedAt: "desc" },
          select: {
            id: true,
            bookedAt: true,
            amountCents: true,
            counterpartyName: true,
            reference: true,
            status: true,
          },
        },
        creditedInvoice: true,
        creditNotes: { include: { payments: { select: { amountCents: true } } } },
        quote: { select: { id: true, number: true, issueDate: true } },
        promoCode: { select: { code: true } },
        options: OPTIONS_INCLUDE,
        milestones: { orderBy: { position: "asc" } },
      },
    });
    if (!invoice) return reply.code(404).send({ error: "Introuvable" });
    const clientType = (invoice.clientSnapshot as ClientSnapshot | null)?.type ?? invoice.client.type;
    return {
      ...serializeInvoice(invoice),
      balance: adminBalanceFields(invoice),
      client: serializeClient(invoice.client),
      subscriptionDateNotice: await subscriptionDateNoticeOf(invoice, clientType, await getCompanySettings()),
      // Rachat (R1) : abonnement racheté par ce devis ou cette facture, lien affiché sur la fiche.
      buysOutSubscription: invoice.buysOutSubscriptionId
        ? await prisma.subscription.findUnique({ where: { id: invoice.buysOutSubscriptionId }, select: { id: true, label: true } })
        : null,
      bankTransactions: invoice.bankTransactions.map((t) => ({
        ...t,
        bookedAt: t.bookedAt.toISOString(),
      })),
    };
  });

  app.put<{ Params: { id: string } }>("/api/invoices/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const id = request.params.id;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (
      "number" in body ||
      "documentNumber" in body ||
      "sequenceYear" in body ||
      "sequenceNumber" in body
    ) {
      return reply.code(403).send({
        error: "Le numéro de document est immuable après attribution",
      });
    }
    const existing = await prisma.invoice.findUnique({ where: { id }, include: { options: { select: { id: true } } } });
    if (!existing) return reply.code(404).send({ error: "Introuvable" });
    if (existing.status !== InvoiceStatus.DRAFT) {
      return reply.code(400).send({ error: "Seuls les brouillons sont modifiables" });
    }
    if (existing.documentType === InvoiceDocumentType.QUOTE) {
      try {
        await assertQuoteEditable(existing.id);
      } catch (e) {
        if (e instanceof DocumentFlowError) {
          return reply.code(e.statusCode).send({ error: e.message });
        }
        throw e;
      }
    }

    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
    }
    const withOptions = Boolean(parsed.data.options);
    if (withOptions && existing.documentType !== InvoiceDocumentType.QUOTE) {
      return reply.code(400).send({ error: "Propositions : réservées au devis" });
    }
    // Devis à propositions : la facturation se règle dans chaque proposition, pas sur le devis.
    const billingFieldsSent =
      parsed.data.billingMode !== undefined ||
      parsed.data.paymentPlanOffer !== undefined ||
      parsed.data.discountType !== undefined ||
      parsed.data.discountPercent !== undefined ||
      parsed.data.discountEuros !== undefined ||
      parsed.data.recurringDiscount !== undefined ||
      parsed.data.openingDiscount !== undefined ||
      parsed.data.promoCode !== undefined;
    if (billingFieldsSent && (withOptions || (existing.options.length > 0 && !parsed.data.lines))) {
      return reply.code(400).send({ error: "Devis à propositions : mode, paiement et remise se règlent dans chaque proposition." });
    }
    let preparedOptions: Awaited<ReturnType<typeof prepareQuoteOptions>> | null = null;
    if (parsed.data.options) {
      try {
        preparedOptions = await prepareQuoteOptions(parsed.data.options, { id, clientId: parsed.data.clientId ?? existing.clientId });
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : "Propositions invalides" });
      }
    }

    const data: {
      clientId?: string;
      notes?: string | null;
      paymentTerms?: string | null;
      subtotalCents?: number;
      totalCents?: number;
      discountType?: string;
      discountValue?: number;
      validUntil?: Date | null;
      serviceDate?: Date | null;
      purchaseOrderRef?: string | null;
      quoteId?: string | null;
      sourceQuoteId?: string | null;
      paymentPlanOffer?: string;
      billingMode?: string | null;
    } & Partial<RecurringDiscountFields> = {};
    if (parsed.data.paymentPlanOffer && existing.documentType === InvoiceDocumentType.QUOTE && !preparedOptions) {
      data.paymentPlanOffer = parsed.data.paymentPlanOffer;
    }
    // Mode de facturation : vérifié sur les lignes envoyées, sinon sur celles du brouillon.
    const discountInputTouched = parsed.data.recurringDiscount !== undefined || parsed.data.openingDiscount !== undefined || parsed.data.promoCode !== undefined;
    if (existing.documentType === InvoiceDocumentType.QUOTE && !preparedOptions && (parsed.data.billingMode !== undefined || parsed.data.lines || discountInputTouched)) {
      const mode = parsed.data.billingMode !== undefined ? (parsed.data.billingMode ?? null) : parseBillingMode(existing.billingMode);
      const modeLines = parsed.data.lines
        ? lineInputsOf(parsed.data.lines)
        : await prisma.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { position: "asc" } });
      try {
        assertBillingModeLines(mode, modeLines);
        // Remise du devis récurrent : celle envoyée, sinon celle du brouillon, revérifiée sur le mode et les lignes ;
        // passage en paiement unique sans remise envoyée : la remise du brouillon est retirée.
        // Code promo (R3) : celui envoyé, sinon celui du brouillon, revérifié (client, offres, usages) ; il fixe la remise.
        const promo =
          mode === "RECURRING"
            ? await resolvePromoForQuote(parsed.data, { id, clientId: parsed.data.clientId ?? existing.clientId, lines: modeLines }, existing.promoCodeId)
            : null;
        Object.assign(
          data,
          mode !== "RECURRING" && !discountInputTouched
            ? NO_RECURRING_DISCOUNT
            : resolveRecurringDiscount(
                mode,
                modeLines,
                promo
                  ? { recurringDiscount: promoAsDiscountInput(promo) }
                  : {
                      recurringDiscount: parsed.data.recurringDiscount !== undefined ? parsed.data.recurringDiscount : storedRecurringDiscount(existing),
                      openingDiscount: parsed.data.openingDiscount ?? (parsed.data.recurringDiscount ? false : existing.openingDiscount),
                    },
              ),
          { promoCodeId: promo?.id ?? null },
        );
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : "Lignes invalides" });
      }
      if (parsed.data.billingMode !== undefined) data.billingMode = mode;
      if (mode === "RECURRING") data.paymentPlanOffer = "NONE";
    }

    if (
      parsed.data.sourceQuoteId !== undefined &&
      existing.documentType === InvoiceDocumentType.INVOICE &&
      existing.invoiceType === InvoiceType.SIMPLE
    ) {
      const target = parsed.data.sourceQuoteId;
      if (target) {
        try {
          await assertQuoteLinkable(target, parsed.data.clientId ?? existing.clientId, existing.id);
        } catch (e) {
          if (e instanceof WorkflowError) return reply.code(e.statusCode).send({ error: e.message });
          throw e;
        }
      }
      data.quoteId = target;
      data.sourceQuoteId = target;
    }

    if (parsed.data.clientId) data.clientId = parsed.data.clientId;
    if (parsed.data.notes !== undefined) data.notes = parsed.data.notes;
    if (parsed.data.paymentTerms !== undefined) data.paymentTerms = parsed.data.paymentTerms;
    if (parsed.data.serviceDate !== undefined) {
      data.serviceDate = parsed.data.serviceDate ? new Date(parsed.data.serviceDate) : null;
    }
    if (parsed.data.purchaseOrderRef !== undefined) {
      data.purchaseOrderRef = parsed.data.purchaseOrderRef || null;
    }
    if (parsed.data.validUntil !== undefined) {
      data.validUntil = parsed.data.validUntil ? new Date(parsed.data.validUntil) : null;
    }

    const discountTouched =
      parsed.data.discountType !== undefined ||
      parsed.data.discountPercent !== undefined ||
      parsed.data.discountEuros !== undefined;

    if (preparedOptions) {
      const options = preparedOptions;
      await prisma.$transaction(async (tx) => {
        await writeQuoteOptions(tx, id, options);
        await tx.invoice.update({ where: { id }, data: { ...data, ...quoteFieldsOfOptions(options) } });
      });
    } else if (parsed.data.lines || discountTouched) {
      const linesSource = parsed.data.lines
        ? await (async () => {
            const existingLines = await prisma.invoiceLine.findMany({
              where: { invoiceId: id },
              orderBy: { position: "asc" },
            });
            return parsed.data.lines!.map((l, idx) => ({
              description: l.description,
              quantity: l.quantity,
              unitPriceCents: eurosToCents(l.unitPriceEuros),
              isSubscription: l.isSubscription,
              billingDay: l.billingDay,
              billingInterval: l.billingInterval,
              serviceId: l.serviceId,
              subscriptionId:
                existingLines.find((e) => e.position === idx + 1)?.subscriptionId ?? null,
              revisesSubscriptionId:
                existingLines.find((e) => e.position === idx + 1)?.revisesSubscriptionId ?? null,
              groupTitle: l.groupTitle ?? null,
              isPackDiscount: l.isPackDiscount,
              ...lineStartFields(l),
            }));
          })()
        : (
            await prisma.invoiceLine.findMany({
              where: { invoiceId: id },
              orderBy: { position: "asc" },
            })
          ).map((l) => ({
            description: l.description,
            quantity: Number(l.quantity),
            unitPriceCents: l.unitPriceCents,
            position: l.position,
            isSubscription: l.isSubscription,
            billingDay: l.billingDay,
            billingInterval: l.billingInterval,
            serviceId: l.serviceId,
            subscriptionId: l.subscriptionId,
            revisesSubscriptionId: l.revisesSubscriptionId,
            groupTitle: l.groupTitle,
            isPackDiscount: l.isPackDiscount,
            subscriptionStart: l.subscriptionStart,
            subscriptionStartDate: l.subscriptionStartDate,
            subscriptionFreeMonths: l.subscriptionFreeMonths,
            commitmentMonths: l.commitmentMonths,
          }));

      if (parsed.data.lines) {
        try {
          assertSubscriptionLinesValid(linesSource);
        } catch (e) {
          return reply
            .code(400)
            .send({ error: e instanceof Error ? e.message : "Lignes invalides" });
        }
      }

      const discount = discountTouched
        ? discountFromBody({
            discountType: parsed.data.discountType ?? (existing.discountType as "NONE" | "PERCENT" | "FIXED"),
            discountPercent:
              parsed.data.discountPercent ??
              (existing.discountType === "PERCENT" ? existing.discountValue / 100 : undefined),
            discountEuros:
              parsed.data.discountEuros ??
              (existing.discountType === "FIXED" ? existing.discountValue / 100 : undefined),
          })
        : {
            discountType: existing.discountType as "NONE" | "PERCENT" | "FIXED",
            discountValue: existing.discountValue,
          };

      const computed = computeLineTotals(linesSource, discount);
      data.subtotalCents = computed.subtotalCents;
      data.totalCents = computed.totalCents;
      data.discountType = computed.discountType;
      data.discountValue = computed.discountValue;

      if (parsed.data.lines) {
        await prisma.$transaction([
          prisma.quoteOption.deleteMany({ where: { quoteId: id } }),
          prisma.invoiceLine.deleteMany({ where: { invoiceId: id } }),
          prisma.invoice.update({
            where: { id },
            data: { ...data, lines: { create: computed.lines } },
          }),
        ]);
      } else {
        await prisma.invoice.update({ where: { id }, data });
      }
    } else {
      await prisma.invoice.update({ where: { id }, data });
    }

    const updated = await prisma.invoice.findUniqueOrThrow({
      where: { id },
      include: {
        lines: { orderBy: { position: "asc" } },
        options: OPTIONS_INCLUDE,
        client: { select: { id: true, displayName: true, clientNumber: true } },
      },
    });
    return serializeInvoice(updated);
  });

  app.delete("/api/invoices/:id", async (_request, reply) => {
    return reply.code(405).send({ error: "Suppression interdite - annulez via un avoir" });
  });

  // Devis préparé hors ligne, relu : l'étiquette « Préparé hors ligne, à relire » est retirée.
  app.delete<{ Params: { id: string } }>("/api/invoices/:id/offline-review", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const found = await prisma.invoice.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!found) return reply.code(404).send({ error: "Introuvable" });
    await prisma.invoice.update({ where: { id: found.id }, data: { offlineReviewReason: null } });
    return { ok: true, offlineReviewReason: null };
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/issue", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsedBody = issueBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) return reply.code(400).send({ error: parsedBody.error.issues[0]?.message ?? "Données invalides" });
    const body = parsedBody.data;
    let issueDate = new Date();
    let dueDate: Date | undefined;
    let validUntil: Date | undefined;
    if (body.issueDate) issueDate = new Date(body.issueDate);
    if (body.dueDate) dueDate = new Date(body.dueDate);
    if (body.validUntil) validUntil = new Date(body.validUntil);
    try {
      const doc = await prisma.invoice.findUnique({ where: { id: request.params.id } });
      if (!doc) return reply.code(404).send({ error: "Introuvable" });
      if (body.issueDate) {
        try {
          await assertIssueDateAllowed(doc.documentType, issueDate);
        } catch (e) {
          if (e instanceof IssueDateError) return reply.code(400).send({ error: e.message });
          throw e;
        }
      }
      const issued =
        doc.documentType === InvoiceDocumentType.QUOTE
          ? await issueQuote(request.params.id, issueDate, validUntil ?? dueDate)
          : await issueInvoice(request.params.id, issueDate, dueDate);
      let paymentWarning: string | null = null;
      // Devis : échéance payable en ligne sous le minimum Stripe (avertissement non bloquant).
      let minimumWarning: string | null = null;
      if (doc.documentType === InvoiceDocumentType.QUOTE) {
        const settings = await getCompanySettings();
        if (settings.moduleStripeEnabled) {
          const { quoteOnlineMinimumWarning } = await import("@/lib/stripe/minimum.js");
          minimumWarning = quoteOnlineMinimumWarning(issued.paymentPlanOffer, issued.depositBaseCents ?? issued.totalCents, settings, parseBillingMode(issued.billingMode));
        }
      }
      if (doc.documentType === InvoiceDocumentType.INVOICE && body.payment) {
        try {
          await applyPaymentLinkChoice(issued.id, body.payment);
        } catch (e) {
          paymentWarning = e instanceof Error ? e.message : "Lien de paiement non enregistré";
        }
      }
      const wantEmail = body.email?.send !== false;
      const mail = await sendDocumentPdf(issued.id, {
        send: wantEmail,
        subject: body.email?.subject,
        text: body.email?.body,
      });
      const subscriptionsCreated =
        "subscriptionsCreated" in issued && typeof issued.subscriptionsCreated === "number"
          ? issued.subscriptionsCreated
          : 0;
      return {
        ...serializeInvoice(issued),
        emailed: mail.sent,
        emailReason: mail.reason ?? null,
        subscriptionsCreated,
        warning: paymentWarning,
        minimumWarning,
      };
    } catch (e) {
      request.log.error({ err: e }, "[issue]");
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Erreur d'émission" });
    }
  });

  app.put<{ Params: { id: string } }>("/api/invoices/:id/payment-link", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = z
      .object({
        payment: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("none") }),
          z.object({ mode: z.literal("manual"), url: z.string().min(1).max(2000) }),
          z.object({ mode: z.literal("auto") }),
        ]),
        sendEmail: z.boolean().optional(),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Lien de paiement invalide" });
    try {
      const url =
        parsed.data.payment.mode === "none"
          ? await setInvoicePaymentLink(request.params.id, null)
          : await applyPaymentLinkChoice(request.params.id, parsed.data.payment);
      let emailed = false;
      let emailReason: string | null = null;
      if (url && parsed.data.sendEmail) {
        const mail = await sendDocumentPdf(request.params.id, { review: { family: "payment_link", origin: "ADMIN_ACTION" } });
        emailed = mail.sent;
        emailReason = mail.reason ?? null;
      }
      return { checkoutUrl: url, emailed, emailReason };
    } catch (e) {
      if (e instanceof WorkflowError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // « Vérifier l'e-mail » : brouillon du renvoi par e-mail (PDF joint), rien n'est envoyé ni préparé.
  app.get<{ Params: { id: string } }>("/api/invoices/:id/send-email/draft", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const invoice = await prisma.invoice.findUnique({ where: { id: request.params.id }, select: { id: true, number: true, status: true } });
    if (!invoice) return reply.code(404).send({ error: "Introuvable" });
    if (!invoice.number || invoice.status === "DRAFT") return reply.code(400).send({ error: "Document non émis" });
    const res = await sendDocumentPdf(invoice.id, { draft: true });
    if (!res.draft) return reply.code(409).send({ error: res.reason === "no_email" ? "Ce client n'a pas d'adresse e-mail." : "Brouillon indisponible" });
    return res.draft;
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/send-email", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const body = (request.body ?? {}) as { subject?: string; body?: string; text?: string };
    const invoice = await prisma.invoice.findUnique({
      where: { id: request.params.id },
      select: { id: true, number: true, status: true },
    });
    if (!invoice) return reply.code(404).send({ error: "Introuvable" });
    if (!invoice.number || invoice.status === "DRAFT") {
      return reply.code(400).send({ error: "Document non émis" });
    }
    const mail = await sendDocumentPdf(invoice.id, {
      subject: body.subject,
      text: body.body ?? body.text,
    });
    return {
      emailed: mail.sent,
      queued: mail.queued ?? false,
      outboxId: mail.outboxId ?? null,
      reason: mail.reason ?? null,
    };
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/convert", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      const invoice = await convertQuoteToInvoice(request.params.id);
      return reply.code(201).send({
        ...serializeInvoice(invoice),
        subscriptionsCreated:
          "subscriptionsCreated" in invoice && typeof invoice.subscriptionsCreated === "number"
            ? invoice.subscriptionsCreated
            : 0,
      });
    } catch (e) {
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Conversion impossible" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/reject", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = z
      .object({ reason: z.string().max(500).optional() })
      .safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Motif invalide" });
    }
    try {
      const quote = await rejectQuote(request.params.id, parsed.data.reason);
      return serializeInvoice(quote);
    } catch (e) {
      if (e instanceof QuoteDecisionError) {
        return reply.code(400).send({ error: e.message, code: e.code });
      }
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Refus impossible" });
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/invoices/:id/milestones",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const quote = await prisma.invoice.findUnique({ where: { id: request.params.id } });
      if (!quote || quote.documentType !== InvoiceDocumentType.QUOTE) {
        return reply.code(404).send({ error: "Devis introuvable" });
      }
      if (quote.status === InvoiceStatus.DRAFT && quote.quoteStatus === QuoteStatus.DRAFT) {
        return prisma.paymentMilestone.findMany({
          where: { quoteId: quote.id },
          orderBy: { position: "asc" },
        });
      }
      const milestones = await ensureQuoteMilestones(quote.id, quote.totalCents);
      return milestones;
    },
  );

  /** Relance manuelle telle que l'ERP l'enverrait (« Relancer le client ») : objet, texte, destinataire. */
  async function manualReminderDraft(invoice: { documentType: InvoiceDocumentType; number: string | null; client: { emailEncrypted: string | null } }) {
    const label = invoice.documentType === InvoiceDocumentType.QUOTE ? "devis" : "facture";
    const brand = await brandFromSettings();
    const signature = formatPlainTextSignature(await getCompanySettings(), brand);
    return {
      to: decryptOptional(invoice.client.emailEncrypted),
      subject: `Relance - ${label} ${invoice.number ?? "brouillon"}`,
      text: `Bonjour,\n\nSauf erreur de notre part, le ${label} ${invoice.number ?? ""} est en attente.\n\n${signature}`,
      brand,
    };
  }

  // « Vérifier l'e-mail » : brouillon de la relance manuelle, rien n'est envoyé.
  app.get<{ Params: { id: string } }>("/api/invoices/:id/reminders/draft", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const invoice = await prisma.invoice.findUnique({ where: { id: request.params.id }, include: { client: true } });
    if (!invoice) return reply.code(404).send({ error: "Introuvable" });
    const draft = await manualReminderDraft(invoice);
    if (!draft.to) return reply.code(409).send({ error: "Ce client n'a pas d'adresse e-mail." });
    return { to: draft.to, subject: draft.subject, text: draft.text, attachments: [] };
  });

  app.post<{ Params: { id: string } }>(
    "/api/invoices/:id/reminders/send",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const edits = emailEditsSchema.safeParse(request.body ?? {});
      if (!edits.success) return reply.code(400).send({ error: "Objet ou message invalide" });
      const invoice = await prisma.invoice.findUnique({
        where: { id: request.params.id },
        include: { client: true },
      });
      if (!invoice) return reply.code(404).send({ error: "Introuvable" });

      const draft = await manualReminderDraft(invoice);
      const email = draft.to;
      const brand = draft.brand;
      // Objet et texte relus dans « Vérifier l'e-mail », sinon ceux de l'ERP.
      const subject = edits.data.subject || draft.subject;
      const body = edits.data.text || draft.text;
      // Pied légal : ajouté une seule fois à l'envoi (processor) ; le brouillon mailto le reçoit ici.
      const mailtoBody = `${body}\n\n${renderEmailTextFooter(brand)}`;

      const smtpOk = await isSmtpConfigured();
      if (email && smtpOk) {
        await mailEnqueue({
          to: email,
          subject,
          text: body,
          clientId: invoice.clientId,
          documentId: invoice.id,
          documentNumber: invoice.number ?? undefined,
          kind: "reminder_soft",
          bodyTextForMessage: body,
        });
      }

      const updated = await markReminderSent(invoice.id);
      return {
        ...serializeInvoice(updated),
        emailed: Boolean(email && smtpOk),
        mailto: email
          ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailtoBody)}`
          : null,
      };
    },
  );

  // « Débloquer » : prélèvement noté « en cours » abandonné après vérification dans Stripe (webhook perdu).
  app.post<{ Params: { id: string } }>("/api/invoices/:id/clear-processing", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const exists = await prisma.invoice.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: "Introuvable" });
    const { clearPaymentProcessingManually } = await import("@/lib/stripe/payment-processing.js");
    const cleared = await clearPaymentProcessingManually({ invoiceId: exists.id });
    if (!cleared) return reply.code(409).send({ error: "Aucun prélèvement en cours sur cette facture." });
    return { cleared: true };
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/pay", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const id = request.params.id;
    const parsed = paySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: BALANCE_INCLUDE,
    });
    if (!invoice) return reply.code(404).send({ error: "Introuvable" });
    if (invoice.status !== InvoiceStatus.ISSUED && invoice.status !== InvoiceStatus.PAID) {
      return reply.code(400).send({ error: "Paiement possible uniquement sur facture émise" });
    }
    if (invoice.totalCents < 0) {
      return reply.code(400).send({ error: "Pas de paiement sur un avoir" });
    }
    // Facture d'abonnement prélevée par Stripe : un règlement à la main suivi du prélèvement ferait payer deux fois.
    if (invoice.stripeInvoiceId) {
      return reply.code(409).send({
        error: "Cette facture est prélevée par Stripe : son règlement s'enregistre à la réception du prélèvement.",
      });
    }

    const amountCents = eurosToCents(parsed.data.amountEuros);
    // Reste dû avoirs compris : net (total - avoirs) moins encaissé net.
    const remainingCents = invoiceBalance(invoice).dueCents;

    if (remainingCents <= 0) {
      return reply.code(400).send({
        error:
          "Facture déjà soldée. Pour rembourser ou corriger le montant, établissez un avoir.",
      });
    }
    if (amountCents > remainingCents) {
      return reply.code(400).send({
        error: `Montant supérieur au reste dû (${formatEUR(remainingCents)}).`,
      });
    }

    // Verrou d'écriture puis reste dû relu : un avoir ou un autre paiement enregistré entre-temps est pris en compte.
    let transition: { before: InvoiceStatus; after: InvoiceStatus } = { before: invoice.status, after: invoice.status };
    const payment = await prisma.$transaction(async (tx) => {
      await lockInvoice(tx, id);
      const due = invoiceBalance(await tx.invoice.findUniqueOrThrow({ where: { id }, include: BALANCE_INCLUDE })).dueCents;
      if (amountCents > due) throw new PaymentAmountError(due);
      const created = await tx.payment.create({
        data: {
          invoiceId: id,
          amountCents,
          paidAt: parsed.data.paidAt ? new Date(parsed.data.paidAt) : new Date(),
          method: parsed.data.method ?? PaymentMethod.BANK_TRANSFER,
          reference: parsed.data.reference ?? null,
          notes: parsed.data.notes ?? null,
        },
      });
      transition = await applySettledStatus(tx, id);
      return created;
    }).catch((e: unknown) => {
      if (e instanceof PaymentAmountError) return e;
      throw e;
    });
    if (payment instanceof PaymentAmountError) {
      return reply.code(400).send({ error: `Montant supérieur au reste dû (${formatEUR(payment.dueCents)}).` });
    }

    if (transition.after === InvoiceStatus.PAID && transition.before !== InvoiceStatus.PAID) {
      const { onInvoicePaidForProject } = await import("@/lib/projects/lifecycle.js");
      await onInvoicePaidForProject(id);
    }
    let receipt: { sent: boolean; reason: string | null } | null = null;
    if (parsed.data.notifyClient !== false) {
      const { sendPaymentReceipt } = await import("@/lib/email/payment-receipt.js");
      const r = await sendPaymentReceipt(id, amountCents, undefined, { review: { family: "payment_receipt", origin: "ADMIN_ACTION" } });
      receipt = { sent: r.sent, reason: r.reason ?? null };
    }
    return reply.code(201).send({ ...payment, receipt });
  });

  /** Règlement visé par le reçu : celui indiqué, sinon le dernier enregistré (montant positif). */
  async function receiptPayment(invoiceId: string, paymentId: string | undefined) {
    return prisma.payment.findFirst({
      where: { invoiceId, amountCents: { gt: 0 }, ...(paymentId ? { id: paymentId } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  // « Vérifier l'e-mail » : brouillon du reçu de paiement (reçu et facture joints), rien n'est envoyé ni rendu.
  app.get<{ Params: { id: string }; Querystring: { paymentId?: string } }>("/api/invoices/:id/receipt/draft", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const payment = await receiptPayment(request.params.id, request.query.paymentId);
    if (!payment) return reply.code(404).send({ error: "Paiement introuvable" });
    const { sendPaymentReceipt } = await import("@/lib/email/payment-receipt.js");
    const r = await sendPaymentReceipt(request.params.id, payment.amountCents, payment.id, { draft: true });
    if (!r.draft) return reply.code(409).send({ error: r.reason === "no_email" ? "Ce client n'a pas d'adresse e-mail." : "Brouillon indisponible" });
    return { ...r.draft, templateKey: "payment.receipt" };
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/receipt", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = emailEditsSchema.extend({ paymentId: z.string().min(1).max(64).optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Objet ou message invalide" });
    const payment = await receiptPayment(request.params.id, parsed.data.paymentId);
    if (!payment) return reply.code(404).send({ error: "Paiement introuvable" });
    const { sendPaymentReceipt } = await import("@/lib/email/payment-receipt.js");
    const r = await sendPaymentReceipt(request.params.id, payment.amountCents, payment.id, { subject: parsed.data.subject, text: parsed.data.text });
    return { sent: r.sent, reason: r.reason ?? null };
  });

  // Remboursement d'un trop-perçu (paiement reçu après un avoir, avoir en mode « Autre » ou sans ligne enregistrée) :
  // ligne négative au livre des recettes, au plus le trop-perçu relu sous verrou, à la date réelle du virement.
  app.post<{ Params: { id: string } }>("/api/invoices/:id/refund", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = refundSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
    const id = request.params.id;
    const amountCents = eurosToCents(parsed.data.amountEuros);
    const result = await prisma.$transaction(async (tx) => {
      const exists = await tx.invoice.findUnique({ where: { id }, select: { documentType: true } });
      if (!exists || exists.documentType !== InvoiceDocumentType.INVOICE) return { status: 404 as const };
      await lockInvoice(tx, id);
      const over = overpaidCents(invoiceBalance(await tx.invoice.findUniqueOrThrow({ where: { id }, include: BALANCE_INCLUDE })));
      if (amountCents > over) return { status: 400 as const, over };
      const created = await tx.payment.create({
        data: {
          invoiceId: id,
          amountCents: -amountCents,
          paidAt: parsed.data.paidAt ? new Date(parsed.data.paidAt) : new Date(),
          method: parsed.data.method ?? PaymentMethod.BANK_TRANSFER,
          reference: parsed.data.reference ?? null,
          notes: "Remboursement du trop-perçu",
        },
      });
      return { status: 201 as const, created };
    });
    if (result.status === 404) return reply.code(404).send({ error: "Introuvable" });
    if (result.status === 400) {
      return reply.code(400).send({
        error: result.over > 0 ? `Au plus ${formatEUR(result.over)} à rembourser (trop-perçu).` : "Aucun trop-perçu sur cette facture.",
      });
    }
    return reply.code(201).send(result.created);
  });

  app.get<{ Params: { id: string } }>(
    "/api/invoices/:id/credit-note/eligibility",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      try {
        return await assessCreditNoteEligibility(request.params.id);
      } catch (e) {
        if (e instanceof CreditNoteError) {
          return reply.code(e.code === "NOT_FOUND" ? 404 : 400).send({
            error: e.message,
            code: e.code,
          });
        }
        throw e;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/invoices/:id/credit-note",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const schema = z.object({
        amountEuros: z.coerce.number().positive(),
        reason: z.nativeEnum(CreditNoteReason),
        reasonDetail: z.string().optional().nullable(),
        refundMethod: z.nativeEnum(RefundMethod),
        cgvDepositRefundable: z.boolean().optional().nullable(),
        issueDate: dateString.optional(),
        registerRefundPayment: z.boolean().optional(),
        refundPaidAt: dateString.optional(),
        /** false : avoir créé sans e-mail, relu ensuite dans « Vérifier l'e-mail ». Absent : envoi direct, comme avant. */
        sendEmail: z.boolean().optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Données invalides" });
      }
      const dateError = parsed.data.issueDate ? await creditNoteDateError(request.params.id, new Date(parsed.data.issueDate)) : null;
      if (dateError) return reply.code(400).send({ error: dateError });
      try {
        const creditNote = await createCreditNote(request.params.id, {
          amountCents: eurosToCents(parsed.data.amountEuros),
          reason: parsed.data.reason,
          reasonDetail: parsed.data.reasonDetail,
          refundMethod: parsed.data.refundMethod,
          cgvDepositRefundable: parsed.data.cgvDepositRefundable,
          issueDate: parsed.data.issueDate
            ? new Date(parsed.data.issueDate)
            : new Date(),
          registerRefundPayment: parsed.data.registerRefundPayment,
          refundPaidAt: parsed.data.refundPaidAt
            ? new Date(parsed.data.refundPaidAt)
            : undefined,
        });
        const mail = parsed.data.sendEmail === false ? { sent: false, reason: undefined } : await sendDocumentPdf(creditNote.id, { review: { family: "document", origin: "ADMIN_ACTION" } });
        return reply.code(201).send({
          ...serializeInvoice(creditNote),
          emailed: mail.sent,
          emailReason: mail.reason ?? null,
        });
      } catch (e) {
        if (e instanceof CreditNoteError) {
          return reply.code(400).send({ error: e.message, code: e.code });
        }
        return reply
          .code(400)
          .send({ error: e instanceof Error ? e.message : "Erreur avoir" });
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/invoices/:id/credit-note/follow-up",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const schema = z.object({
        sentToClient: z.boolean().optional(),
        bankTransferDone: z.boolean().optional(),
        receiptsLineAdded: z.boolean().optional(),
        archivedWithOriginal: z.boolean().optional(),
        urssafImpactNoted: z.boolean().optional(),
        negativeCarryoverReminder: z.boolean().optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides" });
      }
      const inv = await prisma.invoice.findUnique({
        where: { id: request.params.id },
      });
      if (!inv || inv.documentType !== InvoiceDocumentType.CREDIT_NOTE) {
        return reply.code(404).send({ error: "Avoir introuvable" });
      }
      const prev =
        (inv.creditFollowUp as Record<string, boolean> | null) ?? {};
      const updated = await prisma.invoice.update({
        where: { id: inv.id },
        data: {
          creditFollowUp: { ...prev, ...parsed.data },
        },
      });
      return { creditFollowUp: updated.creditFollowUp };
    },
  );

  app.post<{ Params: { id: string } }>("/api/invoices/:id/cancel", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsedBody = z.object({ issueDate: dateString.optional() }).safeParse(request.body ?? {});
    if (!parsedBody.success) return reply.code(400).send({ error: parsedBody.error.issues[0]?.message ?? "Données invalides" });
    const issueDate = parsedBody.data.issueDate ? new Date(parsedBody.data.issueDate) : new Date();
    const dateError = parsedBody.data.issueDate ? await creditNoteDateError(request.params.id, issueDate) : null;
    if (dateError) return reply.code(400).send({ error: dateError });
    try {
      const creditNote = await cancelInvoiceWithCreditNote(request.params.id, issueDate);
      return reply.code(201).send(serializeInvoice(creditNote));
    } catch (e) {
      if (e instanceof CreditNoteError) {
        return reply.code(400).send({
          error: e.message,
          code: e.code,
          ...(e.code === "UNPAID"
            ? {
                alternative:
                  "Conservez la facture, émettez une facture corrigée si besoin. Ne déclarez que les encaissements réels.",
              }
            : {}),
        });
      }
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Erreur d'annulation" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/invoices/:id/pdf", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    // Même chargement que le PDF public, la version lisible et l'archive (P0 du 25/10/2026).
    const doc = await loadDocumentForPdf(request.params.id);
    const invoice = doc?.invoice;
    if (!invoice) {
      const exists = await prisma.invoice.findUnique({ where: { id: request.params.id }, select: { id: true } });
      return exists ? reply.code(400).send({ error: "PDF disponible uniquement après émission" }) : reply.code(404).send({ error: "Introuvable" });
    }
    if (invoice.status === InvoiceStatus.DRAFT) {
      return reply.code(400).send({ error: "PDF disponible uniquement après émission" });
    }
    // Facture ou avoir émis : PDF archivé à l'émission, servi tel quel (document immuable).
    const { issuedDocumentPdf } = await import("@/lib/pdf/issued-archive.js");
    const archived = await issuedDocumentPdf(invoice.id, doc);
    if (archived) {
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${invoice.number}.pdf"`)
        .send(archived);
    }

    const buffer = await renderLoadedDocumentPdf(doc!);

    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="${invoice.number}.pdf"`)
      .send(buffer);
  });

  app.get<{ Params: { id: string } }>(
    "/api/invoices/:id/public-token",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const inv = await prisma.invoice.findUnique({ where: { id: request.params.id } });
      if (!inv || !inv.number) return reply.code(404).send({ error: "Introuvable" });
      return { token: signDocumentToken(inv.id) };
    },
  );
};
