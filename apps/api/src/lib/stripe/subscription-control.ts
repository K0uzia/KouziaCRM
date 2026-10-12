import { getStripe } from "@/lib/stripe/client.js";
import { assertSameMode } from "@/lib/stripe/mode.js";

/**
 * Stripe a refusé ou n'a pas pu exécuter l'action : l'ERP ne change pas l'état de
 * l'abonnement (sinon le client resterait prélevé alors que l'ERP le croit clôturé).
 */
export class StripeSubscriptionSyncError extends Error {
  statusCode = 502;
}

type Action = "cancel" | "pause" | "resume";

const FAILURE: Record<Action, string> = {
  cancel: "Stripe n'a pas résilié le prélèvement : l'abonnement n'est pas clôturé.",
  pause: "Stripe n'a pas suspendu le prélèvement : l'abonnement n'est pas suspendu.",
  resume: "Stripe n'a pas repris le prélèvement : l'abonnement reste suspendu.",
};

function isMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "resource_missing";
}

/**
 * Applique côté Stripe la clôture, la suspension ou la reprise d'un abonnement prélevé.
 * Suspension : pause_collection « void » (factures Stripe annulées pendant la pause,
 * aucun prélèvement). Un abonnement absent de Stripe vaut résiliation faite, seulement si son
 * mode est connu et égal à celui de la clé : sinon « introuvable » veut dire « autre mode ».
 */
export async function applyStripeSubscriptionAction(
  stripeSubscriptionId: string,
  action: Action,
  livemode: boolean | null,
): Promise<void> {
  await assertSameMode(livemode, "Cet abonnement");
  try {
    const stripe = await getStripe();
    if (action === "cancel") {
      await stripe.subscriptions.cancel(stripeSubscriptionId);
    } else if (action === "pause") {
      await stripe.subscriptions.update(stripeSubscriptionId, { pause_collection: { behavior: "void" } });
    } else {
      await stripe.subscriptions.update(stripeSubscriptionId, { pause_collection: "" });
    }
  } catch (err) {
    if (action === "cancel" && livemode !== null && isMissing(err)) return;
    const detail = err instanceof Error && err.message ? ` Détail Stripe : ${err.message.replace(/\.$/, "")}.` : "";
    throw new StripeSubscriptionSyncError(`${FAILURE[action]}${detail}`);
  }
}
