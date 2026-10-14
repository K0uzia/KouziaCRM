import type { CompanySettings } from "@prisma/client";
import {
  HOSTINGER_MAIL_DEFAULTS,
  MAILPIT_MAIL_DEFAULTS,
  resolveSmtpEncryption,
} from "@/lib/settings/defaults.js";
import { secretMeta } from "@/lib/settings/secrets.js";

const OMIT = new Set([
  "smtpPassEncrypted",
  "imapPassEncrypted",
  "revolutMerchantApiKeyEncrypted",
  "revolutWebhookSecretEncrypted",
  "stripeSecretKeyEncrypted",
  "stripeWebhookSecretEncrypted",
  "googleCalendarRefreshTokenEncrypted",
  "githubTokenEncrypted",
]);

export type SettingsTabId =
  | "general"
  | "email"
  | "payments"
  | "reminders"
  | "identity"
  | "numbering"
  | "declarations"
  | "legal";

export type PublicCompanySettings = Omit<
  CompanySettings,
  | "smtpPassEncrypted"
  | "imapPassEncrypted"
  | "revolutMerchantApiKeyEncrypted"
  | "revolutWebhookSecretEncrypted"
  | "stripeSecretKeyEncrypted"
  | "stripeWebhookSecretEncrypted"
  | "googleCalendarRefreshTokenEncrypted"
  | "githubTokenEncrypted"
> & {
  secrets: {
    smtpPass: { set: boolean; hint: string | null };
    imapPass: { set: boolean; hint: string | null };
    stripeSecretKey: { set: boolean; hint: string | null };
    stripeWebhookSecret: { set: boolean; hint: string | null };
    googleCalendarRefreshToken: { set: boolean; hint: string | null };
    githubToken: { set: boolean; hint: string | null };
  };
  smtpEncryptionResolved: string;
  emailDefaults: typeof HOSTINGER_MAIL_DEFAULTS;
  emailPresets: {
    hostinger: typeof HOSTINGER_MAIL_DEFAULTS;
    mailpit: typeof MAILPIT_MAIL_DEFAULTS;
  };
  stripeWebhookUrl: string;
  stripeMode: "test" | "live" | null;
};

export function publicApiBaseUrl(): string {
  const raw =
    process.env.PUBLIC_API_ORIGIN?.trim() ||
    process.env.WEB_ORIGIN?.trim() ||
    `http://localhost:${process.env.API_PORT || "3001"}`;
  return raw.replace(/\/$/, "");
}

export function stripeWebhookUrl(): string {
  return `${publicApiBaseUrl()}/api/webhooks/stripe`;
}

export function toPublicSettings(settings: CompanySettings): PublicCompanySettings {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (OMIT.has(key)) continue;
    rest[key] = value;
  }

  // Mode enregistré avec la clé (stripeKeyMode) ; à défaut, déduit de l'indice.
  let stripeMode: "test" | "live" | null =
    settings.stripeKeyMode === "live" || settings.stripeKeyMode === "test" ? settings.stripeKeyMode : null;
  if (!stripeMode && settings.stripeSecretKeyHint) {
    // L'indice ne révèle pas le mode ; on le déduit si la clé est encore en clair côté save.
    // Mode exposé seulement via test-stripe après coup. Ici : null sauf hint sk_test/sk_live.
    const hint = settings.stripeSecretKeyHint;
    if (hint.includes("live")) stripeMode = "live";
    else if (hint.includes("test")) stripeMode = "test";
  }

  return {
    ...(rest as Omit<
      CompanySettings,
      | "smtpPassEncrypted"
      | "imapPassEncrypted"
      | "revolutMerchantApiKeyEncrypted"
      | "revolutWebhookSecretEncrypted"
      | "stripeSecretKeyEncrypted"
      | "stripeWebhookSecretEncrypted"
      | "googleCalendarRefreshTokenEncrypted"
      | "githubTokenEncrypted"
    >),
    secrets: {
      smtpPass: secretMeta(settings.smtpPassHint, settings.smtpPassEncrypted),
      imapPass: secretMeta(settings.imapPassHint, settings.imapPassEncrypted),
      stripeSecretKey: secretMeta(
        settings.stripeSecretKeyHint,
        settings.stripeSecretKeyEncrypted,
      ),
      stripeWebhookSecret: secretMeta(
        settings.stripeWebhookSecretHint,
        settings.stripeWebhookSecretEncrypted,
      ),
      googleCalendarRefreshToken: secretMeta(
        settings.googleCalendarRefreshTokenHint,
        settings.googleCalendarRefreshTokenEncrypted,
      ),
      githubToken: secretMeta(settings.githubTokenHint, settings.githubTokenEncrypted),
    },
    smtpEncryptionResolved: resolveSmtpEncryption({
      smtpEncryption: settings.smtpEncryption,
      smtpSecure: settings.smtpSecure,
    }),
    emailDefaults: HOSTINGER_MAIL_DEFAULTS,
    emailPresets: {
      hostinger: HOSTINGER_MAIL_DEFAULTS,
      mailpit: MAILPIT_MAIL_DEFAULTS,
    },
    stripeWebhookUrl: stripeWebhookUrl(),
    stripeMode,
  };
}
