import { createHmac, timingSafeEqual } from "node:crypto";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";

export const REVOLUT_MERCHANT_API_VERSION = "2024-09-01";

export type RevolutMerchantMode = "sandbox" | "production";

export function revolutMerchantBaseUrl(mode: RevolutMerchantMode): string {
  return mode === "production"
    ? "https://merchant.revolut.com"
    : "https://sandbox-merchant.revolut.com";
}

export async function getRevolutMerchantConfig(): Promise<{
  apiKey: string;
  webhookSecret: string | null;
  mode: RevolutMerchantMode;
  baseUrl: string;
}> {
  const settings = await getCompanySettings();
  const apiKey = decryptOptional(settings.revolutMerchantApiKeyEncrypted);
  if (!apiKey) {
    throw new Error("Clé API Revolut Merchant absente (Paramètres > Paiements)");
  }
  const mode: RevolutMerchantMode =
    settings.revolutMerchantMode === "production" ? "production" : "sandbox";
  return {
    apiKey,
    webhookSecret: decryptOptional(settings.revolutWebhookSecretEncrypted),
    mode,
    baseUrl: revolutMerchantBaseUrl(mode),
  };
}

export type RevolutCreateOrderInput = {
  amountCents: number;
  currency?: string;
  description: string;
  customerEmail?: string | null;
  reference: string;
};

export type RevolutOrderResult = {
  id: string;
  token: string | null;
  checkoutUrl: string | null;
  state: string;
};

export async function createRevolutOrder(
  input: RevolutCreateOrderInput,
): Promise<RevolutOrderResult> {
  const { apiKey, baseUrl } = await getRevolutMerchantConfig();
  if (input.amountCents <= 0) {
    throw new Error("Montant invalide pour la commande Revolut");
  }

  const body: Record<string, unknown> = {
    amount: input.amountCents,
    currency: input.currency ?? "EUR",
    description: input.description,
    merchant_order_data: { reference: input.reference },
    capture_mode: "automatic",
  };
  const email = input.customerEmail?.trim();
  if (email) {
    body.customer = { email };
  }

  const res = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Revolut-Api-Version": REVOLUT_MERCHANT_API_VERSION,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      typeof json.message === "string"
        ? json.message
        : typeof json.error === "string"
          ? json.error
          : `Revolut ${res.status}`;
    throw new Error(msg);
  }

  return {
    id: String(json.id ?? ""),
    token: typeof json.token === "string" ? json.token : null,
    checkoutUrl:
      typeof json.checkout_url === "string" ? json.checkout_url : null,
    state: typeof json.state === "string" ? json.state : "pending",
  };
}

/** Vérifie la signature HMAC Revolut (v1.{timestamp}.{rawBody}). */
export function verifyRevolutWebhookSignature(opts: {
  rawBody: string;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  signingSecret: string;
  maxSkewMs?: number;
}): boolean {
  const { rawBody, timestamp, signatureHeader, signingSecret } = opts;
  if (!timestamp || !signatureHeader || !signingSecret) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const maxSkew = opts.maxSkewMs ?? 5 * 60 * 1000;
  if (Math.abs(Date.now() - ts) > maxSkew) return false;

  const payloadToSign = `v1.${timestamp}.${rawBody}`;
  const expected =
    "v1=" +
    createHmac("sha256", signingSecret).update(payloadToSign).digest("hex");

  const signatures = signatureHeader.split(",").map((s) => s.trim());
  for (const sig of signatures) {
    if (!sig.startsWith("v1=")) continue;
    try {
      if (timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return true;
      }
    } catch {
      // longueurs différentes
    }
  }
  return false;
}

export function extractRevolutEventId(payload: Record<string, unknown>): string {
  if (typeof payload.id === "string" && payload.id) return payload.id;
  const order = payload.order as Record<string, unknown> | undefined;
  const event = typeof payload.event === "string" ? payload.event : "unknown";
  const orderId = order && typeof order.id === "string" ? order.id : "";
  const ts =
    typeof payload.timestamp === "string"
      ? payload.timestamp
      : String(Date.now());
  return `${event}:${orderId}:${ts}`;
}

export function extractRevolutEventType(payload: Record<string, unknown>): string {
  if (typeof payload.event === "string") return payload.event;
  if (typeof payload.type === "string") return payload.type;
  return "UNKNOWN";
}

export function extractMilestoneReference(
  payload: Record<string, unknown>,
): string | null {
  const order = payload.order as Record<string, unknown> | undefined;
  if (!order) return null;
  const mod = order.merchant_order_data as Record<string, unknown> | undefined;
  if (mod && typeof mod.reference === "string") return mod.reference;
  const meta = order.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta.milestoneId === "string") return meta.milestoneId;
  return null;
}

export function extractRevolutOrderId(
  payload: Record<string, unknown>,
): string | null {
  const order = payload.order as Record<string, unknown> | undefined;
  if (order && typeof order.id === "string") return order.id;
  if (typeof payload.order_id === "string") return payload.order_id;
  return null;
}
