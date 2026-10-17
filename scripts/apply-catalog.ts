// Importe le catalogue Kouzia (apps/api/src/lib/services/catalog.ts) dans la base pointée par
// DATABASE_URL. Idempotent : relancé, il ne crée aucun doublon (rapprochement par nom).
//   npm run catalog -- --dry-run     liste ce qui serait fait, sans rien écrire
//   npm run catalog                  crée seulement les prestations manquantes
//   npm run catalog -- --update      remet aussi les existantes aux valeurs du catalogue
// Sur le CT : kouziactl catalog [--dry-run] [--update]
import { PrismaClient } from "@prisma/client";
import { applyCatalog, type CatalogAction } from "../apps/api/src/lib/services/catalog";

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => a !== "--dry-run" && a !== "--update");
if (unknown.length > 0) {
  console.error(`Option inconnue : ${unknown.join(" ")} (attendu : --dry-run, --update)`);
  process.exit(2);
}
const dryRun = args.has("--dry-run");
const update = args.has("--update");

const LABEL: Record<CatalogAction["action"], string> = {
  create: dryRun ? "à créer" : "créée",
  update: dryRun ? "à mettre à jour" : "mise à jour",
  same: "identique",
  differs: "différente, inchangée (--update pour l'aligner)",
  archive: dryRun ? "à archiver" : "archivée",
  stripe: "liée à Stripe, non modifiée",
};

const prisma = new PrismaClient();

applyCatalog(prisma, { dryRun, update })
  .then((actions) => {
    for (const a of actions) {
      console.log(`${LABEL[a.action].padEnd(16)} ${a.name}${a.changes.length ? ` (${a.changes.join(", ")})` : ""}`);
    }
    const count = (k: CatalogAction["action"]) => actions.filter((a) => a.action === k).length;
    console.log(
      `\n${dryRun ? "Simulation, rien n'est écrit. " : ""}${count("create")} création(s), ${count("update")} mise(s) à jour, ` +
        `${count("archive")} archivage(s), ${count("same")} identique(s), ${count("differs")} différente(s) laissée(s) telles quelles, ` +
        `${count("stripe")} liée(s) à Stripe non modifiée(s).`,
    );
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
