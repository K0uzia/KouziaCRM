import { getStripe } from "@/lib/stripe/client.js";
import { assertSameMode } from "@/lib/stripe/mode.js";

/**
 * Stripe a refusé ou n'a pas pu exécuter l'action : l'ERP ne change pas l'état de
 * l'abonnement (sinon le client resterait prélevé alors que l'ERP le croit clôturé).
 */
export class StripeSubscriptionSyncError extends Error {
  statusCode = 502;
}

/** endAtPeriodEnd : fin à la fin de la période en cours (rachat signé, R2), sans nouveau prélèvement. */
type Action = "cancel" | "pause" | "resume" | "endAtPeriodEnd" | "cancelAt" | "keepRenewing";

const FAILURE: Record<Action, string> = {
  cancel: "Stripe n'a pas résilié le prélèvement : l'abonnement n'est pas clôturé.",
  pause: "Stripe n'a pas suspendu le prélèvement : l'abonnement n'est pas suspendu.",
  resume: "Stripe n'a pas repris le prélèvement : l'abonnement reste suspendu.",
  endAtPeriodEnd: "Stripe n'a pas programmé la fin du prélèvement à la fin de la période en cours.",
  cancelAt: "Stripe n'a pas programmé la fin du prélèvement à la fin du terme : la fin n'est pas programmée.",
  keepRenewing: "Stripe n'a pas annulé la fin programmée du prélèvement : la fin reste programmée.",
};

/**
 * Date de fin calée sur une fin de période Stripe : même jour, à l'heure (UTC) des échéances Stripe, si l'écart ne
 * dépasse pas 3 heures (changement d'heure) ; sinon la date demandée.
 */
export function alignOnStripePeriod(at: Date, periodEndSec: number | null | undefined): Date {
  if (!periodEndSec) return at;
  const end = new Date(periodEndSec * 1000);
  const aligned = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds()));
  for (const candidate of [aligned, new Date(aligned.getTime() - 86_400_000), new Date(aligned.getTime() + 86_400_000)]) {
    if (Math.abs(candidate.getTime() - at.getTime()) <= 3 * 3_600_000) return candidate;
  }
  return at;
}

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
  /** cancelAt : date de fin programmée (fin du terme). */
  at?: Date,
): Promise<Date | void> {
  await assertSameMode(livemode, "Cet abonnement");
  try {
    const stripe = await getStripe();
    if (action === "keepRenewing") {
      await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at: "", cancel_at_period_end: false });
    } else if (action === "cancelAt") {
      if (!at) throw new Error("date de fin manquante");
      // Fin du terme calculée à l'heure de Paris : au changement d'heure, elle tombait une heure avant la fin de période
      // Stripe, qui facturait alors un prorata. Calée sur l'heure des périodes Stripe (essai réel du 28/10/2026).
      const current = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      const cancelAt = alignOnStripePeriod(at, current.items?.data?.[0]?.current_period_end);
      await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at: Math.floor(cancelAt.getTime() / 1000) });
      return cancelAt;
    } else if (action === "cancel") {
      await stripe.subscriptions.cancel(stripeSubscriptionId);
    } else if (action === "endAtPeriodEnd") {
      await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });
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
