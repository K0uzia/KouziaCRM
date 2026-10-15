import type { CompanySettings, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { decryptOptional, encryptOptional } from "@/lib/crypto.js";
import { detectStripeMode } from "@/lib/stripe/client.js";
import { assertSecretKeyFormat, assertWebhookSecretFormat } from "@/lib/stripe/key-check.js";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";
import {
  ATTACHMENT_DEFAULTS,
  inferSmtpEncryptionFromEnv,
  isHexColor,
  isSmtpEncryption,
  resolveSmtpEncryption,
  smtpSecureFromEncryption,
  type SmtpEncryption,
} from "@/lib/settings/defaults.js";
import { applyEncryptedSecret } from "@/lib/settings/secrets.js";
import { diffChangedFields, logSettingsAudit, type AuditActor } from "@/lib/settings/audit.js";
import { toPublicSettings, type SettingsTabId } from "@/lib/settings/public.js";

export { toPublicSettings, type SettingsTabId } from "@/lib/settings/public.js";
export type { AuditActor } from "@/lib/settings/audit.js";

const emptyToNull = (v: string | null | undefined) => {
  if (v === undefined) return undefined;
  const t = v?.trim() ?? "";
  return t.length ? t : null;
};

async function persist(
  current: CompanySettings,
  data: Prisma.CompanySettingsUpdateInput,
  tab: SettingsTabId,
  actor?: AuditActor | null,
  extraAuditFields: string[] = [],
): Promise<CompanySettings> {
  const updated = await prisma.companySettings.update({
    where: { id: current.id },
    data,
  });
  invalidateCompanySettingsCache();
  const changed = [
    ...diffChangedFields(
      current as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
    ),
    ...extraAuditFields,
  ];
  await logSettingsAudit({ actor, tab, fields: changed });
  return updated;
}

export type GeneralPatch = {
  legalName?: string;
  tradeName?: string | null;
  siren?: string;
  siret?: string;
  apeCode?: string;
  addressLine1?: string;
  addressLine2?: string | null;
  postalCode?: string;
  city?: string;
  country?: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  legalForm?: string | null;
  rcsMention?: string | null;
  vatIntraNumber?: string | null;
  decennaleInsurer?: string | null;
  decennalePolicyNumber?: string | null;
  decennaleCoverageZone?: string | null;
  publicTrackingShowAmounts?: boolean;
  reviewInviteEnabled?: boolean;
  googleReviewUrl?: string | null;
  clientPortalUrl?: string | null;
  inpiUrl?: string | null;
};

export async function saveGeneralTab(
  patch: GeneralPatch,
  actor?: AuditActor | null,
): Promise<CompanySettings> {
  const current = await getCompanySettings();
  return persist(
    current,
    {
      ...(patch.legalName !== undefined ? { legalName: patch.legalName } : {}),
      ...(patch.tradeName !== undefined ? { tradeName: emptyToNull(patch.tradeName) } : {}),
      ...(patch.siren !== undefined ? { siren: patch.siren } : {}),
      ...(patch.siret !== undefined ? { siret: patch.siret } : {}),
      ...(patch.apeCode !== undefined ? { apeCode: patch.apeCode } : {}),
      ...(patch.addressLine1 !== undefined ? { addressLine1: patch.addressLine1 } : {}),
      ...(patch.addressLine2 !== undefined ? { addressLine2: emptyToNull(patch.addressLine2) } : {}),
      ...(patch.postalCode !== undefined ? { postalCode: patch.postalCode } : {}),
      ...(patch.city !== undefined ? { city: patch.city } : {}),
      ...(patch.country !== undefined ? { country: patch.country } : {}),
      ...(patch.email !== undefined ? { email: emptyToNull(patch.email) } : {}),
      ...(patch.phone !== undefined ? { phone: emptyToNull(patch.phone) } : {}),
      ...(patch.website !== undefined ? { website: emptyToNull(patch.website) } : {}),
      ...(patch.legalForm !== undefined ? { legalForm: emptyToNull(patch.legalForm) } : {}),
      ...(patch.rcsMention !== undefined ? { rcsMention: emptyToNull(patch.rcsMention) } : {}),
      ...(patch.vatIntraNumber !== undefined
        ? { vatIntraNumber: emptyToNull(patch.vatIntraNumber) }
        : {}),
      ...(patch.decennaleInsurer !== undefined
        ? { decennaleInsurer: emptyToNull(patch.decennaleInsurer) }
        : {}),
      ...(patch.decennalePolicyNumber !== undefined
        ? { decennalePolicyNumber: emptyToNull(patch.decennalePolicyNumber) }
        : {}),
      ...(patch.decennaleCoverageZone !== undefined
        ? { decennaleCoverageZone: emptyToNull(patch.decennaleCoverageZone) }
        : {}),
      ...(patch.publicTrackingShowAmounts !== undefined
        ? { publicTrackingShowAmounts: patch.publicTrackingShowAmounts }
        : {}),
      ...(patch.reviewInviteEnabled !== undefined ? { reviewInviteEnabled: patch.reviewInviteEnabled } : {}),
      ...(patch.googleReviewUrl !== undefined ? { googleReviewUrl: emptyToNull(patch.googleReviewUrl) } : {}),
      ...(patch.clientPortalUrl !== undefined
        ? { clientPortalUrl: emptyToNull(patch.clientPortalUrl) }
        : {}),
      ...(patch.inpiUrl !== undefined ? { inpiUrl: emptyToNull(patch.inpiUrl) } : {}),
    },
    "general",
    actor,
  );
}

export type EmailPatch = {
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpEncryption?: SmtpEncryption;
  smtpUser?: string | null;
  smtpPass?: string | null;
  smtpFrom?: string | null;
  smtpFromName?: string | null;
  smtpReplyTo?: string | null;
  transactionalFrom?: string | null;
  emailThrottlePerMinute?: number;
  imapHost?: string | null;
  imapPort?: number | null;
  imapSecure?: boolean;
  imapUser?: string | null;
  imapPass?: string | null;
  imapMailbox?: string | null;
  imapPollIntervalMinutes?: number;
  imapFolderInbox?: string | null;
  imapFolderSent?: string | null;
  imapFolderDrafts?: string | null;
  imapFolderTrash?: string | null;
  imapFolderJunk?: string | null;
  imapFolderArchive?: string | null;
  emailSignatureHtml?: string | null;
  emailBrowserNotifications?: boolean;
  attachmentMaxFileMb?: number;
  attachmentMaxMessageMb?: number;
};

export async function saveEmailTab(
  patch: EmailPatch,
  actor?: AuditActor | null,
): Promise<CompanySettings> {
  const current = await getCompanySettings();
  const smtpSecret = applyEncryptedSecret(
    current.smtpPassEncrypted,
    current.smtpPassHint,
    patch.smtpPass,
  );
  const imapSecret = applyEncryptedSecret(
    current.imapPassEncrypted,
    current.imapPassHint,
    patch.imapPass,
  );

  const encryption =
    patch.smtpEncryption !== undefined
      ? patch.smtpEncryption
      : resolveSmtpEncryption(current);

  const fileMb = patch.attachmentMaxFileMb ?? current.attachmentMaxFileMb;
  const msgMb = patch.attachmentMaxMessageMb ?? current.attachmentMaxMessageMb;
  if (fileMb < 1 || fileMb > ATTACHMENT_DEFAULTS.maxFileMbCap) {
    throw Object.assign(new Error(`Taille max par fichier : 1 à ${ATTACHMENT_DEFAULTS.maxFileMbCap} Mo`), {
      statusCode: 400,
    });
  }
  if (msgMb < 1 || msgMb > ATTACHMENT_DEFAULTS.maxMessageMbCap) {
    throw Object.assign(
      new Error(`Taille max par message : 1 à ${ATTACHMENT_DEFAULTS.maxMessageMbCap} Mo`),
      { statusCode: 400 },
    );
  }
  if (msgMb < fileMb) {
    throw Object.assign(new Error("Le plafond par message doit être ≥ le plafond par fichier"), {
      statusCode: 400,
    });
  }

  const extra: string[] = [];
  if (smtpSecret.changed) extra.push("smtpPass");
  if (imapSecret.changed) extra.push("imapPass");

  return persist(
    current,
    {
      ...(patch.smtpHost !== undefined ? { smtpHost: emptyToNull(patch.smtpHost) } : {}),
      ...(patch.smtpPort !== undefined ? { smtpPort: patch.smtpPort } : {}),
      smtpEncryption: encryption,
      smtpSecure: smtpSecureFromEncryption(encryption),
      ...(patch.smtpUser !== undefined ? { smtpUser: emptyToNull(patch.smtpUser) } : {}),
      smtpPassEncrypted: smtpSecret.encrypted,
      smtpPassHint: smtpSecret.hint,
      ...(patch.smtpFrom !== undefined ? { smtpFrom: emptyToNull(patch.smtpFrom) } : {}),
      ...(patch.smtpFromName !== undefined ? { smtpFromName: emptyToNull(patch.smtpFromName) } : {}),
      ...(patch.smtpReplyTo !== undefined ? { smtpReplyTo: emptyToNull(patch.smtpReplyTo) } : {}),
      ...(patch.transactionalFrom !== undefined ? { transactionalFrom: emptyToNull(patch.transactionalFrom) } : {}),
      ...(patch.emailThrottlePerMinute !== undefined
        ? { emailThrottlePerMinute: patch.emailThrottlePerMinute }
        : {}),
      ...(patch.imapHost !== undefined ? { imapHost: emptyToNull(patch.imapHost) } : {}),
      ...(patch.imapPort !== undefined ? { imapPort: patch.imapPort } : {}),
      ...(patch.imapSecure !== undefined ? { imapSecure: patch.imapSecure } : {}),
      ...(patch.imapUser !== undefined ? { imapUser: emptyToNull(patch.imapUser) } : {}),
      imapPassEncrypted: imapSecret.encrypted,
      imapPassHint: imapSecret.hint,
      ...(patch.imapMailbox !== undefined
        ? { imapMailbox: patch.imapMailbox?.trim() || "INBOX" }
        : {}),
      ...(patch.imapPollIntervalMinutes !== undefined
        ? { imapPollIntervalMinutes: patch.imapPollIntervalMinutes }
        : {}),
      ...(patch.imapFolderInbox !== undefined
        ? { imapFolderInbox: emptyToNull(patch.imapFolderInbox) }
        : {}),
      ...(patch.imapFolderSent !== undefined
        ? { imapFolderSent: emptyToNull(patch.imapFolderSent) }
        : {}),
      ...(patch.imapFolderDrafts !== undefined
        ? { imapFolderDrafts: emptyToNull(patch.imapFolderDrafts) }
        : {}),
      ...(patch.imapFolderTrash !== undefined
        ? { imapFolderTrash: emptyToNull(patch.imapFolderTrash) }
        : {}),
      ...(patch.imapFolderJunk !== undefined
        ? { imapFolderJunk: emptyToNull(patch.imapFolderJunk) }
        : {}),
      ...(patch.imapFolderArchive !== undefined
        ? { imapFolderArchive: emptyToNull(patch.imapFolderArchive) }
        : {}),
      ...(patch.emailSignatureHtml !== undefined
        ? { emailSignatureHtml: emptyToNull(patch.emailSignatureHtml) }
        : {}),
      ...(patch.emailBrowserNotifications !== undefined
        ? { emailBrowserNotifications: patch.emailBrowserNotifications }
        : {}),
      attachmentMaxFileMb: fileMb,
      attachmentMaxMessageMb: msgMb,
    },
    "email",
    actor,
    extra,
  );
}

export type PaymentsPatch = {
  bankIban?: string | null;
  bankBic?: string | null;
  bankAccountHolder?: string | null;
  bankName?: string | null;
  stripeSecretKey?: string | null;
  stripeWebhookSecret?: string | null;
  /** Clé d'un autre mode (test ou live) que la précédente : enregistrée seulement si confirmé. */
  confirmStripeModeChange?: boolean;
  depositCount?: number;
  depositPercent1Bps?: number;
  depositPercent2Bps?: number;
  depositPercent3Bps?: number;
  split3Percent1Bps?: number;
  split3Percent2Bps?: number;
  split3Percent3Bps?: number;
  split3MinTotalCents?: number;
  paymentChoiceDefault?: boolean;
  split3Step2TriggerText?: string;
  paymentButtonLeadDays?: number;
  projectMilestoneMidBps?: number;
  annualFreeMonths?: number;
  moduleBankEnabled?: boolean;
  moduleSubscriptionsEnabled?: boolean;
  moduleStripeEnabled?: boolean;
};

/** Message affiché avant d'enregistrer une clé d'un autre mode. */
export function stripeModeChangeMessage(from: "test" | "live", to: "test" | "live"): string {
  return `Cette clé est en mode ${to}, la précédente était en mode ${from}. En mode ${to}, les prestations, clients et abonnements liés en mode ${from} ne seront ni modifiés ni archivés, mais leurs paiements et prélèvements ne pourront pas être gérés depuis l'ERP tant que la clé ${from} n'est pas remise. Les webhooks ${from} seront ignorés : pensez au secret de signature ${to}.`;
}

export async function savePaymentsTab(
  patch: PaymentsPatch,
  actor?: AuditActor | null,
): Promise<CompanySettings> {
  const current = await getCompanySettings();
  // Clé et secret collés : nettoyés et contrôlés (clé publiable, secret inversé…) avant tout.
  const typedKey = patch.stripeSecretKey?.trim() ? assertSecretKeyFormat(patch.stripeSecretKey) : patch.stripeSecretKey;
  const typedWebhook = patch.stripeWebhookSecret?.trim()
    ? assertWebhookSecretFormat(patch.stripeWebhookSecret)
    : patch.stripeWebhookSecret;
  const stripeKey = applyEncryptedSecret(
    current.stripeSecretKeyEncrypted,
    current.stripeSecretKeyHint,
    typedKey,
  );
  const stripeWebhook = applyEncryptedSecret(
    current.stripeWebhookSecretEncrypted,
    current.stripeWebhookSecretHint,
    typedWebhook,
  );

  // Changement de mode de clé (live vers test ou l'inverse) : confirmation explicite. Les objets
  // Stripe enregistrés (prestations, clients, abonnements) n'existent que dans leur mode.
  const newKey = typedKey?.trim();
  const newMode = newKey ? detectStripeMode(newKey) : null;
  const previousKey = decryptOptional(current.stripeSecretKeyEncrypted);
  const storedMode = current.stripeKeyMode === "live" || current.stripeKeyMode === "test" ? current.stripeKeyMode : null;
  const previousMode = storedMode ?? (previousKey ? detectStripeMode(previousKey) : null);
  if (newMode && previousMode && newMode !== previousMode && !patch.confirmStripeModeChange) {
    throw Object.assign(new Error(stripeModeChangeMessage(previousMode, newMode)), {
      statusCode: 409,
      code: "stripe_mode_change",
    });
  }

  const p1 = patch.depositPercent1Bps ?? current.depositPercent1Bps;
  const p2 = patch.depositPercent2Bps ?? current.depositPercent2Bps;
  if (p1 + p2 !== 10000) {
    throw Object.assign(
      new Error("La somme des pourcentages acompte + solde doit faire 100 %"),
      {
        statusCode: 400,
      },
    );
  }

  const t1 = patch.split3Percent1Bps ?? current.split3Percent1Bps;
  const t2 = patch.split3Percent2Bps ?? current.split3Percent2Bps;
  const t3 = patch.split3Percent3Bps ?? current.split3Percent3Bps;
  if (t1 + t2 + t3 !== 10000) {
    throw Object.assign(new Error("Paiement en 3 fois : la somme des trois pourcentages doit faire 100 %"), {
      statusCode: 400,
    });
  }

  const extra: string[] = [];
  if (stripeKey.changed) extra.push("stripeSecretKey");
  if (stripeWebhook.changed) extra.push("stripeWebhookSecret");

  const iban =
    patch.bankIban !== undefined
      ? patch.bankIban?.replace(/\s+/g, "").toUpperCase() || null
      : undefined;
  const bic =
    patch.bankBic !== undefined
      ? patch.bankBic?.replace(/\s+/g, "").toUpperCase() || null
      : undefined;

  return persist(
    current,
    {
      ...(iban !== undefined ? { bankIban: iban } : {}),
      ...(bic !== undefined ? { bankBic: bic } : {}),
      ...(patch.bankAccountHolder !== undefined
        ? { bankAccountHolder: emptyToNull(patch.bankAccountHolder) }
        : {}),
      ...(patch.bankName !== undefined ? { bankName: emptyToNull(patch.bankName) } : {}),
      stripeSecretKeyEncrypted: stripeKey.encrypted,
      stripeSecretKeyHint: stripeKey.hint,
      ...(newMode ? { stripeKeyMode: newMode } : {}),
      stripeWebhookSecretEncrypted: stripeWebhook.encrypted,
      stripeWebhookSecretHint: stripeWebhook.hint,
      depositCount: 2,
      depositPercent1Bps: p1,
      depositPercent2Bps: p2,
      depositPercent3Bps: 0,
      split3Percent1Bps: t1,
      split3Percent2Bps: t2,
      split3Percent3Bps: t3,
      ...(patch.split3MinTotalCents !== undefined ? { split3MinTotalCents: patch.split3MinTotalCents } : {}),
      ...(patch.paymentChoiceDefault !== undefined ? { paymentChoiceDefault: patch.paymentChoiceDefault } : {}),
      ...(patch.split3Step2TriggerText !== undefined
        ? { split3Step2TriggerText: patch.split3Step2TriggerText }
        : {}),
      ...(patch.paymentButtonLeadDays !== undefined
        ? { paymentButtonLeadDays: patch.paymentButtonLeadDays }
        : {}),
      ...(patch.projectMilestoneMidBps !== undefined
        ? { projectMilestoneMidBps: patch.projectMilestoneMidBps }
        : {}),
      ...(patch.annualFreeMonths !== undefined ? { annualFreeMonths: patch.annualFreeMonths } : {}),
      ...(patch.moduleBankEnabled !== undefined
        ? { moduleBankEnabled: patch.moduleBankEnabled }
        : {}),
      ...(patch.moduleSubscriptionsEnabled !== undefined
        ? { moduleSubscriptionsEnabled: patch.moduleSubscriptionsEnabled }
        : {}),
      ...(patch.moduleStripeEnabled !== undefined
        ? { moduleStripeEnabled: patch.moduleStripeEnabled }
        : {}),
    },
    "payments",
    actor,
    extra,
  );
}

export type RemindersPatch = {
  reminderQuoteDays?: number;
  reminderInvoiceDays?: number;
  nonRenewalNoticeDays?: number;
  reminderDepositMinus7Days?: number;
  reminderDepositMinus1Days?: number;
  reminderDepositPlus3Days?: number;
  reminderDepositPlus10Days?: number;
  reminderDepositMinus7Enabled?: boolean;
  reminderDepositMinus1Enabled?: boolean;
  reminderDepositPlus3Enabled?: boolean;
  reminderDepositPlus10Enabled?: boolean;
};

export async function saveRemindersTab(
  patch: RemindersPatch,
  actor?: AuditActor | null,
): Promise<CompanySettings> {
  const current = await getCompanySettings();
  return persist(current, { ...patch }, "reminders", actor);
}

export type IdentityPatch = {
  brandPrimaryColor?: string;
  brandSecondaryColor?: string;
  pdfFooterText?: string | null;
  vatMention?: string;
  latePenaltiesText?: string;
  earlyPaymentDiscountText?: string;
  paymentConditions?: string;
  brandLogoPath?: string | null;
  mediationClause?: string | null;
  cgvPublished?: boolean;
  cgvUrl?: string | null;
  cgvVersion?: string | null;
  withdrawalExpressRequestText?: string;
};

export async function saveIdentityTab(
  patch: IdentityPatch,
  actor?: AuditActor | null,
): Promise<CompanySettings> {
  const current = await getCompanySettings();
  // CGV publiées : le site exige leur acceptation à la signature, il faut donc un lien et une version.
  const cgvPublished = patch.cgvPublished ?? current.cgvPublished;
  const cgvUrl = patch.cgvUrl !== undefined ? emptyToNull(patch.cgvUrl) : current.cgvUrl;
  const cgvVersion = patch.cgvVersion !== undefined ? emptyToNull(patch.cgvVersion) : current.cgvVersion;
  if (cgvPublished && (!cgvUrl || !cgvVersion)) {
    throw Object.assign(new Error("CGV publiées : renseignez leur adresse et leur version."), { statusCode: 400 });
  }
  if (patch.brandPrimaryColor !== undefined && !isHexColor(patch.brandPrimaryColor)) {
    throw Object.assign(new Error("Couleur primaire invalide (hex #rrggbb)"), { statusCode: 400 });
  }
  if (patch.brandSecondaryColor !== undefined && !isHexColor(patch.brandSecondaryColor)) {
    throw Object.assign(new Error("Couleur secondaire invalide (hex #rrggbb)"), { statusCode: 400 });
  }
  return persist(
    current,
    {
      ...(patch.brandPrimaryColor !== undefined
        ? { brandPrimaryColor: patch.brandPrimaryColor.toLowerCase() }
        : {}),
      ...(patch.brandSecondaryColor !== undefined
        ? { brandSecondaryColor: patch.brandSecondaryColor.toLowerCase() }
        : {}),
      ...(patch.pdfFooterText !== undefined ? { pdfFooterText: emptyToNull(patch.pdfFooterText) } : {}),
      ...(patch.vatMention !== undefined ? { vatMention: patch.vatMention } : {}),
      ...(patch.latePenaltiesText !== undefined ? { latePenaltiesText: patch.latePenaltiesText } : {}),
      ...(patch.earlyPaymentDiscountText !== undefined
        ? { earlyPaymentDiscountText: patch.earlyPaymentDiscountText }
        : {}),
      ...(patch.paymentConditions !== undefined ? { paymentConditions: patch.paymentConditions } : {}),
      ...(patch.brandLogoPath !== undefined ? { brandLogoPath: patch.brandLogoPath } : {}),
      ...(patch.mediationClause !== undefined ? { mediationClause: emptyToNull(patch.mediationClause) } : {}),
      ...(patch.cgvPublished !== undefined ? { cgvPublished: patch.cgvPublished } : {}),
      ...(patch.cgvUrl !== undefined ? { cgvUrl: emptyToNull(patch.cgvUrl) } : {}),
      ...(patch.cgvVersion !== undefined ? { cgvVersion: emptyToNull(patch.cgvVersion) } : {}),
      ...(patch.withdrawalExpressRequestText !== undefined
        ? { withdrawalExpressRequestText: patch.withdrawalExpressRequestText }
        : {}),
    },
    "identity",
    actor,
  );
}

export type DeclarationsPatch = {
  urssafPeriodicity?: "MONTHLY" | "QUARTERLY";
  treasuryRateBps?: number;
  placementRateBps?: number;
  lastIncomeTaxDeclaredYear?: number | null;
  cfeAmountCents?: number;
  b2cActivity?: boolean;
  incomeTaxReminderMonth?: number;
  incomeTaxReminderDay?: number;
  businessStartDate?: Date | null;
  rneRegistrationDate?: Date | null;
  obligationReminderEmail?: string;
  obligationEmailRemindersEnabled?: boolean;
};

export async function saveDeclarationsTab(
  patch: DeclarationsPatch,
  actor?: AuditActor | null,
): Promise<CompanySettings> {
  const current = await getCompanySettings();
  return persist(
    current,
    {
      ...patch,
      urssafDeadlineDay: 15,
    },
    "declarations",
    actor,
  );
}

/** Copie SMTP_* et IMAP_* du .env vers la base si les champs DB sont vides. */
export async function hydrateSettingsFromEnv(): Promise<void> {
  const current = await prisma.companySettings.findFirst();
  if (!current) return;

  const data: Prisma.CompanySettingsUpdateInput = {};

  if (!current.smtpHost && process.env.SMTP_HOST) data.smtpHost = process.env.SMTP_HOST;
  if (current.smtpPort == null && process.env.SMTP_PORT) {
    data.smtpPort = Number(process.env.SMTP_PORT);
  }
  if (!current.smtpUser && process.env.SMTP_USER) data.smtpUser = process.env.SMTP_USER;
  if (!current.smtpFrom && process.env.SMTP_FROM) data.smtpFrom = process.env.SMTP_FROM;
  if (!current.smtpPassEncrypted && process.env.SMTP_PASS) {
    data.smtpPassEncrypted = encryptOptional(process.env.SMTP_PASS);
    data.smtpPassHint = process.env.SMTP_PASS.slice(-4)
      ? `••••••••${process.env.SMTP_PASS.slice(-4)}`
      : "••••";
  }
  if (!current.smtpEncryption && process.env.SMTP_SECURE !== undefined) {
    const host = process.env.SMTP_HOST ?? current.smtpHost;
    const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : current.smtpPort;
    const encryption = inferSmtpEncryptionFromEnv({
      host,
      port,
      secure: process.env.SMTP_SECURE,
    });
    data.smtpEncryption = encryption;
    data.smtpSecure = encryption === "SSL";
  }

  if (!current.imapHost && process.env.IMAP_HOST) data.imapHost = process.env.IMAP_HOST;
  if (current.imapPort == null && process.env.IMAP_PORT) {
    data.imapPort = Number(process.env.IMAP_PORT);
  }
  if (!current.imapUser && process.env.IMAP_USER) data.imapUser = process.env.IMAP_USER;
  if (!current.imapPassEncrypted && process.env.IMAP_PASS) {
    data.imapPassEncrypted = encryptOptional(process.env.IMAP_PASS);
    data.imapPassHint = process.env.IMAP_PASS.slice(-4)
      ? `••••••••${process.env.IMAP_PASS.slice(-4)}`
      : "••••";
  }
  if (process.env.IMAP_MAILBOX && current.imapMailbox === "INBOX") {
    data.imapMailbox = process.env.IMAP_MAILBOX;
  }
  if (process.env.IMAP_SECURE !== undefined && current.imapHost == null && process.env.IMAP_HOST) {
    data.imapSecure = process.env.IMAP_SECURE !== "false";
  }

  if (!current.clientPortalUrl && process.env.CLIENT_PORTAL_URL) {
    data.clientPortalUrl = process.env.CLIENT_PORTAL_URL.trim();
  }

  if (Object.keys(data).length === 0) return;
  await prisma.companySettings.update({ where: { id: current.id }, data });
  invalidateCompanySettingsCache();
}

export { isSmtpEncryption };
