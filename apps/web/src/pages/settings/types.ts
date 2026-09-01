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
  publicTrackingShowAmounts: boolean;
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
  latePenaltiesText: string;
  earlyPaymentDiscountText: string;
  paymentConditions: string;
  revolutMerchantMode: string;
  depositCount: number;
  depositPercent1Bps: number;
  depositPercent2Bps: number;
  depositPercent3Bps: number;
  paymentButtonLeadDays: number;
  projectMilestoneMidBps: number;
  reminderDepositMinus7Days: number;
  reminderDepositMinus1Days: number;
  reminderDepositPlus3Days: number;
  reminderDepositPlus10Days: number;
  reminderDepositMinus7Enabled: boolean;
  reminderDepositMinus1Enabled: boolean;
  reminderDepositPlus3Enabled: boolean;
  reminderDepositPlus10Enabled: boolean;
  secrets: {
    smtpPass: SecretMeta;
    imapPass: SecretMeta;
    revolutMerchantApiKey: SecretMeta;
    revolutWebhookSecret: SecretMeta;
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
  revolutWebhookUrl: string;
};

export type SettingsTabId =
  | "general"
  | "email"
  | "payments"
  | "reminders"
  | "identity"
  | "numbering"
  | "declarations"
  | "legal";

export const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: "general", label: "Général" },
  { id: "email", label: "Emails & Messagerie" },
  { id: "payments", label: "Paiements" },
  { id: "reminders", label: "Rappels" },
  { id: "identity", label: "Identité & Documents" },
  { id: "numbering", label: "Numérotation" },
  { id: "declarations", label: "Déclarations" },
  { id: "legal", label: "Conditions générales" },
];
