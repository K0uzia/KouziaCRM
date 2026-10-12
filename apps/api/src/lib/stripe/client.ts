import Stripe from "stripe";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { assertSecretKeyFormat, lengthHint } from "@/lib/stripe/key-check.js";

export type StripeMode = "test" | "live";

export class StripeConfigError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 503) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function detectStripeMode(secretKey: string): StripeMode {
  if (secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_")) return "live";
  return "test";
}

export async function getStripeConfig(): Promise<{
  secretKey: string;
  webhookSecret: string | null;
  mode: StripeMode;
  enabled: boolean;
}> {
  const settings = await getCompanySettings();
  const secretKey = decryptOptional(settings.stripeSecretKeyEncrypted);
  if (!secretKey) {
    throw new StripeConfigError("Clé secrète Stripe absente (Réglages > Paiements)");
  }
  return {
    secretKey,
    webhookSecret: decryptOptional(settings.stripeWebhookSecretEncrypted),
    mode: detectStripeMode(secretKey),
    enabled: settings.moduleStripeEnabled,
  };
}

/** Client Stripe configuré depuis les réglages. */
export async function getStripe(): Promise<Stripe> {
  const { secretKey } = await getStripeConfig();
  return new Stripe(secretKey);
}

export async function assertStripeEnabled(): Promise<void> {
  const settings = await getCompanySettings();
  if (!settings.moduleStripeEnabled) {
    throw new StripeConfigError(
      "Le module Stripe n'est pas activé (Réglages > Paiements).",
      409,
    );
  }
  const key = decryptOptional(settings.stripeSecretKeyEncrypted);
  if (!key) {
    throw new StripeConfigError("Clé secrète Stripe absente (Réglages > Paiements).", 409);
  }
}

/** Ping minimal : liste 1 customer pour valider la clé. */
/**
 * Ping minimal (liste 1 customer). Clé saisie (pas encore enregistrée) si fournie, sinon la clé
 * enregistrée. Erreurs en clair : format de la clé, ou refus de Stripe avec la longueur suspecte.
 */
export async function testStripeConnection(typedKey?: string): Promise<{ ok: true; mode: StripeMode; tested: "saisie" | "enregistrée" }> {
  const secretKey = typedKey?.trim() ? assertSecretKeyFormat(typedKey) : (await getStripeConfig()).secretKey;
  try {
    await new Stripe(secretKey).customers.list({ limit: 1 });
  } catch (e) {
    if ((e as { type?: string }).type === "StripeAuthenticationError") {
      throw new StripeConfigError(
        `Stripe refuse cette clé (${typedKey?.trim() ? "clé saisie" : "clé enregistrée"} : Invalid API Key).${lengthHint(secretKey)}`,
        400,
      );
    }
    throw e;
  }
  return { ok: true, mode: detectStripeMode(secretKey), tested: typedKey?.trim() ? "saisie" : "enregistrée" };
}
