// Importe le catalogue Kouzia (apps/api/src/lib/services/catalog.ts) dans la base pointée par
// DATABASE_URL. Idempotent : relancé, il ne crée aucun doublon (rapprochement par nom).
//   npm run catalog -- --dry-run     liste ce qui serait fait, sans rien écrire
//   npm run catalog                  crée seulement les prestations manquantes
//   npm run catalog -- --update      remet aussi les existantes aux valeurs du catalogue
//   npm run catalog -- --update --stripe   applique aussi la grille aux prestations liées à Stripe (même chemin
//                                    que l'écran Prestations) ; avec --dry-run, liste les actions sans appeler Stripe
// Sur le CT : kouziactl catalog [--dry-run] [--update] [--stripe]
import { PrismaClient } from "@prisma/client";
import { applyCatalog, type CatalogAction } from "../apps/api/src/lib/services/catalog";

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => a !== "--dry-run" && a !== "--update" && a !== "--stripe");
if (unknown.length > 0) {
  console.error(`Option inconnue : ${unknown.join(" ")} (attendu : --dry-run, --update, --stripe)`);
  process.exit(2);
}
const dryRun = args.has("--dry-run");
const update = args.has("--update");
const stripe = args.has("--stripe");

const LABEL: Record<CatalogAction["action"], string> = {
  create: dryRun ? "à créer" : "créée",
  update: dryRun ? "à mettre à jour" : "mise à jour",
  same: "identique",
  differs: "différente, inchangée (--update pour l'aligner)",
  archive: dryRun ? "à archiver" : "archivée",
  stripe: "liée à Stripe, non modifiée (--stripe pour l'aligner)",
  blocked: "pack en attente",
  "stripe-update": dryRun ? "Stripe : à mettre à jour" : "Stripe : mise à jour",
  "stripe-create": dryRun ? "Stripe : à créer" : "Stripe : créée",
  "stripe-archive": dryRun ? "Stripe : à archiver" : "Stripe : archivée",
  failed: "ÉCHEC Stripe, inchangée",
};

const prisma = new PrismaClient();

applyCatalog(prisma, { dryRun, update, stripe })
  .then((actions) => {
    for (const a of actions) {
      console.log(`${LABEL[a.action].padEnd(16)} ${a.name}${a.changes.length ? ` (${a.changes.join(", ")})` : ""}`);
    }
    const count = (k: CatalogAction["action"]) => actions.filter((a) => a.action === k).length;
    console.log(
      `\n${dryRun ? "Simulation, rien n'est écrit. " : ""}${count("create")} création(s), ${count("update")} mise(s) à jour, ` +
        `${count("archive")} archivage(s), ${count("same")} identique(s), ${count("differs")} différente(s) laissée(s) telles quelles, ` +
        `${count("stripe")} liée(s) à Stripe non modifiée(s), ${count("blocked")} pack(s) en attente.`,
    );
    if (stripe) {
      console.log(
        `Stripe : ${count("stripe-update")} mise(s) à jour, ${count("stripe-create")} création(s), ${count("stripe-archive")} archivage(s), ${count("failed")} échec(s).`,
      );
    }
    // Échecs Stripe : listés à part, code de sortie non nul (relancer la commande après correction).
    const failed = actions.filter((a) => a.action === "failed");
    if (failed.length) {
      console.error(`
Échecs (rien n'a changé dans l'ERP pour elles) :`);
      for (const a of failed) console.error(`  ${a.name} : ${a.changes.join(" ; ")}`);
      process.exitCode = 1;
    }
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
