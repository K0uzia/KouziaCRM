export type SecretMeta = { set: boolean; hint: string | null };

export type PublicSettings = {
  id: string;
  legalName: string;
  tradeName: string | null;
  siren: string;
  siret: string;
  apeCode: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  country: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  vatMention: string;
  legalForm: string | null;
  rcsMention: string | null;
  vatIntraNumber: string | null;
  decennaleInsurer: string | null;
  decennalePolicyNumber: string | null;
  decennaleCoverageZone: string | null;
  urssafPeriodicity: string;
  treasuryRateBps: number;
  placementRateBps: number;
  reminderQuoteDays: number;
  reminderInvoiceDays: number;
  nonRenewalNoticeDays: number;
  publicTrackingShowAmounts: boolean;
  reviewInviteEnabled: boolean;
  googleReviewUrl: string | null;
  clientPortalUrl: string | null;
  businessStartDate: string | null;
  rneRegistrationDate: string | null;
  lastIncomeTaxDeclaredYear: number | null;
  cfeAmountCents: number;
  bankIban: string | null;
  bankBic: string | null;
  bankAccountHolder: string | null;
  bankName: string | null;
  b2cActivity: boolean;
  incomeTaxReminderMonth: number;
  incomeTaxReminderDay: number;
  inpiUrl: string | null;
  invoiceNumberTemplate: string;
  quoteNumberTemplate: string;
  creditNoteNumberTemplate: string;
  numberCounterWidth: number;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpEncryption: string | null;
  smtpEncryptionResolved: string;
  smtpUser: string | null;
  smtpFrom: string | null;
  smtpFromName: string | null;
  smtpReplyTo: string | null;
  transactionalFrom: string | null;
  emailThrottlePerMinute: number;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean;
  imapUser: string | null;
  imapMailbox: string;
  imapPollIntervalMinutes: number;
  attachmentMaxFileMb: number;
  attachmentMaxMessageMb: number;
  brandPrimaryColor: string;
  brandSecondaryColor: string;
  brandLogoPath: string | null;
  pdfFooterText: string | null;
  /** Mention du médiateur de la consommation (PDF des clients particuliers). */
  mediationClause: string | null;
  /** CGV publiées sur le site : acceptation à la signature, lien et version sur les devis. */
  cgvPublished: boolean;
  cgvUrl: string | null;
  cgvVersion: string | null;
  /** Libellé de la case « exécution avant la fin du délai de rétractation » (particuliers). */
  withdrawalExpressRequestText: string;
  latePenaltiesText: string;
  earlyPaymentDiscountText: string;
  paymentConditions: string;
  depositCount: number;
  depositPercent1Bps: number;
  depositPercent2Bps: number;
  depositPercent3Bps: number;
  split3Percent1Bps: number;
  split3Percent2Bps: number;
  split3Percent3Bps: number;
  split3MinTotalCents: number;
  paymentChoiceDefault: boolean;
  split3Step2TriggerText: string;
  paymentButtonLeadDays: number;
  annualFreeMonths?: number;
  projectMilestoneMidBps: number;
  moduleBankEnabled: boolean;
  moduleSubscriptionsEnabled: boolean;
  moduleStripeEnabled: boolean;
  reminderDepositMinus7Days: number;
  reminderDepositMinus1Days: number;
  reminderDepositPlus3Days: number;
  reminderDepositPlus10Days: number;
  reminderDepositMinus7Enabled: boolean;
  reminderDepositMinus1Enabled: boolean;
  reminderDepositPlus3Enabled: boolean;
  reminderDepositPlus10Enabled: boolean;
  googleCalendarEnabled: boolean;
  googleCalendarConnectedEmail: string | null;
  obligationReminderEmail: string;
  obligationEmailRemindersEnabled: boolean;
  /** Signature des e-mails (HTML assaini par l'API) ; null : signature par défaut. */
  emailSignatureHtml: string | null;
  secrets: {
    smtpPass: SecretMeta;
    imapPass: SecretMeta;
    stripeSecretKey: SecretMeta;
    stripeWebhookSecret: SecretMeta;
    googleCalendarRefreshToken: SecretMeta;
  };
  emailDefaults: {
    smtpHost: string;
    smtpPort: number;
    smtpEncryption: string;
    smtpUser: string;
    smtpFromName: string;
    smtpFrom: string;
    smtpReplyTo: string;
    imapHost: string;
    imapPort: number;
    imapSecure: boolean;
    imapUser: string;
    imapMailbox: string;
  };
  emailPresets: {
    hostinger: PublicSettings["emailDefaults"];
    mailpit: PublicSettings["emailDefaults"];
  };
  stripeWebhookUrl: string;
  stripeMode: "test" | "live" | null;
  /** Couleurs réellement imprimées et charte Kouzia (API : lib/brand.ts). */
  brand?: {
    primary: string;
    secondary: string;
    kouziaPrimary: string;
    kouziaSecondary: string;
    legacyDefaults: string[];
  };
};

export type SettingsTabId =
  | "general"
  | "email"
  | "payments"
  | "reminders"
  | "identity"
  | "numbering"
  | "declarations"
  | "legal"
  | "notifications"
  | "security";

export const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: "general", label: "Identité" },
  { id: "email", label: "Emails" },
  { id: "payments", label: "Paiements" },
  { id: "reminders", label: "Rappels" },
  { id: "identity", label: "Charte des documents" },
  { id: "numbering", label: "Numérotation" },
  { id: "declarations", label: "Fiscalité" },
  { id: "legal", label: "Mentions légales" },
  { id: "notifications", label: "Notifications" },
  { id: "security", label: "Sécurité" },
];
