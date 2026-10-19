// Lectures copiées pour le reste de l'ERP hors ligne (décision d'Alexandre du 19/10/2026 : tout l'ERP en lecture,
// sauf le module Site). Même principe que lib/offline/rules : liste fermée, et pour chaque réponse une liste blanche
// de champs. Restent exclus, toujours : session et 2FA, secrets et clés d'API (Stripe, Google, SMTP, IMAP, GitHub,
// Revolut) et leurs indices, IBAN et coordonnées bancaires, preuves de signature, PDF et pièces jointes, liens de
// paiement (checkoutUrl), jetons d'espace client (publicToken), en-têtes bruts des e-mails, adresses push.
// Messagerie : sujet, expéditeur et texte des messages des 90 derniers jours ; le HTML reçu est réduit au texte.
// Imports relatifs uniquement dans lib/offline : modules testés par vitest sans l'alias « @ ».

type Json = Record<string, unknown>;

export function pick(source: unknown, keys: readonly string[]): Json | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const out: Json = {};
  for (const key of keys) {
    if (key in (source as Json)) out[key] = (source as Json)[key];
  }
  return out;
}

export const listOf = (one: (v: unknown) => unknown) => (data: unknown) => (Array.isArray(data) ? data.map(one) : []);

const obj = (source: unknown, key: string): unknown => (source && typeof source === "object" ? (source as Json)[key] : undefined);

/** Les 90 derniers jours : au-delà, un message n'est pas gardé sur l'appareil. */
export const MAIL_DAYS = 90;
const recent = (iso: unknown, now = Date.now()) => typeof iso === "string" && now - Date.parse(iso) <= MAIL_DAYS * 24 * 3600 * 1000;

/** Texte lisible d'un HTML d'e-mail (balises retirées, entités courantes décodées) : jamais de HTML externe gardé. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Fiches et pièces -----------------------------------------------------------------------------------------

const PACK_LINE_KEYS = ["serviceId", "description", "quantity", "unitPriceCents", "isSubscription", "billingInterval", "billingDay", "groupTitle", "isPackDiscount"] as const;
const RENEWAL_KEYS = ["id", "clientId", "label", "provider", "renewsAt", "interval", "notifyClient", "noticeSentFor", "createdAt", "updatedAt"] as const;
const CLIENT_MAIL_KEYS = ["id", "kind", "at", "subject", "direction", "threadId", "eventKind", "documentId", "documentNumber", "success"] as const;

function sanitizeClientEmails(data: unknown): Json {
  return { items: listOf((v) => pick(v, CLIENT_MAIL_KEYS))(obj(data, "items")) };
}

const SUBSCRIPTION_KEYS = [
  "id", "clientId", "serviceId", "label", "amountCents", "billingDay", "startDate", "endDate", "status", "collectionMethod",
  "billingInterval", "nextInvoiceAt", "lastInvoiceId", "renewalReminderSentFor", "cancellationRequestedAt", "stripeStatus",
  "stripeCancelAt", "setupLinkSentAt", "firstInvoicePending", "draftLike", "createdAt", "updatedAt",
] as const;

function sanitizeSubscription(data: unknown): Json | null {
  const s = pick(data, SUBSCRIPTION_KEYS);
  if (!s) return null;
  s.client = pick(obj(data, "client"), ["id", "displayName", "clientNumber"]);
  s.service = pick(obj(data, "service"), ["id", "name"]);
  return s;
}

function sanitizeRevision(data: unknown): Json | null {
  const r = pick(data, ["lineId", "quoteId", "quoteNumber", "displayName", "description", "amountCents", "billingInterval"]);
  if (!r) return null;
  r.subscriptions = listOf((v) => pick(v, ["id", "label", "amountCents", "billingInterval"]))(obj(data, "subscriptions"));
  return r;
}

const MILESTONE_KEYS = [
  "id", "position", "label", "percentBps", "amountCents", "triggerText", "triggerStepLabel", "triggeredAt", "status",
  "dueDate", "paidAt", "paymentMethod", "invoiceId",
] as const;

function sanitizeMilestone(data: unknown): Json | null {
  const m = pick(data, MILESTONE_KEYS);
  if (!m) return null;
  const invoice = obj(data, "invoice");
  m.invoice = invoice ? pick(invoice, ["id", "number", "status", "invoiceType", "totalCents", "paidCents"]) : null;
  return m;
}

/** Marché d'un devis : jalons et factures liées, sans lien de paiement ni référence de virement. */
function sanitizeMarket(data: unknown): Json | null {
  if (!data || typeof data !== "object") return null;
  const quote = pick(obj(data, "quote"), ["id", "number", "totalCents", "status", "quoteStatus", "issueDate"]);
  if (quote) quote.client = pick(obj(obj(data, "quote"), "client"), ["id", "displayName", "clientNumber"]);
  const balance = pick(obj(data, "balance"), [
    "quoteId", "quoteNumber", "quoteIssueDate", "marketTotalCents", "acomptesPaidCents", "acomptesIssuedUnpaidCents", "balanceDueCents",
  ]);
  if (balance) {
    balance.acomptes = listOf((v) => pick(v, ["invoiceId", "number", "amountCents", "status", "paid", "label", "deductedCents"]))(obj(obj(data, "balance"), "acomptes"));
    balance.pendingMilestones = listOf(sanitizeMilestone)(obj(obj(data, "balance"), "pendingMilestones"));
  }
  return {
    quote,
    milestones: listOf(sanitizeMilestone)(obj(data, "milestones")),
    marketInvoices: listOf((v) => pick(v, ["id", "number", "invoiceType", "status", "totalCents", "paidCents", "issueDate"]))(obj(data, "marketInvoices")),
    progress: pick(obj(data, "progress"), ["milestonesPaid", "milestonesTotal", "encaisseCents", "marketTotalCents", "encaissePercent"]),
    balance,
  };
}

// --- Pilotage et comptabilité ----------------------------------------------------------------------------------

/** Aperçu de la boîte de réception : expéditeur, sujet, extrait, client rattaché. */
function sanitizeInboxSummary(data: unknown): Json | null {
  const s = pick(data, ["folderId", "unreadCount"]);
  if (!s) return null;
  s.messages = listOf((v) => {
    const m = pick(v, ["id", "threadId", "subject", "fromAddress", "fromName", "replyToAddress", "snippet", "direction", "receivedAt", "isRead"]);
    if (m) m.client = pick(obj(v, "client"), ["id", "displayName"]);
    return m;
  })(obj(data, "messages")).filter((m) => m && recent((m as Json).receivedAt));
  return s;
}

// Agrégats calculés par le serveur (montants, échéances, compteurs) : repris tels quels. Les pièces à relancer passent
// par sanitizeInvoice (sans lien de paiement, chemin de PDF ni empreinte) ; le courrier par sanitizeInboxSummary.
const DASHBOARD_KEYS = [
  "company", "scope", "invoiceId", "echeance", "cashflow", "chart", "drafts", "deposit2", "pendingTotalCents", "pendingCount",
  "mrr", "obligations", "cfeObligation", "ownerPay", "pendingStarts", "renewals", "revisionsToAttach", "indisponibles",
] as const;

export function makeDashboardSanitizer(sanitizeInvoice: (v: unknown) => unknown) {
  return (data: unknown): Json | null => {
    const d = pick(data, DASHBOARD_KEYS);
    if (!d) return null;
    if (d.company) d.company = pick(d.company, ["legalName", "tradeName"]);
    d.pendingWithBalance = listOf((v) => pick(v, ["id", "number", "displayName", "remaining"]))(obj(data, "pendingWithBalance"));
    if (obj(data, "reminders") !== undefined) {
      d.reminders = listOf((v) => {
        const inv = sanitizeInvoice(v) as Json | null;
        if (inv) inv.client = pick(obj(v, "client"), ["id", "displayName", "clientNumber"]);
        return inv;
      })(obj(data, "reminders"));
    }
    if (obj(data, "mail") !== undefined) d.mail = sanitizeInboxSummary(obj(data, "mail"));
    if (obj(data, "mailSync") !== undefined) d.mailSync = pick(obj(data, "mailSync"), ["imapConfigured", "lastSyncAt"]);
    return d;
  };
}

const PAYMENT_KEYS = [
  "id", "invoiceId", "amountCents", "paidAt", "method", "reference", "notes", "feeCents", "refundedCents", "disputedCents", "stripePayoutId", "createdAt",
] as const;

function sanitizePayment(data: unknown): Json | null {
  const p = pick(data, PAYMENT_KEYS);
  if (!p) return null;
  const invoice = obj(data, "invoice");
  p.invoice = invoice ? { ...pick(invoice, ["id", "number", "totalCents", "status"]), client: pick(obj(invoice, "client"), ["displayName"]) } : null;
  const payout = obj(data, "stripePayout");
  p.stripePayout = payout ? pick(payout, ["id", "arrivalDate", "status", "amountCents"]) : null;
  return p;
}

const RECEIPT_ROW_KEYS = [
  "id", "paidAt", "invoiceNumber", "invoiceId", "invoiceType", "documentType", "typeLabel", "amountCents", "invoiceTotalCents",
  "clientName", "clientNumber", "nature", "paymentMethod", "paymentMethodLabel", "reference",
] as const;

function sanitizeReceipts(data: unknown): Json | null {
  const r = pick(data, ["totalCents"]);
  if (!r) return null;
  r.period = pick(obj(data, "period"), ["start", "end", "year"]);
  r.rows = listOf((v) => pick(v, RECEIPT_ROW_KEYS))(obj(data, "rows"));
  return r;
}

const OBLIGATION_KEYS = [
  "id", "type", "period", "dueDate", "windowStart", "windowEnd", "status", "displayStatus", "completedAt", "amountCents", "notes",
  "label", "daysLate", "daysRemaining", "daysUntilOpen", "officialUrl", "confirmLabel", "attachmentName", "hasAttachment",
] as const;

function sanitizeObligations(data: unknown): Json | null {
  const o = pick(data, ["summary", "alerts", "links", "checklist", "bankThreshold"]);
  if (!o) return null;
  o.items = listOf((v) => pick(v, OBLIGATION_KEYS))(obj(data, "items"));
  o.history = listOf((v) => pick(v, OBLIGATION_KEYS))(obj(data, "history"));
  return o;
}

const URSSAF_KEYS = [
  "id", "periodKey", "periodicity", "periodStart", "periodEnd", "deadline", "encaisseCents", "amountDueCents", "status", "paidAt",
  "paymentRef", "notes", "createdAt", "updatedAt",
] as const;

function sanitizeOwnerPay(data: unknown): Json | null {
  const o = pick(data, ["availableCents", "paidThisMonthCents", "withdrawalsTotal", "withdrawalsTruncated"]);
  if (!o) return null;
  o.flows = listOf((v) => pick(v, ["key", "label", "encaisseCents", "urssafCents", "cfeCents", "tresorerieCents", "resteNetCents", "verseCents", "salaireDisponibleCents"]))(obj(data, "flows"));
  o.withdrawals = listOf((v) => pick(v, ["id", "amountCents", "date", "note", "createdAt"]))(obj(data, "withdrawals"));
  return o;
}

function sanitizeStripeFlux(data: unknown): Json | null {
  const f = pick(data, ["months", "month", "series"]);
  if (!f) return null;
  f.payouts = listOf((v) => {
    const p = pick(v, ["id", "stripePayoutId", "amountCents", "arrivalDate", "status", "grossCents", "feeCents", "deductionsCents", "expectedCents", "gapCents"]);
    if (p) {
      p.payments = listOf((x) => {
        const pay = pick(x, ["id", "amountCents", "feeCents", "paidAt", "method"]);
        const inv = obj(x, "invoice");
        if (pay) pay.invoice = inv ? { ...pick(inv, ["id", "number"]), client: pick(obj(inv, "client"), ["displayName"]) } : null;
        return pay;
      })(obj(v, "payments"));
    }
    return p;
  })(obj(data, "payouts"));
  return f;
}

function sanitizeNotificationFeed(data: unknown): Json | null {
  const f = pick(data, ["serverTime", "seenAt"]);
  if (!f) return null;
  f.items = listOf((v) => {
    const n = pick(v, ["id", "kind", "title", "body", "href", "at"]);
    const mail = obj(v, "mail");
    if (n && mail) n.mail = pick(mail, ["from", "subject", "client"]);
    return n;
  })(obj(data, "items"));
  return f;
}

// --- Messagerie (90 derniers jours, texte seulement) ------------------------------------------------------------

const FOLDER_KEYS = ["id", "displayName", "role", "unreadCount", "isVirtual"] as const;

function sanitizeFolders(data: unknown): Json {
  return {
    folders: listOf((v) => pick(v, FOLDER_KEYS))(obj(data, "folders")),
    virtualFolders: listOf((v) => pick(v, FOLDER_KEYS))(obj(data, "virtualFolders")),
    syncStatus: pick(obj(data, "syncStatus"), ["connected", "lastSyncAt"]),
  };
}

const LIST_MESSAGE_KEYS = [
  "id", "threadId", "folderId", "subject", "snippet", "fromAddress", "fromName", "replyToAddress", "toAddresses", "receivedAt",
  "isRead", "isStarred", "hasAttachments", "direction",
] as const;

function sanitizeMessageList(data: unknown): Json | null {
  const l = pick(data, ["total", "audienceCounts", "skip", "take"]);
  if (!l) return null;
  l.messages = listOf((v) => {
    const m = pick(v, LIST_MESSAGE_KEYS);
    if (!m) return null;
    const thread = obj(v, "thread");
    m.thread = thread
      ? { ...pick(thread, ["id", "subject", "clientId", "unreadCount"]), client: pick(obj(thread, "client"), ["id", "displayName", "firstName", "lastName", "companyName", "type"]) }
      : null;
    m.folder = pick(obj(v, "folder"), ["id", "displayName", "role"]);
    return m;
  })(obj(data, "messages")).filter((m) => m && recent((m as Json).receivedAt));
  // Total ramené à ce qui est sur l'appareil : l'écran ne demande pas une page suivante qui n'a pas été copiée.
  const all = obj(data, "messages");
  if (Array.isArray(all) && (l.messages as unknown[]).length < all.length) l.total = (l.messages as unknown[]).length;
  return l;
}

const THREAD_MESSAGE_KEYS = [
  "id", "threadId", "folderId", "direction", "fromAddress", "fromName", "replyToAddress", "toAddresses", "ccAddresses", "subject",
  "snippet", "receivedAt", "isRead", "isStarred", "hasAttachments",
] as const;

/** Corps d'un message : texte seulement (le HTML reçu réduit au texte), sans pièce jointe ni en-tête brut. */
function textBody(source: unknown): { bodyText: string | null; bodyHtml: null; bodyFetched: boolean } {
  const text = obj(source, "bodyText");
  const html = obj(source, "bodyHtml");
  const body = typeof text === "string" && text.trim() ? text : typeof html === "string" && html.trim() ? htmlToText(html) : null;
  return { bodyText: body, bodyHtml: null, bodyFetched: body !== null };
}

function sanitizeThread(data: unknown): Json | null {
  const t = pick(data, ["id", "clientId", "subject", "lastMessageAt", "hasAttachments", "unreadCount", "isStarred", "createdAt", "updatedAt", "participants", "quoteConfirmationHint"]);
  if (!t) return null;
  t.client = pick(obj(data, "client"), ["id", "displayName"]);
  t.pendingQuotes = listOf((v) => pick(v, ["id", "number", "totalCents", "issueDate"]))(obj(data, "pendingQuotes"));
  t.acceptanceAudits = [];
  const form = obj(data, "formSubmission");
  t.formSubmission = form ? pick(form, ["messageId", "receivedAt", "fields", "client", "replyTo"]) : null;
  t.messages = listOf((v) => {
    const m = pick(v, THREAD_MESSAGE_KEYS);
    if (!m) return null;
    return { ...m, ...textBody(v), attachments: [] };
  })(obj(data, "messages")).filter((m) => m && recent((m as Json).receivedAt));
  return t;
}

function sanitizeMessageBody(data: unknown): Json {
  return { ...textBody(data), attachments: [], formLead: obj(data, "formLead") ?? null };
}

// --- Réglages en lecture -----------------------------------------------------------------------------------------

/**
 * Réglages lisibles sur l'appareil (écran Réglages en lecture, modules, calculs) : identité, coordonnées de l'entreprise,
 * paiements sans banque ni clé, relances, numérotation, déclarations, mentions légales, charte. Jamais : IBAN, BIC,
 * banque, secrets et leurs indices, serveurs et identifiants SMTP et IMAP, Google, GitHub, URL de webhook, logo.
 */
export const SETTINGS_READ_KEYS = [
  "legalName", "tradeName", "vatMention", "mediationClause", "paymentChoiceDefault", "split3MinTotalCents", "annualFreeMonths",
  "moduleBankEnabled", "moduleSubscriptionsEnabled", "moduleStripeEnabled",
  "siren", "siret", "apeCode", "legalForm", "rcsMention", "vatIntraNumber", "email", "phone", "addressLine1", "addressLine2",
  "postalCode", "city", "country", "website", "decennaleInsurer", "decennalePolicyNumber", "decennaleCoverageZone",
  "clientPortalUrl", "googleReviewUrl", "reviewInviteEnabled", "publicTrackingShowAmounts",
  "smtpFrom", "smtpFromName", "smtpReplyTo", "transactionalFrom", "emailThrottlePerMinute", "imapPollIntervalMinutes",
  "emailSignatureHtml", "emailDefaults", "emailPresets",
  "paymentButtonLeadDays", "stripeMode",
  "reminderQuoteDays", "reminderInvoiceDays", "nonRenewalNoticeDays",
  "invoiceNumberTemplate", "quoteNumberTemplate", "creditNoteNumberTemplate", "numberCounterWidth",
  "urssafPeriodicity", "businessStartDate", "rneRegistrationDate", "b2cActivity", "cfeAmountCents", "treasuryRateBps",
  "placementRateBps", "obligationReminderEmail", "obligationEmailRemindersEnabled",
  "cgvPublished", "cgvUrl", "cgvVersion", "withdrawalExpressRequestText",
  "brandPrimaryColor", "brandSecondaryColor", "pdfFooterText", "brand",
] as const;
/** Familles de réglages chiffrées sans secret (taux d'acompte, paiement en 3 fois, relances d'acompte, pièces jointes). */
const SETTINGS_READ_PATTERNS = [/^depositPercent\w*Bps$/, /^split3\w*$/, /^reminderDeposit\w*$/, /^attachmentMax\w*$/];
const SETTINGS_NEVER = /iban|bic|bank(Name|Account)|secret|pass|token|key|hint|smtpHost|smtpUser|smtpPort|imapHost|imapUser|imapPort|imapMailbox|imapFolder|webhook|googleCalendar|github|revolut|logoPath/i;

export function sanitizeSettingsRead(data: unknown): Json | null {
  const out = pick(data, SETTINGS_READ_KEYS);
  if (!out) return null;
  for (const [key, value] of Object.entries(data as Json)) {
    if (SETTINGS_READ_PATTERNS.some((p) => p.test(key))) out[key] = value;
  }
  for (const key of Object.keys(out)) if (SETTINGS_NEVER.test(key)) delete out[key];
  // Secrets : seulement « configuré ou non » (l'écran l'affiche), jamais la valeur ni son indice.
  const secrets = obj(data, "secrets");
  if (secrets && typeof secrets === "object") {
    out.secrets = Object.fromEntries(Object.entries(secrets as Json).map(([k, v]) => [k, { set: Boolean(obj(v, "set")), hint: null }]));
  }
  return out;
}

// --- Règles ------------------------------------------------------------------------------------------------------

const ID = "[A-Za-z0-9_-]{1,64}";
type Rule = { name: string; pattern: RegExp; sanitize: (data: unknown) => unknown; support?: boolean };

export function erpRules(sanitizeInvoice: (v: unknown) => unknown): Rule[] {
  return [
    { name: "lignes d'un pack", pattern: new RegExp(`^/api/services/${ID}/pack-lines$`), sanitize: listOf((v) => pick(v, PACK_LINE_KEYS)) },
    { name: "renouvellements du client", pattern: new RegExp(`^/api/clients/${ID}/renewals$`), sanitize: listOf((v) => pick(v, RENEWAL_KEYS)) },
    { name: "échanges du client", pattern: new RegExp(`^/api/clients/${ID}/emails$`), sanitize: sanitizeClientEmails },
    { name: "abonnements", pattern: /^\/api\/subscriptions$/, sanitize: listOf(sanitizeSubscription) },
    { name: "avenants à rattacher", pattern: /^\/api\/subscriptions\/revisions-to-attach$/, sanitize: listOf(sanitizeRevision) },
    { name: "marché d'un devis", pattern: new RegExp(`^/api/quotes/${ID}/market$`), sanitize: sanitizeMarket },
    { name: "tableau de bord", pattern: /^\/api\/dashboard\/overview\?scope=(month|quarter|year)$/, sanitize: makeDashboardSanitizer(sanitizeInvoice) },
    { name: "synthèse du tableau de bord", pattern: /^\/api\/dashboard$/, sanitize: makeDashboardSanitizer(sanitizeInvoice) },
    { name: "aperçu de la boîte de réception", pattern: /^\/api\/emails\/inbox-summary$/, sanitize: sanitizeInboxSummary },
    { name: "encaissements", pattern: /^\/api\/payments$/, sanitize: listOf(sanitizePayment) },
    {
      // Écran Encaissements : pièces et ce qui en est déjà encaissé (montants et dates seulement, sans référence).
      name: "pièces à encaisser",
      pattern: /^\/api\/invoices$/,
      sanitize: listOf((v) => {
        const inv = sanitizeInvoice(v) as Json | null;
        if (inv) inv.payments = listOf((p) => pick(p, ["amountCents", "paidAt"]))(obj(v, "payments"));
        return inv;
      }),
    },
    { name: "livre de recettes", pattern: /^\/api\/receipts\?year=\d{4}(&(month=(0?[1-9]|1[0-2])|quarter=[1-4]))?$/, sanitize: sanitizeReceipts },
    { name: "démarches", pattern: /^\/api\/obligations$/, sanitize: sanitizeObligations },
    { name: "déclarations URSSAF", pattern: /^\/api\/urssaf\/declarations$/, sanitize: listOf((v) => pick(v, URSSAF_KEYS)) },
    { name: "retraits", pattern: /^\/api\/owner-pay$/, sanitize: sanitizeOwnerPay },
    { name: "flux Stripe", pattern: /^\/api\/stripe\/flux(\?month=\d{4}-\d{2})?$/, sanitize: sanitizeStripeFlux },
    { name: "notifications", pattern: /^\/api\/notifications\/feed$/, sanitize: sanitizeNotificationFeed, support: true },
    { name: "état de la messagerie", pattern: /^\/api\/emails\/sync-status$/, sanitize: (d) => pick(d, ["connected", "lastSyncAt", "inboxUnreadCount", "imapConfigured"]), support: true },
    { name: "dossiers de la messagerie", pattern: /^\/api\/emails\/folders$/, sanitize: sanitizeFolders },
    { name: "messages d'un dossier", pattern: new RegExp(`^/api/emails/messages\\?folderId=${ID}&skip=0&take=50$`), sanitize: sanitizeMessageList },
    { name: "fil de messages", pattern: new RegExp(`^/api/emails/(?!messages$|folders$|inbox-summary$|sync-status$)${ID}$`), sanitize: sanitizeThread },
    { name: "texte d'un message", pattern: new RegExp(`^/api/emails/messages/${ID}/body(\\?allowRemoteImages=true)?$`), sanitize: sanitizeMessageBody },
    { name: "liste de démarrage", pattern: /^\/api\/checklist$/, sanitize: (d) => pick(d, ["urssafAccount", "impotsProAccount", "activityQuestionnaire", "cfeInitialDeclaration", "rcpInsurance", "mediationChecked", "dedicatedBankAccount", "updatedAt"]) },
    { name: "clauses légales", pattern: /^\/api\/legal-clauses$/, sanitize: listOf((v) => pick(v, ["id", "kind", "title", "body", "required", "active", "audience", "position", "createdAt", "updatedAt"])) },
    { name: "numérotation", pattern: /^\/api\/numbering\/preview$/, sanitize: (d) => pick(d, ["templates", "previews"]) },
    { name: "agenda Google", pattern: /^\/api\/google\/calendar\/status$/, sanitize: (d) => pick(d, ["configured", "connected", "enabled"]) },
  ];
}

/** Chemin de copie : le paramètre anti-cache « t » du tableau de bord ne fait pas une lecture distincte. */
export function copyPathOf(path: string): string {
  if (!path.includes("t=")) return path;
  const [base, query] = path.split("?");
  if (!query) return path;
  const params = new URLSearchParams(query);
  if (!params.has("t")) return path;
  params.delete("t");
  const rest = params.toString();
  return rest ? `${base}?${rest}` : base!;
}
