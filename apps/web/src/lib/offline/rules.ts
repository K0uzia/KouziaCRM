// Liste FERMÉE des lectures copiées pour le hors ligne : clients (coordonnées comprises), bloc-notes, notes de rendez-vous et
// projets des fiches clients, prestations, devis, factures (sans PDF), synthèse de leurs listes (des nombres
// seulement) et le petit sous-ensemble des réglages utile
// aux devis. Toute autre requête n'est jamais
// copiée. Chaque réponse passe par une liste blanche de champs : un champ ajouté plus tard côté API n'entre pas
// dans la copie sans être ajouté ici. Exclus : authentification, 2FA, codes de secours, abonnements push,
// secrets des réglages (Stripe, SMTP, IMAP, Revolut, IBAN), banque, paiements, versements, messagerie,
// pièces jointes, PDF, preuves de signature, codes de l'espace client, jetons d'invitation.

type Json = Record<string, unknown>;
export type OfflineRule = {
  name: string;
  pattern: RegExp;
  sanitize: (data: unknown) => unknown;
  /** Donnée d'appoint (réglages : modules, calcul des devis) : servie sur tout écran, sans mention de date. */
  support?: boolean;
};

/** Écrans consultables hors ligne : listes et fiches des clients, devis, factures, prestations. */
export const OFFLINE_SCREENS = /^\/(clients|quotes|invoices|services)(\/[A-Za-z0-9_-]+)?\/?$/;

const ID = "[A-Za-z0-9_-]{1,64}";

function pick(source: unknown, keys: readonly string[]): Json | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const out: Json = {};
  for (const key of keys) {
    if (key in (source as Json)) out[key] = (source as Json)[key];
  }
  return out;
}

const listOf = (one: (v: unknown) => unknown) => (data: unknown) => (Array.isArray(data) ? data.map(one) : []);

const CLIENT_KEYS = [
  "id", "clientNumber", "type", "displayName", "firstName", "lastName", "companyName",
  "email", "phone", "siret", "siren", "apeCode", "companyVerifiedAt",
  "addressLine1", "addressLine2", "postalCode", "city", "country", "addressCityCode", "addressLat", "addressLon",
  "notes", "notepadUpdatedAt", "billingDay", "needs", "emailVerifiedAt", "onboardingCompletedAt", "createdAt", "updatedAt",
] as const;

const SNAPSHOT_KEYS = [
  "displayName", "type", "email", "phone", "siret", "addressLine1", "addressLine2", "postalCode", "city", "country",
] as const;

const SERVICE_KEYS = [
  "id", "name", "description", "unitPriceCents", "unit", "active", "isSubscription", "defaultBillingDay",
  "billingInterval", "category", "isPack", "createdAt", "updatedAt",
] as const;
const PACK_ITEM_KEYS = ["id", "packId", "serviceId", "quantity", "position"] as const;
const PACK_SERVICE_KEYS = ["id", "name", "unitPriceCents", "isSubscription", "billingInterval", "active"] as const;

const LINE_KEYS = [
  "id", "invoiceId", "position", "description", "quantity", "unitPriceCents", "lineTotalCents", "isSubscription",
  "billingDay", "billingInterval", "subscriptionStart", "subscriptionStartDate", "subscriptionFreeMonths",
  "serviceId", "groupTitle", "isPackDiscount",
] as const;

// Jalons d'un devis : libellé, part et montant. Sans liens de paiement, références ni identifiants Revolut.
const MILESTONE_KEYS = [
  "id", "quoteId", "position", "label", "percentBps", "amountCents", "triggerText", "status", "dueDate",
  "triggerStepLabel", "triggeredAt", "invoiceId",
] as const;

// Devis, facture ou avoir. Sans paiements, transactions bancaires, liens de paiement, identifiants Stripe ou
// Revolut, PDF archivé (chemin, empreinte) ni nom du signataire (preuve de signature).
const INVOICE_KEYS = [
  "id", "number", "documentType", "invoiceType", "status", "quoteStatus", "quoteDecidedAt", "quoteRejectReason",
  "clientId", "issueDate", "serviceDate", "purchaseOrderRef", "dueDate", "validUntil", "sequenceYear",
  "sequenceNumber", "currency", "subtotalCents", "totalCents", "discountType", "discountValue", "marketTotalCents",
  "depositBaseCents", "notes", "paymentTerms", "creditedInvoiceId", "creditReason", "creditReasonDetail",
  "refundMethod", "cgvDepositRefundable", "paymentPlanOffer", "paymentPlan", "quoteId", "sourceQuoteId",
  "milestoneId", "subscriptionId", "issuedAt", "offlineReviewReason", "createdAt", "updatedAt",
] as const;

const NOTE_KEYS = ["id", "clientId", "body", "preparedAt", "createdAt"] as const;
const NOTEPAD_KEYS = ["text", "version", "updatedAt", "conflictAt"] as const;

// Projet de la fiche client : avancement, étapes, liens et liste de contrôle, tels que la fiche les affiche.
const PROJECT_KEYS = [
  "id", "clientId", "name", "progress", "visibleOnPortal", "position", "quoteId", "status", "startedAt", "kind",
  "startsNotBefore", "reviewInviteSentAt", "createdAt", "updatedAt",
] as const;
const STEP_KEYS = ["label", "status", "date", "triggersDeposit2"] as const;
const LINK_KEYS = ["label", "url"] as const;
const CHECK_KEYS = ["label", "done", "note"] as const;
const DEPOSIT2_KEYS = ["locked", "missingStep"] as const;

/** Réglages nécessaires au calcul et à l'affichage des devis (et au menu des modules). Rien d'autre. */
export const SETTINGS_KEYS = [
  "legalName", "tradeName", "vatMention", "mediationClause", "paymentChoiceDefault", "split3MinTotalCents",
  "annualFreeMonths", "moduleBankEnabled", "moduleSubscriptionsEnabled", "moduleStripeEnabled",
] as const;

export function sanitizeClient(data: unknown): Json | null {
  return pick(data, CLIENT_KEYS);
}

export function sanitizeService(data: unknown): Json | null {
  const service = pick(data, SERVICE_KEYS);
  if (!service) return null;
  const items = (data as Json).packItems;
  if (Array.isArray(items)) {
    service.packItems = items.map((item) => {
      const out = pick(item, PACK_ITEM_KEYS);
      if (out) out.service = pick((item as Json).service, PACK_SERVICE_KEYS);
      return out;
    });
  }
  return service;
}

const BALANCE_KEYS = ["creditedCents", "netCents", "refundedCents", "cashInCents", "dueCents", "overpaidCents"] as const;
const AMOUNT_KEYS = ["toCollectCents", "cashInCents", "invoicedNetCents", "openCount", "paidCount"] as const;

/** Champs numériques seulement, parmi une liste fermée. */
function numbers(source: unknown, keys: readonly string[]): Json | null {
  const picked = pick(source, keys);
  if (!picked) return null;
  for (const k of Object.keys(picked)) if (typeof picked[k] !== "number") delete picked[k];
  return picked;
}

function invoiceCore(data: unknown): Json | null {
  const invoice = pick(data, INVOICE_KEYS);
  if (!invoice) return null;
  const source = data as Json;
  if (source.client !== undefined) invoice.client = source.client === null ? null : sanitizeClient(source.client);
  if (source.clientSnapshot !== undefined) invoice.clientSnapshot = source.clientSnapshot === null ? null : pick(source.clientSnapshot, SNAPSHOT_KEYS);
  if (source.quote !== undefined) invoice.quote = source.quote === null ? null : pick(source.quote, ["id", "number", "issueDate"]);
  if (Array.isArray(source.lines)) invoice.lines = source.lines.map((l) => pick(l, LINE_KEYS));
  // Solde de la facture (avoirs compris) : des montants seulement.
  if (source.balance !== undefined) invoice.balance = source.balance === null ? null : numbers(source.balance, BALANCE_KEYS);
  return invoice;
}

export function sanitizeInvoice(data: unknown): Json | null {
  const invoice = invoiceCore(data);
  if (!invoice) return null;
  const source = data as Json;
  if (Array.isArray(source.milestones)) invoice.milestones = source.milestones.map((m) => pick(m, MILESTONE_KEYS));
  if (Array.isArray(source.creditNotes)) invoice.creditNotes = source.creditNotes.map(invoiceCore);
  if (source.creditedInvoice !== undefined) invoice.creditedInvoice = source.creditedInvoice === null ? null : invoiceCore(source.creditedInvoice);
  return invoice;
}

export function sanitizeNote(data: unknown): Json | null {
  return pick(data, NOTE_KEYS);
}

export function sanitizeNotepad(data: unknown): Json | null {
  return pick(data, NOTEPAD_KEYS);
}

export function sanitizeProject(data: unknown): Json | null {
  const project = pick(data, PROJECT_KEYS);
  if (!project) return null;
  const source = data as Json;
  project.steps = listOf((v) => pick(v, STEP_KEYS))(source.steps);
  project.links = listOf((v) => pick(v, LINK_KEYS))(source.links);
  project.checklist = listOf((v) => pick(v, CHECK_KEYS))(source.checklist);
  project.deposit2 = source.deposit2 ? pick(source.deposit2, DEPOSIT2_KEYS) : null;
  return project;
}

export function sanitizeSettings(data: unknown): Json | null {
  return pick(data, SETTINGS_KEYS);
}

/** Synthèse d'une liste : des nombres seulement (par statut, par type, à relire, en retard). */
function counts(source: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const [k, v] of Object.entries(source as Json)) if (typeof v === "number" && /^[A-Z_]{1,32}$/.test(k)) out[k] = v;
  }
  return out;
}
function sanitizeSummary(data: unknown): unknown {
  const s = pick(data, ["total", "byStatus", "byKind", "overdue", "toReview", "amounts"]) ?? {};
  const amounts = numbers(s.amounts, AMOUNT_KEYS);
  const kind = pick(s.byKind, ["factures", "avoirs"]);
  return {
    total: typeof s.total === "number" ? s.total : 0,
    byStatus: counts(s.byStatus),
    ...(kind ? { byKind: { factures: counts(kind.factures), avoirs: counts(kind.avoirs) } } : {}),
    overdue: typeof s.overdue === "number" ? s.overdue : 0,
    toReview: typeof s.toReview === "number" ? s.toReview : 0,
    ...(amounts ? { amounts } : {}),
  };
}

export const OFFLINE_RULES: readonly OfflineRule[] = [
  { name: "clients", pattern: /^\/api\/clients(\?hasCorrespondence=(true|false))?$/, sanitize: listOf(sanitizeClient) },
  { name: "fiche client", pattern: new RegExp(`^/api/clients/${ID}$`), sanitize: sanitizeClient },
  { name: "bloc-notes", pattern: new RegExp(`^/api/clients/${ID}/notepad$`), sanitize: sanitizeNotepad },
  { name: "notes de rendez-vous", pattern: new RegExp(`^/api/clients/${ID}/notes$`), sanitize: listOf(sanitizeNote) },
  { name: "projets du client", pattern: new RegExp(`^/api/clients/${ID}/projects$`), sanitize: listOf(sanitizeProject) },
  { name: "prestations", pattern: /^\/api\/services(\?active=1)?$/, sanitize: listOf(sanitizeService) },
  {
    name: "listes de devis et de factures",
    pattern: new RegExp(
      `^/api/invoices\\?(type=(QUOTE|INVOICE)|clientId=${ID}(&pageSize=100)?|type=QUOTE&clientId=${ID}(&pageSize=100)?|type=INVOICE&market=${ID})$`,
    ),
    sanitize: listOf(sanitizeInvoice),
  },
  { name: "synthèse des devis ou des factures", pattern: /^\/api\/invoices\/summary\?type=(QUOTE|INVOICE)$/, sanitize: sanitizeSummary },
  { name: "devis ou facture", pattern: new RegExp(`^/api/invoices/(?!search$|summary$)${ID}$`), sanitize: sanitizeInvoice },
  { name: "réglages des devis", pattern: /^\/api\/settings$/, sanitize: sanitizeSettings, support: true },
];

/** Règle de copie d'une lecture, ou null : la requête n'est jamais copiée. */
export function offlineRule(path: string): OfflineRule | null {
  return OFFLINE_RULES.find((rule) => rule.pattern.test(path)) ?? null;
}

/** La copie peut-elle servir cette lecture sur cet écran ? Ailleurs (messagerie, paiements…), jamais. */
export function copyServes(rule: OfflineRule, route: string): boolean {
  return rule.support === true || OFFLINE_SCREENS.test(route);
}
