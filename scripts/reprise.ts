// Reprise des anciennes données (bloc-notes, contacts, besoins) après les migrations du 19/10/2026. Idempotente : relancée, elle ne
// reprend que ce qui ne l'a pas encore été. Sortie : des nombres seulement, aucune donnée personnelle.
// Usage : kouziactl reprise [--dry-run]   (ou npm run reprise -- [--dry-run])
//   --dry-run : comptes à blanc, rien n'est écrit (lisible avant la mise à jour réelle).
// La mise à jour (kouziactl update) la lance après sa sauvegarde et migrate deploy, à blanc puis pour de bon.
import { prisma } from "@/lib/prisma.js";
import { runTakeovers, takeoverSummary } from "@/lib/reprises/index.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--dry-run");
  if (unknown.length) {
    console.error(`Usage : kouziactl reprise [--dry-run] (argument inconnu : ${unknown.join(" ")})`);
    process.exitCode = 2;
    return;
  }
  const report = await runTakeovers({ dryRun: args.includes("--dry-run") });
  console.log(takeoverSummary(report).join("\n"));
}

main()
  .catch((e) => {
    console.error("Reprise interrompue :", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
