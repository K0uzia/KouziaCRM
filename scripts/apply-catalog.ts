// Applique le catalogue Kouzia (prestations à prix fixe et offres de maintenance) à la base
// pointée par DATABASE_URL. Idempotent : relançable sans doublon.
import { PrismaClient } from "@prisma/client";
import { applyCatalog } from "../apps/api/src/lib/services/catalog";

const prisma = new PrismaClient();

applyCatalog(prisma)
  .then((r) => {
    console.log(
      `Catalogue appliqué : ${r.created} créée(s), ${r.updated} mise(s) à jour, ${r.archived} ancienne(s) archivée(s).`,
    );
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
