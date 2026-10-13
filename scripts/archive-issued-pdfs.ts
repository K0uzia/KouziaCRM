// Archive le PDF des factures et avoirs émis qui n'en ont pas encore (émis avant l'archivage à
// l'émission). Rendu avec les réglages et clauses du moment : à lancer une fois après la mise à jour.
// Idempotent : un document déjà archivé n'est jamais réécrit.
//   npm run archive-pdfs
// Sur le CT : kouziactl archive-pdfs
import { archivePendingIssuedPdfs } from "../apps/api/src/lib/pdf/issued-archive";
import { prisma } from "../apps/api/src/lib/prisma";

async function main(): Promise<number> {
  let total = 0;
  for (;;) {
    const archived = await archivePendingIssuedPdfs(100);
    total += archived;
    if (archived === 0) break;
  }
  const left = await prisma.invoice.count({
    where: {
      documentType: { in: ["INVOICE", "CREDIT_NOTE"] },
      status: { not: "DRAFT" },
      number: { not: null },
      pdfPath: null,
    },
  });
  console.log(`PDF archivés : ${total}${left > 0 ? ` ; ${left} en échec (voir le journal)` : ""}`);
  return left > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
