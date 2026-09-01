import { encryptOptional } from "@/lib/crypto.js";

const SECRET_FIELD_NAMES = [
  "smtpPassEncrypted",
  "imapPassEncrypted",
  "revolutMerchantApiKeyEncrypted",
  "revolutWebhookSecretEncrypted",
] as const;

export type SecretFieldName = (typeof SECRET_FIELD_NAMES)[number];

export function isSecretColumn(key: string): boolean {
  return (SECRET_FIELD_NAMES as readonly string[]).includes(key);
}

export function secretHint(plaintext: string): string {
  const t = plaintext.trim();
  if (t.length === 0) return "";
  if (t.length < 4) return "••••";
  return `••••••••${t.slice(-4)}`;
}

export type SecretMeta = {
  set: boolean;
  hint: string | null;
};

export function secretMeta(hint: string | null | undefined, encrypted: string | null | undefined): SecretMeta {
  const set = Boolean(encrypted);
  return { set, hint: set ? hint || "••••••••" : null };
}

/**
 * Champ secret : vide / omis = conserver. Nouvelle valeur = rechiffrer.
 * Ne vide jamais un secret existant via une chaîne vide.
 */
export function applyEncryptedSecret(
  currentEncrypted: string | null,
  currentHint: string | null,
  incoming: string | undefined | null,
): { encrypted: string | null; hint: string | null; changed: boolean } {
  if (incoming === undefined || incoming === null || incoming === "") {
    return { encrypted: currentEncrypted, hint: currentHint, changed: false };
  }
  return {
    encrypted: encryptOptional(incoming),
    hint: secretHint(incoming),
    changed: true,
  };
}
