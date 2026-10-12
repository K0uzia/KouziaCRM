import { prisma } from "@/lib/prisma.js";
import { decryptOptional } from "@/lib/crypto.js";
import { getStripe } from "@/lib/stripe/client.js";
import { assertSameMode } from "@/lib/stripe/mode.js";

/** Crée ou récupère le Customer Stripe du client ERP. */
export async function ensureStripeCustomer(clientId: string): Promise<string> {
  const client = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
  });

  // Customer de l'autre mode : refus explicite (ni réutilisé, ni remplacé par un nouveau).
  const live = await assertSameMode(client.stripeCustomerId ? client.stripeCustomerLivemode : null, "Ce client");
  if (client.stripeCustomerId) return client.stripeCustomerId;

  const stripe = await getStripe();
  const email = decryptOptional(client.emailEncrypted) ?? undefined;
  const customer = await stripe.customers.create({
    name: client.displayName,
    email: email || undefined,
    metadata: { erpClientId: client.id },
  });

  await prisma.client.update({
    where: { id: client.id },
    data: { stripeCustomerId: customer.id, stripeCustomerLivemode: live },
  });

  return customer.id;
}
