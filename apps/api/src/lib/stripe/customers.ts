import { prisma } from "@/lib/prisma.js";
import { decryptOptional } from "@/lib/crypto.js";
import { getStripe } from "@/lib/stripe/client.js";

/** Crée ou récupère le Customer Stripe du client ERP. */
export async function ensureStripeCustomer(clientId: string): Promise<string> {
  const client = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
  });

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
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}
