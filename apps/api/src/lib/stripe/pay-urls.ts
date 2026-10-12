import { publicApiBaseUrl } from "@/lib/settings/public.js";
import { signPayToken, type PayTokenKind } from "@/lib/stripe/pay-token.js";

/** Lien ERP permanent qui crée une session Checkout à chaque clic. */
export function buildPayUrl(kind: PayTokenKind, id: string): string {
  const token = signPayToken(kind, id);
  if (kind === "subscribe") {
    return `${publicApiBaseUrl()}/api/public/subscribe/${token}`;
  }
  return `${publicApiBaseUrl()}/api/public/pay/${token}`;
}
