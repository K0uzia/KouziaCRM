import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { detectStripeMode, getStripeConfig } from "@/lib/stripe/client.js";

/**
 * Un identifiant Stripe enregistré n'existe que dans son mode (live ou test). Avec une clé de
 * l'autre mode, Stripe répond « introuvable » : on ne doit ni l'interpréter comme une
 * résiliation faite, ni archiver, ni réutiliser l'objet.
 */
export class StripeModeError extends Error {
  statusCode = 409;
}

export function modeLabel(livemode: boolean): "live" | "test" {
  return livemode ? "live" : "test";
}

/** Mode de la clé configurée : true = live. */
export async function keyLivemode(): Promise<boolean> {
  return (await getStripeConfig()).mode === "live";
}

/**
 * Refuse une action Stripe sur un objet enregistré dans l'autre mode. Mode inconnu (null) :
 * accepté, l'objet est complété au démarrage (backfillStripeModes).
 * @returns le mode de la clé (true = live).
 */
export async function assertSameMode(objectLivemode: boolean | null, what: string): Promise<boolean> {
  const live = await keyLivemode();
  if (objectLivemode !== null && objectLivemode !== live) {
    throw new StripeModeError(
      `${what} est lié à Stripe en mode ${modeLabel(objectLivemode)}, la clé actuelle est en mode ${modeLabel(live)} : rien n'a été fait, ni dans Stripe ni dans l'ERP.`,
    );
  }
  return live;
}

/**
 * Complète le mode des identifiants enregistrés avant son introduction : ils ont été créés avec
 * la clé configurée (en production, des objets live). Sans clé : rien.
 * @returns nombre de lignes complétées.
 */
export async function backfillStripeModes(): Promise<number> {
  const settings = await getCompanySettings();
  const key = decryptOptional(settings.stripeSecretKeyEncrypted);
  if (!key) return 0;
  const mode = detectStripeMode(key);
  const live = mode === "live";
  const [services, subs, clients] = await prisma.$transaction([
    prisma.service.updateMany({
      where: { stripeLivemode: null, OR: [{ stripePriceId: { not: null } }, { stripeProductId: { not: null } }] },
      data: { stripeLivemode: live },
    }),
    prisma.subscription.updateMany({
      where: { stripeLivemode: null, stripeSubscriptionId: { not: null } },
      data: { stripeLivemode: live },
    }),
    prisma.client.updateMany({
      where: { stripeCustomerLivemode: null, stripeCustomerId: { not: null } },
      data: { stripeCustomerLivemode: live },
    }),
  ]);
  if (!settings.stripeKeyMode) {
    await prisma.companySettings.update({ where: { id: settings.id }, data: { stripeKeyMode: mode } });
  }
  return services.count + subs.count + clients.count;
}
