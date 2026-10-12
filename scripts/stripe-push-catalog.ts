/**
 * Envoie le catalogue ERP (prestations actives) vers Stripe.
 * À lancer d'abord en mode test (clé sk_test_), puis en live.
 *
 * Usage : npm run stripe:push-catalog
 */
import { pushCatalogToStripe } from "../apps/api/src/lib/stripe/catalog.js";
import { getCompanySettings } from "../apps/api/src/lib/company.js";
import { prisma } from "../apps/api/src/lib/prisma.js";

async function main() {
  const settings = await getCompanySettings();
  if (!settings.moduleStripeEnabled) {
    console.error("Stripe n'est pas activé (Paramètres > Paiements).");
    process.exit(1);
  }
  if (!settings.stripeSecretKeyEncrypted) {
    console.error("Clé secrète Stripe absente.");
    process.exit(1);
  }

  const hint = settings.stripeSecretKeyHint ?? "";
  const mode = hint.includes("live") ? "live" : hint.includes("test") ? "test" : "inconnu";
  console.log(`Push catalogue ERP → Stripe (mode ${mode})…`);

  const results = await pushCatalogToStripe();
  for (const r of results) {
    console.log(`  [${r.action}] ${r.name} → ${r.stripePriceId}`);
  }
  console.log(`Terminé : ${results.length} prestation(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
