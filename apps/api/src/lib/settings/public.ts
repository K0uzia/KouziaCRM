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
> & {
  secrets: {
    smtpPass: { set: boolean; hint: string | null };
    imapPass: { set: boolean; hint: string | null };
    revolutMerchantApiKey: { set: boolean; hint: string | null };
    revolutWebhookSecret: { set: boolean; hint: string | null };
  };
  smtpEncryptionResolved: string;
  emailDefaults: typeof HOSTINGER_MAIL_DEFAULTS;
  emailPresets: {
    hostinger: typeof HOSTINGER_MAIL_DEFAULTS;
    mailpit: typeof MAILPIT_MAIL_DEFAULTS;
  };
  revolutWebhookUrl: string;
};

export function publicApiBaseUrl(): string {
  const raw =
    process.env.PUBLIC_API_ORIGIN?.trim() ||
    process.env.WEB_ORIGIN?.trim() ||
    `http://localhost:${process.env.API_PORT || "3001"}`;
  return raw.replace(/\/$/, "");
}

export function revolutWebhookUrl(): string {
  return `${publicApiBaseUrl()}/api/webhooks/revolut`;
}

export function toPublicSettings(settings: CompanySettings): PublicCompanySettings {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (OMIT.has(key)) continue;
    rest[key] = value;
  }
  return {
    ...(rest as Omit<
      CompanySettings,
      | "smtpPassEncrypted"
      | "imapPassEncrypted"
      | "revolutMerchantApiKeyEncrypted"
      | "revolutWebhookSecretEncrypted"
    >),
    secrets: {
      smtpPass: secretMeta(settings.smtpPassHint, settings.smtpPassEncrypted),
      imapPass: secretMeta(settings.imapPassHint, settings.imapPassEncrypted),
      revolutMerchantApiKey: secretMeta(
        settings.revolutMerchantApiKeyHint,
        settings.revolutMerchantApiKeyEncrypted,
      ),
      revolutWebhookSecret: secretMeta(
        settings.revolutWebhookSecretHint,
        settings.revolutWebhookSecretEncrypted,
      ),
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
    revolutWebhookUrl: revolutWebhookUrl(),
  };
}
